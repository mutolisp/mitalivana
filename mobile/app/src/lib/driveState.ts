/**
 * Per-device record of what has been uploaded to Drive.
 *
 * A small JSON file in the app's document directory, deliberately NOT in
 * user.db's settings table — the same line `gbifCredentials.ts` draws, for a
 * different reason. Settings ride along inside a backup zip, so a phone
 * restored from yesterday's backup would inherit "last uploaded 2 hours ago"
 * and then stay silent for the whole interval while having, in fact, never
 * uploaded anything. That is a silent way to lose data. This is DEVICE state,
 * not a user preference: a fresh install legitimately starts at "never".
 *
 * `lastAccount` exists so the mismatch is detectable the other way too — the
 * restored settings name account A while the Keychain holds B's token (or
 * nothing), and the account screen can ask for a re-link instead of quietly
 * applying A's preferences to B's Drive.
 */
import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';

const STATE_FILE = 'gdrive_state.json';

type DriveStateValues = {
  /** Epoch ms of the last successful upload from THIS install; null = never. */
  lastUploadAtMs: number | null;
  lastUploadFileId: string | null;
  /** Account that upload went to, for detecting a restored-from-another-phone mismatch. */
  lastAccount: string;
};

const EMPTY: DriveStateValues = {
  lastUploadAtMs: null,
  lastUploadFileId: null,
  lastAccount: '',
};

type DriveStateStore = DriveStateValues & {
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<DriveStateValues>) => Promise<void>;
  clear: () => Promise<void>;
};

function writeFile(values: DriveStateValues): void {
  try {
    const f = new File(Paths.document, STATE_FILE);
    if (f.exists) f.delete();
    f.create();
    f.write(JSON.stringify(values));
  } catch (e) {
    if (__DEV__) console.warn('[driveState] save failed', e);
  }
}

export const useDriveState = create<DriveStateStore>((set, get) => ({
  ...EMPTY,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const f = new File(Paths.document, STATE_FILE);
      if (f.exists) {
        const parsed = JSON.parse(await f.text()) as Partial<DriveStateValues>;
        set({
          lastUploadAtMs:
            typeof parsed.lastUploadAtMs === 'number' ? parsed.lastUploadAtMs : null,
          lastUploadFileId:
            typeof parsed.lastUploadFileId === 'string' ? parsed.lastUploadFileId : null,
          lastAccount: typeof parsed.lastAccount === 'string' ? parsed.lastAccount : '',
        });
      }
    } catch (e) {
      // A corrupt state file must not stop a backup — worst case the app
      // thinks it has never uploaded, which is the safe direction to be wrong.
      if (__DEV__) console.warn('[driveState] load failed', e);
    }
    set({ loaded: true });
  },

  save: async (patch) => {
    await get().load();
    const next: DriveStateValues = {
      lastUploadAtMs: patch.lastUploadAtMs ?? get().lastUploadAtMs,
      lastUploadFileId: patch.lastUploadFileId ?? get().lastUploadFileId,
      lastAccount: patch.lastAccount ?? get().lastAccount,
    };
    set(next);
    writeFile(next);
  },

  clear: async () => {
    set({ ...EMPTY, loaded: true });
    try {
      const f = new File(Paths.document, STATE_FILE);
      if (f.exists) f.delete();
    } catch (e) {
      if (__DEV__) console.warn('[driveState] clear failed', e);
    }
  },
}));
