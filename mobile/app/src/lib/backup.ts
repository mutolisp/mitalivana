/**
 * User-data backup / restore + photo archive.
 *
 *  - createBackup(): snapshot user.db (VACUUM INTO → consistent copy regardless
 *    of journal mode) + manifest → zip. TaiCOL bundle DB is read-only / re-
 *    derived from the app asset, so it is NOT backed up. The same reasoning
 *    excludes the offline vector map and landmark data (`vectormap/`, `poi/`):
 *    read-only data
 *    the app can fetch again, and the entries here are listed one by one rather
 *    than swept from a directory, so nothing new can fall in by accident.
 *  - restoreBackup(): replace user.db with the one inside a backup zip, then
 *    reload the app so every store + migration re-runs cleanly.
 *  - createPhotoBackup(): EXPORT-only archive of every photo referenced by
 *    records (session / plot species / plot env) + a CSV mapping. Photos live
 *    in the device photo library, not in user.db — cross-device re-linking is
 *    not attempted, this is for safekeeping / transfer only.
 *
 * Reuses the photo URI→bytes resolver, permission elevation and zip writer from
 * `bundleExport.ts` rather than reimplementing the ph:// / content:// handling.
 */
import { reloadAppAsync } from 'expo';
import i18n from '~/i18n';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { closeDbs, getUserDb, initDb, parseEnvPhotos, searchByTaxonId, type SearchResult } from '~/db';
import type { TaskReporter } from '~/stores/taskProgress';
import { LATEST_SCHEMA_VERSION } from '~/db/migrations';
import { BACKUP_NAME_PREFIX } from './googleDevice';
import { guardFormula } from './csvFormula';
import {
  base64ToBytes,
  ensurePhotosReadAccess,
  finalizeZip,
  guessExt,
  parsePhotoUris,
  resolveAssetUri,
  sanitizeFilename,
  type BuiltZipEntry,
  type ExportFile,
} from './bundleExport';

import { closePacksDb, getPacksDb, listPacks, PACKS_DB_NAME } from '~/db/regionpacks';
import { parseOverviewPhotos } from '~/modules/gloria/model/overview';
import { parseFiles } from '~/modules/gloria/model/loggers';

const USER_DB_NAME = 'user.db';

/** SQLite VACUUM INTO needs a plain filesystem path, not a file:// URI. */
function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * What a backup manifest says it is.
 *
 * The old value is still accepted and always will be: it is written inside
 * every backup zip made before the rename, including ones sitting in Drive, and
 * refusing them would strand exactly the data a backup exists to protect.
 */
const BACKUP_MANIFEST_KIND = 'mitalivana-user-backup';
const ACCEPTED_BACKUP_KINDS = new Set([BACKUP_MANIFEST_KIND, 'checklister-user-backup']);

type BackupManifest = {
  kind: string;
  schemaVersion: number;
  appVersion: string;
  createdAt: number;
  /** Present (true) when the zip also carries regionpacks.db. Older backups
   *  simply lack the field. */
  hasRegionPacks?: boolean;
};

/**
 * Snapshot user.db into a zip ready to share.
 *
 * Region packs are opt-in (`includePacks`): they are re-downloadable GBIF
 * data that can add tens of MB, so the default backup stays lean. `report`
 * puts the steps on the progress panel (a 50 000-tree database takes minutes
 * on a slow phone, 1E).
 */
