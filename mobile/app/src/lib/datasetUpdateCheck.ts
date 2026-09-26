/**
 * Tell the user when a newer checklist module is on R2.
 *
 * The manifest used to be read only on the regionpacks screen, so an update
 * went unnoticed until someone happened to open it. This checks on launch and
 * whenever the app comes back to the foreground (at most once per
 * CHECK_INTERVAL_MS), drives a red dot on the settings tab and the regionpacks
 * row, and shows one toast per new set of versions. It never downloads: the
 * user decides when to spend the data (tw-taicol alone is 34 MB).
 *
 * No push and no background task: push needs a server holding device tokens
 * (R2 only serves static files), and iOS background fetch runs whenever the OS
 * feels like it. Knowing before the next field trip is enough.
 * Offline or a failed fetch is silent; the next foreground tries again.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { router, type Href } from 'expo-router';
import { allSpecs, getInstall } from '~/db';
import i18n from '~/i18n';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import {
  fetchDatasetManifest,
  hasUpdate,
  useInstalledDatasets,
  useRemoteManifest,
  type DatasetManifestEntry,
} from './datasetInstall';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastCheckedAt = 0;
let inFlight = false;

/** `id@version` of every installed module with a newer remote version — the
 *  same test the regionpacks screen uses (`hasUpdate`), so the dot and the
 *  screen never disagree. Reads the registry itself, not the
 *  `useInstalledDatasets` snapshot: that one is taken at module load and can
 *  predate `initDb()`. */
function updatableSig(entries: DatasetManifestEntry[]): string[] {
  return entries
    .filter((e) => getInstall(e.id) != null && hasUpdate(e))
    .map((e) => `${e.id}@${e.version}`)
    .sort();
}

export async function checkDatasetUpdates(): Promise<void> {
  if (inFlight || Date.now() - lastCheckedAt < CHECK_INTERVAL_MS) return;
  // Nothing installed = DatasetSetupGate is (or was) guiding the first download.
  if (!allSpecs().some((spec) => getInstall(spec.id) != null)) return;
  inFlight = true;
  try {
    const { entries } = await fetchDatasetManifest(); // also refreshes useRemoteManifest
    lastCheckedAt = Date.now();

    const sig = updatableSig(entries).join(',');
    const settings = useSettings.getState();
    // One toast per new set of versions, not one per day; the dot stays until
    // the user updates.
    if (sig === '' || sig === settings.dataset_update_notified) return;
    settings.set('dataset_update_notified', sig);
    useToast.getState().show(i18n.t('datasets.updateToast'), {
      durationMs: 8000,
      action: {
        label: i18n.t('datasets.updateToastAction'),
        onPress: () => router.push('/regionpacks' as Href),
      },
    });
  } catch {
    // Offline in the field is the normal case; try again next foreground.
  } finally {
    inFlight = false;
  }
}

/** Mount once at the root: checks on launch and on every return to foreground. */
export function useDatasetUpdateCheck(): void {
  const loaded = useSettings((s) => s.loaded);
  useEffect(() => {
    if (!loaded) return;
    void checkDatasetUpdates();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void checkDatasetUpdates();
    });
    return () => sub.remove();
  }, [loaded]);
}

/** True while any installed module has a newer version on R2. Re-derives from
 *  the installed list, so the dot clears as soon as the update is installed. */
export function useHasDatasetUpdate(): boolean {
  const entries = useRemoteManifest((s) => s.entries);
  // Subscribed only to re-render when a module is installed or updated.
  useInstalledDatasets((s) => s.installs);
  return updatableSig(entries).length > 0;
}
