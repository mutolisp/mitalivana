#!/usr/bin/env node
/**
 * Guard src/lib/settingsIndex.ts, the registry the settings tab and its
 * search are built from (03-screens-flow.md §4c).
 *
 * Its keys are read as t(entry.labelKey), which check:i18n cannot see, so a
 * missing one would render as a raw key on the settings page. This checks:
 *
 *   1. every labelKey / descKey / keywordsKey and section title exists in each
 *      complete locale (es-419 holds overrides only and falls back to es);
 *   2. every route resolves to a screen file under app/;
 *   3. every `focus` has a <FocusAnchor id="…"> in that screen or a file it
 *      imports, the screen wraps its scroller in <FocusScrollView>, and the
 *      subpage itself has a registry row (the breadcrumb's parent);
 *   4. every switch / select / action id is wired in app/(tabs)/menu.tsx —
 *      an unwired one crashes (switch) or silently renders nothing (select);
 *   5. ids are unique;
 *   6. each entry's `modes` names only vol / casual, with show / adv / hide.
 *
 * Entries offered only in development builds (the usage-mode row) are checked
 * too: `__DEV__` is set before the registry is imported.
 *
 * Usage: npm run check:settings-index   (exit 1 on violation)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Dynamic, after __DEV__: a static import would run before this line.
globalThis.__DEV__ = true;
const { SECTION_TITLE, SETTINGS_INDEX } = await import('../src/lib/settingsIndex.ts');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es'];
const errors = [];

// ---- 1. i18n keys -------------------------------------------------------
const locales = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(ROOT, `src/i18n/locales/${l}.json`), 'utf8'))]),
);
const lookup = (obj, key) => key.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), obj);
const needKey = (key, where) => {
  for (const l of LOCALES) {
    const v = lookup(locales[l], key);
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${where}: "${key}" missing in ${l}.json`);
  }
};
for (const [section, key] of Object.entries(SECTION_TITLE)) if (key) needKey(key, `section ${section}`);
for (const e of SETTINGS_INDEX) {
  for (const f of ['labelKey', 'descKey', 'keywordsKey']) if (e[f]) needKey(e[f], `${e.id}.${f}`);
}

// ---- 2. routes ----------------------------------------------------------
/** URL path → file, with (group) segments and index dropped, as expo-router does. */
const screens = new Map();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.tsx?$/.test(name) || name.startsWith('_') || name.startsWith('+')) continue;
    const segs = relative(join(ROOT, 'app'), p)
      .replace(/\.tsx?$/, '')
      .split('/')
      .filter((s) => !/^\(.*\)$/.test(s));
    if (segs.at(-1) === 'index') segs.pop();
    screens.set('/' + segs.join('/'), p);
  }
})(join(ROOT, 'app'));

for (const e of SETTINGS_INDEX) {
  if (e.kind === 'nav' && !e.route) errors.push(`${e.id}: nav entry without route`);
  if (e.route && !screens.has(e.route)) errors.push(`${e.id}: route ${e.route} has no screen under app/`);
}

// ---- 3. focus anchors ---------------------------------------------------
/** The file itself plus every local module it imports (one level). */
function withImports(file) {
  const src = readFileSync(file, 'utf8');
  const files = [file];
  for (const m of src.matchAll(/from\s+['"]((?:~\/|\.{1,2}\/)[^'"]+)['"]/g)) {
    const base = m[1].startsWith('~/') ? join(ROOT, 'src', m[1].slice(2)) : resolve(dirname(file), m[1]);
    const hit = ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((x) => base + x).find(existsSync);
    if (hit) files.push(hit);
  }
  return files;
}
for (const e of SETTINGS_INDEX) {
  if (!e.focus) continue;
  const screen = screens.get(e.route);
  if (!screen) continue; // already reported
  if (!SETTINGS_INDEX.some((p) => p.route === e.route && !p.focus)) {
    errors.push(`${e.id}: no registry row for its page ${e.route} (breadcrumb parent)`);
  }
  if (!readFileSync(screen, 'utf8').includes('<FocusScrollView')) {
    errors.push(`${e.id}: ${relative(ROOT, screen)} does not use <FocusScrollView>, so focus=${e.focus} is ignored`);
  }
  const anchor = `<FocusAnchor id="${e.focus}"`;
  if (!withImports(screen).some((f) => readFileSync(f, 'utf8').includes(anchor))) {
    errors.push(`${e.id}: no ${anchor}> in ${relative(ROOT, screen)} or the files it imports`);
  }
}

// ---- 4. menu wiring -----------------------------------------------------
const menu = readFileSync(join(ROOT, 'app/(tabs)/menu.tsx'), 'utf8');
for (const e of SETTINGS_INDEX) {
  const wired =
    e.kind === 'select'
      ? menu.includes(`case '${e.id}':`)
      : e.kind === 'switch' || e.kind === 'action'
        ? new RegExp(`^\\s+${e.id}: `, 'm').test(menu)
        : true;
  if (!wired) errors.push(`${e.id}: ${e.kind} not wired in app/(tabs)/menu.tsx`);
}

// ---- 5. unique ids ------------------------------------------------------
const seen = new Set();
for (const e of SETTINGS_INDEX) {
  if (seen.has(e.id)) errors.push(`${e.id}: duplicate id`);
  seen.add(e.id);
}

// ---- 6. usage-mode visibility --------------------------------------------
for (const e of SETTINGS_INDEX) {
  for (const [m, v] of Object.entries(e.modes ?? {})) {
    if (m !== 'vol' && m !== 'casual') errors.push(`${e.id}: modes.${m} is not a simplified mode (pro always shows)`);
    if (!['show', 'adv', 'hide'].includes(v)) errors.push(`${e.id}: modes.${m} = ${JSON.stringify(v)}`);
  }
}

if (errors.length) {
  console.error(`✗ settings index: ${errors.length} problem(s)`);
  for (const m of errors) console.error('  ' + m);
  process.exit(1);
}
console.log(`✓ settings index: ${SETTINGS_INDEX.length} entries, keys in ${LOCALES.length} locales, routes and anchors resolve`);
