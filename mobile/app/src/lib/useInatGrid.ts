/**
 * 物種記錄小地圖上的 iNaturalist 觀察網格圖：解析 → 狀態 → 圖層。
 *
 * 分工：純邏輯在 `inatHeatmap.ts`（Node 可測），快取在 `src/db/inatTaxonMap.ts`
 * （只碰 sqlite），上網與 UI 狀態在這裡。
 *
 * **必須遵守 `src/lib/inat.ts:8` 的那條原則**——「a field survey app must never
 * look like it is working when it is not」。所以離線、查不到、沒有觀察這三種情況
 * 都有各自明講的狀態，**絕不會只是讓圖層空白**：一張空的網格圖與一張「這裡沒有這
 * 個物種」的網格圖在螢幕上長得一模一樣，那是野外最不能有的歧義。
 *
 * 請求數：`gi…`（從 iNat 匯入的外部物種）省掉 autocomplete；一般物種首次 2 次
 * （autocomplete + 野外筆數），野外筆數為 0 時多 1 次（問總數）。之後全部走快取。
 * iNat 官方要求 ≤60 req/min、<10,000 req/day，這個量遠低於門檻。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { readInatTaxonCache, writeInatTaxonCache, type InatTaxonInfo } from '~/db/inatTaxonMap';
import { probe } from './apiFetch';
import { apiErrorMessage } from './apiErrorMessage';
import { fetchObservationCount, lookupTaxonId } from './inatApi';
import { gridTileUrl, isInatCacheStale, pickHeatmapMode, type HeatmapMode } from './inatHeatmap';
import { inatIdFromLocalTaxonId } from './inatPayload';

export type InatGridTaxon = {
  /** 本地 taxon id（`t…` / `y…` / `g…` / `gi…`）。`gi…` 可直接取得 iNat id。 */
  localTaxonId: string;
  /** 學名。 */
  name: string;
  kingdom: string;
};

export type InatGridState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** 有野外觀察，圖層畫的是 `captive=false`。 */
  | { kind: 'wild'; count: number }
  /** 野外 0 筆但總數 > 0：圖層改畫全部，UI 要明講這是圈養／栽培。 */
  | { kind: 'captiveOnly'; count: number }
  /** iNat 有這個物種，但一筆觀察都沒有。 */
  | { kind: 'empty' }
  /** iNat 根本沒有這個名字（實測約 17%）。 */
  | { kind: 'unknown' }
  /**
   * 筆數讀得到（快取裡有），但連不上 iNat，所以**圖層畫不出來**。
   *
   * 這個狀態存在的理由很具體：快取讓「1130 筆」在離線時照樣顯示，但瓦片載不到，
   * 螢幕上就是一行數字配一張空地圖——看起來像「這附近沒有這個物種」。那正是
   * inat.ts 檔頭禁止的那種假象，所以要明講是連線問題。
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
 * iNat 是否連得上。**只在走快取時才需要問**——真的送了查詢的話，成功或失敗本身
 * 就是答案。
 *
 * HEAD 請求（`probe` 回 0 bytes），而且結果在整個 app 共用 60 秒：在記錄之間左右
 * 翻頁時不該每一筆都去敲一次網路。
 */
let reachMemo: { at: number; ok: boolean } | null = null;
const REACH_TTL_MS = 60_000;

async function tilesReachable(signal: AbortSignal): Promise<boolean> {
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
 * 解析一個物種在 iNat 的 id 與觀察筆數，快取優先。
 *
 * 快取讀得到且沒過期就零請求。`gi…` 的本地 id 連 autocomplete 都省掉——那個 id
 * 本來就是從 iNat 來的。`fromCache` 讓呼叫端知道這一趟完全沒碰網路，因此還不知道
 * 瓦片載不載得到。
 */
async function resolve(
  taxon: InatGridTaxon,
  signal: AbortSignal,
): Promise<{ info: InatTaxonInfo; fromCache: boolean }> {
  const cached = readInatTaxonCache(taxon.name, taxon.kingdom);
  if (cached && !isInatCacheStale(cached.checkedAt)) return { info: cached, fromCache: true };

  const direct = inatIdFromLocalTaxonId(taxon.localTaxonId);
  const id = direct ?? (await lookupTaxonId(taxon.name, taxon.kingdom, signal));

  let info: InatTaxonInfo;
  if (id === null) {
    info = { inatTaxonId: null, obsWild: 0, obsTotal: 0 };
  } else {
    const wild = await fetchObservationCount(id, { wildOnly: true }, signal);
    // 野外有資料就不必再問總數——省一次請求，而 pickHeatmapMode 此時也用不到它。
    const total = wild > 0 ? null : await fetchObservationCount(id, {}, signal);
    info = { inatTaxonId: id, obsWild: wild, obsTotal: total };
  }
  writeInatTaxonCache(taxon.name, taxon.kingdom, info);
  // 這一趟真的通了，順手記下來，省掉接下來 60 秒內其他物種的探測
  reachMemo = { at: Date.now(), ok: true };
  return { info, fromCache: false };
}

/**
 * 回傳圖層開關、目前狀態、以及要掛上去的瓦片 URL（沒有就是 null）。
 *
 * `enabled` 由呼叫端持久化（設定 key `inat_grid_overlay`），所以下次開同一張圖
 * 會沿用；但**解析只在真的開著時才發生**，關著的時候一個請求都不會送。
 */
export function useInatGrid(taxon: InatGridTaxon | undefined, enabled: boolean) {
  const [state, setState] = useState<InatGridState>({ kind: 'idle' });
  // 解析出來的 id 跟著 state 一起放，不要在 render 期間回頭讀 DB —— 那會變成
  // 每次 render 一次同步 SQL，正是這個專案一再避免的事。
  const [inatId, setInatId] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // 換物種就重來：同一個 sheet 會被左右滑動換成下一筆記錄，舊的解析必須作廢，
  // 否則前一個物種的筆數會蓋到新物種上。
  const key = taxon ? `${taxon.localTaxonId}|${taxon.name}|${taxon.kingdom}` : '';

  useEffect(() => {
    abortRef.current?.abort();
    setInatId(null);
    if (!taxon || !enabled) {
      setState({ kind: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const { info, fromCache } = await resolve(taxon, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setInatId(info.inatTaxonId);
        const next = stateFor(info);
        // 快取命中＝這一趟沒碰網路，所以還不知道瓦片載不載得到。有筆數要畫的時候
        // 才值得問——「沒有這個物種」那種狀態本來就不掛圖層，離線與否不影響它。
        if (fromCache && (next.kind === 'wild' || next.kind === 'captiveOnly')) {
          const ok = await tilesReachable(ctrl.signal);
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

  const tileUrl = inatId === null ? null : gridTileUrl(inatId, modeFor(state));

  return { state, tileUrl, retry };
}
