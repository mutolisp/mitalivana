/**
 * Web stand-in for mobile/app/src/db/recordVersions.ts.
 *
 * The real module pulls in every record kind (plots, sessions, census, team
 * merge, team crypto) to restore any of them; GLORIA's db.ts only calls
 * `saveVersion('gloria', id, 'before_delete')` lazily from deleteGloriaSurvey.
 * Record versions are a later phase on the web, so these are no-ops for now:
 * deleting a survey keeps no version — the UI must confirm and offer an
 * export first.
 */
export type VersionKind = string;
export type VersionReason = string;

export function saveVersion(_kind: VersionKind, _id: number, _reason: VersionReason, _note: string | null = null): boolean {
  return false;
}

export function saveVersionByUuid(_kind: VersionKind, _uuid: string, _reason: VersionReason): boolean {
  return false;
}

export function saveVersionSoon(_kind: VersionKind, _id: number, _reason: VersionReason): void {}
