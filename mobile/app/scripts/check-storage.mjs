/**
 * Storage clean-up guard: which stored references keep a photo / recording.
 * A miss here deletes a user's photo, so every reference shape is covered —
 * and every column of the real, migrated schema that looks like it holds media
 * must be listed in MEDIA_COLUMNS (or, with a reason, in NOT_MEDIA).
 *
 * Run: npm run check:storage
 */
import { MEDIA_COLUMNS, NOT_MEDIA, mediaNamesIn } from '../src/lib/mediaNames.ts';
import { schemaColumns } from './schema-columns.mjs';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};
const DOC = 'file:///var/mobile/Containers/Data/Application/0A1B-UUID/Documents/';

eq('plain URI', mediaNamesIn(`${DOC}photos/4f2c.jpg`), ['4f2c.jpg']);
eq('JSON array of photo_paths', mediaNamesIn(JSON.stringify([`${DOC}photos/a.jpg`, `${DOC}photos/b.heic`])), ['a.jpg', 'b.heic']);
eq('stale container path still matches by name', mediaNamesIn('file:///var/mobile/Containers/Data/Application/OLD-UUID/Documents/photos/c.png'), ['c.png']);
eq('percent-encoded name', mediaNamesIn(`${DOC}photos/my%20shot.jpg`), ['my shot.jpg']);
eq('GLORIA overview objects', mediaNamesIn(JSON.stringify([{ uri: `${DOC}photos/ov1.jpg`, viewpoint: 'from S, saddle' }])), ['ov1.jpg']);
eq('audio_paths', mediaNamesIn(JSON.stringify([`${DOC}audio/r1.m4a`])), ['r1.m4a']);
eq('photo library refs are not app files', mediaNamesIn(JSON.stringify(['ph://ABC-123/L0/001', 'ph://DEF'])), []);
eq('mixed library and app photos', mediaNamesIn(JSON.stringify(['ph://X', `${DOC}photos/d.jpg`])), ['d.jpg']);
eq('a folder merely named like photos elsewhere does not count twice', mediaNamesIn(`${DOC}photos/e.jpg`).length, 1);
eq('empty', mediaNamesIn(''), []);

// ── The column list against the real schema (migrations run on node:sqlite) ──
{
  const schema = await schemaColumns();
  const listed = new Set(MEDIA_COLUMNS.map(([t, c]) => `${t}.${c}`));
  const looksLikeMedia = /photo|audio|image|media|uri|file|path|pic/i;
  for (const [table, cols] of schema) {
    for (const col of cols) {
      const key = `${table}.${col}`;
      if (looksLikeMedia.test(col) && !listed.has(key) && !(key in NOT_MEDIA)) {
        failures += 1;
        console.error(`  ✗ ${key} looks like media but is in neither MEDIA_COLUMNS nor NOT_MEDIA (src/lib/mediaNames.ts)`);
      }
    }
  }
  for (const key of listed) {
    const [t, c] = key.split('.');
    if (!schema.get(t)?.has(c)) {
      failures += 1;
      console.error(`  ✗ MEDIA_COLUMNS lists ${key}, which the schema does not have`);
    }
  }
}

if (failures) {
  console.error(`check:storage — ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ storage: every stored media reference shape keeps its file');