export async function createBackup(opts?: { includePacks?: boolean; report?: TaskReporter }): Promise<ExportFile> {
  const ts = timestamp();
  await opts?.report?.step('task.snapshot');

  // VACUUM INTO produces a consistent, compacted copy with no -wal/-shm
  // sidecar, sidestepping journal-mode / open-handle concerns.
  const snapshot = new File(Paths.cache, `backup-snapshot-${ts}.db`);
  if (snapshot.exists) snapshot.delete();
  getUserDb().executeSync(`VACUUM INTO ?;`, [uriToPath(snapshot.uri)]);

  // Bytes, not a base64 string: a 58 MB snapshot as base64 is a 156 MB Java
  // string, past Android's app heap limit (1E stress test, 50 000 trees).
  const dbBytes = await snapshot.bytes();
  snapshot.delete();

  let packsBytes: Uint8Array | null = null;
  if (opts?.includePacks) {
    const packsSnapshot = new File(Paths.cache, `backup-packs-${ts}.db`);
    if (packsSnapshot.exists) packsSnapshot.delete();
    getPacksDb().executeSync(`VACUUM INTO ?;`, [uriToPath(packsSnapshot.uri)]);
    packsBytes = await packsSnapshot.bytes();
    packsSnapshot.delete();
  }

  const manifest: BackupManifest = {
    kind: BACKUP_MANIFEST_KIND,
    schemaVersion: LATEST_SCHEMA_VERSION,
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    createdAt: Date.now(),
    hasRegionPacks: packsBytes != null,
  };

  const entries: BuiltZipEntry[] = [
    { name: USER_DB_NAME, bytes: dbBytes },
    { name: 'manifest.json', bytes: strToU8(JSON.stringify(manifest, null, 2)) },
  ];
  if (packsBytes) entries.push({ name: PACKS_DB_NAME, bytes: packsBytes });
  return await finalizeZip(entries, `${BACKUP_NAME_PREFIX}${ts}`, opts?.report?.exportProgress);
}

/** Whether any region pack exists — drives the opt-in switch on the screen. */
export function hasRegionPacks(): boolean {
  try {
    return listPacks().length > 0;
  } catch {
    return false;
  }
}

/**
 * Restore user.db from a backup zip, then reload the app. DESTRUCTIVE: replaces
 * all current user data. Throws (before touching anything) if the zip is not a
 * valid backup or was made by a newer app whose schema this build can't satisfy.
 */
export async function restoreBackup(zipUri: string, report?: TaskReporter): Promise<void> {
  await report?.step('task.unzipping');
  // As bytes for the same reason as createBackup (the zip is in this app's cache: picker copy or Drive download).
  const files = unzipSync(await new File(zipUri).bytes());

  const dbBytes = files[USER_DB_NAME];
  const manifestBytes = files['manifest.json'];
  if (!dbBytes || !manifestBytes) {
    throw new Error(i18n.t('backup.invalidFile'));
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error(i18n.t('backup.corrupt'));
  }
  if (!ACCEPTED_BACKUP_KINDS.has(manifest.kind)) {
    throw new Error(i18n.t('backup.notChecklister'));
  }
  // Must be a real schema number. `undefined > N` and `'abc' > N` are both
  // false, so a missing or garbled field used to slip past the check below and
  // restore an unknown DB. Every backup this app has ever written (since the
  // first backup.ts) carries an integer here, so this rejects only bad files.
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    throw new Error(i18n.t('backup.corrupt'));
  }
  if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      i18n.t('backup.tooNew', { version: manifest.schemaVersion }),
    );
  }

  await report?.step('task.restoring');
  // Packs restore first: replaceUserDb() ends in an app reload, so anything
  // after it never runs. A packs file in the zip replaces the current one;
  // absence leaves the current packs untouched (they are not user data).
  const packsBytes = files[PACKS_DB_NAME];
  if (packsBytes) {
    closePacksDb();
    const dest = new File(Paths.document, PACKS_DB_NAME);
    if (dest.exists) dest.delete();
    for (const sidecar of [`${PACKS_DB_NAME}-wal`, `${PACKS_DB_NAME}-shm`]) {
      const f = new File(Paths.document, sidecar);
      if (f.exists) f.delete();
    }
    dest.create();
    dest.write(packsBytes);
  }

  await replaceUserDb((dest) => {
    dest.create();
    dest.write(dbBytes);
  });
}

/**
 * Swap user.db for something else, then re-open and restart the app.
 *
 * Shared by `restoreBackup` (zip) and `restoreSafetyBackup` (raw snapshot).
 * The op-sqlite handles must be released first, and the -wal/-shm sidecars
 * deleted, or the old journal replays over the file that was just written.
 */
