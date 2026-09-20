/**
 * Mode choice and tile URL for the iNaturalist observation grid.
 *
 * A pure module — it imports no Expo, DB or i18n, so
 * `scripts/check-inat-heatmap.mjs` can verify it under plain Node (the same
 * split as `inatPayload.ts` / `inatJwt.ts`). Network and cache live in
 * `useInatGrid.ts` and `src/db/inatTaxonMap.ts` respectively.
 *
 * **Why `grid` and not `heatmap`**: this layer sits on a 184px-tall mini-map,
 * where square aggregation reads far better than a blurred wash, and a measured
 * tile is 2,835 B against 39,026 B — an order of magnitude off both the mobile
 * data and the battery in the field. All four styles (grid / heatmap /
 * colored_heatmap / points) share the endpoint shape, so switching means
 * changing `STYLE` alone.
 *
 * **`{z}/{x}/{y}` must stay verbatim in the string**: it is a template for
 * react-native-maps `UrlTile` and MapLibre `RasterSource`, and substituting real
 * numbers pins the layer to a single tile.
 */

/**
 * Which set of observations to draw.
 *
 * - `wild`: captive and cultivated excluded (`captive=false`). A field survey is
 *   about natural distribution, and botanical gardens, street trees and pets
 *   distort that reading, so this is the default.
 * - `all`: no filter. **Only used when the species has 0 wild observations but a
 *   non-zero total** — for such a species (an ornamental plant with nothing but
 *   cultivated records, say) `captive=false` produces a completely empty map,
 *   which looks like a broken feature. Draw everything instead, and let the UI
 *   say plainly that these are captive or cultivated records.
 * - `none`: iNat has nothing at all; do not mount the layer.
 */
export type HeatmapMode = 'wild' | 'all' | 'none';

const TILE_BASE = 'https://api.inaturalist.org/v1/grid/{z}/{x}/{y}.png';

/**
 * Layer parameters, shared by every map that mounts the grid.
 *
 * zIndex 3 sits above the NLSC (1) and Academia Sinica (2) overlays; the grid
 * already aggregates by zoom, so going closer only buys more tile requests,
 * hence maxZoom 15.
 */
export const INAT_GRID_LAYER = { id: 'inat-grid', opacity: 0.7, zIndex: 3, maxZoom: 15 } as const;

/** How long before a lookup is re-verified. A stale count is only a display
 *  inaccuracy, not worth a network call every time the map opens. */
export const INAT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isInatCacheStale(checkedAt: number, now: number = Date.now()): boolean {
  return !Number.isFinite(checkedAt) || now - checkedAt > INAT_CACHE_TTL_MS;
}

/**
 * Decide what to draw from the wild and total counts.
 *
 * `obsTotal` is only consulted when `obsWild === 0` — with wild observations
 * present the total was never requested (one call saved), so callers pass 0 or
 * null, which does not affect the result.
 */
export function pickHeatmapMode(obsWild: number, obsTotal: number): HeatmapMode {
  if (obsWild > 0) return 'wild';
  if (obsTotal > 0) return 'all';
  return 'none';
}

/**
 * Tile template. Returns null for `mode === 'none'` or an invalid id, and the
 * caller then mounts no layer.
 *
 * `precisionOffset` makes the cells coarser; see `gridPrecisionOffset`. 0 is
 * left out of the URL entirely so the string stays identical to what earlier
 * versions built, and the CDN keeps serving the same cached tiles.
 */
export function gridTileUrl(
  inatTaxonId: number,
  mode: HeatmapMode,
  precisionOffset = 0,
): string | null {
  if (mode === 'none') return null;
  if (!Number.isInteger(inatTaxonId) || inatTaxonId <= 0) return null;
  const captive = mode === 'wild' ? '&captive=false' : '';
  const offset =
    Number.isInteger(precisionOffset) && precisionOffset > 0
      ? `&precision_offset=${precisionOffset}`
      : '';
  return `${TILE_BASE}?taxon_id=${inatTaxonId}${captive}${offset}`;
}

/**
 * Screen-space zoom level for a map region, in the standard 256 px web-mercator
 * scheme the tile templates are numbered in.
 *
 * `longitudeDelta` is what both map engines report; `widthPt` is the canvas
 * width in points. A 184 px mini-map showing the same span as a full screen is
 * a LOWER zoom, which is exactly what the grid has to know.
 */
export function tileZoomForRegion(longitudeDelta: number, widthPt: number): number {
  if (!(longitudeDelta > 0) || !(widthPt > 0)) return 0;
  return Math.log2((360 * widthPt) / (256 * longitudeDelta));
}

/**
 * How many geotile levels to merge away, as `precision_offset` in the tile URL.
 *
 * iNaturalist aggregates observations into a geotile grid of precision
 * `zoom + 5 - precision_offset` (iNaturalistAPI `lib/elastic_request.js`
 * `geotileGridPrecision`), so at offset 0 one cell is always 1/32 of a tile —
 * 16 px on the 512 px tiles the API serves, i.e. about 8 pt on screen at every
 * zoom. Measured cell edges on live tiles: 4.5 km at z8, 1.1 km at z10, 280 m at
 * z12, 70 m at z14 (lat 23.5°).
 *
 * Coarsening one level above z11 buys two things and costs one:
 *   + 16 pt cells instead of 8 pt — a readable square rather than speckle, at
 *     the zoom where the user is reading one valley rather than the island;
 *   + a quarter of the polygons per tile (measured 12.5 KB → 8.4 KB at z9);
 *   − half the spatial precision, which at these zooms is already finer than
 *     iNaturalist's own obscuring of threatened-species coordinates.
 *
 * It deliberately does NOT try to restore the colour ladder at high zoom: the
 * opacity thresholds are scaled by `max(hits / 2^zoom, 3)`
 * (`lib/inaturalist_map_styles.js` `scaledHitsForGrid`), so past ~z11 they bottom
 * out and the grid is presence/absence whatever offset is used — measured 3
 * distinct opacities at z12 against 20 at z6. Coarsening cannot change that, and
 * pretending otherwise would be the wrong reason to throw away precision.
 *
 * Two buckets, not a smooth curve, on purpose: the offset lives in the tile URL,
 * so every change discards the loaded tiles and re-downloads them.
 */
export function gridPrecisionOffset(zoom: number): number {
  return zoom >= 11 ? 1 : 0;
}
