/**
 * Lock and undo / redo for a record screen (快速名錄, 樣區調查, 採集記錄).
 *
 * Lock: an ended record is read-only. 解鎖編輯 opens it for edits without
 * making it the active record again (reopening would end whatever else is
 * active); the unlock lives in this screen only, so leaving re-locks it.
 *
 * History: the screen calls `checkpoint()` after every reload. When the
 * record differs from the last checkpoint, the previous state becomes one undo
 * step — so every edit made on the screen, through whichever sheet or row
 * action, is covered without wrapping each call site. The history starts over
 * whenever the screen regains focus (another screen may have changed the
 * record) and on lock / unlock.
 *
 * Audio files a removal would delete are kept until the history is dropped,
 * so undoing the removal still has the file to point at.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  restoreRecordSnapshot,
  sameSnapshot,
  snapshotRecord,
  type RecordSnapshot,
  type SnapshotKind,
} from '~/db/recordSnapshot';
import { mediaUriReferenced } from '~/db/records';
import { deleteAudioFile } from '~/lib/audioCapture';
import { useToast } from '~/stores/toast';

const UNDO_LIMIT = 100;

export type RecordEditing = {
  /** Ended and not unlocked here: no edits. */
  locked: boolean;
  /** Ended but opened for edits on this screen. */
  unlocked: boolean;
  setUnlocked: (on: boolean) => void;
  /** Toasts and returns true when an edit must not happen. */
  refuse: () => boolean;
  checkpoint: () => void;
  /** Take in a change the app made by itself (a GNSS stamp landing after an
   *  add) without making it a step of its own. */
  absorb: () => void;
  undoCount: number;
  redoCount: number;
  /** Restore the previous / next state; the caller reloads afterwards. */
  undo: () => void;
  redo: () => void;
  /** Delete this audio file once no undo step can bring its record back. */
  deferAudioDelete: (uri: string) => void;
};

export function useRecordEditing(kind: SnapshotKind, id: number, ended: boolean): RecordEditing {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [unlocked, setUnlockedState] = useState(false);
  const locked = ended && !unlocked;

  const base = useRef<RecordSnapshot | null>(null);
  const undoStack = useRef<RecordSnapshot[]>([]);
  const redoStack = useRef<RecordSnapshot[]>([]);
  const pendingAudio = useRef<string[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  const flushAudio = useCallback(() => {
    const uris = pendingAudio.current;
    pendingAudio.current = [];
    for (const uri of uris) if (!mediaUriReferenced(uri)) void deleteAudioFile(uri);
  }, []);

  const reset = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    setUndoCount(0);
    setRedoCount(0);
    flushAudio();
    base.current = snapshotRecord(kind, id);
  }, [kind, id, flushAudio]);

  useFocusEffect(
    useCallback(() => {
      reset();
      return flushAudio;
    }, [reset, flushAudio]),
  );
  useEffect(() => flushAudio, [flushAudio]);
  // Ending or reopening the record starts a fresh history, locked again.
  const endedBefore = useRef(ended);
  useEffect(() => {
    if (endedBefore.current === ended) return;
    endedBefore.current = ended;
    setUnlockedState(false);
    reset();
  }, [ended, reset]);

  const checkpoint = useCallback(() => {
    const now = snapshotRecord(kind, id);
    if (!now) return;
    if (base.current && !sameSnapshot(base.current, now)) {
      undoStack.current.push(base.current);
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      setUndoCount(undoStack.current.length);
      setRedoCount(0);
    }
    base.current = now;
  }, [kind, id]);

  const step = useCallback(
    (from: { current: RecordSnapshot[] }, to: { current: RecordSnapshot[] }) => {
      const snap = from.current.pop();
      if (!snap) return;
      const now = snapshotRecord(kind, id);
      if (now) to.current.push(now);
      restoreRecordSnapshot(snap);
      base.current = snapshotRecord(kind, id);
      setUndoCount(undoStack.current.length);
      setRedoCount(redoStack.current.length);
    },
    [kind, id],
  );

  const setUnlocked = useCallback(
    (on: boolean) => {
      setUnlockedState(on);
      reset();
      toast(t(on ? 'recordLock.unlockedToast' : 'recordLock.relockedToast'));
    },
    [reset, toast, t],
  );

  const refuse = useCallback(() => {
    if (locked) toast(t('recordLock.lockedToast'));
    return locked;
  }, [locked, toast, t]);

  return {
    locked,
    unlocked,
    setUnlocked,
    refuse,
    checkpoint,
    absorb: () => {
      base.current = snapshotRecord(kind, id);
    },
    undoCount,
    redoCount,
    undo: () => step(undoStack, redoStack),
    redo: () => step(redoStack, undoStack),
    deferAudioDelete: (uri) => {
      pendingAudio.current.push(uri);
    },
  };
}
