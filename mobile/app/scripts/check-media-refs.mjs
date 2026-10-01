/**
 * Files carried by team sync, the pure rules (src/lib/mediaRefsCore.ts):
 *   - every synced media column has a storage kind, and every column the
 *     storage page counts as media (MEDIA_COLUMNS) that belongs to a synced
 *     record kind is covered;
 *   - reading a column value: lists, single files, GLORIA overview photos
 *     (with viewpoint), attachments (with name);
 *   - receiving ADDS only: a file already there (same content) is not added
 *     twice, a filled single-file column is not replaced, notes travel;
 *   - a received manifest keeps only well-formed entries for known columns;
 *   - downloaded files land in photos/, audio/ or files/ by extension.
 */
import { MEDIA_COLUMN_KINDS, folderFor, itemsIn, readMediaManifest, withAddition } from '../src/lib/mediaRefsCore.ts';
import { MEDIA_COLUMNS } from '../src/lib/mediaNames.ts';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};

// Collections are not team-synced; MIREN is not a sync kind yet; the tree
// census (fw_media) syncs per block from Phase 1C — take it off then.
const NOT_SYNCED = ['collection_specimens', 'photo_fix', 'miren_plots', 'fw_media'];
const missing = MEDIA_COLUMNS.filter(([t, c]) => !NOT_SYNCED.includes(t) && !(`${t}.${c}` in MEDIA_COLUMN_KINDS)).map(([t, c]) => `${t}.${c}`);
eq('every media column of a synced record kind is carried', missing, []);

const has = (set) => (u) => set.includes(u);
eq('list: read', itemsIn('list', '["a","b",3]'), [{ uri: 'a' }, { uri: 'b' }]);
eq('list: adds a new file at the end', withAddition('list', '["a"]', 'c', undefined, has([])), '["a","c"]');
eq('list: a file with the same content already there is not added twice', withAddition('list', '["a"]', 'c', undefined, has(['a'])), null);
eq('list: empty column', withAddition('list', null, 'c', undefined, has([])), '["c"]');
eq('single: fills an empty column', withAddition('single', null, 'x', undefined, has([])), 'x');
eq('single: never replaces what is there', withAddition('single', 'mine', 'x', undefined, has([])), null);
eq('overview: viewpoint travels with the photo', withAddition('overview', '[{"uri":"a","viewpoint":"S"}]', 'b', { viewpoint: '從北方鞍部' }, has([])), '[{"uri":"a","viewpoint":"S"},{"uri":"b","viewpoint":"從北方鞍部"}]');
eq('overview: read with viewpoints', itemsIn('overview', '[{"uri":"a","viewpoint":"S"},{"x":1}]'), [{ uri: 'a', meta: { viewpoint: 'S' } }]);
eq('files: the attachment keeps its name', withAddition('files', null, 'file:///d/files/1.pdf', { name: 'Form2 E.pdf' }, has([])), '[{"uri":"file:///d/files/1.pdf","name":"Form2 E.pdf","size":null}]');
eq('files: read with names', itemsIn('files', '[{"uri":"u","name":"n.pdf","size":3}]'), [{ uri: 'u', meta: { name: 'n.pdf' } }]);

const sha = 'a'.repeat(64);
const mid = 'b'.repeat(32);
const good = { ref: { t: 'gloria_units', k: 'N31', c: 'photo_paths' }, sha, mid, size: 12, name: 'x.jpg' };
eq('manifest: well-formed entries kept, notes kept', readMediaManifest([good, { ...good, meta: { viewpoint: 'N', evil: 1 } }]), [good, { ...good, meta: { viewpoint: 'N' } }]);
eq('manifest: unknown column, bad hashes, bad size dropped', readMediaManifest([
  { ...good, ref: { t: 'sessions', k: '', c: 'name' } },
  { ...good, sha: 'zz' },
  { ...good, mid: 'B'.repeat(32) },
  { ...good, size: -1 },
  null,
]), []);
eq('manifest: not an array → nothing', readMediaManifest({ a: 1 }), []);
eq('folders by extension', ['a.JPG', 'b.heic', 'c.m4a', 'd.pdf', 'e'].map(folderFor), ['photos', 'photos', 'audio', 'files', 'files']);

if (failed) {
  console.error(`check:media-refs — ${failed} failed`);
  process.exit(1);
}
console.log('✓ media-refs: every synced media column covered, additions only, manifest parsing, folders');
