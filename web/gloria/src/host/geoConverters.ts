/**
 * Web stand-in for mobile/app/src/lib/geoConverters.ts.
 *
 * The mobile zip reader (recordImportZip.ts) imports it for the site files of
 * checklist and plot records; a GLORIA import returns before any of that. The
 * real module needs @tmcw/togeojson and wellknown, which the GLORIA web app
 * does not ship, so anything reaching here fails loudly instead of silently.
 */
export type ImportedGeometry = { geometry: unknown; name?: string | null };
export type GeoFormat = 'geojson' | 'kml' | 'gpx' | 'wkt';

const unsupported = (): never => {
  throw new Error('Geo files are not supported in the GLORIA web app');
};

export function detectFormat(_text: string, _filename?: string): GeoFormat | null {
  return unsupported();
}
export const parseGeoJSON = (_text: string): ImportedGeometry[] => unsupported();
export const parseKML = (_text: string): ImportedGeometry[] => unsupported();
export const parseGPX = (_text: string): ImportedGeometry[] => unsupported();
export const parseWKT = (_text: string): ImportedGeometry[] => unsupported();
export const parseGeoFile = (_text: string, _format: GeoFormat): ImportedGeometry[] => unsupported();
