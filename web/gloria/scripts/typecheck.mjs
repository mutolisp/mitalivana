/**
 * Type-check the web app's own files.
 *
 * `tsc` follows type imports into mobile/app/src and checks those files too,
 * against this package's shims instead of the real Expo / React Native types,
 * which produces errors that do not exist in the mobile app. Mobile files are
 * the mobile app's responsibility (`cd mobile/app && npx tsc --noEmit`), so
 * only diagnostics in web/gloria fail this check.
 */
import { spawnSync } from 'node:child_process';

const res = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], { encoding: 'utf8' });
const lines = (res.stdout + res.stderr).split('\n');
const own = [];
let mobile = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (!/^\S.*\(\d+,\d+\): error TS/.test(l)) continue;
  if (l.startsWith('../../mobile/')) {
    mobile++;
    continue;
  }
  own.push(l);
  while (lines[i + 1]?.startsWith(' ')) own.push(lines[++i]);
}
if (own.length) {
  console.error(own.join('\n'));
  process.exit(1);
}
console.log(`typecheck ok (${mobile} diagnostics in mobile files ignored; run tsc in mobile/app for those)`);
