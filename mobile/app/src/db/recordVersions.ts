/**
 * Record versions on the database side (migration v73; rules in
 * lib/recordVersionsCore.ts).
 *
 * A snapshot is the local document team merge compares (localSessionDoc /
 * localPlotDoc / localGloriaDoc: export builder → yml → parser) plus the
 * record's file references (mediaRefs.listRecordMedia), JSON, deflated,
 * base64. Its content hash is taken over the merge rows, so timestamps alone
 * never make a new version.
 *
 * Comparing and restoring reuse the merge engine: a version is "the other
 * side", the current record (or the older version) the common ancestor.
 * Restoring writes through the same apply*Merge functions a merge uses, but
 * leaves the team's common ancestor (sync_base) and the merge log alone — it
 * is this device's own edit, synced like any other.
 */
import { assertNever } from '~/lib/assertNever';
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { getUserDb } from '~/db/init';
import { applyPlotMerge, applySessionMerge, localPlotDoc, localSessionDoc } from '~/db/teamMerge';
import { importPlotSurvey, getPlotSurvey, getPlotSurveyByUuid, type ImportedPlot } from '~/db/plots';
import { importSession, getSession, getSessionByUuid, type ImportedSession } from '~/db/sessions';
import { applyGloriaMerge, localGloriaDoc } from '~/modules/gloria/merge';
import { getGloriaSurvey, getSummit, importGloriaDoc } from '~/modules/gloria/db';
import type { GloriaDoc } from '~/modules/gloria/export/yaml';
import { COMBINERS, gloriaSide, plotSide, sessionSide, type MergeKind } from '~/lib/mergeDocs';
import { baseOf, describeMerge, diffSides, planOps, type MergeChange, type MergeSide } from '~/lib/mergeEngine';
import { addRecordMedia, listRecordMedia } from '~/lib/mediaRefs';
import type { FileItem, MediaRef } from '~/lib/mediaRefsCore';
import { b64u, fromB64u } from '~/lib/teamCrypto';
import { pickPrune, planSave, restoreDecisions, snapshotHash, takeVersion, type VersionMeta, type VersionReason } from '~/lib/recordVersionsCore';
import { File } from 'expo-file-system';
import { rebaseAppFileUri } from '~/lib/appFiles';

export type RecordVersion = VersionMeta & {
  record_kind: MergeKind;
  record_uuid: string;
  label: string | null;
  note: string | null;
  size: number;
  deleted_at: number | null;
};

type Doc = ImportedSession | ImportedPlot | GloriaDoc;
type Snapshot = { doc: Doc; media: Array<FileItem & { ref: MediaRef }> };

const rows = <T>(sql: string, args: Array<string | number | null> = []) => (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];
const META = 'id, record_kind, record_uuid, label, reason, note, content_hash, size, created_at, updated_at, deleted_at';

// ── the record as it is ────────────────────────────────────────────────────────

function localDoc(kind: MergeKind, id: number): Doc | null {
  if (kind === 'session') return localSessionDoc(id);
  if (kind === 'plot') return localPlotDoc(id);
  if (kind === 'gloria') return localGloriaDoc(id);
  return assertNever(kind, 'merge kind');
}

function sideOf(kind: MergeKind, doc: Doc): MergeSide {
  if (kind === 'session') return sessionSide(doc as ImportedSession);
  if (kind === 'plot') return plotSide(doc as ImportedPlot);
  if (kind === 'gloria') return gloriaSide(doc as GloriaDoc);
  return assertNever(kind, 'merge kind');
}

export function uuidAndLabel(kind: MergeKind, id: number): { uuid: string; label: string } | null {
  if (kind === 'session') {
    const s = getSession(id);
    return s?.uuid ? { uuid: s.uuid, label: s.name ?? '' } : null;
  }
  if (kind === 'plot') {
    const p = getPlotSurvey(id);
    return p ? { uuid: p.uuid, label: p.plotid ?? '' } : null;
  }
  if (kind === 'gloria') {
    const sv = getGloriaSurvey(id);
    const sm = sv ? getSummit(sv.summit_id) : null;
    return sv && sm ? { uuid: sv.uuid, label: `${sm.full_code} mocy ${sv.mocy}` } : null;
  }
  return assertNever(kind, 'merge kind');
}

export function localRecordId(kind: MergeKind, uuid: string): number | null {
  if (kind === 'session') return getSessionByUuid(uuid)?.id ?? null;
  if (kind === 'plot') return getPlotSurveyByUuid(uuid)?.id ?? null;
  if (kind === 'gloria') return rows<{ id: number }>(`SELECT id FROM gloria_surveys WHERE uuid = ?`, [uuid])[0]?.id ?? null;
  return assertNever(kind, 'merge kind');
}

