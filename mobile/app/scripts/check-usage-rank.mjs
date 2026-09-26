/**
 * Species search ordered by the user's own records (setting search_usage_rank,
 * src/lib/usageRank.ts):
 *   - an exact match (common / scientific / alternative name) is always first,
 *     however rarely used;
 *   - after it, more-recorded taxa first; ties keep the search's order;
 *   - the counting SQL runs on the real migrated schema and counts every
 *     record type, GLORIA included (through its roster).
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import { rankByUsage, usedMatching, isExactMatch, USAGE_COUNTS_SQL } from '../src/lib/usageRank.ts';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};

const R = (id, cname, name, alt = '') => ({ taxon_id: id, _raw_cname: cname, name, alternative_name_c: alt });
const results = [R('t1', '芒', 'Miscanthus sinensis'), R('t2', '五節芒', 'Miscanthus floridulus'), R('t3', '高山芒', 'Miscanthus transmorrisonensis'), R('t4', '白背芒', 'Miscanthus sinensis var. glaber')];
const counts = new Map([['t3', 40], ['t2', 5], ['t4', 5]]);
eq('exact match stays first even with 0 records', rankByUsage(results, '芒', counts).map((r) => r.taxon_id), ['t1', 't3', 't2', 't4']);
eq('no exact match: by count, ties keep order', rankByUsage(results.slice(1), '芒', counts).map((r) => r.taxon_id), ['t3', 't2', 't4']);
eq('scientific name exact, case-insensitive', isExactMatch(R('t9', '', 'Festuca ovina'), 'festuca ovina'), true);
eq('alternative name exact', isExactMatch(R('t9', '羊茅', 'Festuca ovina', '酥油草、狐茅'), '狐茅'), true);
eq('substring is not exact', isExactMatch(R('t2', '五節芒', 'x'), '芒'), false);
eq('nothing used: order unchanged', rankByUsage(results, '白', new Map()).map((r) => r.taxon_id), ['t1', 't2', 't3', 't4']);
eq('used taxa matching the query, most used first',
  usedMatching([{ taxon_id: 'a', n: 2, names: ['玉山箭竹'] }, { taxon_id: 'b', n: 9, names: ['箭竹'] }, { taxon_id: 'c', n: 50, names: ['芒'] }], '箭竹', 5).map((u) => u.taxon_id),
  ['b', 'a']);

// ── the count query on the real schema ──
const sqlite = new DatabaseSync(':memory:');
await runUserMigrations({
  executeSync(sql, params = []) {
    const st = sqlite.prepare(sql);
    try { return { rows: st.all(...params) }; } catch { const r = st.run(...params); return { rows: [], insertId: Number(r.lastInsertRowid) }; }
  },
});
const ins = (table, vals) => {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  const row = {};
  for (const c of cols) if (!c.pk && c.notnull && c.dflt_value == null) row[c.name] = /INT|REAL/i.test(c.type) ? 1 : `${table}-${c.name}`;
  Object.assign(row, vals);
  const k = Object.keys(row);
  return Number(sqlite.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => row[x])).lastInsertRowid);
};
const sid = ins('sessions', { name: 'S' });
ins('checklist_records', { session_id: sid, taxon_id: 't1' });
ins('checklist_records', { session_id: sid, taxon_id: 't1' });
const pid = ins('plot_surveys', { plotid: 'P' });
ins('plot_species_records', { plot_survey_id: pid, taxon_id: 't1', layer: 'E1' });
const cid = ins('collection_trips', { name: 'C' });
ins('collection_specimens', { trip_id: cid, taxon_id: 't2' });
const summit = ins('gloria_summits', {});
const gs = ins('gloria_surveys', { summit_id: summit });
const unit = ins('gloria_units', { survey_id: gs, code: 'N11', unit_type: 'quadrat' });
const gt = ins('gloria_taxa', { survey_id: gs, taxon_id: 't2', serial: 1 });
ins('gloria_unit_species', { unit_id: unit, gloria_taxon_id: gt, occurrence_id: 'o1' });
ins('taxon_name_cache', { taxon_id: 't1', dataset_id: 'tw', simple_name: 'Miscanthus sinensis', common_name_c: '芒' });
const rows = sqlite.prepare(USAGE_COUNTS_SQL).all().sort((a, b) => a.taxon_id.localeCompare(b.taxon_id));
eq('counts over checklist + plot + collection + GLORIA', rows.map((r) => [r.taxon_id, r.n]), [['t1', 3], ['t2', 2]]);
eq('names joined from the name cache', rows[0].cname, '芒');

if (failed) {
  console.error(`check:usage-rank — ${failed} failed`);
  process.exit(1);
}
console.log('✓ usage-rank: exact first, then most recorded; counts span every record type');
