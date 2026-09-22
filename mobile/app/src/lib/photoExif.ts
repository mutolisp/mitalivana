/**
 * Reading and writing the metadata this app puts into, and takes out of, a
 * photo's EXIF.
 *
 * Writer and reader live together on purpose. They were apart — the
 * UserComment JSON was built inline in photoCapture.ts and nothing read it back
 * — and the two halves had already drifted: the JSON says `name` for what the
 * context calls `simple_name`, and `coordinate_uncertainty_m` for `accuracy`.
 * Twenty lines apart, `npm run check:photoexif` can hold them to being inverse.
 *
 * Pure: piexifjs only, no expo, no DB, no i18n. Reading a file is the caller's
 * job (see `readPhotoMeta` in photoCapture.ts).
 *
 * TWO SOURCES, because there is no single one:
 *   - a JPEG's own bytes, parsed by piexif into an IFD dict
 *   - the picker's `asset.exif`, a flat tag-NAME → value map
 * The second exists because piexif cannot read HEIC at all (its format gate
 * accepts JPEG, TIFF or a bare Exif blob and throws otherwise), and HEIC is
 * what an iPhone camera writes. Both normalise to `PhotoMeta` below.
 */
import piexif from 'piexifjs';

/**
 * The JSON this app embeds in EXIF UserComment.
 *
 * `checklister.v1` is still accepted on read and always will be: it is stamped
 * into every photo the app exported before the rename, and those files are out
 * in the world. A schema identifier is a promise about a format, not a brand,
 * so the old one keeps its meaning forever.
 */
export const EMBED_SCHEMA = 'mitalivana.v1';
const ACCEPTED_SCHEMAS = new Set([EMBED_SCHEMA, 'checklister.v1']);

/** Charset header EXIF puts in front of a UserComment payload (8 bytes). */
const ASCII_PREFIX = 'ASCII\0\0\0';

/** What a photo can tell us about the observation it documents. */
export type PhotoMeta = {
  lat: number | null;
  lng: number | null;
  /** GPSHPositioningError in metres — the only uncertainty a photo states
   *  honestly. Usually absent. */
  accuracyM: number | null;
  /** DateTimeOriginal as epoch ms, or null when unreadable. */
  takenAt: number | null;
  /** Our own embedded record, when this photo came out of this app. */
  embedded: EmbeddedContext | null;
};

/** The subset of the embedded JSON a caller can act on. Everything is optional
 *  because `compact()` drops empty values on the way in. */
export type EmbeddedContext = {
  taxon_id: string;
  /** The scientific name. Called `name` in the JSON, `simple_name` everywhere
   *  else — a difference that only existed because nothing read it back. */
  simple_name: string;
  observed_at: number;
  cname?: string;
  family?: string;
  kingdom?: string;
  notes?: string;
  lat?: number;
  lng?: number;
  /** `coordinate_uncertainty_m` in the JSON. */
  accuracy?: number;
  session_id?: number;
  plot_survey_id?: number;
  collection_trip_id?: number;
  record_number?: string;
};

// ── Latin-1 ↔ UTF-8 ────────────────────────────────────────────────────────
// EXIF string tags are bytes. To carry 中文 we encode UTF-8 and reinterpret each
// byte as a Latin-1 codepoint, so piexif writes the bytes through unchanged.