const encode = (s: Snapshot) => b64u(deflateSync(strToU8(JSON.stringify(s)), { level: 9 }));
const decode = (text: string): Snapshot => JSON.parse(strFromU8(inflateSync(fromB64u(text)))) as Snapshot;

// ── save ──────────────────────────────────────────────────────────────────────

/**
 * Snapshot the record now, if it differs from its latest version (manual ones
 * always). Never throws: a version is a safety net, not a reason to fail the
 * finish, merge or navigation that asked for it. Returns whether one was stored.
 */
export function saveVersion(kind: MergeKind, id: number, reason: VersionReason, note: string | null = null): boolean {
  try {
    const who = uuidAndLabel(kind, id);
    const doc = who ? localDoc(kind, id) : null;
    if (!who || !doc) return false;
    const hash = snapshotHash(sideOf(kind, doc));
    const latest = rows<VersionMeta>(
      `SELECT id, reason, content_hash, created_at, updated_at FROM record_versions WHERE record_kind = ? AND record_uuid = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [kind, who.uuid],
    )[0] ?? null;
    const now = Date.now();
    const plan = planSave(latest, hash, reason, now);
    if (plan.kind === 'skip') return false;
    const db = getUserDb();
    if (plan.kind === 'relabel') {
      // Same content, now kept under this reason so a later leave cannot overwrite it.
      db.executeSync(`UPDATE record_versions SET reason = ?, note = COALESCE(?, note) WHERE id = ?`, [reason, note?.trim() || null, plan.id]);
      return true;
    }
    const text = encode({ doc, media: listRecordMedia(kind, id) });
    if (plan.kind === 'update') {
      db.executeSync(`UPDATE record_versions SET content_hash = ?, size = ?, doc = ?, label = ?, updated_at = ? WHERE id = ?`, [hash, text.length, text, who.label, now, plan.id]);
    } else {
      db.executeSync(
        `INSERT INTO record_versions (record_kind, record_uuid, label, reason, note, content_hash, size, doc, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [kind, who.uuid, who.label, reason, note?.trim() || null, hash, text.length, text, now, now],
      );
    }
    const prune = pickPrune(rows(`SELECT id, reason, created_at FROM record_versions WHERE record_kind = ? AND record_uuid = ?`, [kind, who.uuid]));
    for (const pid of prune) db.executeSync(`DELETE FROM record_versions WHERE id = ?`, [pid]);
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[recordVersions] save failed', kind, id, e);
    return false;
  }
}

/** The same, for a record known by uuid (imports that replace it). */
export function saveVersionByUuid(kind: MergeKind, uuid: string, reason: VersionReason): boolean {
  const id = localRecordId(kind, uuid);
  return id == null ? false : saveVersion(kind, id, reason);
}

/** After the current interaction settles (a screen's leave, a finish): the snapshot must not delay the UI.
 *  The delay also lets a text field that commits on blur write first. */
export function saveVersionSoon(kind: MergeKind, id: number, reason: VersionReason): void {
  setTimeout(() => {
    if (saveVersion(kind, id, reason)) for (const fn of listeners) fn(kind, id);
  }, 350);
}

const listeners = new Set<(kind: MergeKind, id: number) => void>();

