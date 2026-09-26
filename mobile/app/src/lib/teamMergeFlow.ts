/**
 * Team merge, app half: the merge waiting for review, and applying it.
 *
 * recordCreate.ts prepares a merge from an imported file (items + the sender's
 * side) and opens app/merge.tsx; the screen collects decisions and calls
 * `applyPendingMerge`, which
 *   1. saves this device's record to Documents/merge-backups (a normal export
 *      zip without photos, re-importable with 覆蓋) before anything changes;
 *   2. imports the photos / clips of the rows being added;
 *   3. writes the ops in one transaction;
 *   4. stores the sender's rows as the new common ancestor.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import { setSyncBase } from '~/db/syncBase';
import { applyPlotMerge, applySessionMerge } from '~/db/teamMerge';
import { applyGloriaMerge } from '~/modules/gloria/merge';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { importAudioClips } from './audioCapture';
import { bundleGloria, bundlePlot, bundleSession, type BundleOptions } from './bundleExport';
import type { MergeKind } from './mergeDocs';
import { baseOf, planOps, type Decision, type MergeItem, type MergeOp, type MergeSide } from './mergeEngine';
import { importPhotosToLibrary } from './photoCapture';
import type { ImportedPhotoBlob } from './recordImportZip';
import { MERGE_BACKUP_DIR } from './storage';

export type PendingMerge = {
  kind: MergeKind;
  localId: number;
  localUuid: string;
  /** Shown in the header: the record's name. */
  label: string;
  items: MergeItem[];
  remoteSide: MergeSide;
  photos: ImportedPhotoBlob[];
  audio: ImportedPhotoBlob[];
  /** Run after a successful apply (team sync marks the peer's upload as merged). */
  afterApply?: () => void;
  /** Team sync: who sent this copy and when they uploaded it (shown in the review header). */
  from?: string | null;
  fromAt?: number | null;
};

export const usePendingMerge = create<{ pending: PendingMerge | null; set: (p: PendingMerge | null) => void }>((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
}));

const KEEP_BACKUPS = 10;

const BACKUP_OPTS: BundleOptions = {
  geoFormats: [],
  includePhotos: false,
  mergeDuplicateTaxa: false,
  includeDocx: false,
  docFormat: 'docx',
  levels: [],
  conservationFields: [],
  conservationHideLowConcern: false,
  includeDwca: false,
};

/** The record as it is now, as an export zip. Returns the saved file. */
export async function backupBeforeMerge(kind: MergeKind, id: number): Promise<File> {
  const zip =
    kind === 'session'
      ? await bundleSession(id, BACKUP_OPTS)
      : kind === 'plot'
        ? await bundlePlot(id, BACKUP_OPTS)
        : await bundleGloria(id, BACKUP_OPTS);
  const dir = new Directory(Paths.document, MERGE_BACKUP_DIR);
  if (!dir.exists) dir.create();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = new File(dir, `${stamp}_${zip.filename}`);
  new File(zip.uri).copy(dest);
  // Keep the newest few; names start with the timestamp.
  const all = dir
    .list()
    .filter((f): f is File => f instanceof File)
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const old of all.slice(KEEP_BACKUPS)) {
    try {
      old.delete();
    } catch {
      // locked or gone: the next merge tries again
    }
  }
  return dest;
}

/** Only the media of rows actually being added, so a big zip is not re-imported whole. */
function mediaWanted(ops: MergeOp[], field: 'photo_files' | 'audio_files'): Set<string> {
  const names = new Set<string>();
  for (const op of ops) {
    if (op.op !== 'insert') continue;
    const files = op.row.extra?.[field];
    if (Array.isArray(files)) for (const f of files) names.add(String(f));
  }
  return names;
}

export type MergeResult = { ops: number; backup: File | null; skippedPhotos: number };

export async function applyPendingMerge(
  p: PendingMerge,
  decisions: Map<string, Decision>,
  opts: { backup: boolean },
): Promise<MergeResult> {
  const backup = opts.backup ? await backupBeforeMerge(p.kind, p.localId) : null;
  const ops = planOps(p.items, decisions);

  let skippedPhotos = 0;
  let photoUriByName: Map<string, string> | undefined;
  let audioUriByName: Map<string, string> | undefined;
  if (p.kind !== 'gloria') {
    const wantPhotos = mediaWanted(ops, 'photo_files');
    const photos = p.photos.filter((ph) => wantPhotos.has(ph.name));
    if (photos.length) {
      const written = await importPhotosToLibrary(photos);
      photoUriByName = written.uriByName;
      skippedPhotos = written.skipped;
    }
    const wantAudio = mediaWanted(ops, 'audio_files');
    const clips = p.audio.filter((a) => wantAudio.has(a.name));
    if (clips.length) audioUriByName = await importAudioClips(clips);
  }

  if (p.kind === 'session') applySessionMerge(p.localId, ops, { photoUriByName, audioUriByName });
  else if (p.kind === 'plot') applyPlotMerge(p.localId, ops, { photoUriByName, audioUriByName });
  else applyGloriaMerge(p.localId, ops);

  setSyncBase(p.kind, p.localUuid, baseOf(p.remoteSide));
  p.afterApply?.();
  useActiveSession.getState().refresh();
  useActivePlot.getState().refresh();
  useActiveGloria.getState().refresh();
  return { ops: ops.length, backup, skippedPhotos };
}
