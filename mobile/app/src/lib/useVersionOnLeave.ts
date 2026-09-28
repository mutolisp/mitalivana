/**
 * Snapshot a record when its screen loses focus (record versions, v73):
 * leaving it, or opening another screen over it. Deferred past the transition
 * so navigation does not wait; an unchanged record stores nothing, and leaves
 * within 30 minutes of each other extend one version (recordVersionsCore).
 */
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { saveVersionSoon } from '~/db/recordVersions';
import type { MergeKind } from './mergeDocs';

export function useVersionOnLeave(kind: MergeKind, id: number): void {
  useFocusEffect(
    useCallback(
      () => () => {
        if (Number.isFinite(id) && id > 0) saveVersionSoon(kind, id, 'leave');
      },
      [kind, id],
    ),
  );
}
