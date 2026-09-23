/**
 * The photo-metadata round trip.
 *
 * The writer and the reader have to be exact inverses, and the only way to know
 * is to go through a real JPEG: build the EXIF, dump it, insert it, load it
 * back. A fixture is assembled in memory rather than committed, so what is
 * tested is the pair actually in use and not a recording of it.
 *
 * Also pins the parts that differ between the three sources of a coordinate —
 * unsigned DMS, positive decimal, already-signed decimal — because getting the
 * sign wrong moves a plot to the wrong hemisphere and nothing else would catch it.
 *
 * Run: npm run check:photoexif
 */
import piexif from 'piexifjs';
import {
  buildUserComment,
  heifExifSegment,
  latin1ToUtf8,
  metaFromExifDict,
  metaFromPickerExif,
  mergeMeta,
  parseExifDateTime,
  parseUserComment,
  utf8ToLatin1,
} from '../src/lib/photoExif.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};
const near = (label, got, want, tol = 1e-6) => {
  if (!(typeof got === 'number' && Math.abs(got - want) <= tol)) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${got}, expected ≈${want}`);
  }
};

// ── 1. Latin-1 bridge is invertible, including 中文 ────────────────────────
for (const s of ['plain ascii', '小西氏石櫟', 'Machilus · 殼斗科 (Fagaceae)', '']) {
  eq(`latin1 round trip: ${s || '(empty)'}`, latin1ToUtf8(utf8ToLatin1(s)), s);
}

// ── 2. Writer → real JPEG → reader ─────────────────────────────────────────
// The smallest JPEG piexif's segment splitter will walk: SOI, APP0, SOS (it
// stops there and takes the rest verbatim), a byte of entropy data, EOI.
const JPEG =
  '\xff\xd8' +
  '\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00' +
  '\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00' +
  '\x00' +
  '\xff\xd9';
const toDataUrl = (bin) => {
  let b64 = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i) & 0xff;
    const b = i + 1 < bin.length ? bin.charCodeAt(i + 1) & 0xff : 0;
    const c = i + 2 < bin.length ? bin.charCodeAt(i + 2) & 0xff : 0;
    b64 += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)];
    b64 += i + 1 < bin.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    b64 += i + 2 < bin.length ? chars[c & 63] : '=';
  }
  return `data:image/jpeg;base64,${b64}`;
};

const ctx = {
  taxon_id: 't0301',
  simple_name: 'Lithocarpus konishii',
  observed_at: 1789864200000,
  name_author: 'Hayata',
  common_name_c: '小西氏石櫟',
  family: 'Fagaceae',
  family_c: '殼斗科',
  kingdom: 'Plantae',
  notes: '林道旁',
  lat: 23.4567,
  lng: 120.8912,
  accuracy: 5,
  session_id: 42,
  sex: null,
  life_stage: 'adult',
};

const exifObj = {
  '0th': {},
  Exif: {
    [piexif.ExifIFD.UserComment]: buildUserComment(ctx),
    [piexif.ExifIFD.DateTimeOriginal]: '2026:09:20 08:30:00',
  },
  GPS: {
    [piexif.GPSIFD.GPSVersionID]: [2, 3, 0, 0],
    [piexif.GPSIFD.GPSLatitudeRef]: 'N',
    [piexif.GPSIFD.GPSLatitude]: piexif.GPSHelper.degToDmsRational(23.4567),
    [piexif.GPSIFD.GPSLongitudeRef]: 'E',
    [piexif.GPSIFD.GPSLongitude]: piexif.GPSHelper.degToDmsRational(120.8912),
  },
};
const stamped = piexif.insert(piexif.dump(exifObj), toDataUrl(JPEG));
const meta = metaFromExifDict(piexif.load(stamped));

near('GPS latitude survives the file', meta.lat, 23.4567);
near('GPS longitude survives the file', meta.lng, 120.8912);
eq('DateTimeOriginal is parsed, not passed through', meta.takenAt, Date.parse('2026-09-20T08:30:00'));
eq('embedded taxon_id', meta.embedded?.taxon_id, 't0301');
// The one that breaks first if the Latin-1 bridge regresses.
eq('embedded Chinese name', meta.embedded?.cname, '小西氏石櫟');
eq('JSON `name` is read back as simple_name', meta.embedded?.simple_name, 'Lithocarpus konishii');
eq('`coordinate_uncertainty_m` is read back as accuracy', meta.embedded?.accuracy, 5);
eq('embedded session_id', meta.embedded?.session_id, 42);
// Most phones never write GPSHPositioningError. A photo this app exported still
// knows the accuracy, because it wrote it into the JSON next to the fix.
eq('accuracy falls back to the embedded value', meta.accuracyM, 5);
eq('empty values are dropped, not written as null', meta.embedded?.notes, '林道旁');

// ── 3. A UserComment that is not ours ──────────────────────────────────────
eq('foreign UserComment', parseUserComment('ASCII\0\0\0Shot on a phone'), null);
eq('empty', parseUserComment(''), null);
eq('non-string', parseUserComment(undefined), null);
eq('our schema but truncated', parseUserComment('{"schema":"checklister.v1"}'), null);

// ── 4. The three coordinate conventions ────────────────────────────────────
// iOS picker: positive decimal + ref. Android: ALREADY signed + ref.
near('iOS southern latitude', metaFromPickerExif({ GPSLatitude: 23.5, GPSLatitudeRef: 'S', GPSLongitude: 120, GPSLongitudeRef: 'E' }).lat, -23.5);
near('Android southern latitude is not flipped back', metaFromPickerExif({ GPSLatitude: -23.5, GPSLatitudeRef: 'S', GPSLongitude: 120, GPSLongitudeRef: 'E' }).lat, -23.5);
near('western longitude', metaFromPickerExif({ GPSLatitude: 10, GPSLatitudeRef: 'N', GPSLongitude: 120.5, GPSLongitudeRef: 'W' }).lng, -120.5);
// Android also hands back a DMS string when latLong is unavailable.
near('DMS string form', metaFromPickerExif({ GPSLatitude: '24/1,30/1,3600/100', GPSLatitudeRef: 'N', GPSLongitude: '121/1,0/1,0/1', GPSLongitudeRef: 'E' }).lat, 24.51);
// iOS nests GNSS on some paths.
near('nested GPS block', metaFromPickerExif({ GPS: { GPSLatitude: 24.1, GPSLatitudeRef: 'N', GPSLongitude: 121.1, GPSLongitudeRef: 'E' } }).lat, 24.1);

// ── 5. Refusals ────────────────────────────────────────────────────────────
eq('out-of-range latitude is dropped, not clamped', metaFromPickerExif({ GPSLatitude: 200, GPSLatitudeRef: 'N', GPSLongitude: 10, GPSLongitudeRef: 'E' }).lat, null);
eq('a latitude with no longitude is not half a fix', metaFromPickerExif({ GPSLatitude: 24, GPSLatitudeRef: 'N' }).lat, null);
eq('no exif at all', metaFromPickerExif(null), { lat: null, lng: null, accuracyM: null, takenAt: null, embedded: null });
eq('malformed DateTimeOriginal', parseExifDateTime('not a date'), null);
eq('DateTimeOriginal with offset', parseExifDateTime('2026:09:20 08:30:00', '+08:00'), Date.parse('2026-09-20T08:30:00+08:00'));

// ── 6. Merge order ─────────────────────────────────────────────────────────
const bytes = { lat: 1, lng: 1, accuracyM: null, takenAt: 111, embedded: { taxon_id: 'from-bytes' } };
const picker = { lat: 2, lng: 2, accuracyM: 9, takenAt: 222, embedded: { taxon_id: 'from-picker' } };
eq('picker wins for coordinates', mergeMeta(bytes, picker).lat, 2);
eq('picker wins for time', mergeMeta(bytes, picker).takenAt, 222);
eq('bytes win for the embedded record', mergeMeta(bytes, picker).embedded.taxon_id, 'from-bytes');
eq('a picker with no fix falls back to the bytes', mergeMeta(bytes, { lat: null, lng: null, accuracyM: null, takenAt: null, embedded: null }).lat, 1);

// ── 7. The same EXIF inside a HEIF container ───────────────────────────────
// A HEIC copied off the picker keeps its position, but piexif refuses the
// container. Built in memory like the JPEG above: ftyp, meta{iinf, iloc[, idat]},
// and the Exif item's payload (4-byte TIFF offset + "Exif\0\0" + TIFF).
const be = (n, bytes) => {
  let out = '';
  for (let i = bytes - 1; i >= 0; i--) out += String.fromCharCode(Math.floor(n / 256 ** i) % 256);
  return out;
};
const box = (type, body) => be(8 + body.length, 4) + type + body;
const fullBox = (type, version, body) => box(type, String.fromCharCode(version) + '\0\0\0' + body);
const tiff = piexif.dump(exifObj).slice(6); // drop piexif's own "Exif\0\0"
const exifPayload = be(6, 4) + 'Exif\0\0' + tiff;
const infe = (id, t) => fullBox('infe', 2, be(id, 2) + be(0, 2) + t + '\0');
const iinf = fullBox('iinf', 0, be(2, 2) + infe(1, 'hvc1') + infe(2, 'Exif'));
const ftyp = box('ftyp', 'heic' + be(0, 4) + 'mif1heic');
const buildHeif = (construction) => {
  // iloc v1 (has construction_method), offset/length 4 bytes, no base offset.
  const iloc = (off) =>
    fullBox('iloc', 1, '\x44\x00' + be(1, 2) +
      be(2, 2) + be(construction, 2) + be(0, 2) + be(1, 2) + be(off, 4) + be(exifPayload.length, 4));
  if (construction === 1) {
    const meta = fullBox('meta', 0, iinf + iloc(0) + box('idat', exifPayload));
    return ftyp + meta;
  }
  // File offset: the payload lives in mdat right after meta, whose size does
  // not depend on the offset value.
  const metaLen = fullBox('meta', 0, iinf + iloc(0)).length;
  const meta = fullBox('meta', 0, iinf + iloc(ftyp.length + metaLen + 8));
  return ftyp + meta + box('mdat', exifPayload);
};
for (const [label, construction] of [['file offset', 0], ['idat', 1]]) {
  const seg = heifExifSegment(buildHeif(construction));
  const m = seg ? metaFromExifDict(piexif.load(seg)) : null;
  near(`HEIF (${label}) latitude`, m?.lat, 23.4567);
  near(`HEIF (${label}) longitude`, m?.lng, 120.8912);
  eq(`HEIF (${label}) embedded name`, m?.embedded?.cname, '小西氏石櫟');
}
eq('JPEG is not mistaken for HEIF', heifExifSegment(JPEG), null);
eq('HEIF without an Exif item', heifExifSegment(ftyp + fullBox('meta', 0, fullBox('iinf', 0, be(1, 2) + infe(1, 'hvc1')))), null);
eq('truncated HEIF does not throw', heifExifSegment(buildHeif(0).slice(0, 60)), null);

if (failures > 0) {
  console.error(`✗ photo-exif: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ photo-exif: writer/reader are inverse, all three GPS conventions land in the right hemisphere, and HEIF yields its Exif');
