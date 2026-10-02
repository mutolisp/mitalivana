/**
 * Survey templates and the component registry (src/survey/template,
 * src/survey/registry.ts, src/survey/templates). Spec:
 * docs/planned/Modular_survey.md §4, §6.
 *
 * What must hold:
 *   - every built-in template validates, carries every always-present
 *     component, and only names registered code sets;
 *   - every component declares levels, styles, an export mapping, and default
 *     parameters its own checker accepts;
 *   - the validator catches duplicate keys, unknown types, wrong levels,
 *     dropped required components, bad parameters, bad code lists;
 *   - checklist and plot styles (2A): a minimal template of each validates
 *     after injection, with Taxon on the occurrence; a plot has 1–3 unit
 *     levels with distinct keys, and a component on the unit level names
 *     one of them; other styles have none;
 *   - labels: a user or imported template writes its words (no i18n keys),
 *     never an empty label or translation;
 *   - a change that adds only optional components or relabels is additive;
 *     removing a component, changing its level or parameters, or removing or
 *     renaming a code value is breaking (code values once used never change);
 *     unit levels must keep their keys and order;
 *   - the template hash ignores key order.
 *
 * Run: npm run check:templates
 */
import { BUILTIN_CODESETS, componentDef, componentDefs, defaultLevelOf } from '../src/survey/registry.ts';
import { STYLE_LEVELS } from '../src/survey/template/types.ts';
import { classifyChange, templateHash, validateTemplate, withRequired } from '../src/survey/template/validate.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import { BUILTIN_TEMPLATES } from '../src/survey/templates/builtins.ts';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};
const ok = (label, cond) => {
  if (!cond) fail(label);
};
const has = (label, problems, needle) => ok(`${label} (problems: ${JSON.stringify(problems)})`, problems.some((p) => p.includes(needle)));

console.log('check:templates');

// ── 1. built-in templates ───────────────────────────────────────────────────
const BUILTINS = BUILTIN_TEMPLATES;
for (const t of BUILTINS) {
  eq(`${t.builtin_key} validates`, validateTemplate(t), []);
  ok(`${t.builtin_key} needs no injection`, withRequired(t) === t);
  ok(`${t.builtin_key} has a builtin_version`, Number.isInteger(t.builtin_version) && t.builtin_version >= 1);
  ok(`${t.builtin_key} labels are i18n keys`, 'i18n' in t.name);
}
const health = STEMMAP_TEMPLATE.components.find((c) => c.type === 'health');
eq('stemmap: census codes only in Phase 1', health.params.codesets, ['forestgeo-census-1998']);
ok('stemmap: no quick add (a tree needs a tag and a position)', STEMMAP_TEMPLATE.quick_add === false);

// ── 2. registry ─────────────────────────────────────────────────────────────
for (const d of componentDefs()) {
  ok(`${d.type}: has levels`, d.levels.length > 0);
  ok(`${d.type}: has styles`, d.styles.length > 0);
  for (const style of d.styles) {
    const level = defaultLevelOf(d, style);
    ok(`${d.type}: default level in ${style} is one of its levels and the style's`, d.levels.includes(level) && STYLE_LEVELS[style].includes(level));
    ok(`${d.type}: declares fields on ${level}`, d.fields(d.defaultParams, level).length > 0);
    ok(`${d.type}: fields on ${level} are stored`, d.fields(d.defaultParams, level).every((f) => !('col' in f.storage) || !f.storage.col.startsWith('undefined')));
  }
  ok(`${d.type}: has an export mapping`, Object.keys(d.exportMap).length > 0);
  eq(`${d.type}: default params pass its own check`, d.checkParams(d.defaultParams), []);
}
eq('taxon on an occurrence is stored on fw_occurrences', componentDef('taxon').fields({}, 'occurrence')[0].storage, { col: 'fw_occurrences.taxon_id' });
eq('comments on a unit are the unit notes', componentDef('comments').fields({}, 'unit')[0].storage, { col: 'fw_units.notes' });
for (const t of ['taxon', 'timestamp', 'comments', 'investigators']) ok(`${t} is always required`, componentDef(t)?.required === true);
eq('built-in code sets', [...BUILTIN_CODESETS], ['forestgeo-census-1998', 'forestgeo-ams-2021']);

