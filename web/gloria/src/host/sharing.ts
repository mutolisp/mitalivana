/**
 * `expo-sharing` → the Web Share API with files (phones), or a download
 * (desktop, and anywhere sharing files is not supported).
 */
import { readUriBytes } from './expoFs';

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}

export function deliver(bytes: Uint8Array, filename: string, mimeType = 'application/octet-stream'): Promise<void> {
  const file = new File([bytes as BlobPart], filename, { type: mimeType });
  if (navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file], title: filename }).catch((e: unknown) => {
      // The user closing the share sheet is not an error.
      if ((e as { name?: string })?.name !== 'AbortError') throw e;
    });
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Promise.resolve();
}

export async function shareAsync(uri: string, opts: { mimeType?: string; dialogTitle?: string; UTI?: string } = {}): Promise<void> {
  const bytes = await readUriBytes(uri);
  if (!bytes) throw new Error(`nothing to share at ${uri}`);
  const name = opts.dialogTitle || decodeURIComponent(uri.split('/').pop() ?? 'export');
  await deliver(bytes, name, opts.mimeType);
}
