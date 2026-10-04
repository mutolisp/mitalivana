/**
 * Team sync of a tree census on the app's connection and the team relay
 * (docs/planned/Modular_survey.md §7.2, §7.9, §9 1C-b). The rules — blocks,
 * documents, clashes, folds, the merge — are in db/censusSyncCore.ts (tested
 * by check:census-sync); this file moves the documents and keeps state:
 *
 * - sync_links: the census ('survey', its uuid → its header's relay name) and
 *   each block this device has seen ('survey_block', `<census uuid>#<block>`),
 *   with the time of the last sync and of the last upload;
 * - sync_base ('survey', census uuid): the merge base of the whole census;
 * - settings `fw_claims:<census uuid>`: blocks claimed here and by teammates
 *   (this phone's roll of tags is in tagRoll.ts).
 *
 * One 同步: teammates' headers (claims, block size) → this device's header →
 * the blocks changed here since the last sync → teammates' changed blocks,
 * merged without a question when nothing needs a person, else the review
 * screen (app/survey/merge.tsx) for the first one → the merged blocks this
 * device works on are sent again (their copy predates the merge).
 */
import { router, type Href } from 'expo-router';
import { create } from 'zustand';
import { getUserDb, withTransaction } from '~/db/init';
import { saveVersion } from '~/db/recordVersions';
import { getSyncBase, patchSyncBase } from '~/db/syncBase';
import { generateUuid } from '~/db/uuid';
import { defaultDecision, describeMerge, needsReview, rowHash, type BaseEntry, type Decision, type MergeChange, type MergeItem, type Row } from '~/lib/mergeEngine';
import { deviceKey, recordKey, type TeamKeys } from '~/lib/teamCrypto';
import {
  asSyncError,
  downloadText,
  installId,
  keysOf,
  link,
  listTeamItems,
  logSync,
  markSeen,
  putSealed,
  rememberMember,
  REUPLOAD_MS,
  seenEtag,
  serverOf,
  TeamSyncError,
  type Item,
  type SyncOutcome,
  type Team,
} from '~/lib/teamSync';
import { useSyncProgress, withSyncProgress } from '~/stores/syncProgress';
import { prepareMediaItems, receiveMedia, sendRecordMedia, serverTakesFiles, type PreparedMedia } from '~/lib/mediaSync';
import type { FileItem, MediaEntry, MediaMeta, MediaRef } from '~/lib/mediaRefsCore';
import { BASE64_FACTOR, bytesPerStemFor, chooseSyncBlock, DEFAULT_STEMS_PER_HA, EDGE_CANDIDATES } from './stemmap/syncBlocks';
import { fgQuadratCounts } from './stemmap/coords';
import * as core from './db/censusSyncCore';
import type { CensusSlice } from './db/sliceCore';
import { quadratRowId, quadratSlice } from './db/censusVersions';
import { censusCodesets, frameGeometry, getFrame, getSurvey, type Ctx } from './db/stemmapCore';
import { clearCensusUndo } from './undo';

const ctx = (): Ctx => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const rows = <T>(sql: string, args: (string | number)[] = []) => (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];

/** A block as uploaded: the document plus its sync block (base, author, files on servers that take them). */
export type CensusBlockUpload = core.CensusBlockDoc & { sync?: { exported_at?: number; base?: BaseEntry[]; author?: string | null; media?: MediaEntry[] } };

const headerRec = (keys: TeamKeys, ident: string) => recordKey(keys.encKey, 'survey', ident);
const blockRec = (keys: TeamKeys, ident: string, block: string) => recordKey(keys.encKey, 'survey_block', `${ident}|${block}`);
const blockLinkUuid = (censusUuid: string, block: string) => `${censusUuid}#${block}`;

export function censusLabel(surveyId: number): string {
  const s = getSurvey(ctx(), surveyId);
  const f = s ? getFrame(ctx(), s.frame_id) : null;
  return s && f ? `${f.code} #${s.census_no}` : '';
}

/** A census document from the relay (JSON), or null for anything else (a record's yml). */
export function readCensusDoc(text: string): core.CensusTeamHeader | CensusBlockUpload | null {
  if (!text.trimStart().startsWith('{')) return null;
  try {
    const doc = JSON.parse(text) as unknown;
    if (core.isTeamHeader(doc)) return doc;
    if (core.isBlockDoc(doc)) return doc as CensusBlockUpload;
  } catch {
    // not JSON after all
  }
  return null;
}

// ── settings kept on this phone ─────────────────────────────────────────────

const getSetting = (key: string): string | null => rows<{ value: string | null }>(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [key])[0]?.value ?? null;
const putSetting = (key: string, value: string | null) =>
  value == null
    ? getUserDb().executeSync(`DELETE FROM settings WHERE key = ?`, [key])
    : getUserDb().executeSync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);

export type BlockClaims = {
  mine: string[];
  /** Teammates' claims by device, from their headers. */
  others: Record<string, { name: string | null; blocks: string[]; at: number }>;
};

const claimsKey = (censusUuid: string) => `fw_claims:${censusUuid}`;

/** Bumped when claims change, so screens re-read them. */
export const useClaimsVersion = create<{ v: number; bump: () => void }>((set) => ({ v: 0, bump: () => set((s) => ({ v: s.v + 1 })) }));

