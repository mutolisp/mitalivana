/**
 * `expo-file-system/legacy`: the string-URI functions over the web FS
 * (expoFs.ts) — picked files, IndexedDB media and in-memory files.
 */
import { Paths, readUriBytes, toBase64, fromBase64, webFs } from './expoFs';

export const documentDirectory = Paths.document.uri;
export const cacheDirectory = Paths.cache.uri;
export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;

export async function readAsStringAsync(uri: string, opts: { encoding?: string } = {}): Promise<string> {
  const b = await readUriBytes(uri);
  if (!b) throw new Error(`no such file: ${uri}`);
  return opts.encoding === 'base64' ? toBase64(b) : new TextDecoder().decode(b);
}

export async function writeAsStringAsync(uri: string, data: string, opts: { encoding?: string } = {}): Promise<void> {
  webFs.put(uri, opts.encoding === 'base64' ? fromBase64(data) : data);
}

export async function deleteAsync(uri: string, _opts?: { idempotent?: boolean }): Promise<void> {
  webFs.remove(uri);
}

export async function getInfoAsync(uri: string): Promise<{ exists: boolean; uri: string; size?: number; isDirectory?: boolean }> {
  const b = await readUriBytes(uri);
  return b ? { exists: true, uri, size: b.byteLength, isDirectory: false } : { exists: false, uri };
}

export async function makeDirectoryAsync(_uri: string, _opts?: unknown): Promise<void> {}

export async function copyAsync({ from, to }: { from: string; to: string }): Promise<void> {
  const b = await readUriBytes(from);
  if (!b) throw new Error(`no such file: ${from}`);
  webFs.put(to, b);
}

export async function moveAsync({ from, to }: { from: string; to: string }): Promise<void> {
  await copyAsync({ from, to });
  webFs.remove(from);
}
