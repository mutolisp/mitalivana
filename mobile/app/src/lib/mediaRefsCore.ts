/**
 * Files carried by team sync (docs/planned/Media_sync.md phase 2) — the pure
 * part, so check:media-refs runs it in Node.
 *
 * A synced record carries, inside its sealed yml, a manifest `sync.media`: one
 * entry per file it refers to, saying where in the record the file sits
 * (`ref`: table, row key, column), what it is (`sha` of the content, `mid`
 * its name on the relay, `size`, `name`) and, for GLORIA overview photos and
 * attachments, the note that goes with it (`meta`).
 *
 * The receiver only ADDS (phase 2): a list column gains the file when it does
 * not have it yet, a single-file column is filled when empty. Nothing is
 * removed or replaced — deletions and conflicts are phase 3.
 */

/** How a media column stores its files. */
export type ColumnKind = 'list' | 'single' | 'overview' | 'files';

/** Every synced media column, `table.column` → how it is stored. */
export const MEDIA_COLUMN_KINDS: Readonly<Record<string, ColumnKind>> = {
  'checklist_records.photo_paths': 'list',
  'checklist_records.audio_paths': 'list',
  'plot_species_records.photo_paths': 'list',
  'plot_species_records.audio_paths': 'list',
  'plot_surveys.env_photos_json': 'list',
  'plot_quadrats.photo_paths': 'list',
  'gloria_units.photo_paths': 'list',
  'gloria_points.photo_m2': 'single',
  'gloria_points.photo_m2f': 'single',
  'gloria_points.photo_point': 'single',
  'gloria_photo_checks.photo_uri': 'single',
  'gloria_loggers.photo_open_uri': 'single',
  'gloria_loggers.photo_closed_uri': 'single',
  'gloria_surveys.overview_photos': 'overview',
  'gloria_surveys.form1_files': 'files',
  'gloria_surveys.form2_files': 'files',
  'gloria_surveys.form3_files': 'files',
  'gloria_surveys.form6s_files': 'files',
  'gloria_logger_visits.form4_files': 'files',
  'gloria_loggers.data_files': 'files',
  // A tree census photo is a row of its own (v80): the entry's `meta.owner` says whose (censusSync.ts);
  // a checklist / plot-style survey's, `meta.place` (mediaRefs.ts).
  'fw_media.uri': 'single',
  // A permanent plot's morphospecies photo, keyed by taxon + label (surveyDocCore.ts).
  'fw_frame_labels.photo_uri': 'single',
};

/** Where a file sits in a record: table, row key ('' for the record's own row), column. */
export type MediaRef = { t: string; k: string; c: string };
/** A census photo's row, which the receiver creates: its tree, stem (null: the whole tree), component and kind. */
export type MediaOwner = { tree: string; stem: string | null; component: string; kind: string };

/** A checklist / plot-style survey photo's row: its unit (level:code) or occurrence (uuid), or neither (the survey's), component and kind. */
export type MediaPlace = { unit: string | null; occ: string | null; component: string; kind: string };

/** What goes with a file besides the file: an overview photo's viewpoint, an attachment's name, a census photo's owner, a survey photo's place. */
export type MediaMeta = { viewpoint?: string; name?: string; owner?: MediaOwner; place?: MediaPlace };

export type MediaEntry = {
  ref: MediaRef;
  /** SHA-256 of the content (hex) — how the receiver recognises a file it already has. */
  sha: string;
  /** The relay's name for the file (keyed on the team key). */
  mid: string;
  size: number;
  /** A file name with the right extension (the attachment's own, or the photo's). */
  name: string;
  meta?: MediaMeta;
};

export type FileItem = { uri: string; meta?: MediaMeta };

