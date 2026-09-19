/**
 * How a site's geometry type is shown — one table, four screens.
 *
 * This existed as four near-copies (the map tab, the 地理樣區 list, the assign
 * sheet and the save modal), one of which silently carried only three of the
 * six types. Keyed on `SiteGeometryType` as a COMPLETE Record, so adding a
 * geometry type fails to compile here instead of rendering a bare i18n key on
 * screen — which is also why call sites no longer need a `?? fallback`.
 *
 * Lives in lib rather than `src/db/sites.ts` so the DB layer does not acquire
 * a dependency on the icon set.
 */
import type { Ionicons } from '@expo/vector-icons';
import type { SiteGeometryType } from '~/db';

export const SITE_TYPE_LABEL: Record<SiteGeometryType, string> = {
  Point: 'sites.typePoint',
  LineString: 'sites.typeLineString',
  Polygon: 'sites.typePolygon',
  MultiPoint: 'sites.typeMultiPoint',
  MultiLineString: 'sites.typeMultiLineString',
  MultiPolygon: 'sites.typeMultiPolygon',
};

export const SITE_TYPE_ICON: Record<SiteGeometryType, keyof typeof Ionicons.glyphMap> = {
  Point: 'pin-outline',
  LineString: 'analytics-outline',
  Polygon: 'shapes-outline',
  MultiPoint: 'pin',
  MultiLineString: 'analytics',
  MultiPolygon: 'shapes',
};

/** What the drawing UI can produce. Multi* only ever arrive via KML/GPX import. */
export type DrawType = Extract<SiteGeometryType, 'Point' | 'LineString' | 'Polygon'>;
