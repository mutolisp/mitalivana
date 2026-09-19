/**
 * Shared basemap helpers. The main map screen (`app/(tabs)/map.tsx`) keeps its
 * own copy with a `terrain` option + icons; this lightweight version is for the
 * inline record-location editor, whose basemap toggle cycles only
 * standard → satellite → hybrid (terrain rarely useful for a single point).
 */
import type { MapType } from 'react-native-maps';
import type { MapBasemap } from '~/stores/settings';

export function basemapToMapType(b: MapBasemap): MapType {
  switch (b) {
    case 'satellite':
      return 'satellite';
    case 'hybrid':
      return 'hybrid';
    case 'terrain':
      return 'terrain';
    // rudy 不是原生 mapType：魯地圖圖磚是不透明疊圖，底下留 standard 當海域與
    // z7 以下的墊底（圖磚包不含那些範圍）。
    case 'rudy':
      return 'standard';
    default:
      return 'standard';
  }
}

/**
 * Cycle order for the inline location editor's basemap toggle (no terrain).
 *
 * `rudy` is deliberately excluded: a cycle whose length depends on whether the
 * tile pack happens to be installed would make `nextBasemap` impure — the same
 * button would behave differently on two phones. The small maps also show a
 * single point or polygon, where contour lines add nothing.
 */
export const BASEMAP_CYCLE: MapBasemap[] = ['standard', 'satellite', 'hybrid'];

export function nextBasemap(b: MapBasemap): MapBasemap {
  const i = BASEMAP_CYCLE.indexOf(b);
  return BASEMAP_CYCLE[(i + 1) % BASEMAP_CYCLE.length] ?? 'standard';
}

/** i18n key for a basemap's display label (reuses the main map's keys). */
export const BASEMAP_LABEL_KEY: Record<MapBasemap, string> = {
  standard: 'map.basemapStandard',
  satellite: 'map.basemapSatellite',
  hybrid: 'map.basemapHybrid',
  terrain: 'map.basemapTerrain',
  rudy: 'map.basemapRudy',
};

/**
 * Does this basemap paint a dark surface under the status bar?
 *
 * Only the aerial imagery does. `terrain` is a pale relief shading and
 * `standard` follows the OS theme, so both are left to the app's own light/dark
 * decision — hard-coding them would make the status bar fight the theme.
 *
 * Used where the map runs full-bleed to the top edge and the system clock sits
 * directly on the tiles.
 */
export function basemapIsDark(b: MapBasemap): boolean {
  return b === 'satellite' || b === 'hybrid';
}