async function replaceUserDb(write: (dest: File) => void): Promise<void> {
  closeDbs();

  const dest = new File(Paths.document, USER_DB_NAME);
  if (dest.exists) dest.delete();
  for (const sidecar of [`${USER_DB_NAME}-wal`, `${USER_DB_NAME}-shm`]) {
    const f = new File(Paths.document, sidecar);
    if (f.exists) f.delete();
  }
  write(dest);

  // Re-open + run migrations (upgrades an older-schema DB) so a botched reload
  // still leaves a usable DB; then restart so every store re-seeds.
  await initDb();
  await reloadAppAsync();
}

/**
 * Restore one of the automatic pre-repair snapshots taken by `cleanup.ts`.
 *
 * Those are raw `VACUUM INTO` copies of user.db, not zips — they are written
 * on the cold-start path, where zipping (base64 of the whole DB through a JS
 * string) would be far too heavy. So there is no manifest to validate; the
 * file was produced by this app moments before a repair, and `initDb()` will
 * migrate it forward if it is somehow older.
 */
export async function restoreSafetyBackup(name: string): Promise<void> {
  const src = new File(Paths.document, name);
  if (!src.exists) throw new Error(i18n.t('backup.invalidFile'));
  await replaceUserDb((dest) => {
    src.copy(dest);
  });
}

/** Delete one automatic snapshot. */
export function deleteSafetyBackup(name: string): void {
  const f = new File(Paths.document, name);
  if (f.exists) f.delete();
}

type PhotoSource = {
  folder: string;
  taxonId: string | null;
  uris: string[];
  /** Attached files keep their own names (scans, logger data), one per uri. */
  names?: string[];
};

