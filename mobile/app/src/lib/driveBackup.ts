/**
 * The backup → Drive driver: pack, upload, rotate, remember.
 *
 * This is the only layer that combines the three pieces — `googleAuth.ts` for
 * a token, `backup.ts` for the zip, `drive.ts` for the REST calls — so neither
 * of those has to know about the others. `backup.ts` in particular is
 * untouched: the cloud path uses exactly the same `createBackup()` snapshot
 * that the share sheet does.
 */
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import i18n from '~/i18n';
import { LATEST_SCHEMA_VERSION } from '~/db/migrations';
import { useSettings } from '~/stores/settings';
import { ApiError } from './apiFetch';
import { apiErrorMessage } from './apiErrorMessage';
import { createBackup, restoreBackup } from './backup';
import {
  deleteFile,
  downloadFile,
  ensureFolders,
  listBackups,
  uploadFile,
  type DriveFile,
} from './drive';
import { useDriveState } from './driveState';
import { GoogleLoginRequired, ensureAccessToken } from './googleAuth';
import { BACKUP_KIND, KIND_KEY, isBackupFileName } from './googleDevice';

/**
 * How many backups to keep in Drive. A constant for now; the preferences control
 * arrives with the automatic mode, and inventing a setting nothing can change
 * yet would just be an untested code path.
 */
const KEEP_BACKUPS = 5;

export type DriveProgress =
  | { phase: 'auth' }
  | { phase: 'packing' }
  | { phase: 'uploading'; sent: number; total: number }
  | { phase: 'rotating' };

type DriveBackupStore = {
  progress: DriveProgress | null;
  setProgress: (p: DriveProgress | null) => void;
};

export const useDriveBackup = create<DriveBackupStore>((set) => ({
  progress: null,
  setProgress: (progress) => set({ progress }),
}));

/**
 * Module-level, not store state: the automatic path needs to ask "is one
 * already running?" from outside React, and two concurrent uploads of the same
 * database is exactly the thing to prevent. Same shape as `isPackRunning` in
 * gbifDownload.ts.
 */
let running = false;

export function isDriveBackupRunning(): boolean {
  return running;
}

/**
 * Pack the user database and upload it to the user's Drive.
 *
 * `interactive` decides what happens when there is no usable token: true opens
 * the device-code sheet (the user pressed a button and is watching), false
 * throws `GoogleLoginRequired` for the caller to handle quietly.
 *
 * Returns false when another run was already in flight — the caller must not
 * report success for an upload that never happened.
 */
export async function runDriveBackup(opts: {
  interactive: boolean;
  includePacks: boolean;
}): Promise<boolean> {
  if (running) return false;
  running = true;
  const { setProgress } = useDriveBackup.getState();
  let localFile: string | null = null;
  try {
    setProgress({ phase: 'auth' });
    const token = await ensureAccessToken({ interactive: opts.interactive });

    setProgress({ phase: 'packing' });
    const file = await createBackup({ includePacks: opts.includePacks });
    localFile = file.uri;

    const folders = await ensureFolders(token);

    setProgress({ phase: 'uploading', sent: 0, total: 0 });
    const { id } = await uploadFile(token, {
      fileUri: file.uri,
      filename: file.filename,
      mimeType: file.mimeType,
      parentId: folders.backupsId,
      // A copy of what manifest.json inside the zip already says, so the
      // restore list can rule a backup out BEFORE downloading it. The manifest
      // stays the authority — `restoreBackup()` re-checks it either way.
      appProperties: {
        [KIND_KEY]: BACKUP_KIND,
        schemaVersion: String(LATEST_SCHEMA_VERSION),
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        createdAt: String(Date.now()),
      },
      onProgress: (sent, total) => setProgress({ phase: 'uploading', sent, total }),
    });

    // Only after the upload succeeded. Deleting first would mean a failed
    // upload leaves the user with neither the new backup nor the old one.
    setProgress({ phase: 'rotating' });
    await rotate(token, folders.backupsId);

    await useDriveState.getState().save({
      lastUploadAtMs: Date.now(),
      lastUploadFileId: id,
      lastAccount: useSettings.getState().gdrive_account,
    });
    return true;
  } finally {
    running = false;
    setProgress(null);
    // The zip was only ever a transfer buffer; the share-sheet path keeps its
    // copy because the user may still pick a destination, this one does not.
    if (localFile) {
      try {
        const f = new File(localFile);
        if (f.exists) f.delete();
      } catch (e) {
        if (__DEV__) console.warn('[driveBackup] temp cleanup failed', e);
      }
    }
  }
}

