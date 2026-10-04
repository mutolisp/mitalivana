#!/usr/bin/env node
/**
 * Action sheets draw in an <ActionSheetLayer /> (07-action-sheet.md §2.4), a
 * plain overlay, not a Modal. An RN <Modal> covers the root layer, so a sheet
 * asked for from inside one would open behind it — the screen dims under the
 * Modal and nothing can be tapped. Hence, in every .tsx file:
 *
 *   - each <Modal> ends with <ActionSheetLayer /> as its last child, given
 *     the Modal's own visible={…} when it has one: iOS keeps a closed
 *     Modal's children until the slide-out ends, and a sheet asked for in
 *     that time would open in the Modal going away and be cancelled unseen
 *     (the conflict question after ＋ 建立記錄, 2026-10-04);
 *   - each Modal's onRequestClose goes through sheetBack(…): Android back
 *     inside a Modal reaches only that prop, never BackHandler, so without it
 *     back would close the Modal under an open sheet instead of the sheet;
 *   - nothing calls ActionSheetIOS (the old iOS path; new iOS draws it as a
 *     centred glass menu).
 *
 * A file may opt out with a header comment `// sheet-layer-ignore: <reason>`.
 *
 * Text check, like check-bottom-dock / check-modal-lookup: the failure is a
 * Modal written without its layer, visible in the file itself. It also runs
 * the sheet's layout rules (src/lib/actionSheetCore.ts) on fixtures.
 *
 * Run: npm run check:sheet-layer
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldSearch, isConfirmation, layoutSheet, markMatch, pushRecent, searchShown } from '../src/lib/actionSheetCore.ts';
import { joinParts, morphoParts, occurrenceParts, partsText, sentenceParts, slot, speciesParts } from '../src/lib/nameParts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) files.push(p);
  }
};
walk(join(root, 'src'));
walk(join(root, 'app'));

/** Comments blanked out (lengths kept), so a `<Modal>` in prose is not a Modal. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
}

/** The end of the JSX opening tag starting at `i` (braces and strings skipped). */
function tagEnd(src, i) {
  let depth = 0;
  let quote = null;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = null;
    } else if (depth > 0 && (ch === "'" || ch === '"' || ch === '`')) quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return j + 1;
  }
  return src.length;
}

