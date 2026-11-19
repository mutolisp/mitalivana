/**
 * Country checklist packs (GBIF SPECIES_LIST) on the web.
 *
 * Same request, file format and import as mobile (gbifDownload.ts): the
 * request body comes from gbifSpeciesList.ts, rows go through
 * parseSpeciesListTsv → importPackRows into regionpacks.db, and the search
 * picks them up (fuzzy.ts searchPackTaxa). One step differs: GBIF serves the
 * finished zip through a redirect without CORS headers, so a page cannot
 * fetch it. When GBIF is done the user downloads the file with the link and
 * imports it; a species list downloaded on gbif.org imports the same way.
 *
 * The GBIF password is used for the one request and never stored here (the
 * web has no keychain). Requests carry no User-Agent header: the browser
 * sets its own, and a custom one would need a CORS preflight GBIF may refuse.
 */
import { create } from 'zustand';
import { strFromU8, unzipSync } from 'fflate';
import { gbifGroupKeys } from '~/lib/gbif';
import type { IconicTaxon } from '~/lib/inat';
import { buildDownloadRequestBody, parseSpeciesListTsv } from '~/lib/gbifSpeciesList';
import { getPack, importPackRows, invalidatePackCache, updatePack } from '~/db/regionpacks';

const API = 'https://api.gbif.org/v1';

/** GLORIA records vascular plants: a pack asks GBIF for the plant kingdom only. */
export const PACK_GROUPS: IconicTaxon[] = ['Plantae'];

export class GbifError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const basic = (user: string, pass: string) => {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
};

/** POST the download request; returns GBIF's download key. */
export async function requestPackDownload(countryCode: string, username: string, password: string, notifyEmail?: string): Promise<string> {
  const body = buildDownloadRequestBody(countryCode, gbifGroupKeys(PACK_GROUPS).map((k) => k.key), notifyEmail);
  let res: Response;
  try {
    res = await fetch(`${API}/occurrence/download/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: basic(username, password) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new GbifError(String((e as Error)?.message ?? e));
  }
  const text = (await res.text()).trim();
  if (!res.ok) throw new GbifError(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, res.status);
  const key = text.replace(/^"|"$/g, '');
  if (!key) throw new GbifError('empty download key');
  return key;
}

/** Where the finished file is: opening it in the browser downloads the zip. */
export const packFileUrl = (key: string) => `${API}/occurrence/download/request/${encodeURIComponent(key)}`;
/** GBIF's own page for the download (status, DOI, citation). */
export const packPageUrl = (key: string) => `https://www.gbif.org/occurrence/download/${encodeURIComponent(key)}`;

// ── Live state (module level: polling survives leaving the screen) ─────────

export type PackLive =
  | { phase: 'waiting'; gbifStatus: string; since: number }
  | { phase: 'fileReady' }
  | { phase: 'importing'; done: number; total: number };

export const usePackLive = create<{ byPack: Record<number, PackLive> }>(() => ({ byPack: {} }));

function setLive(id: number, live: PackLive | null) {
  usePackLive.setState((s) => {
    const byPack = { ...s.byPack };
    if (live) byPack[id] = live;
    else delete byPack[id];
    return { byPack };
  });
}

const POLL_FIRST_MS = 15_000;
const POLL_INTERVAL_MS = 30_000;
const polling = new Set<number>();

/**
 * Poll a requested pack until GBIF has the file (→ fileReady) or gives up
 * (→ failed). Network trouble just stops the poll: the key stays on the pack
 * and the screen offers to resume.
 */
export function drivePack(packId: number, opts: { firstDelayMs?: number } = {}): void {
  if (polling.has(packId)) return;
  const key = getPack(packId)?.gbif_download_key;
  if (!key) return;
  polling.add(packId);
  const since = Date.now();
  void (async () => {
    let wait = opts.firstDelayMs ?? 0;
    try {
      for (;;) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (!getPack(packId)) return; // deleted meanwhile
        const res = await fetch(`${API}/occurrence/download/${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new GbifError(`HTTP ${res.status}`, res.status);
        const json = (await res.json()) as { status?: string; doi?: string };
        const status = String(json.status ?? '');
        if (status === 'SUCCEEDED') {
          updatePack(packId, { status: 'running', gbif_doi: typeof json.doi === 'string' ? json.doi : null, error: null });
          setLive(packId, { phase: 'fileReady' });
          return;
        }
        if (status === 'FAILED' || status === 'KILLED' || status === 'CANCELLED') {
          updatePack(packId, { status: 'failed', error: `GBIF: ${status}` });
          setLive(packId, null);
          return;
        }
        updatePack(packId, { status: 'running' });
        setLive(packId, { phase: 'waiting', gbifStatus: status, since });
        wait = wait ? POLL_INTERVAL_MS : POLL_FIRST_MS;
      }
    } catch {
      setLive(packId, null);
    } finally {
      polling.delete(packId);
    }
  })();
}

export const isPolling = (packId: number) => polling.has(packId);

/** The species list text inside a GBIF download zip (or a bare TSV). */
function speciesListText(bytes: Uint8Array): string {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes, { filter: (f) => /\.(csv|tsv|txt)$/i.test(f.name) });
    const name = Object.keys(files)[0];
    if (!name) throw new GbifError('no species list in the zip');
    return strFromU8(files[name]);
  }
  return strFromU8(bytes);
}

/** Read a SPECIES_LIST file into a pack; returns the number of names. */
export async function importPackFile(packId: number, bytes: Uint8Array): Promise<number> {
  const { rows } = parseSpeciesListTsv(speciesListText(bytes));
  if (rows.length === 0) throw new GbifError('no species rows');
  updatePack(packId, { status: 'importing', error: null });
  setLive(packId, { phase: 'importing', done: 0, total: rows.length });
  try {
    const n = await importPackRows(packId, rows, (done, total) => setLive(packId, { phase: 'importing', done, total }));
    updatePack(packId, { status: 'ready', species_count: n, error: null });
    return n;
  } catch (e) {
    updatePack(packId, { status: 'failed', error: String((e as Error)?.message ?? e) });
    throw e;
  } finally {
    setLive(packId, null);
    invalidatePackCache();
  }
}