/** Collect every photo referenced anywhere in user.db, grouped by owner. */
function collectPhotoSources(): PhotoSource[] {
  const db = getUserDb();
  const out: PhotoSource[] = [];

  const sess = db.executeSync(
    `SELECT cr.taxon_id AS taxon_id, cr.photo_paths AS photo_paths,
            s.id AS owner_id, s.name AS owner_name
       FROM checklist_records cr JOIN sessions s ON cr.session_id = s.id
      WHERE cr.photo_paths IS NOT NULL AND cr.photo_paths != ''`,
  );
  for (const r of (sess.rows ?? []) as Array<Record<string, unknown>>) {
    const uris = parsePhotoUris(r.photo_paths as string);
    if (uris.length) {
      out.push({
        folder: `session_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}`,
        taxonId: (r.taxon_id as string) ?? null,
        uris,
      });
    }
  }

  const plot = db.executeSync(
    `SELECT psr.taxon_id AS taxon_id, psr.photo_paths AS photo_paths,
            p.id AS owner_id, p.plotid AS owner_name
       FROM plot_species_records psr JOIN plot_surveys p ON psr.plot_survey_id = p.id
      WHERE psr.photo_paths IS NOT NULL AND psr.photo_paths != ''`,
  );
  for (const r of (plot.rows ?? []) as Array<Record<string, unknown>>) {
    const uris = parsePhotoUris(r.photo_paths as string);
    if (uris.length) {
      out.push({
        folder: `plot_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}`,
        taxonId: (r.taxon_id as string) ?? null,
        uris,
      });
    }
  }

  const specimens = db.executeSync(
    `SELECT cs.taxon_id AS taxon_id, cs.photo_paths AS photo_paths,
            c.id AS owner_id, c.name AS owner_name
       FROM collection_specimens cs JOIN collection_trips c ON cs.trip_id = c.id
      WHERE cs.photo_paths IS NOT NULL AND cs.photo_paths != ''`,
  );
  for (const r of (specimens.rows ?? []) as Array<Record<string, unknown>>) {
    const uris = parsePhotoUris(r.photo_paths as string);
    if (uris.length) {
      out.push({
        folder: `collection_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}`,
        taxonId: (r.taxon_id as string) ?? null,
        uris,
      });
    }
  }

  const env = db.executeSync(
    `SELECT p.id AS owner_id, p.plotid AS owner_name, p.env_photos_json AS env_photos_json
       FROM plot_surveys p WHERE p.env_photos_json IS NOT NULL AND p.env_photos_json != ''`,
  );
  for (const r of (env.rows ?? []) as Array<Record<string, unknown>>) {
    const uris = parseEnvPhotos(r.env_photos_json as string);
    if (uris.length) {
      out.push({
        folder: `plot_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}/env`,
        taxonId: null,
        uris,
      });
    }
  }

  // GLORIA: measurement-point photos (one URI per column), unit photos,
  // summit overview photos (JSON [{ uri, viewpoint }] on the survey) and the
  // photo checklist's own photos (clusters, quarters, HSP).
  const gloria = db.executeSync(
    `SELECT v.id AS owner_id, s.full_code || '_mocy' || v.mocy AS owner_name,
            p.photo_m2 AS a, p.photo_m2f AS b, p.photo_point AS c, NULL AS paths, NULL AS ov
       FROM gloria_points p JOIN gloria_surveys v ON v.id = p.survey_id JOIN gloria_summits s ON s.id = v.summit_id
      WHERE p.photo_m2 IS NOT NULL OR p.photo_m2f IS NOT NULL OR p.photo_point IS NOT NULL
     UNION ALL
     SELECT v.id, s.full_code || '_mocy' || v.mocy, NULL, NULL, NULL, u.photo_paths, NULL
       FROM gloria_units u JOIN gloria_surveys v ON v.id = u.survey_id JOIN gloria_summits s ON s.id = v.summit_id
      WHERE u.photo_paths IS NOT NULL AND u.photo_paths != ''
     UNION ALL
     SELECT v.id, s.full_code || '_mocy' || v.mocy, NULL, NULL, NULL, NULL, v.overview_photos
       FROM gloria_surveys v JOIN gloria_summits s ON s.id = v.summit_id
      WHERE v.overview_photos IS NOT NULL AND v.overview_photos != ''
     UNION ALL
     SELECT v.id, s.full_code || '_mocy' || v.mocy, c.photo_uri, NULL, NULL, NULL, NULL
       FROM gloria_photo_checks c JOIN gloria_surveys v ON v.id = c.survey_id JOIN gloria_summits s ON s.id = v.summit_id
      WHERE c.photo_uri IS NOT NULL AND c.photo_uri != ''`,
  );
  for (const r of (gloria.rows ?? []) as Array<Record<string, unknown>>) {
    const uris = [r.a, r.b, r.c].filter((x): x is string => typeof x === 'string' && x !== '');
    if (typeof r.paths === 'string') uris.push(...parsePhotoUris(r.paths));
    if (typeof r.ov === 'string') uris.push(...parseOverviewPhotos(r.ov).map((p) => p.uri));
    if (uris.length) {
      out.push({
        folder: `gloria_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}`,
        taxonId: null,
        uris,
      });
    }
  }

  // Attached files (GLORIA form scans v69, temperature-logger visits and
  // loggers v65): documents rather than photos, kept under their own names
  // so a scan is recognisable in the backup. Loggers belong to the summit.
  const files = db.executeSync(
    `SELECT 'gloria_' || v.id || '_' || s.full_code || '_mocy' || v.mocy AS folder,
            v.form1_files AS f1, v.form2_files AS f2, v.form3_files AS f3, v.form6s_files AS f6
       FROM gloria_surveys v JOIN gloria_summits s ON s.id = v.summit_id
      WHERE COALESCE(v.form1_files, v.form2_files, v.form3_files, v.form6s_files) IS NOT NULL`,
  );
  for (const r of (files.rows ?? []) as Array<Record<string, unknown>>) {
    const refs = (['f1', 'f2', 'f3', 'f6'] as const).flatMap((k, i) =>
      parseFiles(r[k] as string | null).map((f) => ({ uri: f.uri, name: `Form${['1', '2', '3', '6-S'][i]}_${f.name}` })),
    );
    if (refs.length) out.push({ folder: `${sanitizeFilename(String(r.folder))}/files`, taxonId: null, uris: refs.map((f) => f.uri), names: refs.map((f) => f.name) });
  }
  const loggers = db.executeSync(
    `SELECT 'gloria_' || s.full_code || '_loggers' AS folder, lv.visit_ts AS ts, lv.form4_files AS form4,
            NULL AS label, NULL AS open, NULL AS closed, NULL AS data
       FROM gloria_logger_visits lv JOIN gloria_summits s ON s.id = lv.summit_id
      WHERE lv.form4_files IS NOT NULL AND lv.form4_files != ''
     UNION ALL
     SELECT 'gloria_' || s.full_code || '_loggers', lv.visit_ts, NULL, l.quadrat || COALESCE(l.label, ''),
            l.photo_open_uri, l.photo_closed_uri, l.data_files
       FROM gloria_loggers l JOIN gloria_logger_visits lv ON lv.id = l.visit_id JOIN gloria_summits s ON s.id = lv.summit_id
      WHERE l.photo_open_uri IS NOT NULL OR l.photo_closed_uri IS NOT NULL OR (l.data_files IS NOT NULL AND l.data_files != '')`,
  );
  for (const r of (loggers.rows ?? []) as Array<Record<string, unknown>>) {
    const day = new Date(Number(r.ts)).toISOString().slice(0, 10);
    const refs: Array<{ uri: string; name: string }> = [];
    for (const f of parseFiles(r.form4 as string | null)) refs.push({ uri: f.uri, name: `${day}_Form4_${f.name}` });
    const tag = String(r.label ?? '');
    if (typeof r.open === 'string' && r.open) refs.push({ uri: r.open, name: `${day}_${tag}_open.jpg` });
    if (typeof r.closed === 'string' && r.closed) refs.push({ uri: r.closed, name: `${day}_${tag}_closed.jpg` });
    for (const f of parseFiles(r.data as string | null)) refs.push({ uri: f.uri, name: `${day}_${tag}_${f.name}` });
    if (refs.length) out.push({ folder: sanitizeFilename(String(r.folder)), taxonId: null, uris: refs.map((f) => f.uri), names: refs.map((f) => f.name) });
  }

  // Added with v77–v83 and MIREN, and missed here until code review M4 (2026-10-04):
  // a fixed plot's 1×1 m quadrats, the survey framework's photos (occurrences,
  // units, the survey, interactions — one file a row), a permanent plot's
  // morphospecies photos and MIREN plot photos. check:storage keeps this list
  // and MEDIA_COLUMNS together.
  const quadrats = db.executeSync(
    `SELECT p.id AS owner_id, p.plotid AS owner_name, q.label AS label, q.photo_paths AS photo_paths
       FROM plot_quadrats q JOIN plot_surveys p ON p.id = q.plot_survey_id
      WHERE q.photo_paths IS NOT NULL AND q.photo_paths != ''`,
  );
  for (const r of (quadrats.rows ?? []) as Array<Record<string, unknown>>) {
    const uris = parsePhotoUris(r.photo_paths as string);
    if (uris.length) out.push({ folder: `plot_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}/${sanitizeFilename(String(r.label ?? 'quadrat'))}`, taxonId: null, uris });
  }
  const fwMedia = db.executeSync(
    `SELECT m.uri AS uri, s.id AS owner_id, s.name AS owner_name, o.taxon_id AS taxon_id
       FROM fw_media m JOIN fw_surveys s ON s.id = m.survey_id LEFT JOIN fw_occurrences o ON o.id = m.occurrence_id
      WHERE m.kind = 'photo' AND m.uri IS NOT NULL AND m.uri != ''`,
  );
  for (const r of (fwMedia.rows ?? []) as Array<Record<string, unknown>>) {
    out.push({ folder: `survey_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}`, taxonId: (r.taxon_id as string) ?? null, uris: [String(r.uri)] });
  }
  const labels = db.executeSync(
    `SELECT f.id AS owner_id, f.code AS owner_name, l.taxon_id AS taxon_id, l.photo_uri AS uri
       FROM fw_frame_labels l JOIN fw_frames f ON f.id = l.frame_id
      WHERE l.photo_uri IS NOT NULL AND l.photo_uri != ''`,
  );
  for (const r of (labels.rows ?? []) as Array<Record<string, unknown>>) {
    out.push({ folder: `frame_${r.owner_id}_${sanitizeFilename(String(r.owner_name ?? ''))}/labels`, taxonId: (r.taxon_id as string) ?? null, uris: [String(r.uri)] });
  }
  const miren = db.executeSync(
    `SELECT p.survey_id AS owner_id, p.id AS plot_id, p.plot_no AS plot_no, p.visit AS visit, p.photo_paths AS photo_paths
       FROM miren_plots p WHERE p.photo_paths IS NOT NULL AND p.photo_paths != ''`,
  );
  for (const r of (miren.rows ?? []) as Array<Record<string, unknown>>) {
    const uris = parsePhotoUris(r.photo_paths as string);
    if (uris.length) out.push({ folder: `miren_${r.owner_id}/plot_${r.plot_id}_${r.plot_no}_v${r.visit}`, taxonId: null, uris });
  }

  return out;
}

