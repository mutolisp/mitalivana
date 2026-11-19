/**
 * The GLORIA survey zip, assembled from data already loaded: entry names,
 * order, Annex III photo names, loggers/, forms/, manifest and README.
 *
 * Pure (no Expo, no DB, no i18n): the mobile app (bundleExport.ts
 * buildGloriaEntries) and the GLORIA web app (web/gloria) both call it, so the
 * zip a phone writes and the zip a browser writes are the same format.
 * Reading a photo or file is injected (`io.readMedia`); a file that cannot be
 * read is skipped, as on mobile — the manifest's photo_count says how many
 * made it, and 01_ / 04_ still name the missing scans and logger files.
 *
 * Checked by scripts/check-gloria-bundle.mjs.
 */
import { strToU8 } from 'fflate';
import yaml from 'js-yaml';
import { buildManifest, buildRecordReadme, parsePhotoUris, sanitizeFilename, type BuiltZipEntry } from '../../../lib/bundleParts';
import { guessExt } from '../../../lib/photoExt';
import { buildPointHitRows, buildSheetTables, POINT_HITS_HEADER, toCsv, type GloriaExportData } from './sheetRows';
import { planPhotoNames, yyyymmdd } from './photoNames';
import { H04_TEMPERATURE_LOGGERS, loggerRows, planLoggerFiles, type ExportVisit } from './loggerRows';
import { CHECKLIST_HEADER, checklistRows, checklistState } from '../model/photoChecks';
import { parseOverviewPhotos } from '../model/overview';
import { planFormScans } from '../model/formScans';
import { loggerPhotoItem } from '../model/loggers';
import type { Direction, P5mCorner } from '../model/units';
import type { GloriaPoint, PhotoCheckRow } from '../db';

export type GloriaBundleInput = {
  surveyId: number;
  /** loadExportData() */
  data: GloriaExportData;
  /** The round-trip document, with the team-merge `sync` block when there is one. */
  doc: object;
  /** listPoints() */
  points: GloriaPoint[];
  /** Units with their photo lists (gloria_units.photo_paths). */
  units: ReadonlyArray<{ code: string; photo_paths: string | null }>;
  /** listPhotoChecks() */
  checks: PhotoCheckRow[];
  /** gloria_surveys.overview_photos */
  overviewPhotos: string | null;
  /** p5mOf(points) */
  p5m: Partial<Record<Direction, P5mCorner>>;
  /** The species checklist, already rendered (markdown is language-dependent). */
  checklist: { md: string; doc?: { ext: string; bytes: Uint8Array } | null } | null;
  includePhotos: boolean;
};

export type GloriaBundleIO = {
  /** Bytes of a stored photo / file, or null when it cannot be read. */
  readMedia(uri: string): Promise<Uint8Array | null>;
  /** Called before the first read of a photo-library reference (mobile asks for permission). */
  beforeLibraryRead?(): Promise<void>;
  onPhotoProgress?(done: number, total: number): void;
};

/** README addendum when photos are in the zip (manual Annex III naming). */
const PHOTO_NOTE =
  '\n\n## GLORIA 照片檔名\n\n' +
  '- 依 GLORIA Field Manual 5th ed. Annex III：監測週期_國碼_目標區_山峰_項目代碼(8 碼，補 _)_日期_流水號(5 碼)。\n' +
  '- 流水號只在這次調查內唯一。手冊要求在整個目標區內唯一，送交 GLORIA 中央資料庫前請在室內重新編號（例如用 GPDM）。\n' +
  '- 日期取調查開始日，不是各張照片的拍攝時間；照片本身的 EXIF 保留原拍攝時間。\n';

export function gloriaFolderName(data: Pick<GloriaExportData, 'summit' | 'survey'>): string {
  return sanitizeFilename(`GLORIA_${data.summit.full_code}_mocy${data.survey.mocy}`);
}