// ── 3. validator negatives ──────────────────────────────────────────────────
const base = STEMMAP_TEMPLATE;
const withComps = (comps) => ({ ...base, components: comps });
const dbh = base.components.find((c) => c.key === 'dbh');
has('duplicate key', validateTemplate(withComps([...base.components, { ...dbh }])), 'duplicate component key dbh');
has('unknown type', validateTemplate(withComps([...base.components, { key: 'x', type: 'nope', level: 'stem', required: false, params: {} }])), 'unknown component type');
has('wrong level', validateTemplate(withComps(base.components.map((c) => (c.key === 'dbh' ? { ...c, level: 'survey' } : c)))), 'cannot sit on the survey level');
has('required made optional', validateTemplate(withComps(base.components.map((c) => (c.key === 'taxon' ? { ...c, required: false } : c)))), 'always required');
const noTaxon = withComps(base.components.filter((c) => c.type !== 'taxon'));
has('dropped required component', validateTemplate(noTaxon), 'missing required component taxon');
eq('withRequired puts it back', validateTemplate(withRequired(noTaxon)), []);
has('bad params', validateTemplate(withComps(base.components.map((c) => (c.key === 'location' ? { ...c, params: { methods: ['teleport'] } } : c)))), 'methods must be');
has('unknown code set', validateTemplate(withComps(base.components.map((c) => (c.key === 'health' ? { ...c, params: { codesets: ['mine'] } } : c)))), 'unknown code set mine');
const myList = { id: 'mine', label: { text: 'Mine' }, items: [{ code: 'AN', label: { text: 'animal' } }] };
eq('own code list accepted', validateTemplate({ ...withComps(base.components.map((c) => (c.key === 'health' ? { ...c, params: { codesets: ['forestgeo-census-1998', 'mine'] } } : c))), codelists: [myList] }), []);
has('duplicate code', validateTemplate({ ...base, codelists: [{ ...myList, items: [...myList.items, ...myList.items] }] }), 'duplicate code AN');
has('shadowing a built-in set', validateTemplate({ ...base, codelists: [{ ...myList, id: 'forestgeo-census-1998' }] }), 'shadows a built-in');
has('plot-only style', validateTemplate({ ...base, style: 'plot' }), 'not available in the plot style');

// ── 3b. checklist and plot styles (2A) ──────────────────────────────────────
const bare = (style, over = {}) => ({ schema: 1, id: `user:${style}`, version: 1, origin: 'user', name: { text: style }, style, components: [], codelists: [], quick_add: true, ...over });
const units2 = [{ key: 'subplot', label: { text: '小區' } }, { key: 'quadrat', label: { text: '小樣方', tr: { en: 'Quadrat' } } }];
const checklist = withRequired(bare('checklist'));
eq('checklist: valid once the required components are in', validateTemplate(checklist), []);
eq('checklist: taxon sits on the occurrence', checklist.components.find((c) => c.type === 'taxon').level, 'occurrence');
has('checklist: required components missing', validateTemplate(bare('checklist')), 'missing required component taxon');
const plot = withRequired(bare('plot', { units: units2 }));
eq('plot: valid with two unit levels', validateTemplate(plot), []);
has('plot: needs a unit level', validateTemplate(withRequired(bare('plot'))), 'unit levels');
has('plot: at most three', validateTemplate({ ...plot, units: [...units2, { key: 'a', label: { text: 'a' } }, { key: 'b', label: { text: 'b' } }] }), 'unit levels');
has('plot: unit keys distinct', validateTemplate({ ...plot, units: [units2[0], units2[0]] }), 'duplicate unit level subplot');
has('plot: unit key without outer spaces', validateTemplate({ ...plot, units: [{ key: ' q', label: { text: 'q' } }] }), 'without outer spaces');
has('checklist: no unit levels', validateTemplate({ ...checklist, units: units2 }), 'belong to the plot style');
const onUnit = (unit) => ({ ...plot, components: [...plot.components, { key: 'unote', type: 'comments', level: 'unit', unit, required: true, params: {} }] });
eq('plot: a component on a named unit level', validateTemplate(onUnit('quadrat')), []);
has('plot: unit level not in the template', validateTemplate(onUnit('transect')), 'names no unit level');
has('plot: unit level not named', validateTemplate(onUnit(undefined)), 'names no unit level');
has('plot: unit named off the unit level', validateTemplate({ ...plot, components: plot.components.map((c) => (c.type === 'taxon' ? { ...c, unit: 'quadrat' } : c)) }), 'only a component on the unit level');
has('checklist: taxon not on the individual level', validateTemplate({ ...checklist, components: checklist.components.map((c) => (c.type === 'taxon' ? { ...c, level: 'individual' } : c)) }), 'cannot sit on the individual level');
has('checklist: census-only component', validateTemplate({ ...checklist, components: [...checklist.components, { key: 'dbh', type: 'dbh', level: 'stem', required: false, params: { classes: 'eia' } }] }), 'not available in the checklist style');

