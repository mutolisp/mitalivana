/**
 * Coordinates → a place name, via the system geocoder (Apple on iOS, Google
 * on Android). Needs a network connection; offline it resolves null and the
 * caller carries on without one. Never throws.
 *
 * expo-location warns that geocoding is rate-limited and that many requests at
 * once can fail, so callers go one at a time (`placeNamesAt`).
 */
import * as Location from 'expo-location';
import { formatPlace } from './placeName';

export async function placeNameAt(lat: number, lng: number, timeoutMs = 6000): Promise<string | null> {
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const lookup = Location.reverseGeocodeAsync({ latitude: lat, longitude: lng }).then(
      (res) => (res[0] ? formatPlace(res[0]) : null),
    );
    return await Promise.race([lookup, timeout]);
  } catch {
    return null;
  }
}

/**
 * Look up several points in sequence. Identical coordinates (to ~1 m) share
 * one request, and the first failure stops the run: a failure almost always
 * means no network, and waiting out the timeout for every remaining point
 * would stall the export for minutes.
 */
export async function placeNamesAt(
  points: { lat: number; lng: number }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of points) {
    const key = placeKey(p.lat, p.lng);
    if (out.has(key)) continue;
    const name = await placeNameAt(p.lat, p.lng);
    if (!name) break;
    out.set(key, name);
  }
  return out;
}

export const placeKey = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