// photos.csv is Excel-bound: formula-like values get a leading apostrophe (code review L17).
const csvEscape = (s: string): string => `"${guardFormula(s).replace(/"/g, '""')}"`;

function uniqueName(entries: BuiltZipEntry[], folder: string, name: string): string {
  const taken = (n: string) => entries.some((e) => e.name === `${folder}/${n}`);
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let k = 2; ; k++) if (!taken(`${stem}-${k}${ext}`)) return `${stem}-${k}${ext}`;
}

/**
 * Export every record photo into a zip + photos.csv mapping. Returns null if
 * there are no photos to back up.
 */
export async function createPhotoBackup(
  onProgress?: (done: number, total: number) => void,
): Promise<ExportFile | null> {
  const sources = collectPhotoSources();
  const total = sources.reduce((n, s) => n + s.uris.length, 0);
  if (total === 0) return null;

  await ensurePhotosReadAccess();

  const nameCache = new Map<string, SearchResult | null>();
  const lookup = (taxonId: string | null): SearchResult | null => {
    if (!taxonId) return null;
    if (!nameCache.has(taxonId)) nameCache.set(taxonId, searchByTaxonId(taxonId));
    return nameCache.get(taxonId) ?? null;
  };

  const entries: BuiltZipEntry[] = [];
  const csv: string[] = ['filename,taxon_id,scientific_name,common_name,source'];
  let done = 0;

  for (const src of sources) {
    const sr = lookup(src.taxonId);
    const label = sanitizeFilename(sr?.cname || sr?.name || src.taxonId || 'env');
    for (let i = 0; i < src.uris.length; i++) {
      const fileUri = await resolveAssetUri(src.uris[i]);
      done += 1;
      onProgress?.(done, total);
      if (!fileUri) continue;
      try {
        const b64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
        const ext = guessExt(fileUri);
        const own = src.names?.[i];
        // Two attachments of one name (Form2_scan.pdf twice) must not overwrite each other.
        const name = own ? `${src.folder}/${uniqueName(entries, src.folder, sanitizeFilename(own))}` : `${src.folder}/${label}_${i + 1}.${ext}`;
        entries.push({ name, bytes: base64ToBytes(b64) });
        csv.push(
          [
            csvEscape(name),
            csvEscape(src.taxonId ?? ''),
            csvEscape(sr?.name ?? ''),
            csvEscape(sr?.cname ?? ''),
            csvEscape(src.folder),
          ].join(','),
        );
      } catch {
        // skip unreadable photo
      }
    }
  }

  if (entries.length === 0) return null;

  // UTF-8 BOM so Excel reads the CJK CSV correctly (matches desktop export).
  entries.push({ name: 'photos.csv', bytes: strToU8(`﻿${csv.join('\n')}`) });
  return await finalizeZip(entries, `mitalivana-photos-${timestamp()}`);
}
