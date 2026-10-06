/**
 * What casual mode captured and is about to name (記一筆觀察 → 這是什麼？,
 * design 18d / 18e): photos, a recording, or nothing but the moment, with the
 * time and place they were taken. Several photos picked from the library as
 * one observation each make a queue the 這是什麼？ screen works through.
 *
 * Kept in a store rather than route params: a picked photo's EXIF map is
 * large, and the place may still be on its way when the screen opens
 * (`draftNow` fills it in when the fix arrives).
 */
import { router, type Href } from 'expo-router';
import { create } from 'zustand';

import type { AdoptionInput, SearchResult } from '~/db';
import type { PickedPhoto } from '~/lib/photoCapture';
import { rememberPickedPhotos, readPhotoMeta } from '~/lib/photoMeta';
import { takeFixNow, type Fix } from '~/lib/recordFix';

export type ObserveDraft = {
  /** Identity within the app run, so a late position finds its draft. */
  id: number;
  photos: string[];
  audio: string[];
  observedAt: number;
  /** Null until known, and when there is none (no permission, no signal). */
  fix: Fix | null;
  /** True while the device position is still being read. */
  locating: boolean;
  /** A species already chosen (the species tab's 加入), with the name it was chosen under. */
  pick?: { sp: SearchResult; adopted?: AdoptionInput | null };
};

type State = {
  queue: ObserveDraft[];
  index: number;
};

export const useObserveDraft = create<State>(() => ({ queue: [], index: 0 }));

let nextId = 1;

/** Open 這是什麼？ on `drafts`, one after another. */
export function startObserve(drafts: ObserveDraft[]): void {
  if (drafts.length === 0) return;
  useObserveDraft.setState({ queue: drafts, index: 0 });
  locateDrafts();
  router.push('/observe' as Href);
}

/**
 * Move to the next draft; false when this was the last. The queue is left as
 * it is then, so the screen keeps its content while it slides away; the next
 * startObserve replaces it.
 */
export function nextDraft(): boolean {
  const { queue, index } = useObserveDraft.getState();
  if (index + 1 >= queue.length) return false;
  useObserveDraft.setState({ index: index + 1 });
  return true;
}

function patchDraft(id: number, patch: Partial<ObserveDraft>): void {
  const { queue } = useObserveDraft.getState();
  if (!queue.some((d) => d.id === id)) return;
  useObserveDraft.setState({ queue: queue.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
}

/**
 * A draft from photos: the time and place of the first photo that states
 * them (a library photo was taken earlier and elsewhere), else now. `here`:
 * just taken with the camera, so a photo without GPS was still taken here
 * and the device position stands in.
 */
export async function draftFromPhotos(photos: PickedPhoto[], here = false): Promise<ObserveDraft> {
  rememberPickedPhotos(photos);
  let observedAt: number | null = null;
  let fix: Fix | null = null;
  for (const p of photos) {
    const meta = await readPhotoMeta(p.uri, p.exif);
    if (observedAt == null && meta.takenAt != null) observedAt = meta.takenAt;
    if (fix == null && meta.lat != null && meta.lng != null) {
      fix = { lat: meta.lat, lng: meta.lng, accuracy: meta.accuracyM, elevation_m: meta.altitudeM };
    }
  }
  return {
    id: nextId++,
    photos: photos.map((p) => p.uri),
    audio: [],
    observedAt: observedAt ?? Date.now(),
    fix,
    locating: here && fix == null,
  };
}

/**
 * A draft of now and here (a recording, a name only). The screen opens at
 * once; the position follows when the device has it.
 */
export function draftNow(
  extra: { audio?: string[]; pick?: ObserveDraft['pick'] } = {},
): ObserveDraft {
  return {
    id: nextId++,
    photos: [],
    audio: extra.audio ?? [],
    observedAt: Date.now(),
    fix: null,
    locating: true,
    pick: extra.pick,
  };
}

/** Read the position for queued drafts that are waiting for one. */
export function locateDrafts(): void {
  const { queue } = useObserveDraft.getState();
  for (const d of queue) {
    if (d.locating) void takeFixNow().then((fix) => patchDraft(d.id, { fix, locating: false }));
  }
}
