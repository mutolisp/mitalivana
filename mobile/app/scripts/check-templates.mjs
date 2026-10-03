/**
 * Survey templates and the component registry (src/survey/template,
 * src/survey/registry.ts, src/survey/templates). Spec:
 * docs/planned/Modular_survey.md §4, §6.
 *
 * What must hold:
 *   - every built-in template validates, carries every always-present
 *     component, and only names registered code sets;
 *   - every component declares levels, styles, an i18n label, an export
 *     mapping and default parameters its own checker accepts, on every level;
 *   - every field it can store (any level, any parameter variant) points at a
 *     column of that level's own row, a values table or an fw_media owner
 *     column that the migrations really build, with a matching type; its DwC
 *     terms are current terms (TDWG cache), its export keys name its fields;
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
import { readFileSync } from 'node:fs';
import {
  ABUNDANCE_KINDS,
  ABUNDANCE_TYPE,
  amsField,
  BUILTIN_CODESETS,
  COMPONENT_TYPES,
  componentDef,
  componentDefs,
  defaultLevelOf,
  defaultParamsOf,
  exportMapOf,
  LEVEL_TABLE,
  PHENOLOGY_FIELDS,
} from '../src/survey/registry.ts';
import { AMS_VARIABLES } from '../src/survey/codesets/forestgeoAms2021.ts';
import { kindForType } from '../src/lib/dwcAbundanceCore.ts';
import { componentProblems, storeBlockers } from '../src/survey/componentRules.ts';
import { migratedDb, schemaColumns } from './schema-columns.mjs';
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
// Parameters beyond the defaults, so every field a component can store is exercised.
const VARIANTS = {
  workers: [{ roles: ['recorder', 'identifier'] }],
  health: [{ codesets: ['forestgeo-census-1998', 'forestgeo-ams-2021', 'mine'] }],
  abundance: [{ kinds: [...ABUNDANCE_KINDS], default: 'custom' }],
  frequency: [{ mode: 'count', n: 5, top_edge: 'upslope' }],
  phenology: [{ fields: [...PHENOLOGY_FIELDS] }],
};
const schema = await schemaColumns();
const types = new Map();
{
  const db = await migratedDb();
  for (const t of schema.keys()) types.set(t, new Map(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c.type])));
  db.close();
}
const DWC_TERMS = new Set(JSON.parse(readFileSync(new URL('./vocab/dwc-current-terms.json', import.meta.url), 'utf8')).terms);
const zh = JSON.parse(readFileSync(new URL('../src/i18n/locales/zh-TW.json', import.meta.url), 'utf8'));
const i18nHas = (key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), zh) !== undefined;
const MEDIA_OWNER = { survey: 'survey_id', unit: 'unit_id', occurrence: 'occurrence_id', individual: 'individual_id', stem: 'measure_id' };
const NUM_TYPES = ['INTEGER', 'REAL'];

for (const d of componentDefs()) {
  ok(`${d.type}: has levels`, d.levels.length > 0);
  ok(`${d.type}: has styles`, d.styles.length > 0);
  ok(`${d.type}: cardinality one or many`, d.cardinality === 'one' || d.cardinality === 'many');
  ok(`${d.type}: label ${d.labelKey} has an i18n key`, i18nHas(d.labelKey));
  for (const style of d.styles) {
    const level = defaultLevelOf(d, style);
    ok(`${d.type}: default level in ${style} is one of its levels and the style's`, d.levels.includes(level) && STYLE_LEVELS[style].includes(level));
  }
  const fieldNames = new Set();
  for (const level of d.levels) {
    eq(`${d.type}@${level}: default params pass its own check`, d.checkParams(defaultParamsOf(d, level), level), []);
    const variants = [defaultParamsOf(d, level), ...(VARIANTS[d.type] ?? [])].filter((p) => d.checkParams(p, level).length === 0);
    for (const params of variants) {
      const fields = d.fields(params, level, 'k');
      ok(`${d.type}@${level}: declares fields`, fields.length > 0);
      eq(`${d.type}@${level}: field names distinct`, fields.length, new Set(fields.map((f) => f.field)).size);
      for (const f of fields) {
        fieldNames.add(f.field);
        const s = f.storage;
        if ('col' in s) {
          const [table, column] = s.col.split('.');
          ok(`${d.type}@${level} ${f.field}: column ${s.col} is on the level's own row`, table === LEVEL_TABLE[level]);
          const type = types.get(table)?.get(column);
          ok(`${d.type}@${level} ${f.field}: column ${s.col} exists`, type !== undefined);
          if (type !== undefined) ok(`${d.type}@${level} ${f.field}: ${s.valueType} fits ${s.col} (${type})`, s.valueType === 'num' ? NUM_TYPES.includes(type) : type === 'TEXT');
        } else if ('values' in s) {
          ok(`${d.type}@${level} ${f.field}: values table ${s.values} exists`, schema.has(s.values));
        } else {
          ok(`${d.type}@${level} ${f.field}: fw_media has an owner column for ${level}`, schema.get('fw_media')?.has(MEDIA_OWNER[level]));
        }
      }
      const map = exportMapOf(d, params, level);
      ok(`${d.type}@${level}: has an export mapping`, Object.keys(map.dwc ?? {}).length + Object.keys(map.mof ?? {}).length > 0);
      for (const term of Object.values(map.dwc ?? {})) ok(`${d.type}: dwc:${term} is a current Darwin Core term`, DWC_TERMS.has(`http://rs.tdwg.org/dwc/terms/${term}`));
    }
  }
  // Export keys must name fields the component has (on some level, with some parameters).
  for (const level of d.levels) {
    for (const params of [defaultParamsOf(d, level), ...(VARIANTS[d.type] ?? [])].filter((p) => d.checkParams(p, level).length === 0)) {
      const map = exportMapOf(d, params, level);
      for (const k of [...Object.keys(map.dwc ?? {}), ...Object.keys(map.mof ?? {})]) ok(`${d.type}: export key ${k} is one of its fields`, fieldNames.has(k));
    }
  }
}
for (const t of ['taxon', 'timestamp', 'comments', 'investigators']) ok(`${t} is always required`, componentDef(t)?.required === true);
eq('every component type is registered once, and only those', componentDefs().map((d) => d.type).sort(), [...COMPONENT_TYPES].sort());
eq('built-in code sets', [...BUILTIN_CODESETS], ['forestgeo-census-1998', 'forestgeo-ams-2021']);
eq('taxon on an occurrence is stored on fw_occurrences', componentDef('taxon').fields({}, 'occurrence', 'taxon')[0].storage, { col: 'fw_occurrences.taxon_id', valueType: 'text' });
eq('comments on a unit are the unit notes', componentDef('comments').fields({}, 'unit', 'comments')[0].storage, { col: 'fw_units.notes', valueType: 'text' });
eq('a traits component keys its rows by the component key', componentDef('traits').fields(componentDef('traits').defaultParams, 'occurrence', 'leaf2')[0].storage.component, 'leaf2');
eq('census health keeps its Phase 1 key', componentDef('health').fields({ codesets: ['forestgeo-census-1998'] }, 'stem', 'x')[0].storage.component, 'health');
eq(
  'every AMS variable is a stored field',
  componentDef('health').fields({ codesets: ['forestgeo-ams-2021'] }, 'stem', 'health').map((f) => f.field),
  AMS_VARIABLES.map((v) => amsField(v.field)),
);
for (const k of Object.keys(ABUNDANCE_TYPE)) eq(`abundance ${k}: its type maps back to it (dwcAbundanceCore)`, kindForType(ABUNDANCE_TYPE[k]), k);

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

// Cardinality and keys (2B): a component stored in columns sits once per level; keys name values-table rows.
const extra = (comps) => ({ ...plot, components: [...plot.components, ...comps] });
const ab1 = { key: 'ab1', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['BB'], default: 'BB' } };
has('plot: abundance twice on the occurrence', validateTemplate(extra([ab1, { ...ab1, key: 'ab2' }])), 'abundance sits on this level twice');
const tr = (key) => ({ key, type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'len', label: { text: 'L' } }] } });
eq('plot: traits twice under two keys', validateTemplate(extra([tr('leaf'), tr('seed')])), []);
const env = (unit) => ({ key: `env_${unit}`, type: 'environment', level: 'unit', unit, required: false, params: { fields: ['slope_deg'] } });
eq('plot: the same component on two unit levels', validateTemplate(extra([env('subplot'), env('quadrat')])), []);
has('plot: a component key outside the pattern', validateTemplate(extra([{ ...ab1, key: 'My Abundance' }])), 'must be lower-case letters');
has('plot: a user template trait with an i18n label', validateTemplate(extra([{ ...tr('leaf'), params: { traits: [{ id: 'len', label: { i18n: 'x.y' } }] } }])), 'leaf trait len: only a built-in');
has('plot: a trait with no label', validateTemplate(extra([{ ...tr('leaf'), params: { traits: [{ id: 'len' }] } }])), 'leaf trait len: label missing');
has('plot: location off the census is GNSS only', validateTemplate(extra([{ key: 'where', type: 'location', level: 'occurrence', required: false, params: { methods: ['grid'] } }])), 'methods must be a non-empty subset of gps');
has('plot: an identifier on a census quadrat', validateTemplate({ ...base, components: base.components.map((c) => (c.type === 'workers' ? { ...c, params: { roles: ['recorder', 'identifier'] } } : c)) }), 'roles must be');

// ── 3c. labels ──────────────────────────────────────────────────────────────
has('user template: no i18n name', validateTemplate({ ...checklist, name: { i18n: 'x.y' } }), 'only a built-in template may use an i18n key');
has('user template: no i18n unit label', validateTemplate({ ...plot, units: [{ key: 'q', label: { i18n: 'x' } }] }), 'only a built-in');
has('empty name', validateTemplate({ ...checklist, name: { text: '  ' } }), 'name: empty label');
has('empty translation', validateTemplate({ ...checklist, name: { text: 'A', tr: { en: '' } } }), 'tr has an empty');
has('empty code label', validateTemplate({ ...checklist, codelists: [{ id: 'L', label: { text: 'L' }, items: [{ code: 'a', label: { text: '' } }] }] }), 'code list L code a: empty label');
has('i18n code label in a user list', validateTemplate({ ...checklist, codelists: [{ id: 'L', label: { text: 'L' }, items: [{ code: 'a', label: { i18n: 'k' } }] }] }), 'only a built-in');
has('empty code list id', validateTemplate({ ...checklist, codelists: [{ id: '', label: { text: 'L' }, items: [] }] }), 'code list with an empty id');
eq('translations accepted', validateTemplate({ ...checklist, name: { text: '樣區', tr: { en: 'Plot', ja: '調査区' } } }), []);

// ── 3d. values against the rules (componentRules, 2B) ──────────────────────
const probs = (type, params, level, values, key = type) => componentProblems(componentDef(type), params, level, key, values).map((p) => `${p.field}${p.idx != null ? `[${p.idx}]` : ''}:${p.code}:${p.severity}`);
const blockers = (type, params, level, values) => storeBlockers(componentDef(type), params, level, type, values).map((p) => `${p.field}:${p.code}`);
const traitsP = { traits: [{ id: 'len', label: { text: 'L' }, min: 0, max: 50 }, { id: 'n', label: { text: 'N' }, integer: true }] };
eq('rules: trait in range, integer', probs('traits', traitsP, 'occurrence', { len: 12.5, n: 3 }), []);
eq('rules: trait above max, not integer', probs('traits', traitsP, 'occurrence', { len: 60, n: 2.5 }), ['len:above_max:error', 'n:not_integer:error']);
eq('rules: text in a number field', probs('traits', traitsP, 'occurrence', { len: 'long' }), ['len:not_a_number:error']);
eq('rules: required taxon missing', probs('taxon', {}, 'occurrence', {}), ['taxon_id:required:error']);
eq('rules: an unknown layer', probs('structure', { layers: 4, methods: ['BB'] }, 'occurrence', { layer: 'E7' }), ['layer:not_allowed:error']);
eq(
  'rules: per-layer values checked per layer, beyond the layer count flagged',
  probs('structure', { layers: 4, methods: ['BB'] }, 'survey', { layer_count: 2, cover_pct: { 1: 50, 2: 120, 3: 5 }, method: { 1: 'percent' } }, 'layers'),
  ['cover_pct[2]:above_max:error', 'method[1]:not_allowed:error', 'cover_pct[3]:layer_out_of_range:warning'],
);
eq('rules: a multi-value field must be a list', probs('phenology', { fields: ['leaf_phenology'] }, 'occurrence', { leaf_phenology: 'green' }), ['leaf_phenology:not_a_list:error']);
eq('rules: end before start', probs('timestamp', {}, 'survey', { start_ts: 10, stop_ts: 5 }), ['stop_ts:ends_before_start:error']);
eq('rules: ground covers over 100 %', probs('environment', { fields: ['rock_cover_pct', 'litter_cover_pct', 'slope_deg'] }, 'survey', { rock_cover_pct: 70, litter_cover_pct: 40, slope_deg: 95 }, 'env'), ['slope_deg:above_max:error', 'null:covers_over_100:warning']);
eq('rules: frequency mask of the grid size', probs('frequency', { mode: 'cells', n: 2, top_edge: 'N' }, 'occurrence', { freq_cells: '10110' }), ['freq_cells:not_a_mask:error']);
eq('rules: frequency count at most n²', probs('frequency', { mode: 'count', n: 2, top_edge: 'N' }, 'occurrence', { freq_count: 5 }), ['freq_count:above_max:error']);
const ab = { kinds: ['BB', 'percent', 'count', 'DBH'], default: 'BB' };
eq('rules: abundance BB', probs('abundance', ab, 'occurrence', { organism_quantity: '3', organism_quantity_type: 'Braun-Blanquet Scale' }), []);
eq('rules: abundance BB out of scale', probs('abundance', ab, 'occurrence', { organism_quantity: '6', organism_quantity_type: 'Braun-Blanquet Scale' }), ['organism_quantity:out_of_range:error']);
eq('rules: abundance percent over 100', probs('abundance', ab, 'occurrence', { organism_quantity: '120', organism_quantity_type: '% cover' }), ['organism_quantity:out_of_range:error']);
eq('rules: abundance count not whole', probs('abundance', ab, 'occurrence', { organism_quantity: '2.5', organism_quantity_type: 'individuals' }), ['organism_quantity:out_of_range:error']);
eq('rules: abundance DBH list', probs('abundance', ab, 'occurrence', { organism_quantity: '[12,0]', organism_quantity_type: 'DBH (cm)' }), ['organism_quantity:out_of_range:error']);
eq('rules: abundance scale the template leaves out', probs('abundance', { kinds: ['BB'], default: 'BB' }, 'occurrence', { organism_quantity: '5', organism_quantity_type: 'individuals' }), ['organism_quantity_type:not_allowed:error']);
eq('rules: abundance value without a type', probs('abundance', ab, 'occurrence', { organism_quantity: '5' }), ['organism_quantity_type:required:error']);
eq('rules: nothing recorded is not a problem', probs('abundance', ab, 'occurrence', {}), []);
const amsP = { codesets: ['forestgeo-ams-2021'] };
eq('rules: AMS markers pass numeric rules', probs('health', amsP, 'stem', { ams_living_length_m: '<POM', ams_remaining_crown_pct: 'NA', ams_leaves_pct: '?' }), []);
eq('rules: AMS marker of another variable', probs('health', amsP, 'stem', { ams_leaves_pct: 'NA' }), ['ams_leaves_pct:not_a_number:error']);
eq('rules: AMS code outside its variable', probs('health', amsP, 'stem', { ams_crown_illumination: '6', ams_mode: ['S', 'Q'] }), ['ams_mode:not_allowed:error', 'ams_crown_illumination:not_allowed:error']);
// The store refuses only what cannot be stored: missing values and rules across fields are the form's.
eq('store: required and cross-field rules do not block', blockers('timestamp', {}, 'survey', { stop_ts: 5, start_ts: 10 }), []);
eq('store: a missing required field does not block (a form saves field by field)', blockers('taxon', {}, 'occurrence', { used_scientific_name: 'Abies' }), []);
eq('store: a wrong kind of value blocks', blockers('traits', traitsP, 'occurrence', { len: 'x', n: 1.5 }), ['len:not_a_number', 'n:not_integer']);
// Every AMS variable and code has its name in the locales (labels are looked up by variable and code).
for (const v of AMS_VARIABLES) {
  ok(`AMS ${v.field}: has a label`, i18nHas(`survey.ams.${v.field}.label`));
  const codes = 'choices' in v ? v.choices.map((c) => c.code) : v.kind === 'number' ? (v.special ?? []).map((x) => (x === '<POM' ? 'belowPom' : x)) : [];
  for (const code of codes) ok(`AMS ${v.field} ${code}: has a label`, i18nHas(`survey.ams.${v.field}.c_${code}`));
}

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
