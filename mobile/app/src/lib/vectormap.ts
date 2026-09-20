/**
 * Paths and state for the offline vector map (Mitalivana Topo).
 *
 * The key property: **the whole map is one file** (the earlier raster tile
 * packs were 25 zips holding 40,000-odd tiles; removed 2026-09-19).
 *
 * MapLibre Native supports the `pmtiles://` protocol natively
 * (`PMTILES_PROTOCOL`, in both iOS 6.26.0 and Android 13.2.0):
 * `PMTilesFileSource` hands tile requests to the ResourceLoader together with a
 * `dataRange` — an `https://` URL behind it becomes an HTTP range request, a
 * `file://` one becomes `util::readFile(path, dataRange)`. So going offline
 * does not mean splitting into 25 zips and unpacking 40,000 files the way the
 * raster edition did: download one .pmtiles, leave it there, done.
 *
 * That is also why MapLibre's `OfflineManager` is not used: it downloads tile
 * by tile, and z0-15 over Taiwan is 370,899 tiles — 370k HTTP requests.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { excludeFromBackup } from '../../modules/backup-exclusion';
import type { PoiMeta } from '~/lib/poi';

const ROOT_DIR = 'vectormap';
const STATE_FILE = 'installed.json';
/** Filename of the locally rewritten style. The remote copy's sources point at
 *  https, this one at file://. */
const LOCAL_STYLE = 'style.json';

export type VectorManifest = {
  version: string;
  styleUrl: string;
  /** Tile file. There may be more than one (if upstream splits for a size limit),
 *  but offline only supports a single file. */
  tilesPmtiles: string[];
  hillshadePmtiles?: string;
  /** Byte count of all assets, style/sprite/glyphs included. */
  bytes: number;
  /** Byte count of the tile file alone — only this makes the progress bar
 *  accurate. */
  tileBytes?: number;
  /** Mountain landmarks. Nothing to do with the map engine, but kept in the same
 *  manifest so the app only has one place to read. */
  poi?: PoiMeta;
  attribution: string;
};

export type VectorInstalled = {
  version: string;
  /** URI of the local style.json, fed straight to MapLibre's mapStyle. */
  styleUri: string;
  bytes: number;
  installedAt: number;
  /**
   * Which remote URL the local sprite was fetched from.
   *
   * Used to decide whether to re-fetch: sprites are uploaded with immutable
   * caching, so a fix ships under a new name (sprite → sprite2), and once the
   * remote style points there this no longer matches. It is only 1 MB — not
   * worth making the user re-download the whole map.
   */
  spriteUrl?: string;
  /** Byte count the tile file should have; how a truncated install is
 *  recognised. */
  tileBytes?: number;
};

export function vectorRoot(): Directory {
  return new Directory(Paths.document, ROOT_DIR);
}

/**
 * Create the root directory and mark it as excluded from backup on iOS.
 *
 * The flag is set **every time**, not only at creation: the native module may
 * arrive with a newer dev client after the map is already installed, so setting
 * it once at creation would permanently miss everyone who installed earlier,
 * leaving 383 MB in their iCloud backup forever.
 */
export function ensureVectorRoot(): Directory {
  const root = vectorRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  excludeFromBackup(root.uri);
  return root;
}

export function vectorTilesFile(): File {
  return new File(vectorRoot(), 'rudy.pmtiles');
}

export function vectorHillshadeFile(): File {
  return new File(vectorRoot(), 'hillshade.pmtiles');
}

export function vectorStyleFile(): File {
  return new File(vectorRoot(), LOCAL_STYLE);
}

/**
 * Font stack name; must match the `text-font` of every symbol layer in the style.
 *
 * Glyphs live at `fonts/<fontstack>/<range>.pbf`, because the style spec
 * requires the `glyphs` template to contain `{fontstack}` (`validateStyleMin`
 * rejects it otherwise). The space in the name is not a problem: MapLibre
 * percent-encodes before sending the request (`Resource::glyphs`) and
 * LocalFileSource percent-decodes before reading, so the two agree.
 */
export const VECTOR_FONT_STACK = 'Noto Sans Regular';

export function vectorFontsDir(): Directory {
  return new Directory(vectorRoot(), 'fonts');
}

/**
 * Where the local style is right now, as MapLibre should be told.
 *
 * **Do not use `installed.styleUri`**: that is an absolute path frozen at
 * install time, and the iOS app container UUID changes on reinstall or update,
 * so the old path points at a file that no longer exists. The file itself is
 * still there (`isVectorReady` finds it under the current `Paths.document`),
 * which produces the hard-to-diagnose state "every file is present, yet the map
 * is blank". Recomputing each time avoids it.
 */
