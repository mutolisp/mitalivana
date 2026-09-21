/**
 * How picked photos become rows.
 *
 * The rules that matter are the ones about absence: a photo with no position
 * must not acquire one, a photo with no time must not silently claim the import
 * ran at the moment it was taken, and a photo with no taxon must not become a
 * record at all.
 *
 * Run: npm run check:photoimport
 */
import { buildPlannedRecords, planPhotoImport } from '../src/lib/photoImport.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};

const meta = (o = {}) => ({ lat: null, lng: null, accuracyM: null, takenAt: null, embedded: null, ...o });
const NOW = 1_800_000_000_000;

const photos = [
  // Ours: names its own taxon, carries its own fix and time.
  { uri: 'file://a.jpg', meta: meta({ lat: 24.1, lng: 121.1, accuracyM: 5, takenAt: 300, embedded: { taxon_id: 't-own' } }) },
  // A camera JPEG: position and time, no idea what it is.
  { uri: 'file://b.jpg', meta: meta({ lat: 24.2, lng: 121.2, takenAt: 100 }) },
  // Shot indoors: no GPS.
  { uri: 'file://c.jpg', meta: meta({ takenAt: 200 }) },
];

const plan = planPhotoImport(photos);
eq('counts: resolved', plan.resolvedCount, 1);
eq('counts: needs a species', plan.needsTaxonCount, 2);
eq('counts: with coordinates', plan.withCoords, 2);
eq('counts: without', plan.withoutCoords, 1);

// ── One species applied to everything that did not name itself ─────────────
const rows = buildPlannedRecords(plan, 't-picked', { kind: 'leave-empty' }, NOW);
eq('one row per photo', rows.length, 3);
eq('rows are oldest first', rows.map((r) => r.observed_at), [100, 200, 300]);
eq('a photo that named itself keeps ITS taxon', rows.find((r) => r.observed_at === 300).taxon_id, 't-own');
eq('the rest take the chosen one', rows.find((r) => r.observed_at === 100).taxon_id, 't-picked');
eq('one photo per row', rows.map((r) => JSON.parse(r.photo_paths).length), [1, 1, 1]);

// The point of the whole feature: each row keeps its OWN position.
eq('positions are per row, not shared', rows.map((r) => r.lat), [24.2, null, 24.1]);
eq('accuracy rides along with the position it belongs to', rows.map((r) => r.accuracy), [null, null, 5]);

// ── Absence must stay absence ─────────────────────────────────────────────
eq('no GPS means no coordinate, not 0,0', rows.find((r) => r.observed_at === 200).lat, null);

const stamped = buildPlannedRecords(plan, 't-picked', { kind: 'fixed', lat: 9, lng: 9, accuracyM: 12 }, NOW);
eq('a supplied position only fills the gaps', stamped.map((r) => r.lat), [24.2, 9, 24.1]);
eq('and never overwrites a photo’s own fix', stamped.find((r) => r.observed_at === 300).lat, 24.1);
eq('a supplied position carries its own accuracy', stamped.find((r) => r.observed_at === 200).accuracy, 12);

// ── A photo with no taxon at all is not a record ──────────────────────────
eq('no embedded taxon and no choice → dropped', buildPlannedRecords(plan, null, { kind: 'leave-empty' }, NOW).length, 1);
eq('the one that survives is the self-naming one',
  buildPlannedRecords(plan, null, { kind: 'leave-empty' }, NOW)[0].taxon_id, 't-own');

// ── No DateTimeOriginal ───────────────────────────────────────────────────
const timeless = planPhotoImport([{ uri: 'file://d.jpg', meta: meta({ lat: 1, lng: 1 }) }]);
eq('falls back to import time only when there is no shutter time',
  buildPlannedRecords(timeless, 't-x', { kind: 'leave-empty' }, NOW)[0].observed_at, NOW);

eq('nothing picked', planPhotoImport([]).items, []);
eq('nothing picked builds nothing', buildPlannedRecords(planPhotoImport([]), 't-x', { kind: 'leave-empty' }, NOW), []);

if (failures > 0) {
  console.error(`✗ photo-import: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ photo-import: one row per photo, each keeping its own position and time');