/** A tag's `visible={…}` expression (braces balanced), or null (absent, or the bare `visible`). */
function visibleExpr(tag) {
  const m = tag.match(/\svisible=\{/);
  if (!m) return null;
  let depth = 1;
  let j = m.index + m[0].length;
  const start = j;
  for (; j < tag.length && depth; j++) {
    if (tag[j] === '{') depth++;
    else if (tag[j] === '}') depth--;
  }
  return tag.slice(start, j - 1).trim();
}

const squash = (s) => s.replace(/\s+/g, '');

let failures = 0;
const fail = (rel, src, index, msg) => {
  failures += 1;
  const line = src.slice(0, index).split('\n').length;
  console.error(`  ✗ ${rel}:${line} ${msg}`);
};

for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const rel = relative(root, f);
  if (/^\s*\/\/ sheet-layer-ignore: \S/m.test(raw)) continue;
  const src = stripComments(raw);
  if (/\bActionSheetIOS\b/.test(src)) fail(rel, src, src.search(/\bActionSheetIOS\b/), 'calls ActionSheetIOS (use showActionSheet)');
  if (!f.endsWith('.tsx')) continue;
  for (const m of src.matchAll(/<Modal\b/g)) {
    const tag = src.slice(m.index, tagEnd(src, m.index));
    const close = tag.match(/onRequestClose=\{\s*/);
    if (close && !tag.slice(close.index + close[0].length).startsWith('sheetBack(')) fail(rel, src, m.index, '<Modal> onRequestClose not wrapped in sheetBack(…)');
  }
  // Opening and closing tags paired (a Modal may sit inside another), for the
  // visible each closing tag's layer must carry.
  const events = [];
  for (const m of src.matchAll(/<Modal\b/g)) {
    const tag = src.slice(m.index, tagEnd(src, m.index));
    if (!tag.endsWith('/>')) events.push({ at: m.index, visible: visibleExpr(tag) });
  }
  for (const m of src.matchAll(/<\/Modal>/g)) events.push({ at: m.index, close: true });
  const stack = [];
  for (const e of events.sort((a, b) => a.at - b.at)) {
    if (!e.close) {
      stack.push(e);
      continue;
    }
    const open = stack.pop();
    const before = src.slice(0, e.at).trimEnd();
    const last = before.slice(before.lastIndexOf('<ActionSheetLayer'));
    const layer = /^<ActionSheetLayer(\s+visible=\{[^]*\})?\s*\/>$/.test(last) ? last : null;
    if (!layer) fail(rel, src, e.at, '<Modal> without <ActionSheetLayer /> as its last child');
    // iOS keeps a closed Modal's children until its slide-out ends: the layer
    // must stop taking sheets when the Modal is told to close, not then.
    else if (open?.visible && open.visible !== 'true' && squash(visibleExpr(layer) ?? '') !== squash(open.visible))
      fail(rel, src, e.at, `<Modal visible={${open.visible}}> whose last child is not <ActionSheetLayer visible={${open.visible}} />`);
  }
}

// ── the sheet's layout (actionSheetCore.ts) ─────────────────────────────────
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`  ✗ ${msg}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
};
const shape = (sections) => sections.map((s) => [s.kind, s.title, s.rows]);
const opts = [
  { label: '刪除', destructive: true },
  { label: 'Alpha', section: 'A' },
  { label: 'Beta', section: 'A', description: '臺灣' },
  { label: 'Gamma', section: 'B', keywords: 'Litsea' },
  { label: '封存', destructive: true },
  { label: 'Delta', section: 'B', disabled: true },
];
eq('destructive options last, in their own group; indices stay the caller\'s', shape(layoutSheet(opts)), [
  ['plain', 'A', [1, 2]],
  ['plain', 'B', [3, 5]],
  ['destructive', null, [0, 4]],
]);
eq('recent picks on top (still on offer, not disabled), without dropping them below', shape(layoutSheet(opts, { recent: ['Gamma', 'gone', 'Delta', 'Alpha'] })).slice(0, 2), [
  ['recent', null, [3, 1]],
  ['plain', 'A', [1, 2]],
]);
eq('search: one list, no groups; label, description and keywords, any case', shape(layoutSheet(opts, { query: 'litSEA' })), [['plain', null, [3]]]);
eq('search: full-width letters and 台 / 臺 match', shape(layoutSheet(opts, { query: 'ＢＥＴＡ' })).concat(shape(layoutSheet(opts, { query: '台灣' }))), [
  ['plain', null, [2]],
  ['plain', null, [2]],
]);
eq('search: destructive matches still last', shape(layoutSheet(opts, { query: '刪' })), [['destructive', null, [0]]]);
eq('search: nothing matches → no groups', layoutSheet(opts, { query: 'zzz' }).length, 0);
eq('filter chip: only its options, still grouped', shape(layoutSheet(opts, { match: (o) => o.section === 'B' })), [['plain', 'B', [3, 5]]]);
eq('filter and search together', shape(layoutSheet(opts, { match: (o) => o.section === 'A', query: 'gamma' })), []);
eq('consecutive same section only: a section that comes back is a new group', shape(layoutSheet([{ label: 'a', section: 'X' }, { label: 'b' }, { label: 'c', section: 'X' }])), [
  ['plain', 'X', [0]],
  ['plain', null, [1]],
  ['plain', 'X', [2]],
]);
eq('the match marked in the original text', markMatch('Litsea ＡＢ', 'ab'), ['Litsea ', 'ＡＢ', '']);
eq('folding keeps every index', [...foldSearch('ＡＢ臺x')].length, 4);
eq('search box: auto above 8 options; true / false as given', [searchShown('auto', 8), searchShown(undefined, 9), searchShown(true, 2), searchShown(false, 50)], [false, true, true, false]);
eq('recent: newest first, no repeats, at most 3', pushRecent(['a', 'b', 'c'], 'b').concat(pushRecent(['a', 'b', 'c'], 'd')), ['b', 'a', 'c', 'd', 'a', 'b']);
eq('confirmation: one destructive option alone', [isConfirmation([{ label: 'x', destructive: true }]), isConfirmation([{ label: 'x', destructive: true }, { label: 'y' }]), isConfirmation([{ label: 'x' }])], [true, false, false]);

// ── names in sheet titles and options (src/lib/nameParts.ts) ───────────────
eq('species: the common name when there is one', speciesParts('豬腳楠', 'Machilus thunbergii', 'Species', 'Plantae'), ['豬腳楠']);
eq('species: a common name without a scientific one', speciesParts('薹屬', null), ['薹屬']);
eq('species: else the scientific name with its rank', speciesParts(null, 'Litsea', 'Genus', 'Plantae'), [{ sci: 'Litsea', rank: 'Genus', kingdom: 'Plantae' }]);
eq('species: neither → the taxon id as text', speciesParts('', '', null, null, 't0001'), ['t0001']);
eq('occurrence: a label stays text', occurrenceParts({ verbatim_identification: 'sp1', common_name_c: '薹屬', simple_name: 'Carex', taxon_id: 't' }), ['sp1']);
eq('occurrence: common name, then the scientific name', occurrenceParts({ common_name_c: '白頭翁', simple_name: 'Pycnonotus sinensis', taxon_id: 't', rank: 'Species', kingdom: 'Animalia' }), ['白頭翁 ', { sci: 'Pycnonotus sinensis', rank: 'Species', kingdom: 'Animalia' }]);
eq('morphospecies: the base by its rank, the code as text', morphoParts('Acacia MTN1', 'Acacia', 'Genus'), [{ sci: 'Acacia', rank: 'Genus', kingdom: null }, ' MTN1']);
eq('morphospecies: a name only starting with the same letters stays text', morphoParts('Acaciaceae X', 'Acacia', 'Genus'), ['Acaciaceae X']);
const sentence = sentenceParts(`已存在：${slot('name')}，與 ${slot('other')}`, { name: [{ sci: 'Litsea' }], other: ['x'] });
eq('sentence: each slot filled, the text around kept', sentence, ['已存在：', { sci: 'Litsea' }, '，與 ', 'x']);
eq('sentence: plain text for search and screen readers', partsText(sentence), '已存在：Litsea，與 x');
eq('a list of names joined', joinParts([[{ sci: 'A' }], ['乙']], '、'), [{ sci: 'A' }, '、', '乙']);

if (failures) {
  console.error(`check:sheet-layer — ${failures} problem(s)`);
  process.exit(1);
}
console.log('✓ sheet-layer: every Modal carries an action-sheet layer and passes back through sheetBack; layout and name-part rules hold');
