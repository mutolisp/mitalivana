#!/usr/bin/env node
/**
 * decodeUtf8 (src/lib/utf8.ts) reads every imported record file, so it must
 * give exactly what TextDecoder gives for valid UTF-8 — ASCII, CJK, emoji
 * (surrogate pairs), a leading BOM, runs across its internal pieces — and
 * null for anything else, so the caller falls back to TextDecoder.
 *
 * Usage: npm run check:utf8   (exit 1 on violation)
 */
import { decodeUtf8 } from '../src/lib/utf8.ts';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
console.log('check:utf8');

const enc = new TextEncoder();
const td = new TextDecoder();
const firstDiff = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `at ${i}: ${JSON.stringify(a.slice(i, i + 12))} vs ${JSON.stringify(b.slice(i, i + 12))}`;
  return '';
};
const agrees = (label, bytes) => {
  const want = td.decode(bytes);
  const got = decodeUtf8(bytes);
  ok(got === want, label, got == null ? 'null' : firstDiff(got, want));
};

// ── valid text ────────────────────────────────────────────────────────────
agrees('empty', new Uint8Array(0));
agrees('ASCII', enc.encode('{"tag":"1-1","dbh":12.5}'));
agrees('2-, 3- and 4-byte characters', enc.encode('é ñ ß 樟科 Lauraceae 学名 調査区 𠀀 🌳 𩸽'));
agrees('a leading BOM is dropped', new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('樹號,tag\n')]));
agrees('a BOM later on stays', enc.encode('a﻿b'));
agrees('the largest code points', enc.encode('\u{10FFFF}￿߿ࠀ\u0080'));
{
  // Long and mixed: ASCII runs longer and shorter than the internal pieces,
  // multi-byte characters on every boundary.
  const pool = ['a', 'Z', '0', ' ', '\n', '"', 'é', '樟', '科', '学', '🌳', '𠀀', 'ж', 'ا'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const [n, label] of [[20_000, 'random mix, 20 000 characters'], [300_000, 'random mix, 300 000 characters']]) {
    let s = '';
    for (let i = 0; i < n; i++) s += rnd() < 0.7 ? 'abcdefghij'.slice(0, 1 + Math.floor(rnd() * 10)) : pool[Math.floor(rnd() * pool.length)];
    agrees(label, enc.encode(s));
  }
  agrees('ASCII longer than a piece, then CJK', enc.encode('x'.repeat(8191) + '樟' + 'y'.repeat(20_000) + '🌳'));
  agrees('short ASCII runs across a piece boundary', enc.encode(('é' + 'abcdefghij').repeat(3000)));
  const census = JSON.stringify({ trees: Array.from({ length: 3000 }, (_, i) => ({ uuid: crypto.randomUUID(), tag: String(i), name: i % 7 ? null : '樟樹 Cinnamomum camphora', notes: i % 11 ? '' : '枯梢；萌櫱 🌱' })) });
  agrees('a census-like export', enc.encode(census));
}

// ── not UTF-8: null, the caller falls back ────────────────────────────────
const bad = (label, bytes) => ok(decodeUtf8(new Uint8Array(bytes)) === null, `invalid → null: ${label}`);
bad('a lone continuation byte', [0x61, 0x80, 0x62]);
bad('an overlong 2-byte form', [0xc0, 0xaf]);
bad('an overlong 3-byte form', [0xe0, 0x80, 0xaf]);
bad('an overlong 4-byte form', [0xf0, 0x80, 0x80, 0xaf]);
bad('a UTF-16 surrogate', [0xed, 0xa0, 0x80]);
bad('beyond U+10FFFF', [0xf4, 0x90, 0x80, 0x80]);
bad('F5 and above', [0xf5, 0x80, 0x80, 0x80]);
bad('cut off at the end', [0x61, 0xe6, 0xa8]);
bad('a missing continuation', [0xe6, 0x61, 0x80]);
bad('Latin-1 text', [...enc.encode('caf'), 0xe9]);

if (failed > 0) {
  console.error(`\n✗ check:utf8: ${failed} failed`);
  process.exit(1);
}
console.log('\n✓ check:utf8');
