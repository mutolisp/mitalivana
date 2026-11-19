/**
 * Web stand-in for mobile/app/src/lib/fileAttach.ts: attached documents
 * (logger data files, form scans) stored in IndexedDB as
 * `webmedia:files/<uuid>.<ext>`, the original name kept for display/export.
 */
import type { FileRef } from '~/modules/gloria/model/loggers';
import { putMedia, readMediaBytes } from './mediaStore';
import { chooseFiles } from './pickFiles';
import { deliver } from './sharing';

export async function pickFiles(): Promise<FileRef[]> {
  const files = await chooseFiles({ multiple: true });
  const out: FileRef[] = [];
  for (const f of files) out.push({ uri: await putMedia('files', f), name: f.name, size: f.size });
  return out;
}

export function photoRef(uri: string, name: string): FileRef {
  return { uri, name, size: null };
}

/** Download / share the stored file under its original name. */
export async function shareAttached(ref: FileRef, _resolve?: (uri: string) => Promise<string | null>): Promise<void> {
  const bytes = await readMediaBytes(ref.uri);
  if (!bytes) throw new Error('file unavailable');
  await deliver(bytes, ref.name);
}
