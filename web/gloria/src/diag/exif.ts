/**
 * Minimal JPEG EXIF probe for the diagnostics page: is there an EXIF block,
 * a DateTimeOriginal, a GPS IFD. Reads only IFD0 and the Exif sub-IFD.
 */
export type ExifSummary = { hasExif: boolean; hasGps: boolean; dateTimeOriginal: string | null };

export function readExifSummary(b: Uint8Array): ExifSummary {
  const none: ExifSummary = { hasExif: false, hasGps: false, dateTimeOriginal: null };
  if (b[0] !== 0xff || b[1] !== 0xd8) return none;
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      return parseTiff(b, p + 10);
    }
    if (marker === 0xda) break; // start of scan: no more metadata
    p += 2 + len;
  }
  return none;
}

function parseTiff(b: Uint8Array, t: number): ExifSummary {
  const le = b[t] === 0x49;
  const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const entries = (ifd: number): Array<{ tag: number; type: number; count: number; value: number }> => {
    const out = [];
    const n = u16(t + ifd);
    for (let i = 0; i < n; i++) {
      const e = t + ifd + 2 + i * 12;
      out.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), value: u32(e + 8) });
    }
    return out;
  };
  const ifd0 = entries(u32(t + 4));
  const hasGps = ifd0.some((e) => e.tag === 0x8825);
  let dateTimeOriginal: string | null = null;
  const exifPtr = ifd0.find((e) => e.tag === 0x8769);
  if (exifPtr) {
    const dto = entries(exifPtr.value).find((e) => e.tag === 0x9003);
    if (dto && dto.count >= 19) {
      const start = t + dto.value;
      dateTimeOriginal = String.fromCharCode(...b.subarray(start, start + 19));
    }
  }
  return { hasExif: true, hasGps, dateTimeOriginal };
}