export async function assembleGloriaEntries(
  input: GloriaBundleInput,
  io: GloriaBundleIO,
): Promise<{ entries: BuiltZipEntry[]; folderName: string; photoCount: number }> {
  const { data } = input;
  const base = gloriaFolderName(data);
  const entries: BuiltZipEntry[] = [];
  entries.push({
    name: `${base}/${base}.yml`,
    bytes: strToU8(yaml.dump(input.doc, { lineWidth: -1, noRefs: true })),
  });
  for (const t of buildSheetTables(data)) {
    if (t.rows.length === 0) continue;
    entries.push({ name: `${base}/${base}_${t.name}.csv`, bytes: strToU8(toCsv(t.header, t.rows)) });
  }
  const pointRows = buildPointHitRows(data);
  if (pointRows.length) {
    entries.push({ name: `${base}/${base}_point_hits.csv`, bytes: strToU8(toCsv(POINT_HITS_HEADER, pointRows)) });
  }
  if (input.checklist) {
    entries.push({ name: `${base}/${base}_checklist.md`, bytes: strToU8(input.checklist.md) });
    const doc = input.checklist.doc;
    if (doc) entries.push({ name: `${base}/${base}_checklist.${doc.ext}`, bytes: doc.bytes });
  }
  // Form 1 photo checklist: what was ticked, what has a photo in the app.
  const overview = parseOverviewPhotos(input.overviewPhotos);
  const checklist = checklistState({ checks: input.checks, points: input.points, overviewCount: overview.length });
  entries.push({
    name: `${base}/${base}_photo_checklist.csv`,
    bytes: strToU8(toCsv(CHECKLIST_HEADER, checklistRows(checklist.items))),
  });

  const isLibrary = (uri: string) => !uri.startsWith('file:');
  let asked = false;
  const ask = async () => {
    if (asked) return;
    asked = true;
    await io.beforeLibraryRead?.();
  };

  // Photos named per manual Annex III, in photos/ like the other exports.
  let photoCount = 0;
  if (input.includePhotos) {
    const plan = planPhotoNames({
      mocy: data.survey.mocy,
      country: data.summit.country,
      region: data.summit.target_region,
      summit: data.summit.summit,
      date: yyyymmdd(data.survey.start_ts),
      p5m: input.p5m,
      points: input.points,
      units: input.units.map((u) => ({ code: u.code, photo_uris: parsePhotoUris(u.photo_paths) })),
      overview,
      checks: input.checks.flatMap((c) => (c.photo_uri ? [{ item: c.item, uri: c.photo_uri }] : [])),
      loggers: (data.visits ?? []).flatMap((v) =>
        v.loggers.flatMap((l) =>
          (['open', 'closed'] as const).flatMap((w) => {
            const uri = w === 'open' ? l.photo_open_uri : l.photo_closed_uri;
            return uri ? [{ uri, item: loggerPhotoItem(l.quadrat, l.label), note: w, date: yyyymmdd(v.visit_ts) }] : [];
          }),
        ),
      ),
      extOf: (uri) => guessExt(uri),
    });
    if (plan.length) await ask();
    for (let i = 0; i < plan.length; i++) {
      io.onPhotoProgress?.(i, plan.length);
      const bytes = await io.readMedia(plan[i].uri);
      if (!bytes) continue;
      entries.push({ name: `${base}/photos/${plan[i].name}`, bytes });
      photoCount += 1;
    }
  }
  // Temperature loggers: data exports and Form 4 scans, always, under loggers/.
  const loggerFiles = planLoggerFiles(data.survey.mocy, data.summit, data.visits ?? []);
  if (loggerFiles.some((f) => isLibrary(f.uri))) await ask();
  for (const f of loggerFiles) {
    const bytes = await io.readMedia(f.uri);
    if (bytes) entries.push({ name: `${base}/loggers/${f.name}`, bytes });
  }
  // Scans of the paper forms 1, 2, 3, 6-S, named by their 01_ identifiers;
  // always, whatever the photos switch: they are the survey's paper record.
  const scans = planFormScans(data.summit.full_code, data.survey, data.units);
  if (scans.some((f) => isLibrary(f.uri))) await ask();
  for (const f of scans) {
    const bytes = await io.readMedia(f.uri);
    if (bytes) entries.push({ name: `${base}/forms/${f.name}`, bytes });
  }
  const manifest = buildManifest({
    kind: 'gloria',
    id: input.surveyId,
    uuid: data.survey.uuid,
    name: `${data.summit.full_code} mocy ${data.survey.mocy}`,
    record_count: data.species.length,
    photo_count: photoCount,
  });
  entries.push({ name: `${base}/manifest.json`, bytes: strToU8(JSON.stringify(manifest, null, 2)) });
  entries.push({
    name: `${base}/README.md`,
    bytes: strToU8(buildRecordReadme(base, entries) + (photoCount ? PHOTO_NOTE : '')),
  });
  return { entries, folderName: base, photoCount };
}