export function getClaims(surveyId: number): BlockClaims {
  const s = getSurvey(ctx(), surveyId);
  const raw = s ? getSetting(claimsKey(s.uuid)) : null;
  try {
    const v = raw ? (JSON.parse(raw) as Partial<BlockClaims>) : {};
    return { mine: Array.isArray(v.mine) ? v.mine : [], others: v.others && typeof v.others === 'object' ? v.others : {} };
  } catch {
    return { mine: [], others: {} };
  }
}

function putClaims(surveyId: number, c: BlockClaims): void {
  const s = getSurvey(ctx(), surveyId);
  if (!s) return;
  putSetting(claimsKey(s.uuid), JSON.stringify(c));
  useClaimsVersion.getState().bump();
}

/** Claim or release a block for this phone's group (sent with the next 同步). */
export function setMyClaim(surveyId: number, block: string, on: boolean): void {
  const c = getClaims(surveyId);
  const mine = new Set(c.mine);
  if (on) mine.add(block);
  else mine.delete(block);
  putClaims(surveyId, { ...c, mine: [...mine].sort() });
}

export type BlockState = {
  block: string;
  /** Block column / row from the lower left. */
  bc: number;
  br: number;
  label: string;
  mine: boolean;
  /** Teammates claiming it (names). */
  others: string[];
  /** Last team sync of this block on this phone (ms), any team. */
  syncedAt: number | null;
  /** Changed here since then. */
  unsent: boolean;
};

/** Every block of a census with its claims and sync state (the blocks screen); null before the block size is decided. */
export function blockStates(surveyId: number): BlockState[] | null {
  const c = ctx();
  const s = getSurvey(c, surveyId);
  if (!s?.sync_block_quadrats) return null;
  const k = s.sync_block_quadrats;
  const { cols, rows: rr } = fgQuadratCounts(frameGeometry(getFrame(c, s.frame_id)!));
  const claims = getClaims(surveyId);
  const synced = new Map(
    rows<{ u: string; t: number | null }>(`SELECT record_uuid AS u, MAX(last_synced_at) AS t FROM sync_links WHERE record_kind = 'survey_block' AND record_uuid LIKE ? GROUP BY record_uuid`, [
      `${s.uuid}#%`,
    ]).map((r) => [r.u.slice(s.uuid.length + 1), r.t]),
  );
  const stamps = core.blockStamps(c, surveyId, k);
  return core.allBlocks(cols, rr, k).map((block) => {
    const p = core.parseBlock(block)!;
    const at = synced.get(block) ?? null;
    return {
      block,
      bc: p.bc,
      br: p.br,
      label: blockLabel(surveyId, block),
      mine: claims.mine.includes(block),
      others: Object.values(claims.others)
        .filter((o) => o.blocks.includes(block))
        .map((o) => o.name ?? '?'),
      syncedAt: at,
      unsent: (stamps.get(block) ?? 0) > (at ?? 0),
    };
  });
}

/** Who else claims the block holding this quadrat (names), for the warning before editing there. */
export function claimedByOthers(surveyId: number, quadratCode: string): string[] {
  const s = getSurvey(ctx(), surveyId);
  if (!s?.sync_block_quadrats) return [];
  const block = core.blockOf(quadratCode, s.sync_block_quadrats);
  const c = getClaims(surveyId);
  if (c.mine.includes(block)) return [];
  return Object.values(c.others)
    .filter((o) => o.blocks.includes(block))
    .map((o) => o.name ?? '?');
}

// ── block size (first team sync, §7.9) ──────────────────────────────────────


export type BlockSizeOption = { edge: number; blocks: number; estimatedBytes: number; estimatedObjects: number; recommended: boolean; tooLarge: boolean };

/** The choices offered at the first team sync: each block edge, with its estimates; the recommended one first in importance. */
export function blockSizeOptions(surveyId: number): BlockSizeOption[] {
  const c = ctx();
  const s = getSurvey(c, surveyId)!;
  const frame = getFrame(c, s.frame_id)!;
  const g = frameGeometry(frame);
  const { cols, rows: rr } = fgQuadratCounts(g);
  // Density: the stems this census and the one before it have per hectare in their densest 1 ha, at least the default.
  const stems = rows<{ q: string; n: number }>(
    `SELECT i.quadrat_code AS q, COUNT(*) AS n FROM fw_stems st JOIN fw_individuals i ON i.id = st.individual_id WHERE i.frame_id = ? GROUP BY i.quadrat_code`,
    [frame.id],
  );
  const perBlock = new Map<string, number>();
  for (const r of stems) perBlock.set(core.blockOf(r.q, 5), (perBlock.get(core.blockOf(r.q, 5)) ?? 0) + r.n);
  const haOf5 = (25 * g.quadratM * g.quadratM) / 10000;
  const density = Math.max(DEFAULT_STEMS_PER_HA, ...[...perBlock.values()].map((n) => n / haOf5));
  // With AMS each stem carries its AMS values too (BYTES_PER_STEM_AMS).
  const bytesPerStem = bytesPerStemFor(censusCodesets(c, surveyId));
  const pick = chooseSyncBlock({ quadratsX: cols, quadratsY: rr, quadratM: g.quadratM, stemsPerHa: density, bytesPerStem });
  const edges = [...new Set([Math.max(cols, rr), ...EDGE_CANDIDATES.filter((k) => k < Math.max(cols, rr))])];
  return edges.map((edge) => {
    const blocks = Math.ceil(cols / edge) * Math.ceil(rr / edge);
    const ha = (Math.min(edge, cols) * g.quadratM * Math.min(edge, rr) * g.quadratM) / 10000;
    const estimatedBytes = density * ha * bytesPerStem * BASE64_FACTOR;
    return { edge, blocks, estimatedBytes, estimatedObjects: blocks * 1.5, recommended: edge === pick.edgeQuadrats, tooLarge: estimatedBytes > 5 * 1024 * 1024 * 0.4 };
  });
}

