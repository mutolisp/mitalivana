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
import { isPreviewId } from '~/db/previewDb';
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
import * as census from '~/survey/db/censusVersions';
import {
  applySurveyOps,
  modularIdByUuid,
  modularIdentity,
  putBackSurveyMedia,
  recoverSurvey,
  sealedOccurrences,
  sealedOwners,
  surveyDoc,
  surveySide,
  withoutSealed,
  type SurveyDoc,
} from '~/survey/db/surveyDocs';

/**
 * What versions are kept for: the merge kinds (a checklist / plot-style survey,
 * 'modular', is one of them: one document, surveyDocCore.ts), plus a census
 * per 20 m quadrat ('survey_quadrat') and a whole census when it is deleted
 * ('survey', recoverable). These strings are stored (record_versions).
 */
export type VersionKind = MergeKind | 'survey_quadrat' | 'survey';

export type RecordVersion = VersionMeta & {
  record_kind: VersionKind;
  record_uuid: string;
  label: string | null;
  note: string | null;
  size: number;
  deleted_at: number | null;
};

type Doc = ImportedSession | ImportedPlot | GloriaDoc | census.CensusSlice | census.CensusHeaderDoc | SurveyDoc;
type Snapshot = { doc: Doc; media: Array<FileItem & { ref: MediaRef }> };

const rows = <T>(sql: string, args: Array<string | number | null> = []) => (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];
const META = 'id, record_kind, record_uuid, label, reason, note, content_hash, size, created_at, updated_at, deleted_at';

// ── the record as it is ────────────────────────────────────────────────────────

function localDoc(kind: VersionKind, id: number): Doc | null {
  switch (kind) {
    case 'session':
      return localSessionDoc(id);
    case 'plot':
      return localPlotDoc(id);
    case 'gloria':
      return localGloriaDoc(id);
    case 'modular':
      return surveyDoc(id);
    case 'survey_quadrat':
      return census.quadratSlice(id);
    case 'survey':
      return census.censusHeader(id);
    default:
      return assertNever(kind, 'version kind');
  }
}

function sideOf(kind: VersionKind, doc: Doc): MergeSide {
  switch (kind) {
    case 'session':
      return sessionSide(doc as ImportedSession);
    case 'plot':
      return plotSide(doc as ImportedPlot);
    case 'gloria':
      return gloriaSide(doc as GloriaDoc);
    case 'modular':
      // One survey's rows: the plot's layout and morphospecies are left out (another survey may use them).
      return surveySide(doc as SurveyDoc, { frame: false });
    case 'survey_quadrat':
      return census.censusSide(doc as census.CensusSlice);
    case 'survey':
      return census.headerSide(doc as census.CensusHeaderDoc);
    default:
      return assertNever(kind, 'version kind');
  }
}

const combinersOf = (kind: VersionKind) => (kind === 'survey_quadrat' || kind === 'survey' ? census.CENSUS_COMBINERS : COMBINERS[kind]);

/** The census kinds and a modular survey keep files as fw_media rows inside their document, not as file references. */
const mediaOf = (kind: VersionKind, id: number) => (kind === 'survey_quadrat' || kind === 'survey' || kind === 'modular' ? [] : listRecordMedia(kind, id));

export function uuidAndLabel(kind: VersionKind, id: number): { uuid: string; label: string } | null {
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
  if (kind === 'modular') return modularIdentity(id);
  if (kind === 'survey_quadrat') return census.quadratIdentity(id);
  if (kind === 'survey') return census.censusIdentity(id);
  return assertNever(kind, 'version kind');
}

export function localRecordId(kind: VersionKind, uuid: string): number | null {
  if (kind === 'session') return getSessionByUuid(uuid)?.id ?? null;
  if (kind === 'plot') return getPlotSurveyByUuid(uuid)?.id ?? null;
  if (kind === 'gloria') return rows<{ id: number }>(`SELECT id FROM gloria_surveys WHERE uuid = ?`, [uuid])[0]?.id ?? null;
  if (kind === 'modular') return modularIdByUuid(uuid);
  if (kind === 'survey_quadrat') return census.quadratIdByUuid(uuid);
  if (kind === 'survey') return census.censusIdByUuid(uuid);
  return assertNever(kind, 'version kind');
}

const encode = (s: Snapshot) => b64u(deflateSync(strToU8(JSON.stringify(s)), { level: 9 }));
const decode = (text: string): Snapshot => JSON.parse(strFromU8(inflateSync(fromB64u(text)))) as Snapshot;

// ── save ──────────────────────────────────────────────────────────────────────

/**
 * Snapshot the record now, if it differs from its latest version (manual ones
 * always). Never throws: a version is a safety net, not a reason to fail the
 * finish, merge or navigation that asked for it. Returns whether one was stored.
 */
