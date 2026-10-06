/**
 * iNaturalist upload bookkeeping on the three record tables (v30 columns) and
 * on casual mode's pending observations (v92, the same columns).
 *
 * Three writes, in the order the upload driver reaches them, so a crash at any
 * point leaves a row that says exactly how far it got:
 *   markInatObservation → the observation exists on the server (id known)
 *   markInatMediaDone   → the first n media items were accepted
 *   markInatUploaded    → everything is up
 *
 * Table names come from the literal map below, never from input — the same
 * justification as `columnsOf` in migrations.ts.
 */
import { getUserDb } from './init';
import type { RecordKind } from './records_list';

/** Record kinds that can hold iNaturalist uploads. GLORIA is left out on
 *  purpose: its plot data belongs in the GLORIA sheet, not on iNaturalist;
 *  a census's trees are tagged plot records, not observations. Checklist /
 *  plot-style surveys have no upload state (inat_* columns) yet. `pending`:
 *  casual mode's observations that have no name yet, uploaded under the
 *  kingdom the user picked (they all form one unit, id 0). */
export type InatKind = Exclude<RecordKind, 'gloria' | 'perm_survey' | 'modular'> | 'pending';

const TABLE: Record<InatKind, string> = {
  session: 'checklist_records',
  plot: 'plot_species_records',
  collection: 'collection_specimens',
  pending: 'pending_observations',
};

export function markInatObservation(kind: InatKind, id: number, observationId: number): void {
  getUserDb().executeSync(
    `UPDATE ${TABLE[kind]} SET inat_observation_id = ?, inat_media_done = 0, inat_uploaded_at = NULL WHERE id = ?`,
    [observationId, id],
  );
}

export function markInatMediaDone(kind: InatKind, id: number, n: number): void {
  getUserDb().executeSync(`UPDATE ${TABLE[kind]} SET inat_media_done = ? WHERE id = ?`, [n, id]);
}

export function markInatUploaded(kind: InatKind, id: number, syncHash: string | null = null): void {
  getUserDb().executeSync(`UPDATE ${TABLE[kind]} SET inat_uploaded_at = ?, inat_sync_hash = ? WHERE id = ?`, [
    Date.now(),
    syncHash,
    id,
  ]);
}