// ── photos (self-hosted servers that take files, Media_sync.md) ─────────────

/** A block's photos as file-sync items: each is its own fw_media row, so the entry names its tree and stem. */
function blockMedia(surveyId: number, block: string): Array<FileItem & { ref: MediaRef }> {
  const s = getSurvey(ctx(), surveyId)!;
  const codes = core.censusBlockCodes(ctx(), surveyId, s.sync_block_quadrats!, block);
  if (!codes.length) return [];
  return rows<{ u: string; uri: string; tree: string; stem: string | null; component: string; kind: string }>(
    `SELECT md.uuid AS u, md.uri, i.uuid AS tree, st.uuid AS stem, md.component, md.kind FROM fw_media md
       JOIN fw_individuals i ON i.id = md.individual_id
       LEFT JOIN fw_stem_measures m ON m.id = md.measure_id LEFT JOIN fw_stems st ON st.id = m.stem_id
      WHERE md.survey_id = ? AND i.quadrat_code IN (${codes.map(() => '?').join(', ')})`,
    [surveyId, ...codes],
  ).map((r) => ({ uri: r.uri, ref: { t: 'fw_media', k: r.u, c: 'uri' }, meta: { owner: { tree: r.tree, stem: r.stem, component: r.component, kind: r.kind } } }));
}

