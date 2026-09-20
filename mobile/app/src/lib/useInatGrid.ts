/**
 * The iNaturalist observation grid overlay on a record's mini-map: resolve →
 * state → layer.
 *
 * Split of duties: pure logic in `inatHeatmap.ts` (testable under Node), the
 * cache in `src/db/inatTaxonMap.ts` (sqlite only), network and UI state here.
 *
 * **The rule in `src/lib/inat.ts:8` applies** — "a field survey app must never
 * look like it is working when it is not". So offline, not-found and
 * no-observations each get their own spelled-out state and **the layer is never
 * left simply blank**: an empty grid and a grid saying "this species is not
 * here" look identical on screen, and that is the one ambiguity you cannot
 * afford in the field.
 *
 * Request count: `gi…` (an external taxon imported from iNat) skips the
 * autocomplete; any other species costs 2 on first sight (autocomplete + wild
 * count), plus 1 more when the wild count is 0 (asking for the total). After
 * that everything comes from the cache. iNat asks for ≤60 req/min and <10,000
 * req/day; this is far below either.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { readInatTaxonCache, writeInatTaxonCache, type InatTaxonInfo } from '~/db/inatTaxonMap';
import { probe } from './apiFetch';
import { apiErrorMessage } from './apiErrorMessage';
import { fetchObservationCount, lookupTaxon } from './inatApi';
import {
  gridPrecisionOffset,
  gridTileUrl,
  isInatCacheStale,
  pickHeatmapMode,
  type HeatmapMode,
} from './inatHeatmap';
import { inatIdFromLocalTaxonId, type TaxonMatchVia } from './inatPayload';

export type InatGridTaxon = {
  /** Local taxon id (`t…` / `y…` / `g…` / `gi…`). A `gi…` id already carries the
 *  iNat id. */
  localTaxonId: string;
  /** Scientific name. */
  name: string;
  kingdom: string;
};

export type InatGridState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** Wild observations exist; the layer draws `captive=false`. */
  | { kind: 'wild'; count: number }
  /** Zero wild but a non-zero total: the layer draws everything, and the UI has
 *  to say these are captive or cultivated. */
  | { kind: 'captiveOnly'; count: number }
  /** iNat has the species but not a single observation. */
  | { kind: 'empty' }
  /** iNat does not have this name at all (measured: about 17%). */
  | { kind: 'unknown' }
  /**
   * The counts are known (they were cached) but iNat is unreachable, so **the
   * layer cannot draw**.
   *
   * This state exists for a very concrete reason: the cache still shows "1130
   * observations" while offline, yet no tile loads, so the screen is a number
   * above an empty map — which reads as "this species is not around here". That
   * is exactly the illusion the file header of inat.ts forbids, so it has to be
   * named as a connectivity problem.
   */
  | { kind: 'offline'; count: number | null }
  | { kind: 'error'; message: string };

function stateFor(info: InatTaxonInfo): InatGridState {
  if (info.inatTaxonId === null) return { kind: 'unknown' };
  const mode = pickHeatmapMode(info.obsWild, info.obsTotal ?? 0);
  if (mode === 'wild') return { kind: 'wild', count: info.obsWild };
  if (mode === 'all') return { kind: 'captiveOnly', count: info.obsTotal ?? 0 };
  return { kind: 'empty' };
}

function modeFor(state: InatGridState): HeatmapMode {
  if (state.kind === 'wild') return 'wild';
  if (state.kind === 'captiveOnly') return 'all';
  return 'none';
}

/**
 * Whether iNat is reachable. **Only worth asking when the answer came from the
 * cache** — if a query was actually sent, its success or failure is the answer.
 *
 * A HEAD request (`probe` returns 0 bytes), and the result is shared app-wide
 * for 60 s: paging left and right between records should not poke the network
 * once per record.
 */
let reachMemo: { at: number; ok: boolean } | null = null;
const REACH_TTL_MS = 60_000;

export async function inatTilesReachable(signal: AbortSignal): Promise<boolean> {
  if (reachMemo && Date.now() - reachMemo.at < REACH_TTL_MS) return reachMemo.ok;
  try {
    await probe('inat', 'https://api.inaturalist.org/v1/taxa/1', signal, 6000);
    reachMemo = { at: Date.now(), ok: true };
  } catch {
    reachMemo = { at: Date.now(), ok: false };
  }
  return reachMemo.ok;
}

/**
 * Resolve a species' iNat id and observation counts, cache first.
 *
 * A live, unexpired cache entry costs zero requests. A `gi…` local id skips even
 * the autocomplete — that id came from iNat in the first place. `fromCache`
 * tells the caller this round never touched the network, and therefore that
 * whether tiles will load is still unknown.
 */