export function utf8ToLatin1(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function latin1ToUtf8(s: string): string {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return new TextDecoder('utf-8').decode(bytes);
}

// ── UserComment ────────────────────────────────────────────────────────────

/** Drop keys with no value so the JSON states only what was recorded. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  ) as Partial<T>;
}

/** Fields the writer takes. A structural subset of PhotoSpeciesContext, so this
 *  module needs nothing from the DB layer. */
export type UserCommentInput = {
  taxon_id: string;
  simple_name: string;
  observed_at: number;
  name_author?: string;
  common_name_c?: string;
  family?: string;
  family_c?: string;
  kingdom?: string;
  notes?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  session_id?: number;
  plot_survey_id?: number;
  collection_trip_id?: number;
  record_number?: string;
  sex?: string | null;
  life_stage?: string | null;
  reproductive_condition?: string | null;
  leaf_phenology?: string | null;
  degree_of_establishment?: string | null;
  detection_type?: string | null;
  organism_quantity?: string | null;
  organism_quantity_type?: string | null;
};

/** The full EXIF UserComment value, charset header included. */
export function buildUserComment(ctx: UserCommentInput): string {
  const json = JSON.stringify({
    schema: EMBED_SCHEMA,
    taxon_id: ctx.taxon_id,
    name: ctx.simple_name,
    observed_at: ctx.observed_at,
    ...compact({
      author: ctx.name_author,
      cname: ctx.common_name_c,
      family: ctx.family,
      family_c: ctx.family_c,
      kingdom: ctx.kingdom,
      notes: ctx.notes,
      lat: ctx.lat,
      lng: ctx.lng,
      coordinate_uncertainty_m: ctx.accuracy,
      session_id: ctx.session_id,
      plot_survey_id: ctx.plot_survey_id,
      collection_trip_id: ctx.collection_trip_id,
      record_number: ctx.record_number,
      // DwC species attributes, English enum values exactly as stored.
      sex: ctx.sex,
      life_stage: ctx.life_stage,
      reproductive_condition: ctx.reproductive_condition,
      leaf_phenology: ctx.leaf_phenology,
      degree_of_establishment: ctx.degree_of_establishment,
      detection_type: ctx.detection_type,
      organism_quantity: ctx.organism_quantity,
      organism_quantity_type: ctx.organism_quantity_type,
    }),
  });
  return `${ASCII_PREFIX}${utf8ToLatin1(json)}`;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

/**
 * Parse a UserComment back, from either source.
 *
 * Accepts the value with or without the charset header: piexif hands back what
 * we wrote, but CoreGraphics and androidx ExifInterface strip the header and
 * decode the rest themselves, and what they decode non-ASCII bytes into is
 * platform-defined. So try the value as-is first, then the Latin-1 repair.
 *
 * Returns null for anything that is not our schema — a UserComment is a free
 * text field and most photos that have one got it from something else.
 */
export function parseUserComment(raw: unknown): EmbeddedContext | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const body = raw.startsWith(ASCII_PREFIX) ? raw.slice(ASCII_PREFIX.length) : raw;
  const attempts = [() => JSON.parse(latin1ToUtf8(body)), () => JSON.parse(body)];
  for (const attempt of attempts) {
    let json: Record<string, unknown>;
    try {
      json = attempt() as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!json || typeof json.schema !== 'string' || !ACCEPTED_SCHEMAS.has(json.schema)) return null;
    const taxonId = str(json.taxon_id);
    const name = str(json.name);
    const observedAt = num(json.observed_at);
    if (!taxonId || !name || observedAt === undefined) return null;
    return {
      taxon_id: taxonId,
      simple_name: name,
      observed_at: observedAt,
      cname: str(json.cname),
      family: str(json.family),
      kingdom: str(json.kingdom),
      notes: str(json.notes),
      lat: num(json.lat),
      lng: num(json.lng),
      accuracy: num(json.coordinate_uncertainty_m),
      session_id: num(json.session_id),
      plot_survey_id: num(json.plot_survey_id),
      collection_trip_id: num(json.collection_trip_id),
      record_number: str(json.record_number),
    };
  }
  return null;
}

// ── GNSS ────────────────────────────────────────────────────────────────────

/**
 * Apply the N/S/E/W reference to a magnitude.
 *
 * The three sources disagree about sign, so this takes the magnitude and lets
 * the ref decide: piexif gives an unsigned DMS triple, iOS's CGImageSource a
 * positive decimal, and androidx ExifInterface a decimal that is ALREADY
 * signed. Taking abs() first makes the Android case idempotent instead of
 * flipping a southern latitude back to the northern hemisphere.
 */
function applyRef(value: number, ref: unknown): number {
  const south = typeof ref === 'string' && /^[SW]/i.test(ref.trim());
  return south ? -Math.abs(value) : Math.abs(value);
}

/** `[[d,1],[m,1],[s,100]]` or `"24/1,30/1,3600/100"` → decimal degrees. */
function dmsToDeg(v: unknown): number | null {
  if (Array.isArray(v)) {
    try {
      const deg = piexif.GPSHelper.dmsRationalToDeg(v as [number, number][], 'N');
      return Number.isFinite(deg) ? deg : null;
    } catch {
      return null;
    }
  }
  if (typeof v === 'string' && v.includes('/')) {
    const parts = v.split(',').map((p) => {
      const [a, b] = p.trim().split('/').map(Number);
      return b ? a / b : a;
    });
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return (parts[0] ?? 0) + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Reject coordinates outside the possible range rather than recording them. */
function validLatLng(lat: number | null, lng: number | null): { lat: number | null; lng: number | null } {
  const okLat = lat !== null && Math.abs(lat) <= 90;
  const okLng = lng !== null && Math.abs(lng) <= 180;
  return okLat && okLng ? { lat, lng } : { lat: null, lng: null };
}

// ── DateTimeOriginal ───────────────────────────────────────────────────────

/**
 * `"2026:09:20 08:30:00"` → epoch ms. EXIF's own format, not ISO.
 *
 * Without an offset the timestamp is local wall-clock with no zone, which is
 * all the camera recorded — parsing it as local time is the only honest
 * reading. `OffsetTimeOriginal` ("+08:00") is used when present.
 */
export function parseExifDateTime(dt: unknown, offset?: unknown): number | null {
  if (typeof dt !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dt.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const off = typeof offset === 'string' ? offset.trim() : '';
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}${/^[+-]\d{2}:\d{2}$/.test(off) ? off : ''}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ── The two sources ────────────────────────────────────────────────────────

type ExifDictLike = {
  '0th'?: Record<number, unknown>;
  Exif?: Record<number, unknown>;
  GPS?: Record<number, unknown>;
};

/** From a JPEG's own IFD dict, as `piexif.load` returns it. */
export function metaFromExifDict(dict: ExifDictLike): PhotoMeta {
  const gps = dict.GPS ?? {};
  const exif = dict.Exif ?? {};
  const G = piexif.GPSIFD;
  const E = piexif.ExifIFD;
  const latRaw = dmsToDeg(gps[G.GPSLatitude]);
  const lngRaw = dmsToDeg(gps[G.GPSLongitude]);
  const { lat, lng } = validLatLng(
    latRaw === null ? null : applyRef(latRaw, gps[G.GPSLatitudeRef]),
    lngRaw === null ? null : applyRef(lngRaw, gps[G.GPSLongitudeRef]),
  );
  const err = gps[G.GPSHPositioningError];
  const embedded = parseUserComment(exif[E.UserComment]);
  return {
    lat,
    lng,
    // GPSHPositioningError first — it is what the camera measured. Most phones
    // never write it, so a photo this app exported falls back to the accuracy
    // it recorded alongside the fix. Both describe the same measurement.
    accuracyM:
      (Array.isArray(err) && err.length === 2 && err[1] ? err[0] / err[1] : null) ??
      embedded?.accuracy ??
      null,
    takenAt: parseExifDateTime(exif[E.DateTimeOriginal], exif[E.OffsetTimeOriginal]),
    embedded,
  };
}

/** From `asset.exif` — a flat tag-NAME → value map. The only source for HEIC. */
export function metaFromPickerExif(exif: Record<string, unknown> | null | undefined): PhotoMeta {
  const e = exif ?? {};
  // iOS nests GPS under `{GPS: {...}}` on some paths and flattens it on others.
  const gps = (typeof e.GPS === 'object' && e.GPS ? (e.GPS as Record<string, unknown>) : e) as Record<
    string,
    unknown
  >;
  const latRaw = dmsToDeg(gps.GPSLatitude ?? gps.Latitude ?? e.GPSLatitude);
  const lngRaw = dmsToDeg(gps.GPSLongitude ?? gps.Longitude ?? e.GPSLongitude);
  const { lat, lng } = validLatLng(
    latRaw === null ? null : applyRef(latRaw, gps.GPSLatitudeRef ?? e.GPSLatitudeRef),
    lngRaw === null ? null : applyRef(lngRaw, gps.GPSLongitudeRef ?? e.GPSLongitudeRef),
  );
  const err = gps.GPSHPositioningError ?? e.GPSHPositioningError;
  const embedded = parseUserComment(e.UserComment);
  return {
    lat,
    lng,
    accuracyM:
      (typeof err === 'number' && Number.isFinite(err) ? err : null) ?? embedded?.accuracy ?? null,
    takenAt: parseExifDateTime(
      e.DateTimeOriginal ?? e.DateTime ?? e.DateTimeDigitized,
      e.OffsetTimeOriginal,
    ),
    embedded,
  };
}

/** Prefer whichever source has the answer, per field.
 *
 *  GNSS and time come from the picker first: it reads the ORIGINAL asset, while
 *  the bytes on disk may be a re-encoded copy. The embedded JSON comes from the
 *  bytes first: we wrote those with `utf8ToLatin1` and can invert it exactly,
 *  whereas the platform decodes the tag by its own rules. */
export function mergeMeta(fromBytes: PhotoMeta | null, fromPicker: PhotoMeta | null): PhotoMeta {
  const b = fromBytes ?? { lat: null, lng: null, accuracyM: null, takenAt: null, embedded: null };
  const p = fromPicker ?? { lat: null, lng: null, accuracyM: null, takenAt: null, embedded: null };
  const coords = p.lat !== null && p.lng !== null ? p : b;
  return {
    lat: coords.lat,
    lng: coords.lng,
    accuracyM: coords.accuracyM ?? b.accuracyM ?? p.accuracyM,
    takenAt: p.takenAt ?? b.takenAt,
    embedded: b.embedded ?? p.embedded,
  };
}
