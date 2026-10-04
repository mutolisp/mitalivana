/**
 * The survey a builder 預覽 runs (2G-e, decided 2026-10-04): a new survey of
 * the draft, as 開始調查 would make it, in a scratch file built with the real
 * migrations. The real survey screens open it; its ids route their reads and
 * writes there (previewDb.ts), so user.db is not touched. Closing it deletes
 * the file and the photos and recordings taken in it (unless a record of
 * user.db uses the same file).
 */
import { open, type DB } from '@op-engineering/op-sqlite';
import { File, Paths } from 'expo-file-system';
import { runUserMigrations } from '~/db/migrations';
import { raisePreviewIds, setPreviewDb } from '~/db/previewDb';
import { mediaUriReferenced } from '~/db/records';
import { generateUuid } from '~/db/uuid';
import * as core from '~/survey/db/surveyCore';
import type { SurveyTemplate } from '~/survey/template/types';

const PREVIEW_FILE = 'survey-preview.db';
/** Writes still on their way when the screen goes (a typed value flushed on unmount) land before the file closes. */
const CLOSE_DELAY_MS = 1000;

let pendingClose: (() => void) | null = null;

const removeFiles = () => {
  for (const name of [PREVIEW_FILE, `${PREVIEW_FILE}-wal`, `${PREVIEW_FILE}-shm`, `${PREVIEW_FILE}-journal`]) {
    const f = new File(Paths.document, name);
    if (f.exists) f.delete();
  }
};

function closeNow(db: DB): void {
  setPreviewDb(null);
  try {
    const uris = (db.executeSync(`SELECT uri FROM fw_media`).rows ?? []) as { uri: string }[];
    for (const { uri } of uris) {
      if (mediaUriReferenced(uri)) continue;
      const f = new File(uri);
      if (f.exists) f.delete();
    }
  } catch (e) {
    if (__DEV__) console.warn('[preview] media clean-up failed', e);
  }
  db.close();
  removeFiles();
}

/** Open a preview of `template`; `close` ends it (once). */
export async function openPreviewSurvey(template: SurveyTemplate): Promise<{ id: number; close: () => void }> {
  // A preview closed a moment ago goes first: one scratch file at a time.
  pendingClose?.();
  removeFiles();
  const db = open({ name: PREVIEW_FILE, location: Paths.document.uri });
  try {
    await runUserMigrations(db);
    db.executeSync('PRAGMA foreign_keys = ON;');
    raisePreviewIds(db);
    // add-guard: a scratch database, not user.db; nothing there is active.
    const id = core.createSurvey({ db, now: Date.now, uuid: generateUuid }, { template });
    setPreviewDb(db);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const timer = setTimeout(run, CLOSE_DELAY_MS);
      function run() {
        clearTimeout(timer);
        if (pendingClose === run) pendingClose = null;
        closeNow(db);
      }
      pendingClose = run;
    };
    return { id, close };
  } catch (e) {
    db.close();
    removeFiles();
    throw e;
  }
}
