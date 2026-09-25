/**
 * GLORIA photo file names — manual Annex III (p.136–137). Pure.
 *
 *   element 1  monitoring cycle   2 digits   (01 = first survey)
 *   element 2  country code       2
 *   element 3  target region      3
 *   element 4  summit code        3
 *   element 5  item code          8, padded with '_'
 *   element 6  date of photo      yyyymmdd
 *   element 7  ordering number    5 digits
 * separated by '_' ("not blanks or dots or hyphens" between elements).
 *
 * Item codes come from Work Steps O–R and Box 6.1: quadrat codes (N31), the
 * cluster (N), corner points (p5m-N31 / p-N13), 10-m points (p10m-N) and
 * intersection points (pNE-5), and summit overview photos (SU-OV), whose
 * viewpoint goes into the optional element 8.
 *
 * The ordering number must be unique within the target region; the app can
 * only number within one survey, so it counts from 1 per survey and the
 * README says to renumber before delivery to the central database.
 */

import { POINTS, pointNumberOf, type Direction, type P5mCorner } from '../model/units';
import { element8, type OverviewPhoto } from '../model/overview';

export type PhotoNameParts = {
  mocy: number;
  country: string;
  region: string;
  summit: string;
  item: string;
  date: string; // yyyymmdd
  order: number;
  /** Element 8 (Annex III): free description, required for SU-OV / PLANT / LANDSC / OTHER. */
  note?: string;
};

export function photoFileName(p: PhotoNameParts, ext = 'jpg'): string {
  const item = p.item.length > 8 ? p.item.slice(0, 8) : p.item.padEnd(8, '_');
  return [
    String(p.mocy).padStart(2, '0'),
    p.country.slice(0, 2).padEnd(2, '_'),
    p.region.slice(0, 3).padEnd(3, '_'),
    p.summit.slice(0, 3).padEnd(3, '_'),
    item,
    p.date,
    String(p.order).padStart(5, '0'),
    ...(p.note && element8(p.note) ? [element8(p.note)] : []),
  ].join('_') + `.${ext}`;
}

export function yyyymmdd(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

type PointPhotos = {
  point_key: string;
  photo_m2: string | null;
  photo_m2f: string | null;
  photo_point: string | null;
};

/**
 * Every photo of a survey with its Annex III name, in a stable order: the
 * measurement points in sheet order (quadrat photo, then quadrat with the
 * frequency frame, then the point itself), then unit photos.
 */
export function planPhotoNames(input: {
  mocy: number;
  country: string;
  region: string;
  summit: string;
  date: string;
  p5m: Partial<Record<Direction, P5mCorner>>;
  points: PointPhotos[];
  units: Array<{ code: string; photo_uris: string[] }>;
  overview?: OverviewPhoto[];
  extOf?: (uri: string) => string;
}): Array<{ uri: string; name: string }> {
  const out: Array<{ uri: string; name: string }> = [];
  const byKey = new Map(input.points.map((p) => [p.point_key, p]));
  let order = 0;
  const push = (uri: string | null, item: string, note?: string) => {
    if (!uri) return;
    order += 1;
    const base = { mocy: input.mocy, country: input.country, region: input.region, summit: input.summit, date: input.date };
    out.push({ uri, name: photoFileName({ ...base, item, order, note }, input.extOf?.(uri) ?? 'jpg') });
  };
  for (const def of POINTS) {
    const p = byKey.get(def.key);
    if (!p) continue;
    if (def.quadrat) {
      // The m² photos show the quadrat, so they carry the quadrat code.
      push(p.photo_m2, def.quadrat);
      push(p.photo_m2f, def.quadrat);
    }
    push(p.photo_point, pointNumberOf(def.key, input.p5m));
  }
  for (const u of input.units) for (const uri of u.photo_uris) push(uri, u.code);
  for (const p of input.overview ?? []) push(p.uri, 'SU-OV', p.viewpoint);
  return out;
}
