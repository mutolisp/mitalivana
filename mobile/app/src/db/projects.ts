import { getUserDb } from './init';
import { PROJECT_FK_TABLES } from './integrityRules';

export type Project = {
  id: number;
  name: string;
  abstract: string | null;
  location_description: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export function listProjects(): Project[] {
  const db = getUserDb();
  const res = db.executeSync(`SELECT * FROM projects ORDER BY id ASC`);
  return ((res.rows ?? []) as unknown) as Project[];
}

export type ProjectWithCounts = Project & {
  session_count: number;
  plot_count: number;
  collection_count: number;
  gloria_count: number;
  miren_count: number;
};

export function listProjectsWithCounts(): ProjectWithCounts[] {
  const db = getUserDb();
  const res = db.executeSync(
    `SELECT p.*,
            (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
            (SELECT COUNT(*) FROM plot_surveys ps WHERE ps.project_id = p.id) AS plot_count,
            (SELECT COUNT(*) FROM collection_trips ct WHERE ct.project_id = p.id) AS collection_count,
            (SELECT COUNT(*) FROM gloria_surveys gs WHERE gs.project_id = p.id) AS gloria_count,
            (SELECT COUNT(*) FROM miren_surveys ms WHERE ms.project_id = p.id) AS miren_count
       FROM projects p
   ORDER BY p.id ASC`,
  );
  return ((res.rows ?? []) as unknown) as ProjectWithCounts[];
}

export function getProject(id: number): Project | null {
  const db = getUserDb();
  const res = db.executeSync(`SELECT * FROM projects WHERE id = ?`, [id]);
  const rows = (res.rows ?? []) as unknown as Project[];
  return rows[0] ?? null;
}

export type ProjectInput = Omit<Project, 'id' | 'created_at' | 'updated_at'>;

export function createProject(input: ProjectInput): number {
  const db = getUserDb();
  const now = Date.now();
  const res = db.executeSync(
    `INSERT INTO projects (name, abstract, location_description, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.name, input.abstract, input.location_description, input.notes, now, now],
  );
  return res.insertId ?? 0;
}

/**
 * Resolve a project by name, for importers that only have the exported name.
 *
 * With `create: true` an unknown name becomes a new project instead of
 * silently collapsing into the uncategorised project (id 0) — the exported
 * `project` field is data the user entered, and dropping it on import loses it
 * for good.
 */
export function resolveProjectIdByName(
  name: string | null | undefined,
  opts: { create?: boolean } = {},
): number {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 0;
  const db = getUserDb();
  const res = db.executeSync(`SELECT id FROM projects WHERE name = ? LIMIT 1`, [trimmed]);
  const found = (res.rows?.[0] as { id?: number } | undefined)?.id;
  if (found !== undefined) return found;
  if (!opts.create) return 0;
  return createProject({ name: trimmed, abstract: null, location_description: null, notes: null });
}

/**
 * The source row's project, or 0 (uncategorised) when that project is gone.
 *
 * `PRAGMA foreign_keys` is ON at runtime (src/db/init.ts), and dangling
 * project ids are only repaired at cold start, so copying one verbatim would
 * raise a constraint error mid-transaction.
 */
export function existingProjectId(projectId: number): number {
  if (!projectId) return 0;
  const res = getUserDb().executeSync(`SELECT 1 FROM projects WHERE id = ? LIMIT 1`, [projectId]);
  return (res.rows?.length ?? 0) > 0 ? projectId : 0;
}

export function updateProject(id: number, input: Partial<ProjectInput>): void {
  const db = getUserDb();
  const fields: string[] = [];
  const params: (string | null)[] = [];
  for (const [k, v] of Object.entries(input)) {
    fields.push(`${k} = ?`);
    params.push(v as string | null);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  const finalParams = [...params, Date.now(), id] as (string | number | null)[];
  db.executeSync(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, finalParams);
}

export function deleteProject(id: number): void {
  if (id === 0) throw new Error('Cannot delete the default 未分類 project');
  const db = getUserDb();
  // Every table with a FK to projects moves to 0 (未分類). A table left out
  // strands its rows under a deleted project — or, with FK enforcement on,
  // makes this delete throw (miren_surveys was missed: data-model audit A1).
  for (const table of PROJECT_FK_TABLES) {
    db.executeSync(`UPDATE ${table} SET project_id = 0 WHERE project_id = ?`, [id]);
  }
  db.executeSync(`DELETE FROM projects WHERE id = ?`, [id]);
}