export async function resolveInatTaxon(
  taxon: InatGridTaxon,
  signal: AbortSignal,
): Promise<{ info: InatTaxonInfo; fromCache: boolean }> {
  const cached = readInatTaxonCache(taxon.name, taxon.kingdom);
  if (cached && !isInatCacheStale(cached.checkedAt)) return { info: cached, fromCache: true };

  // A `gi…` id came from iNaturalist to begin with, so it IS the taxon's own
  // id and there is nothing to match.
  const direct = inatIdFromLocalTaxonId(taxon.localTaxonId);
  const match =
    direct === null
      ? await lookupTaxon(taxon.name, taxon.kingdom, signal)
      : { id: direct, name: taxon.name, via: 'name' as const };

  let info: InatTaxonInfo;
  if (match === null) {
    info = { inatTaxonId: null, obsWild: 0, obsTotal: 0, inatName: null, via: null };
  } else {
    const wild = await fetchObservationCount(match.id, { wildOnly: true }, signal);
    // A non-zero wild count makes the total unnecessary — one request saved, and
  // pickHeatmapMode does not look at it in that case anyway.
    const total = wild > 0 ? null : await fetchObservationCount(match.id, {}, signal);
    info = {
      inatTaxonId: match.id,
      obsWild: wild,
      obsTotal: total,
      inatName: match.name,
      via: match.via,
    };
  }
  writeInatTaxonCache(taxon.name, taxon.kingdom, info);
  // This round really did get through; remember it and save every other species
  // a probe for the next 60 seconds.
  reachMemo = { at: Date.now(), ok: true };
  return { info, fromCache: false };
}

/** What the layer is actually drawing, once resolution has succeeded. */
export type InatGridResolved = {
  inatTaxonId: number;
  /** The name iNaturalist files it under — not necessarily the name asked for. */
  inatName: string;
  via: TaxonMatchVia;
};

/**
 * Returns the layer's state and the tile URL to mount (null when there is none).
 *
 * `enabled` is persisted by the caller (setting key `inat_grid_overlay`), so the
 * next map opens the same way; but **resolution only happens while it is
 * actually on** — switched off, not a single request is sent.
 *
 * `zoom` (see `tileZoomForRegion`) only decides how coarse the cells are; it is
 * bucketed by `gridPrecisionOffset` before it reaches the URL, so panning and
 * pinching do not keep invalidating the loaded tiles.
 */
export function useInatGrid(
  taxon: InatGridTaxon | undefined,
  enabled: boolean,
  zoom = 0,
) {
  const [state, setState] = useState<InatGridState>({ kind: 'idle' });
  // The resolved id is kept next to the state rather than read back from the DB
  // during render: that would be one synchronous SQL call per render, which is
  // exactly what this project keeps avoiding.
  const [inatId, setInatId] = useState<number | null>(null);
  const [resolved, setResolved] = useState<InatGridResolved | null>(null);
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // A different species starts over: this sheet gets swiped sideways to the next
  // record, so the previous resolution must be discarded or its counts land on
  // the new species.
  const key = taxon ? `${taxon.localTaxonId}|${taxon.name}|${taxon.kingdom}` : '';

  useEffect(() => {
    abortRef.current?.abort();
    setInatId(null);
    setResolved(null);
    if (!taxon || !enabled) {
      setState({ kind: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const { info, fromCache } = await resolveInatTaxon(taxon, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setInatId(info.inatTaxonId);
        setResolved(
          info.inatTaxonId === null
            ? null
            : {
                inatTaxonId: info.inatTaxonId,
                // Rows written before v37 carry neither field, and those could
                // only have been strict matches — see the v37 migration.
                inatName: info.inatName || taxon.name,
                via: info.via ?? 'name',
              },
        );
        const next = stateFor(info);
        // 快取命中＝這一趟沒碰網路，所以還不知道瓦片載不載得到。有筆數要畫的時候
        // 才值得問——「沒有這個物種」那種狀態本來就不掛圖層，離線與否不影響它。
        if (fromCache && (next.kind === 'wild' || next.kind === 'captiveOnly')) {
          const ok = await inatTilesReachable(ctrl.signal);
          if (ctrl.signal.aborted) return;
          if (!ok) {
            setState({ kind: 'offline', count: next.count });
            return;
          }
        }
        setState(next);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        // 這裡會多打一次「另一個服務」的探測，把「你沒訊號」與「iNat 掛了」分開。
        setState({ kind: 'error', message: await apiErrorMessage(e) });
      }
    })();
    return () => ctrl.abort();
    // key 就是 taxon 的身分；直接用物件會因為每次 render 新建而無限重跑。
    // attempt 是 retry 的觸發點：狀態沒變也要能重跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, attempt]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const tileUrl =
    inatId === null ? null : gridTileUrl(inatId, modeFor(state), gridPrecisionOffset(zoom));

  return { state, tileUrl, retry, resolved };
}
