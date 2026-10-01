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
 *   - a change that adds only optional components or relabels is additive;
 *     removing a component, changing its level or parameters, or removing or
 *     renaming a code value is breaking (code values once used never change);
 *   - the template hash ignores key order.
 *
 * Run: npm run check:templates
 */
import { BUILTIN_CODESETS, componentDef, componentDefs } from '../src/survey/registry.ts';
import { classifyChange, templateHash, validateTemplate, withRequired } from '../src/survey/template/validate.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';

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
const BUILTINS = [STEMMAP_TEMPLATE];
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
  ok(`${d.type}: default level is one of its levels`, d.levels.includes(d.defaultLevel));
  ok(`${d.type}: has styles`, d.styles.length > 0);
  ok(`${d.type}: has an export mapping`, Object.keys(d.exportMap).length > 0);
  eq(`${d.type}: default params pass its own check`, d.checkParams(d.defaultParams), []);
  ok(`${d.type}: declares fields`, d.fields(d.defaultParams).length > 0);
}
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

// ── 5. hash ─────────────────────────────────────────────────────────────────
const reordered = Object.fromEntries(Object.entries(base).reverse());
eq('hash ignores key order', templateHash(reordered), templateHash(base));
ok('hash changes with content', templateHash(v2({})) !== templateHash(base));

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ templates: built-ins valid, registry complete, validator and change rules hold');
