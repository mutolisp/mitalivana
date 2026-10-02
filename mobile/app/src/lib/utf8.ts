/**
 * UTF-8 bytes → string, for files the app reads back (record imports).
 *
 * The app's TextDecoder is a JS polyfill (Hermes has none; the text-encoding
 * package is installed for UTF-16LE), and it took 7 of the 9 s of reading a
 * 20 000-tree census on the emulator (1E). An export is mostly ASCII — keys,
 * numbers, uuids — so runs of ASCII go to `String.fromCharCode` a piece at a
 * time, and only the rest is decoded byte by byte.
 *
 * Invalid UTF-8 gives null instead of replacement characters: the caller then
 * uses TextDecoder, whose replacement rules this does not reproduce. A leading
 * BOM is dropped, as TextDecoder does. `check:utf8` compares the two.
 */
const PIECE = 8192;
/** ASCII runs shorter than this are copied with the rest instead of becoming a string of their own. */
const SHORT_RUN = 64;

const fromUnits = (u: Uint8Array | Uint16Array) => String.fromCharCode.apply(null, u as unknown as number[]);

export function decodeUtf8(bytes: Uint8Array): string | null {
  const len = bytes.length;
  let i = len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const parts: string[] = [];
  const units = new Uint16Array(PIECE);
  let n = 0;
  const flush = () => {
    if (n) parts.push(fromUnits(units.subarray(0, n)));
    n = 0;
  };
  while (i < len) {
    const b = bytes[i];
    if (b < 0x80) {
      const stop = Math.min(len, i + PIECE);
      let j = i + 1;
      while (j < stop && bytes[j] < 0x80) j++;
      if (j - i < SHORT_RUN) {
        if (n + (j - i) > PIECE) flush();
        units.set(bytes.subarray(i, j), n);
        n += j - i;
      } else {
        flush();
        parts.push(fromUnits(bytes.subarray(i, j)));
      }
      i = j;
      continue;
    }
    let cp: number;
    if (b >= 0xc2 && b <= 0xdf) {
      const c1 = bytes[i + 1];
      if (i + 1 >= len || (c1 & 0xc0) !== 0x80) return null;
      cp = ((b & 0x1f) << 6) | (c1 & 0x3f);
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      const c1 = bytes[i + 1];
      const c2 = bytes[i + 2];
      if (i + 2 >= len || (c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) return null;
      // Overlong forms and UTF-16 surrogates are not UTF-8.
      if ((b === 0xe0 && c1 < 0xa0) || (b === 0xed && c1 > 0x9f)) return null;
      cp = ((b & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4) {
      const c1 = bytes[i + 1];
      const c2 = bytes[i + 2];
      const c3 = bytes[i + 3];
      if (i + 3 >= len || (c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) return null;
      if ((b === 0xf0 && c1 < 0x90) || (b === 0xf4 && c1 > 0x8f)) return null;
      cp = ((b & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
      i += 4;
    } else {
      return null;
    }
    if (n + 2 > PIECE) flush();
    if (cp < 0x10000) units[n++] = cp;
    else {
      cp -= 0x10000;
      units[n++] = 0xd800 | (cp >> 10);
      units[n++] = 0xdc00 | (cp & 0x3ff);
    }
  }
  flush();
  return parts.join('');
}
