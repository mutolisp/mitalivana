#!/usr/bin/env node
/**
 * The piecewise zip writer (src/lib/zipWriter.ts) must write what fflate's
 * zipSync wrote before it — every export and backup leaves through it:
 *
 *   - stored files: byte for byte the same archive as zipSync;
 *   - deflated files: the same headers field by field (names, order, flags,
 *     method, time, CRC, sizes before the data, no data descriptors); only
 *     the deflate stream and so the compressed sizes and offsets differ;
 *   - every file reads back intact with fflate, `unzip -t` and Python's
 *     zipfile;
 *   - progress counts the input bytes up to the total;
 *   - names handed out for one zip never repeat (src/lib/zipEntryNames.ts):
 *     many sources in one folder, a hand-set name meeting a numbered one,
 *     two records with the same folder name (code review H7, H8).
 *
 * Usage: npm run check:zip-writer   (exit 1 on violation)
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { zipInPieces } from '../src/lib/zipWriter.ts';
import { createEntryNamer, createFolderNamer, moveUnder, withSuffix } from '../src/lib/zipEntryNames.ts';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
console.log('check:zip-writer');

const MTIME = new Date(2026, 9, 2, 14, 30, 12).getTime();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const rows = [];
for (let i = 0; i < 12000; i++) rows.push(`{"uuid":"${crypto.randomUUID()}","tag":"${i}","dbh":${(Math.random() * 50).toFixed(1)},"name":"樟科 Lauraceae"}`);
const big = strToU8(rows.join('\n'));
const noise = new Uint8Array(randomBytes(300_000));
const files = [
  { name: 'P25_2/P25_2.yml', bytes: big },
  { name: 'P25_2/census.csv', bytes: strToU8('tag,dbh\n1,2.5\n') },
  { name: 'P25_2/empty.txt', bytes: new Uint8Array(0) },
  { name: 'P25_2/樹種.csv', bytes: strToU8('樟科,Lauraceae\n') },
  { name: 'P25_2/photos/a.jpg', bytes: noise, level: 0 },
];

/** Central directory entries: every header field, with where the data starts. */
function central(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let e = zip.length - 22;
  if (v.getUint32(e, true) !== 0x06054b50) throw new Error('no end record');
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header');
    const nameLen = v.getUint16(p + 28, true);
    const off = v.getUint32(p + 42, true);
    const local = {
      sig: v.getUint32(off, true),
      version: v.getUint16(off + 4, true),
      flags: v.getUint16(off + 6, true),
      method: v.getUint16(off + 8, true),
      time: v.getUint32(off + 10, true),
      crc: v.getUint32(off + 14, true),
      csize: v.getUint32(off + 18, true),
      size: v.getUint32(off + 22, true),
      nameLen: v.getUint16(off + 26, true),
      extra: v.getUint16(off + 28, true),
    };
    out.push({
      name: new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)),
      made: v.getUint16(p + 4, true),
      version: v.getUint16(p + 6, true),
      flags: v.getUint16(p + 8, true),
      method: v.getUint16(p + 10, true),
      time: v.getUint32(p + 12, true),
      crc: v.getUint32(p + 16, true),
      csize: v.getUint32(p + 20, true),
      size: v.getUint32(p + 24, true),
      extra: v.getUint16(p + 30, true),
      comment: v.getUint16(p + 32, true),
      disk: v.getUint16(p + 34, true),
      internal: v.getUint16(p + 36, true),
      external: v.getUint32(p + 38, true),
      local,
    });
    p += 46 + nameLen;
  }
  return out;
}
const withoutSizes = (h) => {
  const { csize, local, ...rest } = h;
  const { csize: lc, ...l } = local;
  return { ...rest, local: l };
};

// ── 1. stored files: the same archive as zipSync ──────────────────────────
{
  const ours = await zipInPieces(files, { level: 0, mtime: MTIME });
  const theirs = zipSync(Object.fromEntries(files.map((f) => [f.name, f.bytes])), { level: 0, mtime: MTIME });
  ok(same(ours, theirs), 'stored: byte for byte the archive zipSync writes', `${ours.length} vs ${theirs.length} bytes`);
}

// ── 2. deflated: the same headers, only the stream differs ────────────────
const ours = await zipInPieces(files, { level: 6, mtime: MTIME });
const theirs = zipSync(Object.fromEntries(files.map((f) => [f.name, f.level === 0 ? [f.bytes, { level: 0 }] : f.bytes])), { level: 6, mtime: MTIME });
{
  const a = central(ours);
  const b = central(theirs);
  ok(a.length === files.length && a.map((h) => h.name).join('|') === b.map((h) => h.name).join('|'), 'deflated: the same files in the same order');
  ok(JSON.stringify(a.map(withoutSizes)) === JSON.stringify(b.map(withoutSizes)), 'deflated: every header field the same except the compressed size', JSON.stringify(a.map(withoutSizes)[0]));
  ok(a.every((h) => (h.local.flags & 8) === 0 && h.local.csize === h.csize && h.local.size === h.size), 'deflated: sizes in the local headers, no data descriptors');
  ok(a.find((h) => h.name.endsWith('.jpg')).method === 0 && a.find((h) => h.name.endsWith('.yml')).method === 8, "deflated: a file's own level 0 stores it");
  ok(a.find((h) => h.name.includes('樹種')).flags === 0x800 && a.find((h) => h.name.endsWith('.yml')).flags === 0, 'deflated: the UTF-8 flag only on the non-ASCII name');
  const growth = ours.length / theirs.length - 1;
  ok(growth < 0.01, `deflated: within 1 % of zipSync's size (${(growth * 100).toFixed(2)} %)`);
}

