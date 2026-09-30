/**
 * Specimens from picked photos (collection trip, 從照片選取; user decisions
 * 2026-09-30) — pure, pinned by check:photoimport.
 *
 *   - 'one': every photo goes on one specimen. Its time is the earliest photo
 *     time; its position the first photo (in pick order) that has one.
 *   - 'each': one specimen per photo, each keeping its own time and position,
 *     numbered oldest photo first (the picker's order is its own, not the
 *     order things were collected); photos without a time go last, as picked.
 *
 * A photo without a time leaves the specimen's time to the caller (now); a
 * specimen without a position gets the caller's missing-position choice —
 * the current fix, or nothing — never another photo's.
 */
import type { PhotoMeta } from './photoExif';

export type PickedWithMeta = { uri: string; meta: PhotoMeta };

export type SpecimenPlan = {
  uris: string[];
  takenAt: number | null;
  fix: { lat: number; lng: number; accuracyM: number | null; altitudeM: number | null } | null;
};

const fixOf = (m: PhotoMeta) =>
  m.lat != null && m.lng != null ? { lat: m.lat, lng: m.lng, accuracyM: m.accuracyM, altitudeM: m.altitudeM } : null;

export function planSpecimensFromPhotos(photos: readonly PickedWithMeta[], mode: 'one' | 'each'): SpecimenPlan[] {
  if (photos.length === 0) return [];
  if (mode === 'each') {
    const byTime = photos
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (a.p.meta.takenAt ?? Infinity) - (b.p.meta.takenAt ?? Infinity) || a.i - b.i);
    return byTime.map(({ p }) => ({ uris: [p.uri], takenAt: p.meta.takenAt, fix: fixOf(p.meta) }));
  }
  const times = photos.map((p) => p.meta.takenAt).filter((t): t is number => t != null);
  const withFix = photos.find((p) => fixOf(p.meta));
  return [{ uris: photos.map((p) => p.uri), takenAt: times.length ? Math.min(...times) : null, fix: withFix ? fixOf(withFix.meta) : null }];
}

/** How many of the planned specimens have no position of their own. */
export function specimensWithoutFix(plans: readonly SpecimenPlan[]): number {
  return plans.filter((p) => !p.fix).length;
}