/**
 * The temperature loggers of one summit alone (the summit page): every visit
 * under the cycle its date falls in, for visits between two surveys. 04_
 * table, loggers/ (data files and Form 4 scans, always) and photos/ (position
 * photos, with the photos switch), then the README.
 */
export async function assembleLoggerEntries(
  input: {
    summit: { full_code: string; country: string; target_region: string; summit: string };
    /** Visits with their loggers, keyed by monitoring cycle (cycleOf). */
    byCycle: Map<number, ExportVisit[]>;
    includePhotos: boolean;
  },
  io: Pick<GloriaBundleIO, 'readMedia' | 'beforeLibraryRead'> & { onFileProgress?(done: number, total: number): void },
): Promise<{ entries: BuiltZipEntry[]; folderName: string }> {
  const { summit, byCycle } = input;
  const base = sanitizeFilename(`GLORIA_${summit.full_code}_temperature-loggers`);
  const entries: BuiltZipEntry[] = [];
  const cycles = [...byCycle.entries()].sort((a, b) => a[0] - b[0]);
  const rows = cycles.flatMap(([m, vs]) => loggerRows(m, summit, vs));
  entries.push({ name: `${base}/${base}_04_temperature_loggers.csv`, bytes: strToU8(toCsv(H04_TEMPERATURE_LOGGERS, rows)) });
  const files = [...byCycle.entries()].flatMap(([m, vs]) => planLoggerFiles(m, summit, vs));
  const photos = input.includePhotos
    ? [...byCycle.entries()].flatMap(([m, vs]) =>
        planPhotoNames({
          mocy: m,
          country: summit.country,
          region: summit.target_region,
          summit: summit.summit,
          date: '',
          p5m: {},
          points: [],
          units: [],
          loggers: vs.flatMap((v) =>
            v.loggers.flatMap((l) =>
              (['open', 'closed'] as const).flatMap((w) => {
                const uri = w === 'open' ? l.photo_open_uri : l.photo_closed_uri;
                return uri ? [{ uri, item: loggerPhotoItem(l.quadrat, l.label), note: w, date: yyyymmdd(v.visit_ts) }] : [];
              }),
            ),
          ),
          extOf: (uri) => guessExt(uri),
        }),
      )
    : [];
  if (photos.length || files.some((f) => !f.uri.startsWith('file:'))) await io.beforeLibraryRead?.();
  const todo = [
    ...files.map((f) => ({ uri: f.uri, name: `${base}/loggers/${f.name}` })),
    ...photos.map((p) => ({ uri: p.uri, name: `${base}/photos/${p.name}` })),
  ];
  for (let i = 0; i < todo.length; i++) {
    io.onFileProgress?.(i, todo.length);
    // Gone from the device: the 04_ table still names it.
    const bytes = await io.readMedia(todo[i].uri);
    if (bytes) entries.push({ name: todo[i].name, bytes });
  }
  entries.push({ name: `${base}/README.md`, bytes: strToU8(buildRecordReadme(base, entries)) });
  return { entries, folderName: base };
}