// ── 3c. labels ──────────────────────────────────────────────────────────────
has('user template: no i18n name', validateTemplate({ ...checklist, name: { i18n: 'x.y' } }), 'only a built-in template may use an i18n key');
has('user template: no i18n unit label', validateTemplate({ ...plot, units: [{ key: 'q', label: { i18n: 'x' } }] }), 'only a built-in');
has('empty name', validateTemplate({ ...checklist, name: { text: '  ' } }), 'name: empty label');
has('empty translation', validateTemplate({ ...checklist, name: { text: 'A', tr: { en: '' } } }), 'tr has an empty');
has('empty code label', validateTemplate({ ...checklist, codelists: [{ id: 'L', label: { text: 'L' }, items: [{ code: 'a', label: { text: '' } }] }] }), 'code list L code a: empty label');
has('i18n code label in a user list', validateTemplate({ ...checklist, codelists: [{ id: 'L', label: { text: 'L' }, items: [{ code: 'a', label: { i18n: 'k' } }] }] }), 'only a built-in');
has('empty code list id', validateTemplate({ ...checklist, codelists: [{ id: '', label: { text: 'L' }, items: [] }] }), 'code list with an empty id');
eq('translations accepted', validateTemplate({ ...checklist, name: { text: '樣區', tr: { en: 'Plot', ja: '調査区' } } }), []);

// ── 4. change classification ────────────────────────────────────────────────
const v2 = (over) => ({ ...base, version: 2, ...over });
eq('identical', classifyChange(base, v2({})), 'same');
eq('relabel', classifyChange(base, v2({ name: { text: 'Mine' } })), 'additive');
eq('add an optional component', classifyChange(base, v2({ components: [...base.components, { key: 'photos2', type: 'photos', level: 'survey', required: false, params: { max: 2 } }] })), 'additive');
eq('add a required component', classifyChange(base, v2({ components: [...base.components, { key: 'h2', type: 'height', level: 'individual', required: true, params: {} }] })), 'breaking');
eq('remove a component', classifyChange(base, v2({ components: base.components.filter((c) => c.key !== 'height') })), 'breaking');
eq('change params', classifyChange(base, v2({ components: base.components.map((c) => (c.key === 'photos' ? { ...c, params: { max: 3 } } : c)) })), 'breaking');
eq('optional made required', classifyChange(base, v2({ components: base.components.map((c) => (c.key === 'height' ? { ...c, required: true } : c)) })), 'breaking');
const withList = { ...base, codelists: [myList] };
eq('deprecate a code', classifyChange(withList, { ...withList, version: 2, codelists: [{ ...myList, items: [{ ...myList.items[0], deprecated: true }] }] }), 'additive');
eq('remove a code', classifyChange(withList, { ...withList, version: 2, codelists: [{ ...myList, items: [] }] }), 'breaking');
eq('rename a code', classifyChange(withList, { ...withList, version: 2, codelists: [{ ...myList, items: [{ ...myList.items[0], code: 'AX' }] }] }), 'breaking');
eq('other template', classifyChange(base, { ...base, id: 'other' }), 'breaking');
eq('relabel a unit level', classifyChange(plot, { ...plot, version: 2, units: [units2[0], { ...units2[1], label: { text: '樣方' } }] }), 'additive');
eq('add a unit level', classifyChange(plot, { ...plot, version: 2, units: [...units2, { key: 'cell', label: { text: 'cell' } }] }), 'breaking');
eq('reorder unit levels', classifyChange(plot, { ...plot, version: 2, units: [units2[1], units2[0]] }), 'breaking');
eq('move a component to another unit level', classifyChange(onUnit('quadrat'), { ...onUnit('subplot'), version: 2 }), 'breaking');

// ── 5. hash ─────────────────────────────────────────────────────────────────
const reordered = Object.fromEntries(Object.entries(base).reverse());
eq('hash ignores key order', templateHash(reordered), templateHash(base));
ok('hash changes with content', templateHash(v2({})) !== templateHash(base));

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ templates: built-ins valid, registry complete, validator and change rules hold');
