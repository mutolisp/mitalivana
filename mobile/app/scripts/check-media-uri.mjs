/**
 * Security audit S1: a record's media text must never make the app read,
 * share, upload or delete a file outside its media folders (user.db, the
 * credentials file, cache snapshots).
 *   - isAllowedMediaUri on Android and iOS directory layouts: media folders
 *     and shared storage yes; Documents root, cache, the app's data root,
 *     another app, `..` and bad escapes no; old-container media re-anchored;
 *   - sanitizeMediaField / sanitizeGloriaDocMedia drop exactly the bad refs;
 *   - only listed files may call rebaseAppFileUri directly (display, sizes,
 *     guarded hashing); everything that reads for export, shares, uploads or
 *     deletes goes through safeAppFileUri / resolveAssetUri.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { isAllowedMediaUri, sanitizeMediaField } from '../src/lib/appMediaUriCore.ts';
import { sanitizeGloriaDocMedia } from '../src/modules/gloria/export/yaml.ts';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};

const ANDROID = { documentDirectory: 'file:///data/user/0/tw.checklister.mobile/files/', cacheDirectory: 'file:///data/user/0/tw.checklister.mobile/cache/' };
const IOS = {
  documentDirectory: 'file:///var/mobile/Containers/Data/Application/AAAA-1111/Documents/',
  cacheDirectory: 'file:///var/mobile/Containers/Data/Application/AAAA-1111/Library/Caches/',
};
const a = (u) => isAllowedMediaUri(u, ANDROID);
const i = (u) => isAllowedMediaUri(u, IOS);

eq('android: photo in media folder', a(`${ANDROID.documentDirectory}photos/abc.jpg`), true);
eq('android: audio and files folders', [a(`${ANDROID.documentDirectory}audio/x.m4a`), a(`${ANDROID.documentDirectory}files/scan.pdf`)], [true, true]);
eq('android: camera photo in shared storage', a('file:///storage/emulated/0/DCIM/Camera/IMG_1.jpg'), true);
eq('android: media library / content uris', [a('content://media/external/images/media/12'), a('ph://ABC')], [true, true]);
eq('android: user.db refused', a(`${ANDROID.documentDirectory}user.db`), false);
eq('android: credentials file refused', a(`${ANDROID.documentDirectory}gbif_credentials.json`), false);
eq('android: nested under media refused', a(`${ANDROID.documentDirectory}photos/sub/x.jpg`), false);
eq('android: cache refused', a(`${ANDROID.cacheDirectory}backup-snapshot-1.db`), false);
eq('android: app data root refused', a('file:///data/user/0/tw.checklister.mobile/databases/x.db'), false);
eq('android: /data/data alias refused', a('file:///data/data/tw.checklister.mobile/files/user.db'), false);
eq('android: another app refused', a('file:///data/user/0/com.other/files/secret'), false);
eq('android: .. refused', a(`${ANDROID.documentDirectory}photos/../user.db`), false);
eq('android: encoded .. refused', a(`${ANDROID.documentDirectory}photos/..%2Fuser.db`), false);
eq('android: bad escape refused', a(`${ANDROID.documentDirectory}photos/%E0%A4%A.jpg`), false);
eq('ios: photo in media folder', i(`${IOS.documentDirectory}photos/abc.heic`), true);
eq('ios: old container media re-anchored', i('file:///var/mobile/Containers/Data/Application/BBBB-2222/Documents/photos/abc.heic'), true);
eq('ios: old container user.db refused', i('file:///var/mobile/Containers/Data/Application/BBBB-2222/Documents/user.db'), false);
eq('ios: current Documents root refused', i(`${IOS.documentDirectory}user.db`), false);
eq('ios: Library refused', i('file:///var/mobile/Containers/Data/Application/AAAA-1111/Library/Preferences/x.plist'), false);
eq('ios: encoded traversal via files/ refused', i('file:///x/files/..%2Fuser.db'), false);

// Field sanitising: single, arrays of strings, arrays of objects.
const good = `${ANDROID.documentDirectory}files/f.pdf`;
const bad = `${ANDROID.documentDirectory}user.db`;
eq('single good kept', sanitizeMediaField(good, a), good);
eq('single bad dropped', sanitizeMediaField(bad, a), null);
eq('string array filtered', sanitizeMediaField(JSON.stringify([good, bad]), a), JSON.stringify([good]));
eq('FileRef array filtered', sanitizeMediaField(JSON.stringify([{ uri: bad, name: 'scan.jpg' }, { uri: good, name: 'f.pdf' }]), a), JSON.stringify([{ uri: good, name: 'f.pdf' }]));
eq('clean array returned unchanged', sanitizeMediaField(JSON.stringify([good]), a), JSON.stringify([good]));
eq('broken JSON dropped', sanitizeMediaField('[{"uri":', a), null);
eq('empty stays empty', [sanitizeMediaField(null, a), sanitizeMediaField('', a)], [null, '']);

// A malicious GLORIA file: every media field pointing at user.db.
const doc = {
  record_type: 'gloria',
  survey: { uuid: 's', overview_photos: JSON.stringify([{ uri: bad, viewpoint: 'N' }]), form1_files: JSON.stringify([{ uri: bad, name: 'scan.jpg' }]), form2_files: null, form3_files: JSON.stringify([{ uri: good, name: 'ok.pdf' }]), form6s_files: null },
  points: [{ point_key: 'p', photo_m2: bad, photo_m2f: good, photo_point: null }],
  units: [{ code: 'N11', uuid: 'u', photo_paths: JSON.stringify([bad]) }],
  photo_checks: [{ item: 'x', checked: 1, photo_uri: bad, updated_at: 1 }],
  logger_visits: [{ uuid: 'v', form4_files: JSON.stringify([{ uri: bad, name: 'f4.jpg' }]), loggers: [{ photo_open_uri: bad, photo_closed_uri: good, data_files: JSON.stringify([{ uri: bad, name: 'd.csv' }]) }] }],
};
const out = sanitizeGloriaDocMedia(doc, a);
const leftovers = JSON.stringify(out).includes('user.db');
eq('malicious GLORIA doc: no reference to user.db survives', leftovers, false);
eq('malicious GLORIA doc: good references kept', [out.survey.form3_files, out.points[0].photo_m2f, out.logger_visits[0].loggers[0].photo_closed_uri], [JSON.stringify([{ uri: good, name: 'ok.pdf' }]), good, good]);

// Only these files may call rebaseAppFileUri directly.
const ALLOWED = new Set([
  'src/lib/appFiles.ts',
  'src/lib/mediaSync.ts', // after isAppMediaAllowed
  'src/lib/exportSize.ts', // size estimate only
  'src/db/recordVersions.ts', // exists check only
  'src/components/AudioClipList.tsx', // playback
  'src/components/SpeciesCard.tsx', // display
  'src/components/PhotoGrid.tsx', // display
  'app/collection/[id].tsx', // display
]);
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
};
walk('src');
walk('app');
for (const f of files) {
  if (ALLOWED.has(f)) continue;
  const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  if (/\brebaseAppFileUri\(/.test(code)) {
    failed++;
    console.error(`✗ ${f} calls rebaseAppFileUri directly — use safeAppFileUri (or add it to the list with a reason)`);
  }
}

if (failed) {
  console.error(`\n${failed} media-uri check(s) failed`);
  process.exit(1);
}
console.log('✓ media uris: only media folders and shared storage are readable; GLORIA imports are sanitised');
