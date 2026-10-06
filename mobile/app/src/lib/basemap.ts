/**
 * Shared basemap helpers: the basemap menu (`BASEMAP_OPTIONS`, with terrain
 * and icons) and the lighter cycle of the inline record-location editor,
 * whose toggle steps only standard → satellite → hybrid (terrain is rarely
 * useful for a single point).
 */
import type { Ionicons } from '@expo/vector-icons';

import type { BaseMapType } from '~/components/map/types';
import type { MapBasemap } from '~/stores/settings';

export function basemapToMapType(b: MapBasemap): BaseMapType {
  switch (b) {
    case 'satellite':
      return 'satellite';
    case 'hybrid':
      return 'hybrid';
    case 'terrain':
      return 'terrain';
    // vector goes through MapLibre and has no native mapType; returning standard
    // only keeps the type total.
    case 'vector':
      return 'standard';
    default:
      return 'standard';
  }
}

/**
 * Cycle order for the inline location editor's basemap toggle (no terrain).
 *
 * `vector` is deliberately excluded: the small maps show a single point or
 * polygon, where contour lines add nothing, and swapping the whole canvas to a
 * different native view just to toggle a basemap is not worth it here.
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
  vector: 'map.basemapRudyVector',
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

/**
 * Basemap menu: the map tab, and casual mode's map. **No mapType here** —
 * that mapping lives once in `basemapToMapType()` above; a second copy used
 * to live in the menu and was a source of duplication.
 */
export const BASEMAP_OPTIONS: {
  value: MapBasemap;
  labelKey: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { value: 'standard', labelKey: 'map.basemapStandard', icon: 'map-outline' },
  { value: 'satellite', labelKey: 'map.basemapSatellite', icon: 'globe-outline' },
  { value: 'hybrid', labelKey: 'map.basemapHybrid', icon: 'layers-outline' },
  { value: 'terrain', labelKey: 'map.basemapTerrain', icon: 'trail-sign-outline' },
  // The vector RudyMap. Always available online (reading the remote pmtiles
  // directly); once the offline package is installed it reads one local file.
  // The label tracks offline state, see basemapLabelKey().
  { value: 'vector', labelKey: 'map.basemapRudyVector', icon: 'triangle-outline' },
];

/**
 * Display label for a basemap.
 *
 * Only the vector one is dynamic: "RudyMap" online, "RudyMap (offline)" once the
 * offline package is installed — what the user cares about is whether this map
 * needs the network right now, not how it is rendered.
 */
export function basemapLabelKey(o: (typeof BASEMAP_OPTIONS)[number], vectorReady: boolean): string {
  if (o.value === 'vector' && vectorReady) return 'map.basemapRudyVectorOffline';
  return o.labelKey;
}
