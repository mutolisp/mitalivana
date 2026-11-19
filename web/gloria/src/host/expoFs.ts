/**
 * Minimal stand-in for the slice of `expo-file-system` (new File/Directory API)
 * that reused mobile modules touch: datasets.ts (install list, existence checks)
 * and regionpacks.ts (`Paths.document.uri` for the packs DB location).
 *
 * Files live in an in-memory map; the real bytes behind dataset files are
 * held by datasetsHost.ts / persist.ts. Nothing here touches a real disk.
 */

const ROOT = 'webfs:///Documents/';
const files = new Map<string, Uint8Array | string>();
const dirs = new Set<string>([ROOT]);

function join(base: string | { uri: string }, name?: string): string {
  const b = typeof base === 'string' ? base : base.uri;
  if (name === undefined) return b;
  return `${b.replace(/\/?$/, '/')}${name}`;
}

export class Directory {
  readonly uri: string;
  constructor(base: string | { uri: string }, name?: string) {
    this.uri = join(base, name).replace(/\/?$/, '/');
  }
  get exists(): boolean {
    return dirs.has(this.uri);
  }
  create(_opts?: { intermediates?: boolean }): void {
    dirs.add(this.uri);
  }
}

export class File {
  readonly uri: string;
  constructor(base: string | { uri: string }, name?: string) {
    this.uri = join(base, name).replace(/\/$/, '');
  }
  get exists(): boolean {
    return files.has(this.uri);
  }
  get size(): number {
    const v = files.get(this.uri);
    if (v === undefined) return 0;
    return typeof v === 'string' ? new TextEncoder().encode(v).byteLength : v.byteLength;
  }
  textSync(): string {
    const v = files.get(this.uri);
    if (v === undefined) throw new Error(`no such file: ${this.uri}`);
    return typeof v === 'string' ? v : new TextDecoder().decode(v);
  }
  async text(): Promise<string> {
    return this.textSync();
  }
  bytesSync(): Uint8Array {
    const v = files.get(this.uri);
    if (v === undefined) throw new Error(`no such file: ${this.uri}`);
    return typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }
  write(content: string | Uint8Array): void {
    files.set(this.uri, content);
  }
  delete(): void {
    files.delete(this.uri);
  }
  move(target: File | Directory): void {
    const v = files.get(this.uri);
    if (v === undefined) return;
    files.delete(this.uri);
    files.set(target.uri, v);
  }
  copy(target: File | Directory): void {
    const v = files.get(this.uri);
    if (v !== undefined) files.set(target.uri, v);
  }
}

export const Paths = {
  document: new Directory(ROOT),
  cache: new Directory('webfs:///Caches/'),
};

/** Host-only helpers (not part of expo-file-system). */
export const webFs = {
  ROOT,
  put(uri: string, content: Uint8Array | string): void {
    files.set(uri, content);
    const dir = uri.replace(/[^/]+$/, '');
    dirs.add(dir);
  },
  get(uri: string): Uint8Array | string | undefined {
    return files.get(uri);
  },
  remove(uri: string): void {
    files.delete(uri);
  },
};
