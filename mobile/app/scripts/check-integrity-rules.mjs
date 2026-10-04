/**
 * src/db/integrityRules.ts against the schema the migrations actually build.
 * The lists there are what deleteProject, countSiteReferences, purgeOrphanRows
 * and checkIntegrity use; each once missed a newer table (data-model audit
 * A1–A3). Derived from the schema, so a new table fails here until covered:
 *   - every FOREIGN KEY project_id → projects is in PROJECT_FK_TABLES (and back);
 *   - every site_id column pointing at `sites` (FK or not) is in SITE_REF_TABLES;
 *   - every ON DELETE CASCADE edge has an orphan rule naming that column and
 *     parent, or an exemption with a reason; on a nullable column the rule
 *     tests `IS NOT NULL` first, because `NULL NOT IN (<empty>)` is true in
 *     SQLite: with the parent table empty, every row with no parent would be
 *     swept (v83 nearly deleted every census photo that way);
 *   - every ON DELETE SET NULL edge is in NULL_DANGLING;
 *   - every rule runs (valid SQL) on the migrated schema, and parents come
 *     before children in CASCADE_ORPHANS;
 *   - every table keyed by a record is in SYNC_RECORD_TABLES (or exempt), and
 *     every table keyed by a team in TEAM_TABLES; their pending files are retried.
 */
import { migratedDb } from './schema-columns.mjs';
import { readFileSync } from 'node:fs';
import { CASCADE_EXEMPT, CASCADE_ORPHANS, NULL_DANGLING, PROJECT_FK_TABLES, SITE_REF_TABLES, SYNC_RECORD_EXEMPT, SYNC_RECORD_TABLES, TEAM_TABLES } from '../src/db/integrityRules.ts';

const db = await migratedDb();
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
const fks = tables.flatMap((t) => db.prepare(`PRAGMA foreign_key_list("${t}")`).all().map((f) => ({ child: t, from: f.from, parent: f.table, onDelete: f.on_delete })));
const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
const nullable = (t, c) => db.prepare(`PRAGMA table_info("${t}")`).all().some((x) => x.name === c && !x.notnull && !x.pk);

const errors = [];
const projectFks = new Set(fks.filter((f) => f.parent === 'projects').map((f) => f.child));
for (const t of projectFks) if (!PROJECT_FK_TABLES.includes(t)) errors.push(`${t}.project_id → projects is not in PROJECT_FK_TABLES`);
for (const t of PROJECT_FK_TABLES) if (!projectFks.has(t)) errors.push(`PROJECT_FK_TABLES has ${t}, which has no FK to projects`);

for (const t of tables) {
  if (!cols(t).includes('site_id')) continue;
  const fk = fks.find((f) => f.child === t && f.from === 'site_id');
  const toSites = !fk || fk.parent === 'sites';
  if (toSites && !SITE_REF_TABLES.includes(t)) errors.push(`${t}.site_id is not in SITE_REF_TABLES (fk: ${fk?.parent ?? 'none'})`);
  if (!toSites && SITE_REF_TABLES.includes(t)) errors.push(`SITE_REF_TABLES has ${t}, whose site_id points at ${fk.parent}`);
}

for (const f of fks.filter((x) => x.onDelete === 'CASCADE')) {
  const key = `${f.child}.${f.from}`;
  if (CASCADE_EXEMPT[key]) continue;
  const rule = CASCADE_ORPHANS.find(([t, w]) => t === f.child && w.includes(`${f.from} NOT IN (SELECT id FROM ${f.parent})`));
  if (!rule) errors.push(`CASCADE ${key} → ${f.parent} has no rule in CASCADE_ORPHANS (or a reason in CASCADE_EXEMPT)`);
  else if (nullable(f.child, f.from) && !rule[1].includes(`${f.from} IS NOT NULL AND ${f.from} NOT IN (SELECT id FROM ${f.parent})`)) {
    errors.push(`CASCADE ${key} is nullable: its rule must read "${f.from} IS NOT NULL AND ${f.from} NOT IN (…)"`);
  }
}
for (const key of Object.keys(CASCADE_EXEMPT)) {
  const [t, c] = key.split('.');
  if (!fks.some((f) => f.child === t && f.from === c && f.onDelete === 'CASCADE')) errors.push(`CASCADE_EXEMPT ${key} is not a CASCADE key`);
}
for (const f of fks.filter((x) => x.onDelete === 'SET NULL')) {
  if (!NULL_DANGLING.some(([t, c, p]) => t === f.child && c === f.from && p === f.parent)) errors.push(`SET NULL ${f.child}.${f.from} → ${f.parent} is not in NULL_DANGLING`);
}