// ── 3. reads back everywhere ──────────────────────────────────────────────
{
  const back = unzipSync(ours);
  ok(files.every((f) => back[f.name] && same(back[f.name], f.bytes)), 'fflate unzipSync: every file intact');
  const dir = mkdtempSync(join(tmpdir(), 'zipw-'));
  const path = join(dir, 'a.zip');
  writeFileSync(path, ours);
  const unzip = spawnSync('unzip', ['-t', path], { encoding: 'utf8' });
  ok(unzip.status === 0 && /No errors detected/.test(unzip.stdout), 'unzip -t: no errors', unzip.stdout.split('\n').slice(-3).join(' '));
  const py = spawnSync('python3', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(len(z.namelist()))', path], { encoding: 'utf8' });
  ok(py.status === 0 && py.stdout.trim() === `None\n${files.length}`, "python zipfile: testzip finds nothing", py.stdout + py.stderr);
  rmSync(dir, { recursive: true, force: true });
}

// ── 4. progress ───────────────────────────────────────────────────────────
{
  const seen = [];
  await zipInPieces(files, { level: 6, mtime: MTIME }, (done, total) => {
    seen.push([done, total]);
  });
  const total = files.reduce((a, f) => a + f.bytes.length, 0);
  ok(seen.length > 3, `progress: reported in pieces (${seen.length})`);
  ok(seen.every(([, t]) => t === total) && seen.every(([d], i) => i === 0 || d >= seen[i - 1][0]), 'progress: rises towards the input total');
  ok(seen[seen.length - 1][0] === total, 'progress: ends at the total');
  const empty = await zipInPieces([], { level: 6, mtime: MTIME });
  ok(same(empty, zipSync({}, { level: 6, mtime: MTIME })), 'an empty archive is the same as zipSync');
}

{
  // One zip's names (code review H7, H8).
  const n = createEntryNamer();
  const day = 'pending_2026-10-06_Plantae';
  // Two pending observations of one day, one photo each: two sources, one folder.
  const a = n.numbered(day, 'env', 'jpg');
  const b = n.numbered(day, 'env', 'jpg');
  ok(a === `${day}/env_1.jpg` && b === `${day}/env_2.jpg`, 'names: numbering runs across sources sharing a folder', `${a} ${b}`);
  ok(n.numbered('other', 'env', 'jpg') === 'other/env_1.jpg', 'names: another folder counts from 1');
  ok(n.claim(`${day}/env_1.jpg`) === `${day}/env_1-2.jpg`, 'names: a hand-set name meeting a numbered one gets -2 before the extension');
  ok(n.claim('f/Form2_scan.pdf') === 'f/Form2_scan.pdf' && n.claim('f/Form2_scan.pdf') === 'f/Form2_scan-2.pdf', 'names: the same attachment name twice');
  ok(withSuffix('TW.01/readme', '-2') === 'TW.01/readme-2' && withSuffix('a/b.tar.gz', '-2') === 'a/b.tar-2.gz', 'names: suffix goes before the last segment\'s extension only');
  const f = createFolderNamer();
  const first = f('P01_Proj');
  const second = f('P01_Proj');
  ok(first === 'P01_Proj' && second === 'P01_Proj_2' && f('P01_Proj') === 'P01_Proj_3', 'folders: a resurvey with the same plotid gets _2, _3');
  ok(moveUnder('P01_Proj/P01_Proj.yml', 'P01_Proj', 'P01_Proj_2') === 'P01_Proj_2/P01_Proj.yml', 'folders: entries move under the new folder');
  ok(moveUnder('P01_Proj_x/a.yml', 'P01_Proj', 'P01_Proj_2') === 'P01_Proj_x/a.yml', 'folders: a folder that only starts with the name is left alone');
  // The zips built from many sources take their names from the namer (text check).
  const src = (f) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8');
  const backup = src('backup.ts');
  ok(backup.includes('names.numbered(') && !/_\$\{i \+ 1\}/.test(backup), 'photo backup: numbered by the shared namer, not per source');
  const many = src('bundleExport.ts');
  ok(/const folder = place\(await build\w+Entries\(/.test(many) && !/for \(const e of entries\) allEntries\.push\(e\)/.test(many), 'multi-record export: every record folder goes through place()');
  ok(src('projectExport.ts').includes('claimFolder(folderName)'), 'project export: record folders go through the folder namer');
}

if (failed > 0) {
  console.error(`\n✗ check:zip-writer: ${failed} failed`);
  process.exit(1);
}
console.log('\n✓ check:zip-writer');
