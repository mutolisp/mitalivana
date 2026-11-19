/**
 * `expo-location` (what summit-new and photo stamps call): the browser
 * Geolocation API. Permission is asked by the browser on the first read.
 */
export const Accuracy = { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 } as const;
export type LocationObject = {
  coords: { latitude: number; longitude: number; altitude: number | null; accuracy: number | null; altitudeAccuracy: number | null; heading: number | null; speed: number | null };
  timestamp: number;
};
type Perm = { status: 'granted' | 'denied' | 'undetermined'; granted: boolean; canAskAgain: boolean };

async function state(): Promise<Perm> {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (p?.state === 'granted') return { status: 'granted', granted: true, canAskAgain: true };
    if (p?.state === 'denied') return { status: 'denied', granted: false, canAskAgain: false };
  } catch {
    // Safari: no permissions API for geolocation
  }
  // Unknown or "prompt": report granted so the caller goes on to read; the browser asks then.
  return { status: 'granted', granted: true, canAskAgain: true };
}
export const getForegroundPermissionsAsync = state;
export const requestForegroundPermissionsAsync = state;

export function getCurrentPositionAsync(opts: { accuracy?: number } = {}): Promise<LocationObject> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          coords: {
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            altitude: p.coords.altitude,
            accuracy: p.coords.accuracy,
            altitudeAccuracy: p.coords.altitudeAccuracy,
            heading: p.coords.heading,
            speed: p.coords.speed,
          },
          timestamp: p.timestamp,
        }),
      (e) => reject(new Error(e.message)),
      { enableHighAccuracy: (opts.accuracy ?? 3) >= 4, timeout: 30000, maximumAge: 0 },
    ),
  );
}
export async function getLastKnownPositionAsync(): Promise<LocationObject | null> {
  return null;
}