export function saveVersion(kind: VersionKind, id: number, reason: VersionReason, note: string | null = null): boolean {
  // A builder preview keeps nothing (previewDb.ts).
  if (isPreviewId(id)) return false;
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
    const text = encode({ doc, media: mediaOf(kind, id) });
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
export function saveVersionByUuid(kind: VersionKind, uuid: string, reason: VersionReason): boolean {
  const id = localRecordId(kind, uuid);
  return id == null ? false : saveVersion(kind, id, reason);
}

/** After the current interaction settles (a screen's leave, a finish): the snapshot must not delay the UI.
 *  The delay also lets a text field that commits on blur write first. */
export function saveVersionSoon(kind: VersionKind, id: number, reason: VersionReason): void {
  setTimeout(() => {
    if (saveVersion(kind, id, reason)) for (const fn of listeners) fn(kind, id);
  }, 350);
}

const listeners = new Set<(kind: VersionKind, id: number) => void>();

/** Told when a deferred snapshot lands — the versions screen opens over the record, before its "leave" one. */
export function onVersionSaved(fn: (kind: VersionKind, id: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── read ──────────────────────────────────────────────────────────────────────

export function listVersions(kind: VersionKind, uuid: string): RecordVersion[] {
  return rows<RecordVersion>(`SELECT ${META} FROM record_versions WHERE record_kind = ? AND record_uuid = ? ORDER BY created_at DESC, id DESC`, [kind, uuid]);
}

function readSnapshot(versionId: number): (Snapshot & { kind: VersionKind }) | null {
  const r = rows<{ doc: string; record_kind: VersionKind }>(`SELECT doc, record_kind FROM record_versions WHERE id = ?`, [versionId])[0];
  if (!r) return null;
  try {
    return { ...decode(r.doc), kind: r.record_kind };
  } catch {
    return null;
  }
}

/** Rows that change going from `from` to `to` (a version id, or 'now' for the record as it is). */
export function diffVersions(kind: VersionKind, recordId: number | null, from: number | 'now', to: number | 'now'): MergeChange[] | null {
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
  let items = diffSides(a, b, baseOf(a), takeVersion(combinersOf(kind)));
  // From the survey as it is: what a restore would do, which leaves sealed blind records alone.
  if (kind === 'modular' && from === 'now' && to !== 'now' && recordId != null) {
    const here = localDoc(kind, recordId) as SurveyDoc | null;
    const there = readSnapshot(to)?.doc as SurveyDoc | undefined;
    if (here && there) items = withoutSealed(items, sealedOccurrences(here, there));
  }
  return describeMerge(items, restoreDecisions(items));
}

// ── restore / recover ──────────────────────────────────────────────────────────

/** Files the snapshot referred to that are still on this device go back where they were (adding only). */
function putBackMedia(kind: VersionKind, id: number, media: Snapshot['media']): void {
  if (kind === 'survey_quadrat' || kind === 'survey' || kind === 'modular') return; // fw_media rows travel inside the document
  for (const m of media ?? []) {
    const here = m.uri.startsWith('file:') ? new File(rebaseAppFileUri(m.uri)).exists : true;
    if (!here) continue;
    addRecordMedia(kind, id, m.ref, m.uri, m.meta, (u) => u === m.uri);
  }
}

/** Make the record equal to a version again. The current state is saved first. Returns the rows changed. */
export function restoreVersion(kind: VersionKind, id: number, versionId: number): number {
  const snap = readSnapshot(versionId);
  const doc = localDoc(kind, id);
  if (!snap || !doc) throw new Error('version or record not found');
  saveVersion(kind, id, 'before_restore');
  let changed: number;
  if (kind === 'survey_quadrat') {
    // A census quadrat restores through its own rules (sliceCore.restoreSlice).
    changed = census.restoreQuadrat(id, snap.doc as census.CensusSlice);
  } else {
    const current = sideOf(kind, doc);
    let items = diffSides(current, sideOf(kind, snap.doc), baseOf(current), takeVersion(combinersOf(kind)));
    // A closed blind phase's records stay as they are (sealed, Modular_survey.md §5.5).
    const sealed = kind === 'modular' ? sealedOccurrences(doc as SurveyDoc, snap.doc as SurveyDoc) : null;
    if (sealed) items = withoutSealed(items, sealed);
    const ops = planOps(items, restoreDecisions(items));
    switch (kind) {
      case 'session':
        applySessionMerge(id, ops, {});
        break;
      case 'plot':
        applyPlotMerge(id, ops, {});
        break;
      case 'gloria':
        applyGloriaMerge(id, ops);
        break;
      case 'modular':
        applySurveyOps(id, ops);
        // Photos the version had whose file is still here come back (adding only).
        putBackSurveyMedia(id, snap.doc as SurveyDoc, sealedOwners(sealed));
        break;
      case 'survey':
        throw new Error('a census header is not restored; a deleted census is recovered');
      default:
        return assertNever(kind, 'version kind');
    }
    changed = ops.length;
  }
  putBackMedia(kind, id, snap.media);
  for (const fn of restoredListeners) fn(kind, id);
  return changed;
}

/**
 * Make a checklist / plot-style survey equal to a document brought in from a
 * file (覆蓋, Phase 2E-a), as a restore does: the current state is saved first
 * (`before_import`), sealed blind records stay, and the document's photos and
 * recordings whose file is here (written by the import) are added. Returns
 * the rows changed.
 */
export function overwriteSurvey(id: number, doc: SurveyDoc): number {
  const here = localDoc('modular', id) as SurveyDoc | null;
  if (!here) throw new Error('survey not found');
  saveVersion('modular', id, 'before_import');
  const current = sideOf('modular', here);
  const sealed = sealedOccurrences(here, doc);
  const items = withoutSealed(diffSides(current, sideOf('modular', doc), baseOf(current), takeVersion(combinersOf('modular'))), sealed);
  const ops = planOps(items, restoreDecisions(items));
  applySurveyOps(id, ops);
  putBackSurveyMedia(id, doc, sealedOwners(sealed));
  for (const fn of restoredListeners) fn('modular', id);
  return ops.length;
}

const restoredListeners = new Set<(kind: VersionKind, id: number) => void>();

/** Told after a restore, for a record screen that stays mounted under the versions screen and keeps its own copies. */
export function onVersionRestored(fn: (kind: VersionKind, id: number) => void): () => void {
  restoredListeners.add(fn);
  return () => restoredListeners.delete(fn);
}

export type DeletedRecord = { kind: VersionKind; uuid: string; label: string | null; deletedAt: number; versions: number; latestId: number };

/** Records whose versions outlive them (deleted within the last 30 days). A
 *  census's quadrats are not listed: they come back with their census. */
export function listDeletedRecords(): DeletedRecord[] {
  return rows<{ record_kind: VersionKind; record_uuid: string; label: string | null; deleted_at: number; n: number; latest: number }>(
    `SELECT record_kind, record_uuid, MAX(label) AS label, MAX(deleted_at) AS deleted_at, COUNT(*) AS n, MAX(id) AS latest
       FROM record_versions WHERE deleted_at IS NOT NULL AND record_kind != 'survey_quadrat' GROUP BY record_kind, record_uuid ORDER BY deleted_at DESC`,
  ).map((r) => ({ kind: r.record_kind, uuid: r.record_uuid, label: r.label, deletedAt: r.deleted_at, versions: r.n, latestId: r.latest }));
}

/**
 * Rebuild a deleted record from its latest version, under its own uuid. It
 * lands finished (imports never take the single-active slot). Returns its id.
 */
export function recoverRecord(kind: VersionKind, uuid: string): number {
  const latestOf = (k: VersionKind, u: string) =>
    rows<{ id: number }>(`SELECT id FROM record_versions WHERE record_kind = ? AND record_uuid = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [k, u])[0];
  const latest = latestOf(kind, uuid);
  const snap = latest ? readSnapshot(latest.id) : null;
  if (!snap) throw new Error('no version to recover from');
  let id: number;
  switch (kind) {
    case 'survey': {
      // The census header names its quadrats; each comes back from its own latest version.
      const header = snap.doc as census.CensusHeaderDoc;
      const slices = header.quadrats
        .map((q) => latestOf('survey_quadrat', q.uuid))
        .map((v) => (v ? readSnapshot(v.id)?.doc : null))
        .filter((d): d is census.CensusSlice => d != null && (d as census.CensusSlice).record_type === 'census_slice');
      id = census.recoverCensusFrom(header, slices);
      getUserDb().executeSync(
        `UPDATE record_versions SET deleted_at = NULL WHERE record_kind = 'survey_quadrat' AND record_uuid IN (${header.quadrats.map(() => '?').join(', ') || "''"})`,
        header.quadrats.map((q) => q.uuid),
      );
      break;
    }
    case 'survey_quadrat':
      throw new Error('a census quadrat comes back with its census');
    case 'session':
      id = importSession(snap.doc as ImportedSession, { newUuid: false }).sessionId;
      break;
    case 'plot':
      id = importPlotSurvey(snap.doc as ImportedPlot, { newUuid: false }).plotId;
      break;
    case 'gloria':
      id = importGloriaDoc(snap.doc as GloriaDoc).surveyId;
      break;
    case 'modular':
      id = recoverSurvey(snap.doc as SurveyDoc);
      break;
    default:
      return assertNever(kind, 'version kind');
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
