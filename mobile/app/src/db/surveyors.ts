import { getUserDb } from './init';

/**
 * Two lists of people, one shape.
 *
 * `surveyors` (v15) are DwC recordedBy — who made the observation or collected
 * the specimen. `identifiers` (v38) are DwC identifiedBy — who determined it.
 * The same person is often on both lists, which is exactly why they are two
 * tables and not one with a role column (see the v38 migration).
 *
 * The table name is interpolated into the SQL. It can only ever be one of the
 * two literals below — never user input — the same rule `columnsOf` in
 * migrations.ts follows for its PRAGMA.
 */
export type PersonKind = 'surveyor' | 'identifier';

const TABLE: Record<PersonKind, string> = {
  surveyor: 'surveyors',
  identifier: 'identifiers',
};

/** A common surveyor (DwC recordedBy). `is_default` ones auto-fill new records. */
export type Surveyor = {
  id: number;
  name: string;
  is_default: boolean;
  sort_order: number;
  created_at: number;
};

/** A preferred identifier (DwC identifiedBy). Same shape as `Surveyor`; the
 *  alias exists so call sites read as what they are about. */
export type Identifier = Surveyor;

export function listPeople(kind: PersonKind): Surveyor[] {
  const res = getUserDb().executeSync(
    `SELECT id, name, is_default, sort_order, created_at
       FROM ${TABLE[kind]} ORDER BY sort_order ASC, name ASC;`,
  );
  return ((res.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as number,
    name: (row.name as string) ?? '',
    is_default: row.is_default === 1,
    sort_order: (row.sort_order as number) ?? 0,
    created_at: (row.created_at as number) ?? 0,
  }));
}

/** Add a person (no-op if the name already exists). Returns the row id. */
export function addPerson(kind: PersonKind, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return 0;
  const db = getUserDb();
  db.executeSync(`INSERT OR IGNORE INTO ${TABLE[kind]} (name, created_at) VALUES (?, ?);`, [
    trimmed,
    Date.now(),
  ]);
  const res = db.executeSync(`SELECT id FROM ${TABLE[kind]} WHERE name = ? LIMIT 1;`, [trimmed]);
  return ((res.rows?.[0]?.id as number) ?? 0) || 0;
}

export function renamePerson(kind: PersonKind, id: number, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  getUserDb().executeSync(`UPDATE ${TABLE[kind]} SET name = ? WHERE id = ?;`, [trimmed, id]);
}

export function removePerson(kind: PersonKind, id: number): void {
  getUserDb().executeSync(`DELETE FROM ${TABLE[kind]} WHERE id = ?;`, [id]);
}

export function setPersonDefault(kind: PersonKind, id: number, on: boolean): void {
  getUserDb().executeSync(`UPDATE ${TABLE[kind]} SET is_default = ? WHERE id = ?;`, [
    on ? 1 : 0,
    id,
  ]);
}

/** Persist a new ordering: `sort_order` = position in `ids` (drag-to-reorder). */
export function reorderPeople(kind: PersonKind, ids: number[]): void {
  const db = getUserDb();
  ids.forEach((id, i) => {
    db.executeSync(`UPDATE ${TABLE[kind]} SET sort_order = ? WHERE id = ?;`, [i, id]);
  });
}

export function getDefaultNames(kind: PersonKind): string[] {
  const res = getUserDb().executeSync(
    `SELECT name FROM ${TABLE[kind]} WHERE is_default = 1 ORDER BY sort_order ASC, name ASC;`,
  );
  return ((res.rows ?? []) as Array<Record<string, unknown>>).map((r) => (r.name as string) ?? '');
}

/** Comma-joined default names for auto-filling a record on create. Returns null
 *  when no default is set (so the column stays NULL). */
export function defaultPersonString(kind: PersonKind): string | null {
  const names = getDefaultNames(kind);
  return names.length ? names.join(', ') : null;
}

// ── surveyor-named wrappers ─────────────────────────────────────────────────
// Kept so the call sites that predate the identifier list read unchanged.

export function listSurveyors(): Surveyor[] {
  return listPeople('surveyor');
}

export function addSurveyor(name: string): number {
  return addPerson('surveyor', name);
}

export function renameSurveyor(id: number, name: string): void {
  renamePerson('surveyor', id, name);
}

export function removeSurveyor(id: number): void {
  removePerson('surveyor', id);
}

export function setSurveyorDefault(id: number, on: boolean): void {
  setPersonDefault('surveyor', id, on);
}

export function reorderSurveyors(ids: number[]): void {
  reorderPeople('surveyor', ids);
}

export function getDefaultSurveyorNames(): string[] {
  return getDefaultNames('surveyor');
}

export function defaultSurveyorString(): string | null {
  return defaultPersonString('surveyor');
}

/** Comma-joined default identifiers, for a new specimen's `identified_by`. */
export function defaultIdentifierString(): string | null {
  return defaultPersonString('identifier');
}