/** Told when a deferred snapshot lands — the versions screen opens over the record, before its "leave" one. */
export function onVersionSaved(fn: (kind: MergeKind, id: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── read ──────────────────────────────────────────────────────────────────────

export function listVersions(kind: MergeKind, uuid: string): RecordVersion[] {
  return rows<RecordVersion>(`SELECT ${META} FROM record_versions WHERE record_kind = ? AND record_uuid = ? ORDER BY created_at DESC, id DESC`, [kind, uuid]);
}

function readSnapshot(versionId: number): (Snapshot & { kind: MergeKind }) | null {
  const r = rows<{ doc: string; record_kind: MergeKind }>(`SELECT doc, record_kind FROM record_versions WHERE id = ?`, [versionId])[0];
  if (!r) return null;
  try {
    return { ...decode(r.doc), kind: r.record_kind };
  } catch {
    return null;
  }
}

/** Rows that change going from `from` to `to` (a version id, or 'now' for the record as it is). */
export function diffVersions(kind: MergeKind, recordId: number | null, from: number | 'now', to: number | 'now'): MergeChange[] | null {
  const sideAt = (v: number | 'now'): MergeSide | null => {
    if (v === 'now') {
      const d = recordId != null ? localDoc(kind, recordId) : null;
      return d ? sideOf(kind, d) : null;
    }
    const s = readSnapshot(v);
    return s ? sideOf(kind, s.doc) : null;
  };
  const a = sideAt(from);
  const b = sideAt(to);
  if (!a || !b) return null;
  const items = diffSides(a, b, baseOf(a), takeVersion(COMBINERS[kind]));
  return describeMerge(items, restoreDecisions(items));
}

// ── restore / recover ──────────────────────────────────────────────────────────

/** Files the snapshot referred to that are still on this device go back where they were (adding only). */
function putBackMedia(kind: MergeKind, id: number, media: Snapshot['media']): void {
  for (const m of media ?? []) {
    const here = m.uri.startsWith('file:') ? new File(rebaseAppFileUri(m.uri)).exists : true;
    if (!here) continue;
    addRecordMedia(kind, id, m.ref, m.uri, m.meta, (u) => u === m.uri);
  }
}

/** Make the record equal to a version again. The current state is saved first. Returns the rows changed. */
export function restoreVersion(kind: MergeKind, id: number, versionId: number): number {
  const snap = readSnapshot(versionId);
  const doc = localDoc(kind, id);
  if (!snap || !doc) throw new Error('version or record not found');
  saveVersion(kind, id, 'before_restore');
  const current = sideOf(kind, doc);
  const items = diffSides(current, sideOf(kind, snap.doc), baseOf(current), takeVersion(COMBINERS[kind]));
  const ops = planOps(items, restoreDecisions(items));
  if (kind === 'session') applySessionMerge(id, ops, {});
  else if (kind === 'plot') applyPlotMerge(id, ops, {});
  else applyGloriaMerge(id, ops);
  putBackMedia(kind, id, snap.media);
  for (const fn of restoredListeners) fn(kind, id);
  return ops.length;
}

const restoredListeners = new Set<(kind: MergeKind, id: number) => void>();

/** Told after a restore, for a record screen that stays mounted under the versions screen and keeps its own copies. */
export function onVersionRestored(fn: (kind: MergeKind, id: number) => void): () => void {
  restoredListeners.add(fn);
  return () => restoredListeners.delete(fn);
}

export type DeletedRecord = { kind: MergeKind; uuid: string; label: string | null; deletedAt: number; versions: number; latestId: number };

/** Records whose versions outlive them (deleted within the last 30 days). */
export function listDeletedRecords(): DeletedRecord[] {
  return rows<{ record_kind: MergeKind; record_uuid: string; label: string | null; deleted_at: number; n: number; latest: number }>(
    `SELECT record_kind, record_uuid, MAX(label) AS label, MAX(deleted_at) AS deleted_at, COUNT(*) AS n, MAX(id) AS latest
       FROM record_versions WHERE deleted_at IS NOT NULL GROUP BY record_kind, record_uuid ORDER BY deleted_at DESC`,
  ).map((r) => ({ kind: r.record_kind, uuid: r.record_uuid, label: r.label, deletedAt: r.deleted_at, versions: r.n, latestId: r.latest }));
}

/**
 * Rebuild a deleted record from its latest version, under its own uuid. It
 * lands finished (imports never take the single-active slot). Returns its id.
 */
export function recoverRecord(kind: MergeKind, uuid: string): number {
  const latest = rows<{ id: number }>(`SELECT id FROM record_versions WHERE record_kind = ? AND record_uuid = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [kind, uuid])[0];
  const snap = latest ? readSnapshot(latest.id) : null;
  if (!snap) throw new Error('no version to recover from');
  let id: number;
  switch (kind) {
    case 'session':
      id = importSession(snap.doc as ImportedSession, { newUuid: false }).sessionId;
      break;
    case 'plot':
      id = importPlotSurvey(snap.doc as ImportedPlot, { newUuid: false }).plotId;
      break;
    case 'gloria':
      id = importGloriaDoc(snap.doc as GloriaDoc).surveyId;
      break;
    default:
      return assertNever(kind, 'merge kind');
  }
  putBackMedia(kind, id, snap.media);
  getUserDb().executeSync(`UPDATE record_versions SET deleted_at = NULL WHERE record_kind = ? AND record_uuid = ?`, [kind, uuid]);
  return id;
}

// Start-up housekeeping (deleted records, 30-day expiry) is in db/cleanup.ts.

/** Total stored size (storage page). */
export function versionsSize(): { bytes: number; count: number } {
  const r = rows<{ b: number | null; n: number }>(`SELECT SUM(size) AS b, COUNT(*) AS n FROM record_versions`)[0];
  return { bytes: r?.b ?? 0, count: r?.n ?? 0 };
}

/** Storage page's clean-up: every automatic version, keeping the newest per record and all manual ones. */
export function clearOldVersions(): number {
  const db = getUserDb();
  const before = versionsSize().count;
  db.executeSync(
    `DELETE FROM record_versions WHERE reason != 'manual' AND id NOT IN (
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY record_kind, record_uuid ORDER BY created_at DESC, id DESC) AS rn FROM record_versions) WHERE rn = 1)`,
  );
  return before - versionsSize().count;
}