const parseArray = (v: string | null | undefined): unknown[] => {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/** The files a column value holds, in order, with their notes. */
export function itemsIn(kind: ColumnKind, value: string | null | undefined): FileItem[] {
  if (kind === 'single') return value ? [{ uri: value }] : [];
  const arr = parseArray(value);
  if (kind === 'list') return arr.filter((x): x is string => typeof x === 'string').map((uri) => ({ uri }));
  if (kind === 'overview') {
    return arr
      .filter((x): x is { uri: string; viewpoint?: unknown } => !!x && typeof (x as { uri?: unknown }).uri === 'string')
      .map((x) => ({ uri: x.uri, meta: { viewpoint: typeof x.viewpoint === 'string' ? x.viewpoint : '' } }));
  }
  return arr
    .filter((x): x is { uri: string; name?: unknown } => !!x && typeof (x as { uri?: unknown }).uri === 'string')
    .map((x) => ({ uri: x.uri, meta: { name: typeof x.name === 'string' ? x.name : '' } }));
}

/**
 * The column value with `uri` added, or null when nothing changes: the file
 * is already there (`has` recognises it by content), or a single-file column
 * is already filled.
 */
export function withAddition(
  kind: ColumnKind,
  value: string | null | undefined,
  uri: string,
  meta: MediaMeta | undefined,
  has: (uri: string) => boolean,
): string | null {
  const present = itemsIn(kind, value);
  if (present.some((x) => has(x.uri))) return null;
  if (kind === 'single') return present.length ? null : uri;
  if (kind === 'list') return JSON.stringify([...present.map((x) => x.uri), uri]);
  const arr = parseArray(value);
  if (kind === 'overview') return JSON.stringify([...arr, { uri, viewpoint: meta?.viewpoint ?? '' }]);
  return JSON.stringify([...arr, { uri, name: meta?.name || uri.split('/').pop() || 'file', size: null }]);
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** `sync.media` of a received yml; malformed entries are dropped. */
export function readMediaManifest(v: unknown): MediaEntry[] {
  if (!Array.isArray(v)) return [];
  const out: MediaEntry[] = [];
  for (const e of v as Array<Record<string, unknown>>) {
    const ref = e?.ref as Record<string, unknown> | undefined;
    if (!ref || typeof ref.t !== 'string' || typeof ref.k !== 'string' || typeof ref.c !== 'string') continue;
    if (!(`${ref.t}.${ref.c}` in MEDIA_COLUMN_KINDS)) continue;
    if (typeof e.sha !== 'string' || !HEX64.test(e.sha) || typeof e.mid !== 'string' || !HEX32.test(e.mid)) continue;
    const size = Number(e.size);
    if (!Number.isFinite(size) || size < 0) continue;
    const m = e.meta as Record<string, unknown> | undefined;
    const o = m?.owner as Record<string, unknown> | undefined;
    const owner: MediaOwner | null =
      o && typeof o.tree === 'string' && (o.stem == null || typeof o.stem === 'string') && typeof o.component === 'string' && typeof o.kind === 'string'
        ? { tree: o.tree, stem: (o.stem as string | null) ?? null, component: o.component, kind: o.kind }
        : null;
    const pl = m?.place as Record<string, unknown> | undefined;
    const optStr = (v: unknown) => v == null || typeof v === 'string';
    const place: MediaPlace | null =
      pl && optStr(pl.unit) && optStr(pl.occ) && typeof pl.component === 'string' && typeof pl.kind === 'string'
        ? { unit: (pl.unit as string | null) ?? null, occ: (pl.occ as string | null) ?? null, component: pl.component, kind: pl.kind }
        : null;
    const meta: MediaMeta | undefined = m
      ? {
          ...(typeof m.viewpoint === 'string' ? { viewpoint: m.viewpoint } : {}),
          ...(typeof m.name === 'string' ? { name: m.name } : {}),
          ...(owner ? { owner } : {}),
          ...(place ? { place } : {}),
        }
      : undefined;
    out.push({
      ref: { t: ref.t, k: ref.k, c: ref.c },
      sha: e.sha,
      mid: e.mid,
      size,
      name: typeof e.name === 'string' && e.name ? e.name.slice(0, 200) : 'file',
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    });
  }
  return out;
}

/** Where a downloaded file goes: photos/ for images, audio/ for sound, files/ for the rest (the storage page scans all three). */
export function folderFor(name: string): 'photos' | 'audio' | 'files' {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif'].includes(ext)) return 'photos';
  if (['m4a', 'aac', 'mp3', 'wav', 'caf', 'ogg', 'opus', '3gp'].includes(ext)) return 'audio';
  return 'files';
}

export function extOf(name: string): string {
  return /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? 'bin';
}
