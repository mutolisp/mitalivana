/**
 * Documents attached to records (GLORIA temperature loggers: the loggers'
 * data exports, Form 4 scans). A picked file is copied into
 * Documents/files/{uuid}.{ext} — the document picker's copy lives in the
 * cache, which the storage page may clear — and referenced as
 * { uri, name, size }, the original name kept for display and export.
 *
 * Read paths through rebaseAppFileUri (appFiles.ts): the absolute path
 * changes on iOS reinstall. Removing a reference leaves the file; the
 * storage page's orphan scan (MEDIA_COLUMNS) reclaims it.
 */
import * as DocumentPicker from 'expo-document-picker';
import { copyAsync, documentDirectory, makeDirectoryAsync } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { generateUuid } from '~/db/uuid';
import type { FileRef } from '~/modules/gloria/model/loggers';
import { rebaseAppFileUri } from './appFiles';

const FILES_DIR = documentDirectory ? `${documentDirectory}files/` : null;

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : 'bin';
}

/** Pick one or more files of any type; each is copied into Documents/files/. Empty when cancelled. */
export async function pickFiles(): Promise<FileRef[]> {
  const r = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (r.canceled || !r.assets?.length) return [];
  if (FILES_DIR) {
    try {
      await makeDirectoryAsync(FILES_DIR, { intermediates: true });
    } catch {
      // already there
    }
  }
  const out: FileRef[] = [];
  for (const a of r.assets) {
    const name = a.name || `file.${extOf(a.uri)}`;
    let uri = a.uri;
    if (FILES_DIR) {
      const target = `${FILES_DIR}${generateUuid()}.${extOf(name)}`;
      try {
        await copyAsync({ from: a.uri, to: target });
        uri = target;
      } catch (e) {
        if (__DEV__) console.warn('[fileAttach] copy failed', e);
      }
    }
    out.push({ uri, name, size: typeof a.size === 'number' ? a.size : null });
  }
  return out;
}

/** A photo (camera or library reference) kept as an attachment, e.g. a Form 4 scan. */
export function photoRef(uri: string, name: string): FileRef {
  return { uri, name, size: null };
}

/** Hand the file to the system share sheet (open in another app, save, send). */
export async function shareAttached(ref: FileRef, resolve?: (uri: string) => Promise<string | null>): Promise<void> {
  const local = ref.uri.startsWith('file:') ? rebaseAppFileUri(ref.uri) : ((await resolve?.(ref.uri)) ?? null);
  if (!local) throw new Error('file unavailable');
  await Sharing.shareAsync(local, { dialogTitle: ref.name });
}
