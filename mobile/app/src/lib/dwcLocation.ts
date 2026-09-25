/**
 * The Darwin Core datum and elevation terms every exported location carries,
 * derived in one place so plots, checklist records, plot species and
 * specimens cannot disagree.
 *
 * Checked against the TDWG term list (term_versions.csv), not recalled:
 *   - `geodeticDatum`: "The ellipsoid, geodetic datum, or spatial reference
 *     system (SRS) upon which the geographic coordinates given in
 *     dwc:decimalLatitude and dwc:decimalLongitude are based"; best practice
 *     is the EPSG code of the SRS — EPSG:4326 (2D WGS 84, latitude/longitude,
 *     no height axis) is what every coordinate in this app is.
 *   - `minimumElevationInMeters` / `maximumElevationInMeters`: the least /
 *     greatest elevation "within a range of elevations", relative to
 *     `verticalDatum`. A single measured value is written as both, per GBIF
 *     Georeferencing Best Practices §2 ("If a single value is given for
 *     elevation … estimate the minimum and maximum elevations").
 *   - `verticalDatum`: GNSS altitude is height above the WGS 84 ellipsoid
 *     (expo-location's own definition of `coords.altitude`) → `EPSG:7030`, the
 *     WGS 84 ellipsoid, a TDWG example value. A typed-in altitude could be
 *     read off a map (sea level) or anything else → `not recorded`, also a
 *     TDWG example value.
 *
 * Pure module (no Expo / DB imports) so the exporters' checks run under Node.
 */

export type ElevationSource = 'gnss' | 'manual';

export const GEODETIC_DATUM = 'EPSG:4326';
export const GNSS_VERTICAL_DATUM = 'EPSG:7030';
export const UNKNOWN_DATUM = 'not recorded';

export type LocationTerms = {
  geodeticDatum: string;
  minimumElevationInMeters: number | string;
  maximumElevationInMeters: number | string;
  verticalDatum: string;
};

/** Blank ('') where there is nothing to qualify: no datum without a
 *  coordinate, no vertical datum without an altitude. */
export function locationTerms(
  lat: number | null | undefined,
  elevation: number | null | undefined,
  source: string | null | undefined,
): LocationTerms {
  const hasElevation = elevation != null && Number.isFinite(elevation);
  return {
    geodeticDatum: lat != null ? GEODETIC_DATUM : '',
    minimumElevationInMeters: hasElevation ? elevation : '',
    maximumElevationInMeters: hasElevation ? elevation : '',
    verticalDatum: hasElevation ? verticalDatumFor(source) : '',
  };
}

export function verticalDatumFor(source: string | null | undefined): string {
  return source === 'gnss' ? GNSS_VERTICAL_DATUM : UNKNOWN_DATUM;
}

/** Import side: an elevation that came back with the GNSS datum was a GNSS
 *  reading; any other elevation is treated as typed in. */
export function sourceFromVerticalDatum(
  verticalDatum: unknown,
  elevation: number | null | undefined,
): ElevationSource | null {
  if (elevation == null) return null;
  return verticalDatum === GNSS_VERTICAL_DATUM ? 'gnss' : 'manual';
}
