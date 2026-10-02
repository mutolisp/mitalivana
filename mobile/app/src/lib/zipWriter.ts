/**
 * A zip writer that lets the UI breathe: each file is deflated in 256 KB
 * pieces, with a progress callback (which may yield to the UI) between them.
 * fflate's `zipSync` freezes the JS thread for the whole archive (44 s for a
 * 20 000-tree census on the emulator, 1E), and its streaming `Zip` writes a
 * different layout (sizes after the data, in data descriptors).
 *
 * The layout is zipSync's, field by field (fflate 0.8 `wzh`/`wzf`): sizes and
 * CRC in the local headers, no data descriptors, version 20, the UTF-8 flag
 * only for non-ASCII names, the same DOS time stamp. Only the deflate stream
 * itself can differ, because it is produced in pieces (`check:zip-writer`).
 *
 * Pure (no Expo, no DB): the check script runs it under Node.
 */
import { Deflate, strToU8 } from 'fflate';

export type ZipInput = { name: string; bytes: Uint8Array; level?: number };
export type ZipProgress = (done: number, total: number) => Promise<void> | void;

const CHUNK = 256 * 1024;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(c: number, d: Uint8Array): number {
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c & 255) ^ d[i]] ^ (c >>> 8);
  return c;
}

function w2(d: Uint8Array, b: number, v: number): void {
  d[b] = v & 255;
  d[b + 1] = (v >>> 8) & 255;
}

function w4(d: Uint8Array, b: number, v: number): void {
  d[b] = v & 255;
  d[b + 1] = (v >>> 8) & 255;
  d[b + 2] = (v >>> 16) & 255;
  d[b + 3] = (v >>> 24) & 255;
}

/** The DOS date and time zipSync writes (local time, two-second steps). */
function dosTime(ms: number): number {
  const dt = new Date(ms);
  const y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119) throw new Error('zip: date out of range');
  return (y << 25) | ((dt.getMonth() + 1) << 21) | (dt.getDate() << 16) | (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
}

type Entry = { name: Uint8Array; utf8: boolean; method: number; crc: number; size: number; data: Uint8Array[]; length: number; offset: number };

async function compress(bytes: Uint8Array, level: number, step: (n: number) => Promise<void>): Promise<{ data: Uint8Array[]; length: number }> {
  const data: Uint8Array[] = [];
  let length = 0;
  const d = new Deflate({ level: level as 1 }, (chunk) => {
    data.push(chunk);
    length += chunk.length;
  });
  if (bytes.length === 0) d.push(bytes, true);
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    d.push(bytes.subarray(i, end), end === bytes.length);
    await step(end - i);
  }
  return { data, length };
}

/**
 * Zip `files` in order. `level` is the default compression (zipSync's
 * option); a file's own `level` wins, and 0 stores it. `onProgress` gets the
 * input bytes done so far, after every piece.
 */
export async function zipInPieces(files: ZipInput[], opts: { level: number; mtime?: number }, onProgress?: ZipProgress): Promise<Uint8Array> {
  const total = files.reduce((a, f) => a + f.bytes.length, 0);
  let done = 0;
  const step = async (n: number) => {
    done += n;
    await onProgress?.(done, total);
  };
  const time = dosTime(opts.mtime ?? Date.now());
  const entries: Entry[] = [];
  let offset = 0;
  for (const f of files) {
    const name = strToU8(f.name);
    if (name.length > 65535) throw new Error('zip: file name too long');
    const level = f.level ?? opts.level;
    let crc = -1;
    for (let i = 0; i < f.bytes.length; i += CHUNK) crc = crc32(crc, f.bytes.subarray(i, Math.min(f.bytes.length, i + CHUNK)));
    const packed = level === 0 ? null : await compress(f.bytes, level, step);
    if (!packed) await step(f.bytes.length);
    const data = packed ? packed.data : [f.bytes];
    const length = packed ? packed.length : f.bytes.length;
    entries.push({ name, utf8: name.length !== f.name.length, method: packed ? 8 : 0, crc: ~crc, size: f.bytes.length, data, length, offset });
    offset += 30 + name.length + length;
  }

  const central = entries.reduce((a, e) => a + 46 + e.name.length, 0);
  const out = new Uint8Array(offset + central + 22);
  const header = (b: number, e: Entry, centralAt: number | null): number => {
    w4(out, b, centralAt == null ? 0x04034b50 : 0x02014b50);
    b += 4;
    if (centralAt != null) {
      out[b++] = 20; // version made by
      out[b++] = 0; // made by: MS-DOS (zipSync's default os)
    }
    out[b] = 20; // version needed
    b += 2;
    out[b++] = 0;
    out[b++] = e.utf8 ? 8 : 0; // bit 11: UTF-8 name
    w2(out, b, e.method);
    b += 2;
    w4(out, b, time);
    b += 4;
    w4(out, b, e.crc);
    w4(out, b + 4, e.length);
    w4(out, b + 8, e.size);
    w2(out, b + 12, e.name.length);
    w2(out, b + 14, 0); // extra
    b += 16;
    if (centralAt != null) {
      // comment length, disk, internal and external attributes stay 0
      w4(out, b + 10, e.offset);
      b += 14;
    }
    out.set(e.name, b);
    return b + e.name.length;
  };
  let c = offset;
  for (const e of entries) {
    let b = header(e.offset, e, null);
    for (const part of e.data) {
      out.set(part, b);
      b += part.length;
    }
    c = header(c, e, e.offset);
  }
  w4(out, c, 0x06054b50);
  w2(out, c + 8, entries.length);
  w2(out, c + 10, entries.length);
  w4(out, c + 12, central);
  w4(out, c + 16, offset);
  return out;
}