/**
 * Keep the newest `KEEP_BACKUPS`, delete the rest.
 *
 * Only files still carrying the generated name prefix are considered, which
 * doubles as a way for the user to pin one: rename it in Drive and rotation
 * will leave it alone. A delete that fails is logged, not raised — the backup
 * itself already succeeded, and reporting it as a failure would be a lie.
 */
async function rotate(accessToken: string, backupsId: string): Promise<void> {
  try {
    const files = await listBackups(accessToken, backupsId);
    const ours = files.filter((f) => isBackupFileName(f.name));
    for (const f of ours.slice(KEEP_BACKUPS)) {
      await deleteFile(accessToken, f.id);
    }
  } catch (e) {
    if (__DEV__) console.warn('[driveBackup] rotation failed', e);
  }
}

/**
 * Drive-specific failures worth naming, everything else through the shared
 * vocabulary. Kept here rather than in `apiErrorMessage.ts` because only this
 * feature knows that a 403 mentioning `storageQuotaExceeded` means the user's
 * Drive is full — which is actionable, unlike "the service returned 403".
 */
export async function driveErrorMessage(e: unknown): Promise<string> {
  if (e instanceof GoogleLoginRequired) return i18n.t('gdrive.needLink');
  if (e instanceof ApiError) {
    if (e.status === 401) return i18n.t('gdrive.needLink');
    if (e.status === 403 && (e.detail ?? '').includes('storageQuotaExceeded')) {
      return i18n.t('gdrive.quotaFull');
    }
  }
  return apiErrorMessage(e);
}

// ── restore ──────────────────────────────────────────────────────────────────

export type { DriveFile };

/** The backups in the user's Drive, newest first. */
export async function listDriveBackups(opts: { interactive: boolean }): Promise<DriveFile[]> {
  const token = await ensureAccessToken({ interactive: opts.interactive });
  const folders = await ensureFolders(token);
  return listBackups(token, folders.backupsId);
}

/**
 * Whether this build is too old to read that backup.
 *
 * Decided here, not on the screen, so the list can grey a row out BEFORE
 * spending the download — which is the whole reason the schema version is
 * copied into `appProperties`. `restoreBackup()` re-checks the manifest inside
 * the zip regardless, and stays the authority: a backup uploaded by an older
 * build carries no appProperties at all, so this returns false for it and the
 * manifest check is what catches anything wrong.
 */
export function backupTooNew(f: DriveFile): boolean {
  return f.meta.schemaVersion != null && f.meta.schemaVersion > LATEST_SCHEMA_VERSION;
}

/**
 * Download a backup and restore it. DESTRUCTIVE: replaces all current data.
 *
 * On success `restoreBackup()` reloads the app, so control never returns here.
 */
export async function restoreFromDrive(
  file: DriveFile,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  // Immediately before the download: createDownloadResumable freezes the
  // Authorization header when the task is built.
  const token = await ensureAccessToken({ interactive: false });
  const dest = new File(Paths.cache, `drive-restore-${file.id}.zip`);
  await downloadFile(token, file.id, dest.uri, onProgress);
  try {
    await restoreBackup(dest.uri);
  } catch (e) {
    // Rejected (wrong kind, newer schema, corrupt) — don't leave the zip in
    // the cache, the user is not going to get at it there anyway.
    if (dest.exists) dest.delete();
    throw e;
  }
}

/** Progress as a line of text for the screen. */
export function driveProgressLabel(p: DriveProgress): string {
  switch (p.phase) {
    case 'auth':
    case 'packing':
      return i18n.t('gdrive.uploadingPacking');
    case 'uploading': {
      const pct = p.total > 0 ? Math.round((p.sent / p.total) * 100) : 0;
      return i18n.t('gdrive.uploadingProgress', { pct });
    }
    case 'rotating':
      return i18n.t('gdrive.uploadingRotating');
  }
}
