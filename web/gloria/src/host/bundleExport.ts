/**
 * Web stand-in for mobile/app/src/lib/bundleExport.ts — what the GLORIA
 * screens call: `resolveAssetUri` (photo / file → something readable) and
 * `bundleLoggers` (the summit page's logger zip, assembled by the same pure
 * module as on mobile). A bundle is written into the web FS's cache and
 * returned as an ExportFile, which useExportShare hands to the share sheet
 * (expo-sharing shim → Web Share or download).
 */
import { getSummit } from '~/modules/gloria/db';
import { listLoggers, listVisits, summitCycles } from '~/modules/gloria/loggerDb';
import { cycleOf } from '~/modules/gloria/model/loggers';
import type { ExportVisit } from '~/modules/gloria/export/loggerRows';
import { assembleLoggerEntries } from '~/modules/gloria/export/bundle';
import type { FormulaTally } from '~/lib/csvFormula';
import i18n from './i18n';
import { isWebMediaUri } from './appFiles';
import { readMediaBytes } from './mediaStore';
import { Paths, webFs } from './expoFs';
import { zipEntries } from '../export/zip';

export type ExportProgress = { label: string; done?: number; total?: number; bytes?: boolean };
export type ExportFile = { uri: string; filename: string; mimeType: string; formulaCells?: FormulaTally };
export type BundleOptions = { includePhotos: boolean; onProgress?: (p: ExportProgress) => void };
export type { BuiltZipEntry } from '~/lib/bundleParts';
export { sanitizeFilename } from '~/lib/bundleParts';

/** Web media is read straight from IndexedDB; nothing else is reachable. */
export async function resolveAssetUri(uri: string): Promise<string | null> {
  return isWebMediaUri(uri) ? uri : null;
}

export async function bundleLoggers(summitId: number, opts: BundleOptions): Promise<ExportFile> {
  const summit = getSummit(summitId);
  if (!summit) throw new Error(`GLORIA summit ${summitId} not found`);
  const cycles = summitCycles(summitId);
  const byCycle = new Map<number, ExportVisit[]>();
  for (const v of listVisits(summitId)) {
    const m = cycleOf(v.visit_ts, cycles) ?? 0;
    byCycle.set(m, [...(byCycle.get(m) ?? []), { ...v, loggers: listLoggers(v.id) }]);
  }
  const { entries, folderName } = await assembleLoggerEntries(
    { summit, byCycle, includePhotos: opts.includePhotos },
    {
      readMedia: readMediaBytes,
      onFileProgress: (done, total) => opts.onProgress?.({ label: i18n.t('export.stage.files'), done, total }),
    },
  );
  const filename = `${folderName}.zip`;
  const uri = `${Paths.cache.uri}${filename}`;
  webFs.put(uri, zipEntries(entries));
  return { uri, filename, mimeType: 'application/zip' };
}