export function vectorStyleUri(): string {
  return vectorStyleFile().uri;
}

/** Snapshot of the current state, for when the map will not load. Read-only,
 *  and everything in it is safe to print to a log. */
export function describeVectorInstall(): Record<string, unknown> {
  const style = vectorStyleFile();
  const fonts = vectorFontsDir();
  const stackDir = new Directory(fonts, VECTOR_FONT_STACK);
  const tiles = vectorTilesFile();
  const hs = vectorHillshadeFile();
  const out: Record<string, unknown> = {
    root: vectorRoot().uri,
    styleExists: style.exists,
    // The byte count is the crucial part: a truncated .pmtiles still has a readable
// header but yields no tiles, and the symptom is a blank map.
    tileBytes: tiles.exists ? tiles.size : 0,
    hillshadeBytes: hs.exists ? hs.size : 0,
    spriteBytes: new File(vectorRoot(), 'sprite.json').exists
      ? new File(vectorRoot(), 'sprite.json').size
      : 0,
    fontsFlat: fonts.exists ? fonts.list().filter((f) => f instanceof File).length : 0,
    fontsInStack: stackDir.exists ? stackDir.list().length : 0,
    stackDirUri: stackDir.uri,
  };
  if (style.exists) {
    out.styleBytes = style.size;
    try {
      const parsed = JSON.parse(style.textSync()) as Record<string, unknown>;
      const sources = parsed.sources as Record<string, Record<string, unknown>> | undefined;
      out.glyphs = parsed.glyphs;
      out.sprite = parsed.sprite;
      out.rudyUrl = sources?.rudy?.url;
      out.hillshadeUrl = sources?.hillshade?.url;
      out.layerCount = Array.isArray(parsed.layers) ? parsed.layers.length : null;
    } catch (e) {
      out.styleParseError = (e as Error).message;
    }
  }
  return out;
}

/**
 * Rewrite the remote style to point at local files.
 *
 * A source's `url` goes from `pmtiles://https://…` to `pmtiles://file:///…`.
 *
 * **Glyphs and sprites must be stored locally too** (about 2 MB together).
 * Swapping only the tile source is not enough — measured while verifying on the
 * desktop: with a single glyph range missing MapLibre fails to render the whole
 * map, not just the labels, and the console reports nothing but a 404, no
 * rendering error at all, which makes it very hard to track down. Offline every
 * range fails, so the entire map is blank.
 */
export function localizeStyle(
  style: Record<string, unknown>,
  paths: { tiles: string; hillshade?: string; sprite?: string; glyphs?: string },
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(style)) as Record<string, unknown>;
  const sources = out.sources as Record<string, Record<string, unknown>> | undefined;
  if (sources?.rudy) {
    sources.rudy.url = `pmtiles://${paths.tiles}`;
    delete sources.rudy.tiles;
  }
  if (sources?.hillshade && paths.hillshade) {
    sources.hillshade.url = `pmtiles://${paths.hillshade}`;
    delete sources.hillshade.tiles;
  }
  if (paths.sprite) out.sprite = paths.sprite;
  if (paths.glyphs) out.glyphs = paths.glyphs;
  return out;
}

export function readVectorInstalled(): VectorInstalled | null {
  const f = new File(vectorRoot(), STATE_FILE);
  if (!f.exists) return null;
  try {
    // textSync: this runs on the render path, so it cannot be a Promise.
    return JSON.parse(f.textSync()) as VectorInstalled;
  } catch {
    return null;
  }
}

export function writeVectorInstalled(state: VectorInstalled): void {
  ensureVectorRoot();
  new File(vectorRoot(), STATE_FILE).write(JSON.stringify(state));
}

/**
 * Installed means the files are really there **and their sizes match**.
 *
 * Existence alone is not enough: a truncated .pmtiles still has its header and
 * root directory at the start of the file, so the style loads while not one
 * tile can be fetched — on screen that reads as "hillshade yes, vector map
 * blank". A size mismatch counts as not installed, so the app falls back to
 * online mode (which works) and the settings screen offers the download again.
 * Better than keeping a broken file that looks fine.
 */
export function isVectorReady(state: VectorInstalled | null): boolean {
  if (state == null || !vectorTilesFile().exists || !vectorStyleFile().exists) return false;
  if (state.tileBytes != null && state.tileBytes > 0) {
    return (vectorTilesFile().size ?? 0) === state.tileBytes;
  }
  return true;
}

export function deleteVectorMap(): void {
  const root = vectorRoot();
  if (root.exists) root.delete();
}