// Every rule is valid SQL on this schema; a parent is swept before its children.
for (const [t, w] of CASCADE_ORPHANS) {
  try {
    db.prepare(`SELECT COUNT(*) FROM ${t} WHERE ${w}`).get();
  } catch (e) {
    errors.push(`CASCADE_ORPHANS ${t}: ${e.message}`);
  }
}
for (const [t, c, p] of NULL_DANGLING) {
  try {
    db.prepare(`SELECT COUNT(*) FROM ${t} WHERE ${c} IS NOT NULL AND ${c} NOT IN (SELECT id FROM ${p})`).get();
  } catch (e) {
    errors.push(`NULL_DANGLING ${t}.${c}: ${e.message}`);
  }
}
const order = CASCADE_ORPHANS.map(([t]) => t);
for (const [i, [t, w]] of CASCADE_ORPHANS.entries()) {
  for (const m of w.matchAll(/SELECT id FROM (\w+)/g)) {
    const at = order.indexOf(m[1]);
    if (at > i) errors.push(`CASCADE_ORPHANS: ${t} comes before its parent ${m[1]}`);
  }
}

// ── Rows keyed by a record or a team (code review M14, 2026-10-04) ──
// media_pending was in neither list: a deleted record's or a left team's
// files stayed counted on the team page.
{
  const has = (t, ...cs) => cs.every((c) => cols(t).includes(c));
  for (const t of tables) {
    if (has(t, 'record_kind', 'record_uuid') && !SYNC_RECORD_TABLES.includes(t) && !(t in SYNC_RECORD_EXEMPT)) {
      errors.push(`${t} is keyed by (record_kind, record_uuid) but is neither in SYNC_RECORD_TABLES (purged with its record) nor in SYNC_RECORD_EXEMPT`);
    }
    if (has(t, 'team_id') && !TEAM_TABLES.includes(t)) errors.push(`${t} has team_id but is not in TEAM_TABLES (leaveTeam leaves its rows)`);
  }
  for (const t of SYNC_RECORD_TABLES) if (!has(t, 'record_kind', 'record_uuid')) errors.push(`SYNC_RECORD_TABLES has ${t}, which is not keyed by a record`);
  for (const t of TEAM_TABLES) if (!has(t, 'team_id')) errors.push(`TEAM_TABLES has ${t}, which has no team_id`);
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  if (!/\.\.\.SYNC_RECORD_TABLES\.flatMap/.test(src('db/cleanup.ts'))) errors.push('purgeOrphanRows does not sweep SYNC_RECORD_TABLES');
  if (!/\['media_pending', `team_id NOT IN \(SELECT team_id FROM sync_teams\)`\]/.test(src('db/cleanup.ts'))) errors.push('purgeOrphanRows keeps media_pending of a team no longer here');
  if (!/for \(const t of TEAM_TABLES\) db\.executeSync\(`DELETE FROM \$\{t\} WHERE team_id = \?`/.test(src('lib/teamSync.ts'))) errors.push('leaveTeam does not delete from TEAM_TABLES');
  // Every kind that files wait under is retried: the records' (mediaSync) and a census's (censusSync).
  const retry = src('lib/mediaSync.ts').match(/export async function retryPendingMedia[\s\S]*?\n\}/)?.[0] ?? '';
  for (const k of ['session', 'plot', 'gloria', 'modular']) if (!retry.includes(`'${k}'`)) errors.push(`retryPendingMedia skips the files of a ${k}`);
  for (const f of ['lib/teamSync.ts', '../app/settings/team/[id].tsx']) if (!src(f).includes('retryCensusMedia(teamId)')) errors.push(`${f} does not retry a census's files (retryCensusMedia)`);
}
db.close();

if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  process.exit(1);
}
console.log(`✓ integrity rules: ${projectFks.size} project FKs, ${SITE_REF_TABLES.length} site_id tables, ${CASCADE_ORPHANS.length} cascade rules, ${NULL_DANGLING.length} null rules cover the schema`);