/** Add a teammate's census photo here as its own row (adding only); false when it is here or its tree is not. */
function placeCensusMedia(surveyId: number): (ref: MediaRef, uri: string, meta: MediaMeta | undefined) => boolean {
  return (ref, uri, meta) => {
    const owner = meta?.owner;
    if (ref.t !== 'fw_media' || !owner) return false;
    if (rows(`SELECT id FROM fw_media WHERE uuid = ?`, [ref.k]).length) return false;
    const tree = rows<{ id: number; q: string }>(`SELECT id, quadrat_code AS q FROM fw_individuals WHERE uuid = ?`, [owner.tree])[0];
    if (!tree) return false;
    const measure = owner.stem
      ? (rows<{ id: number }>(`SELECT m.id FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.uuid = ? AND m.survey_id = ?`, [owner.stem, surveyId])[0]?.id ?? null)
      : null;
    getUserDb().executeSync(`INSERT INTO fw_media (uuid, survey_id, individual_id, measure_id, component, kind, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      ref.k,
      surveyId,
      tree.id,
      measure,
      owner.component,
      owner.kind,
      uri,
      Date.now(),
    ]);
    return true;
  };
}

/** Fetch and place the files of a teammate's block (and those that could not be fetched before). */
async function receiveCensusMedia(teamId: string, surveyId: number, censusUuid: string, manifest: unknown): Promise<{ added: number; pending: number }> {
  const pending = rows<{ entry: string }>(`SELECT entry FROM media_pending WHERE team_id = ? AND record_kind = 'survey' AND record_uuid = ?`, [teamId, censusUuid]).flatMap((r) => {
    try {
      return [JSON.parse(r.entry) as unknown];
    } catch {
      return [];
    }
  });
  const all = [...(Array.isArray(manifest) ? manifest : []), ...pending];
  return all.length ? receiveMedia(teamId, 'survey', censusUuid, all, placeCensusMedia(surveyId)) : { added: 0, pending: 0 };
}

/**
 * The team's census files that could not be fetched before, without waiting
 * for a teammate's block (the team page's 待抓檔案, a team 同步): the retry for
 * records skipped them, and the count never went down (code review M14).
 */
export async function retryCensusMedia(teamId: string): Promise<{ added: number; pending: number }> {
  let added = 0;
  let pending = 0;
  for (const r of rows<{ record_uuid: string }>(`SELECT DISTINCT record_uuid FROM media_pending WHERE team_id = ? AND record_kind = 'survey'`, [teamId])) {
    const id = rows<{ id: number }>(`SELECT id FROM fw_surveys WHERE uuid = ?`, [r.record_uuid])[0]?.id;
    if (id == null) {
      getUserDb().executeSync(`DELETE FROM media_pending WHERE team_id = ? AND record_kind = 'survey' AND record_uuid = ?`, [teamId, r.record_uuid]);
      continue;
    }
    const x = await receiveCensusMedia(teamId, id, r.record_uuid, []);
    added += x.added;
    pending += x.pending;
  }
  return { added, pending };
}

// ── one 同步 ────────────────────────────────────────────────────────────────

export type CensusSyncOutcome = SyncOutcome & {
  blocksSent: number;
  /** Not synced: no block size yet and nobody to ask (team page); open the census and sync there. */
  needsBlockSize?: boolean;
  /** Teammates whose census here uses another template: their blocks were not merged (names, '' when unknown). */
  templateDiffers?: string[];
};

export type CensusSyncOptions = {
  /** Ask the person for the block size (census screen); null = cancelled. */
  chooseBlockSize?: (options: BlockSizeOption[]) => Promise<number | null>;
};

export function syncCensus(teamId: string, surveyId: number, opts: CensusSyncOptions = {}): Promise<CensusSyncOutcome | null> {
  return withSyncProgress(() => {
    useSyncProgress.getState().update({ record: censusLabel(surveyId), stage: 'record', blockStage: null, blockIndex: null, blockCount: null });
    return syncCensusNow(teamId, surveyId, opts);
  });
}

/** The team page's 同步 of a linked census (no one to ask for a block size there). Null when it is not here. */
export async function syncLinkedCensus(teamId: string, censusUuid: string): Promise<CensusSyncOutcome | null> {
  const id = rows<{ id: number }>(`SELECT id FROM fw_surveys WHERE uuid = ?`, [censusUuid])[0]?.id;
  return id == null ? null : syncCensus(teamId, id);
}

type BlockLink = { last_synced_at: number | null; uploaded_at: number | null; uploaded_hash: string | null };

function blockLink(teamId: string, censusUuid: string, block: string): BlockLink | null {
  return (
    rows<BlockLink>(`SELECT last_synced_at, uploaded_at, uploaded_hash FROM sync_links WHERE team_id = ? AND record_kind = 'survey_block' AND record_uuid = ?`, [
      teamId,
      blockLinkUuid(censusUuid, block),
    ])[0] ?? null
  );
}

async function syncCensusNow(teamId: string, surveyId: number, opts: CensusSyncOptions): Promise<CensusSyncOutcome | null> {
  const { team, keys } = await keysOf(teamId);
  const c = ctx();
  const s0 = getSurvey(c, surveyId);
  if (!s0) throw new TeamSyncError('noRecord');
  const censusUuid = s0.uuid;
  const ident = core.identOfCensus(c, surveyId)!;
  const dev = deviceKey(keys.encKey, installId());
  const hRec = headerRec(keys, ident);
  const server = serverOf(team);
  const label = censusLabel(surveyId);
  const logRec = { kind: 'survey' as const, uuid: censusUuid, label };
  const out: CensusSyncOutcome = { merged: 0, mergedFrom: [], changes: [], review: false, queued: false, uploaded: false, blocksSent: 0 };
  try {
    const items = await listTeamItems(team, keys);

    // 1. Teammates' headers: their claims, and the block size if this phone has none yet.
    let teamK: number | null = null;
    const needK = getSurvey(c, surveyId)!.sync_block_quadrats == null;
    // Teammates on another template: their header stays unseen (asked again next time), their blocks are not merged.
    const otherTemplate = new Map<string, string>();
    for (const it of items) {
      if (it.rec !== hRec || it.dev === dev) continue;
      if (!needK && seenEtag(teamId, hRec, it.dev) === it.etag) continue;
      const doc = readCensusDoc(await downloadText(team, keys, hRec, it.dev));
      if (!doc || doc.record_type !== 'census_team_header' || doc.ident !== ident) {
        markSeen(teamId, hRec, it.dev, it.etag);
        continue;
      }
      if (core.templateDiffers(s0.template_id, doc.survey)) {
        otherTemplate.set(it.dev, doc.author ?? '');
        logSync(teamId, 'skip', logRec, { server, detail: 'template_differs' });
        continue;
      }
      markSeen(teamId, hRec, it.dev, it.etag);
      rememberMember(teamId, it.dev, doc.author, it.uploaded);
      const claims = getClaims(surveyId);
      putClaims(surveyId, { ...claims, others: { ...claims.others, [it.dev]: { name: doc.author ?? null, blocks: doc.claims, at: it.uploaded } } });
      teamK ??= doc.block_quadrats;
    }

    // 2. The block size: the team's, or chosen here at the first sync.
    let k = getSurvey(c, surveyId)!.sync_block_quadrats;
    if (k == null) {
      if (teamK != null) k = teamK;
      else if (opts.chooseBlockSize) {
        const chosen = await opts.chooseBlockSize(blockSizeOptions(surveyId));
        if (chosen == null) return null;
        k = chosen;
      } else {
        logSync(teamId, 'skip', logRec, { server, detail: 'block_size' });
        return { ...out, needsBlockSize: true };
      }
      const kk = k;
      withTransaction(() => core.setBlockSize(c, surveyId, kk));
    } else if (teamK != null && teamK !== k) {
      throw new core.CensusSyncError('block_size_differs');
    }
    link(teamId, 'survey', censusUuid, hRec, null);

    // 3. This phone's header (claims, name), when it changed or is due again.
    {
      const header = core.buildTeamHeader(c, surveyId, getClaims(surveyId).mine, team.member_name);
      const hash = rowHash(header as unknown as Row);
      const last = rows<{ uploaded_hash: string | null; uploaded_at: number | null }>(
        `SELECT uploaded_hash, uploaded_at FROM sync_links WHERE team_id = ? AND record_kind = 'survey' AND record_uuid = ?`,
        [teamId, censusUuid],
      )[0];
      if (last?.uploaded_hash !== hash || (last.uploaded_at ?? 0) < Date.now() - REUPLOAD_MS) {
        const bytes = await putSealed(team, keys, hRec, dev, JSON.stringify(header));
        getUserDb().executeSync(`UPDATE sync_links SET uploaded_hash = ?, uploaded_at = ? WHERE team_id = ? AND record_kind = 'survey' AND record_uuid = ?`, [
          hash,
          Date.now(),
          teamId,
          censusUuid,
        ]);
        logSync(teamId, 'upload', logRec, { server, bytes });
      }
    }

    // 4. Blocks changed here since the last sync (or sent before and due again).
    const takesFiles = await serverTakesFiles(server);
    // Read once, not per block: a 25 ha census's base is 100 000 rows (code
    // review M6). Sending changes no base; merging does, so step 6 reads again.
    let censusBase = getSyncBase('survey', censusUuid);
    const putBlock = async (block: string, force: boolean) => {
      const doc = core.buildBlockDoc(c, surveyId, block);
      const base = core.baseForSlice(censusBase, doc.slice);
      const prepared: PreparedMedia | null = takesFiles ? await prepareMediaItems(keys, blockMedia(surveyId, block)) : null;
      // A new photo is a change of the block (photo rows are not in the merge rows).
      const files = (prepared?.entries ?? []).map((e) => `${e.ref.k}:${e.sha}`);
      const hash = rowHash({ side: core.blockSide(doc.slice), base, files } as unknown as Row);
      const bRec = blockRec(keys, ident, block);
      const linkUuid = blockLinkUuid(censusUuid, block);
      link(teamId, 'survey_block', linkUuid, bRec, null);
      const lk = blockLink(teamId, censusUuid, block);
      const now = Date.now();
      if (!force && lk?.uploaded_hash === hash && (lk.uploaded_at ?? 0) > now - REUPLOAD_MS) {
        getUserDb().executeSync(`UPDATE sync_links SET last_synced_at = ? WHERE team_id = ? AND record_kind = 'survey_block' AND record_uuid = ?`, [now, teamId, linkUuid]);
        return;
      }
      if (prepared) await sendRecordMedia(server, keys, prepared, bRec, dev);
      const upload: CensusBlockUpload = {
        ...doc,
        sync: { exported_at: now, base, ...(team.member_name ? { author: team.member_name } : {}), ...(prepared?.entries.length ? { media: prepared.entries } : {}) },
      };
      const bytes = await putSealed(team, keys, bRec, dev, JSON.stringify(upload));
      getUserDb().executeSync(
        `UPDATE sync_links SET uploaded_hash = ?, uploaded_at = ?, last_synced_at = ? WHERE team_id = ? AND record_kind = 'survey_block' AND record_uuid = ?`,
        [hash, now, now, teamId, linkUuid],
      );
      out.blocksSent += 1;
      out.uploaded = true;
      logSync(teamId, 'upload', logRec, { server, bytes, detail: blockLabel(surveyId, block) });
    };
    const outgoing = [...core.blockStamps(c, surveyId, k)].filter(([block, stamp]) => {
      const lk = blockLink(teamId, censusUuid, block);
      const changedHere = stamp > (lk?.last_synced_at ?? 0);
      // Sent before but the relay may have lost it (a moved team clears the hash) or it is getting old.
      const due = lk?.uploaded_at != null && (lk.uploaded_hash == null || lk.uploaded_at < Date.now() - REUPLOAD_MS);
      return changedHere || due;
    });
    // The strip counts blocks: a whole 25 ha census is tens of them (1E).
    for (const [i, [block]] of outgoing.entries()) {
      useSyncProgress.getState().update({ blockStage: 'up', blockIndex: i + 1, blockCount: outgoing.length });
      await putBlock(block, false);
    }

    // 5. Teammates' changed blocks.
    const { cols, rows: rr } = fgQuadratCounts(frameGeometry(getFrame(c, getSurvey(c, surveyId)!.frame_id)!));
    const recBlock = new Map(core.allBlocks(cols, rr, k).map((b) => [blockRec(keys, ident, b), b]));
    const merged = new Set<string>();
    const incoming = items.filter((it) => {
      const block = it.rec ? recBlock.get(it.rec) : undefined;
      return block && it.dev !== dev && !otherTemplate.has(it.dev) && seenEtag(teamId, it.rec!, it.dev) !== it.etag;
    });
    if (otherTemplate.size) out.templateDiffers = [...otherTemplate.values()];
    for (const [i, it] of incoming.entries()) {
      const block = recBlock.get(it.rec!)!;
      useSyncProgress.getState().update({ blockStage: 'down', blockIndex: i + 1, blockCount: incoming.length });
      const doc = readCensusDoc(await downloadText(team, keys, it.rec!, it.dev));
      if (!doc || doc.record_type !== 'census_block' || doc.ident !== ident || doc.block !== block || doc.block_quadrats !== k) {
        markSeen(teamId, it.rec!, it.dev, it.etag);
        continue;
      }
      const from = doc.sync?.author ?? null;
      rememberMember(teamId, it.dev, from, it.uploaded);
      const res = mergeBlockQuietly(surveyId, doc, team.member_name);
      if (res.kind === 'review') {
        useCensusMerge.getState().set({
          teamId,
          surveyId,
          censusUuid,
          rec: it.rec!,
          label: `${label} · ${blockLabel(surveyId, block)}`,
          doc,
          from,
          fromAt: it.uploaded || null,
          afterApply: () => {
            markSeen(teamId, it.rec!, it.dev, it.etag);
            // Files after the reviewed rows are in; failures wait in media_pending.
            void receiveCensusMedia(teamId, surveyId, censusUuid, doc.sync?.media).catch(() => {});
          },
        });
        router.push('/survey/merge' as Href);
        out.review = true;
        break;
      }
      // Their files, after their rows (a photo needs its tree here).
      await receiveCensusMedia(teamId, surveyId, censusUuid, doc.sync?.media);
      markSeen(teamId, it.rec!, it.dev, it.etag);
      link(teamId, 'survey_block', blockLinkUuid(censusUuid, block), it.rec!, Date.now());
      if (res.kind === 'merged') {
        merged.add(block);
        out.merged += 1;
        // One by one: a large census's first exchange has hundreds of thousands (code review M7).
        for (const ch of res.changes) out.changes.push(ch);
        if (from) out.mergedFrom.push(from);
      }
    }

    // 6. Merged blocks this phone also works on: their copy predates the merge (as for records).
    const again = [...merged].filter((block) => blockLink(teamId, censusUuid, block)?.uploaded_at != null);
    if (again.length) censusBase = getSyncBase('survey', censusUuid);
    for (const [i, block] of again.entries()) {
      useSyncProgress.getState().update({ blockStage: 'up', blockIndex: i + 1, blockCount: again.length });
      await putBlock(block, true);
    }
    if (out.merged > 0) logSync(teamId, 'merge', logRec, { server, detail: [...new Set(out.mergedFrom)].join('、') || String(out.merged) });
    const now = Date.now();
    link(teamId, 'survey', censusUuid, hRec, now);
    getUserDb().executeSync(`UPDATE sync_teams SET last_sync_at = ? WHERE team_id = ?`, [now, teamId]);
    getUserDb().executeSync(`DELETE FROM sync_queue WHERE team_id = ? AND record_kind = 'survey' AND record_uuid = ?`, [teamId, censusUuid]);
    return out;
  } catch (e) {
    if (e instanceof core.CensusSyncError) {
      logSync(teamId, 'fail', logRec, { server, detail: e.code });
      throw e;
    }
    const err = asSyncError(e);
    if (err.code === 'offline') {
      getUserDb().executeSync(`INSERT OR REPLACE INTO sync_queue (team_id, record_kind, record_uuid, queued_at) VALUES (?, 'survey', ?, ?)`, [teamId, censusUuid, Date.now()]);
      logSync(teamId, 'queued', logRec, { server });
      return { ...out, queued: true };
    }
    logSync(teamId, 'fail', logRec, { server, detail: err.code });
    throw err;
  }
}

/** A block's name on screen: its first and last quadrat. */
export function blockLabel(surveyId: number, block: string): string {
  const s = getSurvey(ctx(), surveyId);
  const codes = s ? core.censusBlockCodes(ctx(), surveyId, s.sync_block_quadrats, block) : [];
  return codes.length ? (codes.length === 1 ? codes[0] : `${codes[0]}–${codes[codes.length - 1]}`) : block;
}

/** Census quadrats as they are now, by their fw_survey_quadrats row: versions to keep before a merge. */
type QuadratDocs = [number, CensusSlice][];

function quadratDocs(surveyId: number, codes: readonly string[]): QuadratDocs {
  const out: QuadratDocs = [];
  for (const code of new Set(codes)) {
    const id = quadratRowId(surveyId, code);
    const doc = id != null ? quadratSlice(id) : null;
    if (id != null && doc) out.push([id, doc]);
  }
  return out;
}

const blockCodes = (surveyId: number, block: string) => core.censusBlockCodes(ctx(), surveyId, getSurvey(ctx(), surveyId)!.sync_block_quadrats, block);

/**
 * Keep them as before_merge. Taken before the merge writes anything: openBlock
 * folds trees away first, and a version saved after it lacked them, so a merge
 * could not be undone from the versions (code review M10, 2026-10-04). The
 * same content again is not kept twice (planSave).
 */
function keepBeforeMerge(docs: QuadratDocs): void {
  for (const [id, doc] of docs) saveVersion('survey_quadrat', id, 'before_merge', null, { doc });
}

/** The quadrats as they were when a reviewed merge was opened (openCensusMerge folds). */
const beforeOpened = new WeakMap<PendingCensusMerge, QuadratDocs>();

/**
 * Merge a teammate's block when nothing needs a person (only their additions
 * and one-sided changes, no clash); else 'review'. Their folds are carried out
 * either way.
 */
export function mergeBlockQuietly(surveyId: number, doc: CensusBlockUpload, by: string | null): { kind: 'same' } | { kind: 'review' } | { kind: 'merged'; changes: MergeChange[] } {
  const c = ctx();
  const censusUuid = getSurvey(c, surveyId)!.uuid;
  // Undo steps taken before a teammate's trees came in would take them out again (code review H1).
  let changedHere = false;
  // Their folds (openBlock) write first: the quadrats they take are read before.
  const takes = core.quadratsTheirFoldsTake(c, doc.slice);
  let before: QuadratDocs | null = takes.length ? quadratDocs(surveyId, [...blockCodes(surveyId, doc.block), ...takes]) : null;
  const keepBefore = () => keepBeforeMerge((before ??= quadratDocs(surveyId, blockCodes(surveyId, doc.block))));
  const out = withTransaction(() => {
    const opened = core.openBlock(c, surveyId, doc.slice);
    // A stem renamed here (two phones, one number: M9) is a change here too: undo steps name it.
    changedHere = opened.folded > 0 || opened.sameTree.length > 0 || opened.stemsJoined > 0;
    // Before the folds found here (settleCollisions) are written too.
    if (changedHere) keepBefore();
    if (opened.collisions.length) return { kind: 'review' as const };
    const remote = core.settleCollisions(c, surveyId, opened, new Map(), by);
    const localBase = getSyncBase('survey', censusUuid);
    const items = core.blockItems(c, surveyId, doc.block, remote, doc.sync?.base ?? null, localBase);
    if (items.some(needsReview)) return { kind: 'review' as const };
    if (!items.length) {
      patchSyncBase('survey', censusUuid, core.baseChangeAfterMerge(localBase, doc.slice));
      return { kind: 'same' as const };
    }
    const decisions = new Map(items.map((it) => [it.id, defaultDecision(it)]));
    keepBefore();
    const changes = applyAround(surveyId, () => core.applyBlockItems(c, surveyId, items, decisions, remote), items, decisions);
    patchSyncBase('survey', censusUuid, core.baseChangeAfterMerge(localBase, doc.slice));
    return { kind: 'merged' as const, changes };
  });
  if (changedHere || out.kind === 'merged') clearCensusUndo(surveyId);
  return out;
}

/** Apply, then keep the quadrats it wrote as after_merge (before_merge is kept by the caller: keepBeforeMerge). */
function applyAround(surveyId: number, apply: () => string[], items: MergeItem[], decisions: Map<string, Decision>): MergeChange[] {
  const changes = describeMerge(items, decisions);
  const touched = apply();
  const s = getSurvey(ctx(), surveyId)!;
  if (touched.length) {
    for (const r of rows<{ id: number }>(`SELECT id FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code IN (${touched.map(() => '?').join(', ')})`, [s.id, ...touched])) {
      saveVersion('survey_quadrat', r.id, 'after_merge');
    }
  }
  return changes;
}

// ── the review (app/survey/merge.tsx) ───────────────────────────────────────

export type PendingCensusMerge = {
  /** Team sync: the team and the block's name on the relay; absent for a census merged from a file. */
  teamId?: string;
  rec?: string;
  surveyId: number;
  censusUuid: string;
  label: string;
  doc: CensusBlockUpload;
  from: string | null;
  fromAt: number | null;
  afterApply?: () => void;
  /** More censuses of the same file to merge after this one (oldest first). */
  next?: PendingCensusMerge[];
};

export const useCensusMerge = create<{ pending: PendingCensusMerge | null; set: (p: PendingCensusMerge | null) => void }>((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
}));

/** Step 1 on screen: carry out their folds, and list the clashes that need a person. */
export function openCensusMerge(p: PendingCensusMerge): core.Collision[] {
  const takes = core.quadratsTheirFoldsTake(ctx(), p.doc.slice);
  const before = quadratDocs(p.surveyId, [...blockCodes(p.surveyId, p.doc.block), ...takes]);
  beforeOpened.set(p, before);
  // Their folds are written now, before anything is asked: the version first (code review M10).
  if (takes.length) keepBeforeMerge(before);
  const collisions = withTransaction(() => core.openBlock(ctx(), p.surveyId, p.doc.slice).collisions);
  // Their folds are written: undo steps from before them are gone (code review H1).
  clearCensusUndo(p.surveyId);
  return collisions;
}

/** What step 2 settled: the field items, their block in this phone's terms, and whether the decisions changed their copy. */
export type SettledCensusMerge = { items: MergeItem[]; remote: CensusSlice; correctsTheirs: boolean };

/** Step 2: write the clash decisions. */
export function settleCensusMerge(p: PendingCensusMerge, decisions: Map<string, core.CollisionDecision>, by: string | null): SettledCensusMerge {
  const c = ctx();
  return withTransaction(() => {
    const opened = core.openBlock(c, p.surveyId, p.doc.slice);
    // As the block was when the review opened, and our trees a decision takes
    // elsewhere (one tree, a new number for ours): before any of it is written.
    const ours = opened.collisions.filter((col) => {
      const d = decisions.get(col.id);
      return d?.kind === 'same' || (d?.kind === 'renumber' && d.which === 'local');
    });
    const opening = beforeOpened.get(p) ?? quadratDocs(p.surveyId, blockCodes(p.surveyId, p.doc.block));
    const have = new Set(opening.map(([id]) => id));
    keepBeforeMerge([...opening, ...quadratDocs(p.surveyId, ours.map((col) => col.local.quadrat)).filter(([id]) => !have.has(id))]);
    const remote = core.settleCollisions(c, p.surveyId, opened, decisions, by);
    const items = core.blockItems(c, p.surveyId, p.doc.block, remote, p.doc.sync?.base ?? null, getSyncBase('survey', p.censusUuid));
    return { items, remote, correctsTheirs: core.decisionsCorrectTheirs(opened, decisions) };
  });
}

/** Step 3: apply the reviewed items. Returns the rows written. */
export function applyCensusMerge(p: PendingCensusMerge, { remote, items, correctsTheirs }: SettledCensusMerge, decisions: Map<string, Decision>): { changes: MergeChange[] } {
  const c = ctx();
  const changes = withTransaction(() => {
    const localBase = getSyncBase('survey', p.censusUuid);
    const ch = applyAround(p.surveyId, () => core.applyBlockItems(c, p.surveyId, items, decisions, remote), items, decisions);
    patchSyncBase('survey', p.censusUuid, core.baseChangeAfterMerge(localBase, p.doc.slice));
    return ch;
  });
  clearCensusUndo(p.surveyId);
  p.afterApply?.();
  if (p.teamId && p.rec) {
    // A block this phone also works on stays "changed here": the next 同步 sends
    // the merged copy (what the quiet merge does at once). So does one whose
    // copy the decisions changed (a new number for their tree, a fold). A
    // block it only receives is marked synced, so the merge itself is not sent back.
    const contributes = correctsTheirs || blockLink(p.teamId, p.censusUuid, p.doc.block)?.uploaded_at != null;
    link(p.teamId, 'survey_block', blockLinkUuid(p.censusUuid, p.doc.block), p.rec, contributes ? null : Date.now());
  }
  return { changes };
}

// ── pulling a team's records (teamSync.pullTeamRecords) ─────────────────────

/** Relay names of the linked censuses' headers and blocks: not records to import. */
export function linkedCensusRecs(teamId: string, keys: TeamKeys): string[] {
  const out: string[] = [];
  const c = ctx();
  for (const l of rows<{ record_uuid: string }>(`SELECT record_uuid FROM sync_links WHERE team_id = ? AND record_kind = 'survey'`, [teamId])) {
    const s = rows<{ id: number }>(`SELECT id FROM fw_surveys WHERE uuid = ?`, [l.record_uuid])[0];
    if (!s) continue;
    const ident = core.identOfCensus(c, s.id)!;
    out.push(headerRec(keys, ident));
    const sv = getSurvey(c, s.id)!;
    if (sv.sync_block_quadrats == null) continue;
    const { cols, rows: rr } = fgQuadratCounts(frameGeometry(getFrame(c, sv.frame_id)!));
    for (const b of core.allBlocks(cols, rr, sv.sync_block_quadrats)) out.push(blockRec(keys, ident, b));
  }
  return out;
}

/**
 * A teammate's census header met while pulling the team's records: the census
 * is created here (or found) and linked; its blocks come with its first 同步.
 * Returns the relay names of its blocks, so the pull does not fetch them.
 */
export function receiveCensusHeader(
  teamId: string,
  keys: TeamKeys,
  rec: string,
  it: Item,
  doc: core.CensusTeamHeader,
): { result: 'imported' | 'linked' | 'skipped'; censusUuid: string | null; blockRecs: string[] } {
  const c = ctx();
  rememberMember(teamId, it.dev, doc.author, it.uploaded);
  const team = rows<Team>(`SELECT * FROM sync_teams WHERE team_id = ?`, [teamId])[0];
  const server = team ? serverOf(team) : null;
  try {
    const got = withTransaction(() => core.ensureCensus(c, doc));
    const s = getSurvey(c, got.surveyId)!;
    link(teamId, 'survey', s.uuid, rec, null);
    const claims = getClaims(got.surveyId);
    putClaims(got.surveyId, { ...claims, others: { ...claims.others, [it.dev]: { name: doc.author ?? null, blocks: doc.claims, at: it.uploaded } } });
    logSync(teamId, got.created ? 'import' : 'link', { kind: 'survey', uuid: s.uuid, label: censusLabel(got.surveyId) }, { server, detail: doc.author ?? null });
    const { cols, rows: rr } = fgQuadratCounts(frameGeometry(getFrame(c, s.frame_id)!));
    return {
      result: got.created ? 'imported' : 'linked',
      censusUuid: s.uuid,
      blockRecs: core.allBlocks(cols, rr, doc.block_quadrats).map((b) => blockRec(keys, doc.ident, b)),
    };
  } catch (e) {
    const code = e instanceof core.CensusSyncError ? e.code : 'error';
    logSync(teamId, 'fail', { kind: 'survey', uuid: String(doc.survey.uuid ?? ''), label: `${String(doc.frame.code ?? '')} #${String(doc.survey.census_no ?? '')}` }, { server, detail: code });
    return { result: 'skipped', censusUuid: null, blockRecs: [] };
  }
}
