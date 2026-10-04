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
 *   - the template hash ignores key order;
 *   - a tree census template (2D-b) is a copy of the built-in: only height,
 *     photos and traits on the tree come and go, Health keeps the census
 *     codes and takes AMS and the template's lists (adding is additive).
 *
 * Run: npm run check:templates
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
const readdirRecursive = (dir) => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? readdirRecursive(`${dir}/${n}`) : [`${dir}/${n}`]));
import {
  ABUNDANCE_KINDS,
  ABUNDANCE_TYPE,
  amsField,
  BUILTIN_CODESETS,
  COMPONENT_TYPES,
  componentDef,
  paramsChangeOf,
  componentDefs,
  defaultLevelOf,
  defaultParamsOf,
  exportMapOf,
  fixedAt,
  LEVEL_TABLE,
  PHENOLOGY_FIELDS,
  SPATIAL_TYPES,
} from '../src/survey/registry.ts';
import { AMS_VARIABLES } from '../src/survey/codesets/forestgeoAms2021.ts';
import { BUILTIN_INTERACTIONS } from '../src/survey/codesets/interactions.ts';
import { CUSTOM_METHOD, METHOD_GROUPS, SAMPLING_METHODS, SIZE_UNITS } from '../src/survey/codesets/samplingMethods.ts';
import { kindForType } from '../src/lib/dwcAbundanceCore.ts';
import { componentProblems, storeBlockers } from '../src/survey/componentRules.ts';
import { migratedDb, schemaColumns } from './schema-columns.mjs';
import { STYLE_LEVELS } from '../src/survey/template/types.ts';
import { classifyChange, templateHash, validateTemplate, withRequired } from '../src/survey/template/validate.ts';
import { normalizeTemplate, parseSnapshot } from '../src/survey/template/normalize.ts';
import { requiredByAuthor } from '../src/survey/componentRules.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import { BUILTIN_TEMPLATES } from '../src/survey/templates/builtins.ts';
import { SAMPLE_PLOT_TEMPLATE } from '../src/survey/templates/samples.ts';
import * as E from '../src/survey/template/edit.ts';
import * as S from '../src/survey/template/share.ts';

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
const throwsTo = (label, fn) => {
  try {
    fn();
  } catch {
    return;
  }
  ok(`${label} (did not throw)`, false);
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
/** Components whose records are rows of their own table, not fields of their owner (exported on their own). */
const OWN_ROWS = { interaction: 'fw_interactions' };
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
      if (OWN_ROWS[d.type]) ok(`${d.type}: its table ${OWN_ROWS[d.type]} exists`, schema.has(OWN_ROWS[d.type]));
      else ok(`${d.type}@${level}: declares fields`, fields.length > 0);
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
      // A row-fixed module (the 空間資料 three) is exported with its owner row instead.
      if (!OWN_ROWS[d.type] && !d.rowFixed) ok(`${d.type}@${level}: has an export mapping`, Object.keys(map.dwc ?? {}).length + Object.keys(map.mof ?? {}).length > 0);
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

// Parameters: only widening keeps running surveys (decided 2026-10-03).
const pc = (type, prev, next) => paramsChangeOf(componentDef(type), prev, next);
eq('params: abundance gains a scale', pc('abundance', { kinds: ['BB'], default: 'BB' }, { kinds: ['BB', 'count'], default: 'BB' }), 'additive');
eq('params: abundance default only', pc('abundance', { kinds: ['BB', 'count'], default: 'BB' }, { kinds: ['BB', 'count'], default: 'count' }), 'additive');
eq('params: abundance loses a scale', pc('abundance', { kinds: ['BB', 'count'], default: 'BB' }, { kinds: ['BB'], default: 'BB' }), 'breaking');
eq('params: same scales in another order', pc('abundance', { kinds: ['BB', 'count'], default: 'BB' }, { kinds: ['count', 'BB'], default: 'BB' }), 'additive');
eq('params: phenology gains a field', pc('phenology', { fields: ['sex'] }, { fields: ['sex', 'life_stage'] }), 'additive');
eq('params: environment loses a field', pc('environment', { fields: ['slope_deg', 'aspect_deg'] }, { fields: ['slope_deg'] }), 'breaking');
eq('params: location gains a method', pc('location', { methods: ['gps'] }, { methods: ['gps', 'xy'] }), 'additive');
eq('params: workers gain a role', pc('workers', { roles: ['recorder'] }, { roles: ['recorder', 'identifier'] }), 'additive');
eq('params: photos more', pc('photos', { max: 4 }, { max: 6 }), 'additive');
eq('params: photos fewer', pc('photos', { max: 6 }, { max: 4 }), 'breaking');
eq('params: audio unchanged', pc('audio', { max: 3 }, { max: 3 }), 'same');
const trait = (over = {}) => ({ id: 'len', label: { text: '葉長' }, unit: 'cm', min: 0, max: 50, ...over });
eq('params: traits widened and relabelled', pc('traits', { traits: [trait()] }, { traits: [trait({ min: -1, max: 80, label: { text: '葉片長' } })] }), 'additive');
eq('params: traits bound removed', pc('traits', { traits: [trait()] }, { traits: [trait({ max: undefined })] }), 'additive');
eq('params: traits gains a trait', pc('traits', { traits: [trait()] }, { traits: [trait(), trait({ id: 'wid' })] }), 'additive');
eq('params: traits narrowed', pc('traits', { traits: [trait()] }, { traits: [trait({ max: 40 })] }), 'breaking');
eq('params: traits min raised', pc('traits', { traits: [trait()] }, { traits: [trait({ min: 1 })] }), 'breaking');
eq('params: traits unit changed', pc('traits', { traits: [trait()] }, { traits: [trait({ unit: 'mm' })] }), 'breaking');
eq('params: traits made integer', pc('traits', { traits: [trait()] }, { traits: [trait({ integer: true })] }), 'breaking');
eq('params: traits loses a trait', pc('traits', { traits: [trait(), trait({ id: 'wid' })] }, { traits: [trait()] }), 'breaking');
eq('params: frequency grid changed', pc('frequency', { mode: 'cells', n: 5, top_edge: 'N' }, { mode: 'cells', n: 10, top_edge: 'N' }), 'breaking');
eq('params: structure gains a method (not on the list)', pc('structure', { layers: 4, methods: ['BB'] }, { layers: 4, methods: ['BB', 'percent'] }), 'breaking');
eq('params: structure layers changed', pc('structure', { layers: 4, methods: ['BB'] }, { layers: 5, methods: ['BB'] }), 'breaking');
const sampleV2 = { ...SAMPLE_PLOT_TEMPLATE, version: 2, components: SAMPLE_PLOT_TEMPLATE.components.map((c) => (c.key === 'abundance' ? { ...c, params: { ...c.params, kinds: [...c.params.kinds, 'count'] } } : c)) };
eq('a template whose abundance gains a scale is additive', classifyChange(SAMPLE_PLOT_TEMPLATE, sampleV2), 'additive');
const reorderedV2 = { ...SAMPLE_PLOT_TEMPLATE, version: 2, components: [...SAMPLE_PLOT_TEMPLATE.components].reverse() };
eq('components moved: a change, nothing breaks', classifyChange(SAMPLE_PLOT_TEMPLATE, reorderedV2), 'additive');

// ── 6. the builder's edits (template/edit.ts) ──────────────────────────────
{
  const name = E.makeLabel('我的名錄', 'My checklist');
  const cl = E.blankTemplate('checklist', 'user:a', name, null);
  const pl = E.blankTemplate('plot', 'user:b', E.makeLabel('樣區'), E.makeLabel('小區', 'Subplot'));
  eq('blank: checklist is valid', validateTemplate(cl), []);
  eq('blank: plot is valid', validateTemplate(pl), []);
  eq('blank: always-present components, the 空間資料 modules and a species\' comments', cl.components.map((c) => c.type).sort(), ['centre', 'comments', 'comments', 'investigators', 'site', 'taxon', 'timestamp', 'track']);
  ok('blank: the species\' comments is an optional module, schema 2', cl.components.some((c) => c.type === 'comments' && c.level === 'occurrence' && !c.required) && cl.schema === 2);
  eq('blank: quick add on a checklist, off on a plot', [cl.quick_add, pl.quick_add], [true, false]);
  eq('places: checklist', E.placesOf(cl), [{ level: 'survey' }, { level: 'occurrence' }]);
  eq('places: plot (no permanent-plot level)', E.placesOf(pl).map((p) => p.level), ['survey', 'unit', 'occurrence']);
  const occ = { level: 'occurrence' };
  const add = E.addableTypes(cl, occ);
  ok('addable: optional types of this style and level', add.includes('abundance') && add.includes('traits') && !add.includes('comments') && !add.includes('dbh') && !add.includes('environment'));
  let t = E.addComponent(cl, 'abundance', occ).template;
  t = E.addComponent(t, 'traits', occ).template;
  const second = E.addComponent(t, 'traits', occ);
  t = second.template;
  eq('add: keys from the type, a second traits under traits_2', [second.key, t.components.filter((c) => c.type === 'traits').map((c) => c.key)], ['traits_2', ['traits', 'traits_2']]);
  ok('add: one abundance per level', !E.addableTypes(t, occ).includes('abundance'));
  throwsTo('add: refused where it cannot sit', () => E.addComponent(t, 'environment', occ));
  eq('add: default parameters', t.components.find((c) => c.key === 'abundance').params, componentDef('abundance').defaultParams);
  t = E.addComponent(t, 'photos', { level: 'survey' }).template;
  eq('add: after the last of the same place', E.componentsAt(t, { level: 'survey' }).at(-1).key, 'photos');
  {
    // Places interleaved in the array: a new survey component lands right after the survey's last, not at the end.
    const mixed = { ...cl, components: [cl.components.find((c) => c.type === 'timestamp'), cl.components.find((c) => c.type === 'taxon')] };
    const added = E.addComponent(mixed, 'photos', { level: 'survey' }).template;
    eq('add: right after its place, before other places', added.components.map((c) => c.type), ['timestamp', 'photos', 'taxon']);
    const moved = E.moveComponent({ ...mixed, components: [...mixed.components, { key: 'photos', type: 'photos', level: 'survey', required: false, params: { max: 2 } }] }, 'photos', -1);
    eq('move: skips components of other places', moved.components.map((c) => c.type), ['photos', 'taxon', 'timestamp']);
  }
  ok('valid after adding', validateTemplate(t).length === 0);
  eq('remove: an always-present one stays', E.removeComponent(t, 'comments').components.length, t.components.length);
  eq('remove: an optional one goes', E.removeComponent(t, 'traits_2').components.some((c) => c.key === 'traits_2'), false);
  const order = (x) => E.componentsAt(x, occ).map((c) => c.key);
  const before = order(t);
  const moved = order(E.moveComponent(t, before[2], -1));
  eq('move: swaps with the one above', moved, [before[0], before[2], before[1], ...before.slice(3)]);
  eq('move: the first stays first', order(E.moveComponent(t, before[0], -1)), before);
  eq('update: an always-present one stays required', E.updateComponent(t, 'comments', { required: false }).components.find((c) => c.key === 'comments').required, true);
  eq('update: label set and dropped', [E.updateComponent(t, 'photos', { label: E.makeLabel('現場') }).components.find((c) => c.key === 'photos').label, 'label' in E.updateComponent(E.updateComponent(t, 'photos', { label: E.makeLabel('現場') }), 'photos', { label: null }).components.find((c) => c.key === 'photos')], [{ text: '現場' }, false]);
  // traits: id from the English name while new; kept once saved
  let tt = E.addTrait(t, 'traits');
  eq('trait: added blank at the end', E.componentsAt(tt, occ).find((c) => c.key === 'traits').params.traits.length, 2);
  tt = E.updateTrait(tt, 'traits', 1, { name: { text: '葉寬', en: 'Leaf width' }, unit: 'cm', min: 0 }, null);
  const tr1 = tt.components.find((c) => c.key === 'traits').params.traits[1];
  eq('trait: id from the English name while new', [tr1.id, tr1.label, tr1.unit, tr1.min], ['leaf_width', { text: '葉寬', tr: { en: 'Leaf width' } }, 'cm', 0]);
  const renamed = E.updateTrait(tt, 'traits', 1, { name: { text: '葉片寬', en: 'Blade width' } }, tt).components.find((c) => c.key === 'traits').params.traits[1];
  eq('trait: id kept once a saved version has it', renamed.id, 'leaf_width');
  eq('trait: no English name → from the name, or "trait"', [E.keyFromName('Leaf length (mm)'), E.keyFromName('葉長'), E.keyFromName('2nd node')], ['leaf_length_mm', 'trait', 'nd_node']);
  eq('trait: cleared min dropped', 'min' in E.updateTrait(tt, 'traits', 1, { min: null }, null).components.find((c) => c.key === 'traits').params.traits[1], false);
  eq('trait: the last stays', E.removeTrait(E.updateTrait(t, 'traits', 0, { name: { text: 'x', en: '' } }, null), 'traits', 0).components.find((c) => c.key === 'traits').params.traits.length, 1);
  // unit levels: positional keys, so every template on a plot shares its layout (decided 2026-10-03)
  eq('units: a new plot starts at u1', pl.units.map((u) => u.key), ['u1']);
  let p = E.addUnitLevel(pl, E.makeLabel('小樣方'));
  p = E.addUnitLevel(p, E.makeLabel('樣格'));
  eq('units: added below, keyed by position', p.units.map((u) => u.key), ['u1', 'u2', 'u3']);
  eq('units: up to three', E.addUnitLevel(p, E.makeLabel('多')).units.length, 3);
  p = E.addComponent(p, 'photos', { level: 'unit', unit: 'u2' }).template;
  p = E.addComponent(p, 'environment', { level: 'unit', unit: 'u3' }).template;
  ok('units: valid with components on levels', validateTemplate(p).length === 0);
  const removed = E.removeUnitLevel(p, 'u2');
  eq(
    'units: removing a level takes its components, the levels below move up with theirs',
    [removed.units.map((u) => `${u.key}:${u.label.text}`), removed.components.filter((c) => c.level === 'unit').map((c) => `${c.type}@${c.unit}`)],
    [['u1:小區', 'u2:樣格'], ['environment@u2']],
  );
  eq('units: a plot keeps one level', E.removeUnitLevel(pl, 'u1').units.length, 1);
  const movedLevels = E.moveUnitLevel(p, 'u3', -1);
  eq(
    'units: a move swaps the levels, components follow, keys stay positional',
    [movedLevels.units.map((u) => `${u.key}:${u.label.text}`), movedLevels.components.filter((c) => c.level === 'unit').map((c) => `${c.type}@${c.unit}`).sort()],
    [['u1:小區', 'u2:樣格', 'u3:小樣方'], ['environment@u2', 'photos@u3']],
  );
  ok('units: valid after moving', validateTemplate(movedLevels).length === 0);
  const other = E.blankTemplate('plot', 'user:other', E.makeLabel('另一份'), E.makeLabel('樣區'));
  eq('units: two templates built apart share level keys (one layout per plot)', other.units[0].key, pl.units[0].key);
  const sampleCopy = E.copyTemplate(SAMPLE_PLOT_TEMPLATE, 'user:sc', E.makeLabel('複本'));
  eq(
    'units: a copy of a sample is put on the positional keys, its components following',
    [sampleCopy.units.map((u) => u.key), sampleCopy.components.filter((c) => c.level === 'unit').map((c) => c.unit).sort()],
    [['u1', 'u2'], ['u1', 'u2']],
  );
  ok('units: the copy is valid', validateTemplate(sampleCopy).length === 0);
  // copies and labels
  const cp = E.copyTemplate({ ...STEMMAP_TEMPLATE }, 'user:c', E.makeLabel('複本'));
  eq('copy: own id, first version, the user\'s', [cp.id, cp.version, cp.origin, 'builtin_key' in cp, 'builtin_version' in cp], ['user:c', 1, 'user', false, false]);
  ok('copy: a built-in\'s i18n description is dropped, the copy validates', !('description' in cp) && validateTemplate(cp).length === 0);
  eq('label: name plus English, English dropped when the same or blank', [E.makeLabel(' 葉長 ', ' Leaf length '), E.makeLabel('Leaf', 'Leaf'), E.makeLabel('x', ' '), E.makeLabel('  ')], [{ text: '葉長', tr: { en: 'Leaf length' } }, { text: 'Leaf' }, { text: 'x' }, null]);
  eq('label: parts', [E.labelParts({ text: 'a', tr: { en: 'b' } }), E.labelParts({ i18n: 'k' })], [{ text: 'a', en: 'b' }, { text: '', en: '' }]);
  // what still needs the user
  const bad = E.updateTrait(E.updateComponent({ ...p, name: { text: ' ' }, units: [{ key: 'u1', label: { text: '' } }, ...p.units.slice(1)] }, 'photos', { params: { max: 99 } }), 'photos', 0, {}, null);
  const withTraits = E.updateTrait(E.addTrait(E.addComponent(cl, 'traits', occ).template, 'traits'), 'traits', 1, { min: 5, max: 1 }, null);
  eq('issues: name, unit name, parameters', E.draftIssues(bad).map((i) => i.code), ['name_empty', 'unit_label_empty', 'params']);
  eq('issues: trait without a name, min above max', E.draftIssues(withTraits).map((i) => `${i.code}:${i.trait}`), ['trait_name_empty:1', 'trait_range:1']);
  eq('issues: none on a fresh template', [E.draftIssues(cl), E.draftIssues(pl)], [[], []]);
}

// ── 7. code lists and the choice component (2D-b) ──────────────────────────
{
  const occ = { level: 'occurrence' };
  const cl = E.blankTemplate('checklist', 'user:lists', E.makeLabel('清單'), null);
  const withChoice = E.addChoice(cl, occ, E.makeLabel('微棲地'));
  const t1 = withChoice.template;
  eq('choice: added with a new list when the template has none', [t1.codelists.map((l) => l.id), t1.components.find((c) => c.key === withChoice.key).params], [['list_1'], { list: 'list_1', multi: false }]);
  const second = E.addChoice(t1, occ, E.makeLabel('不該建立'));
  eq('choice: a second one uses the first list, no new list', [second.template.codelists.length, second.key], [1, 'choice_2']);
  eq('issues: an empty list', E.draftIssues(t1).map((i) => i.code), ['list_no_codes']);
  let t2 = E.addCode(E.addCode(t1, 'list_1'), 'list_1');
  eq('codes: numbered as added', t2.codelists[0].items.map((x) => x.code), ['1', '2']);
  eq('issues: codes need names', E.draftIssues(t2).map((i) => `${i.code}:${i.index}`), ['code_name_empty:0', 'code_name_empty:1']);
  t2 = E.updateCode(t2, 'list_1', 0, { code: 'rock', name: { text: '岩石', en: 'Rock' } }, null);
  t2 = E.updateCode(t2, 'list_1', 1, { code: 'rock', name: { text: '倒木', en: '' } }, null);
  eq('issues: a duplicate code', E.draftIssues(t2).map((i) => `${i.code}:${i.index}`), ['code_duplicate:1']);
  t2 = E.updateCode(t2, 'list_1', 1, { code: 'log' }, null);
  eq('codes: valid once named and distinct', [E.draftIssues(t2), validateTemplate(t2)], [[], []]);
  // once saved, a code keeps its value; removing it marks it deprecated
  const saved = { ...t2 };
  const renamed = E.updateCode(t2, 'list_1', 0, { code: 'stone', name: { text: '石頭', en: 'Stone' } }, saved);
  eq('codes: a saved code is not renamed, its name changes', [renamed.codelists[0].items[0].code, renamed.codelists[0].items[0].label.text], ['rock', '石頭']);
  const gone = E.removeCode(t2, 'list_1', 1, saved);
  eq('codes: a saved code removed is only deprecated', [gone.codelists[0].items.length, gone.codelists[0].items[1].deprecated], [2, true]);
  eq('codes: deprecating is additive, removing a saved code breaking', [classifyChange({ ...saved, version: 1 }, { ...gone, version: 2 }), classifyChange({ ...saved, version: 1 }, { ...saved, version: 2, codelists: [{ ...saved.codelists[0], items: [saved.codelists[0].items[0]] }] })], ['additive', 'breaking']);
  const added = E.addCode(t2, 'list_1');
  eq('codes: a new code is removed outright', E.removeCode(added, 'list_1', 2, saved).codelists[0].items.length, 2);
  eq('codes: undeprecate', 'deprecated' in E.updateCode(gone, 'list_1', 1, { deprecated: false }, saved).codelists[0].items[1], false);
  eq('lists: one in use is not removed', E.removeCodeList(t2, 'list_1').codelists.length, 1);
  const extra = E.addCodeList(t2, E.makeLabel('另一個'));
  eq('lists: a new list gets the next id; an unused one goes', [extra.id, E.removeCodeList(extra.template, extra.id).codelists.length], ['list_2', 1]);
  eq('lists: users', E.codeListUsers(t2, 'list_1').map((c) => c.key), [withChoice.key]);
  has('validator: a choice on a list the template lacks', validateTemplate({ ...t2, codelists: [] }), 'unknown code list list_1');
  eq('choice: single is text, several are a list', [componentDef('choice').fields({ list: 'l', multi: false }, 'occurrence', 'k')[0].storage.valueType, componentDef('choice').fields({ list: 'l', multi: true }, 'unit', 'k')[0].storage.valueType], ['text', 'json']);
  eq('choice: changing single to several needs a new survey', paramsChangeOf(componentDef('choice'), { list: 'l', multi: false }, { list: 'l', multi: true }), 'breaking');
}

// ── 8. template files (.mtpl.json, 2D-b) ───────────────────────────────────
{
  const src = E.addChoice(E.blankTemplate('plot', 'user:share', E.makeLabel('分享'), E.makeLabel('小區')), { level: 'occurrence' }, E.makeLabel('微棲地')).template;
  const withCode = E.updateCode(E.addCode(src, 'list_1'), 'list_1', 0, { code: 'rock', name: { text: '岩石', en: 'Rock' } }, null);
  const text = S.templateFileText(withCode, 1000);
  let n = 0;
  const newId = () => `user:new${++n}`;
  const back = S.readTemplateFile(text, new Set(), newId);
  ok('file: read back as an imported template, same id, version 1', back.ok && back.template.id === 'user:share' && back.template.origin === 'imported' && back.template.version === 1 && !back.renamed);
  eq('file: structure kept (units, components, code lists)', back.ok && [back.template.units, back.template.components.length, back.template.codelists], [withCode.units, withCode.components.length, withCode.codelists]);
  const again = S.readTemplateFile(text, new Set(['user:share']), newId);
  ok('file: an id already here comes in under a new id, not over it', again.ok && again.template.id === 'user:new1' && again.renamed);
  const builtin = S.readTemplateFile(S.templateFileText({ ...SAMPLE_PLOT_TEMPLATE, id: 'builtin:x', origin: 'builtin' }, 1), new Set(), newId);
  ok('file: a built-in id never comes in as is', builtin.ok && builtin.template.id === 'user:new2' && builtin.template.origin === 'imported');
  ok('file: units put on the positional keys', builtin.ok && builtin.template.units.map((u) => u.key).join() === 'u1,u2');
  const newer = S.readTemplateFile(S.templateFileText({ ...withCode, components: [...withCode.components, { key: 'x', type: 'hologram', level: 'survey', required: false, params: {} }] }, 1), new Set(), newId);
  eq('file: a component this app does not know is refused, named', newer, { ok: false, reason: 'newer_app', types: ['hologram'] });
  eq('file: not a template', [S.readTemplateFile('{"a":1}', new Set(), newId), S.readTemplateFile('nope', new Set(), newId)].map((r) => r.ok || r.reason), ['not_a_template', 'not_a_template']);
  const bad = S.readTemplateFile(S.templateFileText({ ...withCode, codelists: [] }, 1), new Set(), newId);
  ok('file: an invalid template is refused with its problems', !bad.ok && bad.reason === 'invalid' && /unknown code list/.test(bad.detail));
}

// ── 9. tree census templates (2D-b) ────────────────────────────────────────
{
  const c0 = E.copyTemplate(STEMMAP_TEMPLATE, 'user:census', E.makeLabel('每木'));
  ok('census: a copy of the built-in is a valid user template', c0.origin === 'user' && !c0.builtin_key && !c0.description && validateTemplate(c0).length === 0);
  eq('census: its places are the census, quadrat, tree and stem', E.placesOf(c0).map((p) => p.level), ['survey', 'quadrat', 'individual', 'stem']);
  eq('census: the tree takes traits only (height and photos are there)', E.addableTypes(c0, { level: 'individual' }), ['traits']);
  eq('census: nothing to add on the census, quadrat or stem', [E.addableTypes(c0, { level: 'survey' }), E.addableTypes(c0, { level: 'quadrat' }), E.addableTypes(c0, { level: 'stem' })], [[], [], []]);
  const fixed = c0.components.filter((c) => E.isFixedComponent(c0, c)).map((c) => c.key);
  eq('census: all but height and photos are fixed', fixed, c0.components.map((c) => c.key).filter((k) => k !== 'height' && k !== 'photos'));
  eq('census: removing a fixed component changes nothing', ['dbh', 'health', 'workers', 'location', 'taxon'].map((k) => E.removeComponent(c0, k) === c0), [true, true, true, true, true]);
  const noH = E.removeComponent(E.removeComponent(c0, 'height'), 'photos');
  eq('census: height and photos can go, and come back', [noH.components.length, E.addableTypes(noH, { level: 'individual' })], [c0.components.length - 2, ['height', 'photos', 'traits']]);
  ok('census: required flags stay as the census sets them', E.updateComponent(c0, 'photos', { required: true }).components.find((c) => c.key === 'photos').required === false);
  eq('census: parameters offered for Health, Location and the optional ones', c0.components.filter((c) => E.hasEditableParams(c0, c)).map((c) => c.type), ['location', 'height', 'photos', 'health']);
  const t1 = E.addComponent(c0, 'traits', { level: 'individual' });
  const withT = t1.template;
  ok('census: a Traits component on the tree validates (stored per census on the tree)', validateTemplate(withT).length === 0 && withT.components.find((c) => c.key === t1.key).level === 'individual');
  // Health code sets: the census codes stay, AMS and lists come and go.
  const list = E.addCodeList(withT, E.makeLabel('損傷'));
  let h = E.updateCode(E.addCode(list.template, list.id), list.id, 0, { name: { text: '蟲害', en: '' } }, null);
  h = E.setHealthCodeset(h, 'health', 'forestgeo-census-1998', false);
  h = E.setHealthCodeset(E.setHealthCodeset(h, 'health', 'forestgeo-ams-2021', true), 'health', list.id, true);
  eq('census: Health takes AMS and a list, keeps the census codes', h.components.find((c) => c.key === 'health').params.codesets, ['forestgeo-census-1998', 'forestgeo-ams-2021', list.id]);
  ok('census: the list is in use (cannot be deleted)', E.removeCodeList(h, list.id) === h);
  eq('census: adding AMS or a list is additive; taking one away breaks', [classifyChange(withT, { ...h }), classifyChange(h, E.setHealthCodeset(h, 'health', 'forestgeo-ams-2021', false))], ['additive', 'breaking']);
  has('census: a census template without the census codes is refused', validateTemplate({ ...c0, components: c0.components.map((c) => (c.type === 'health' ? { ...c, params: { codesets: ['forestgeo-ams-2021'] } } : c)) }), 'forestgeo-census-1998');
  eq('census: a location method more is additive, one less breaks', [
    classifyChange(E.updateComponent(c0, 'location', { params: { methods: ['grid', 'xy'] } }), c0),
    classifyChange(c0, E.updateComponent(c0, 'location', { params: { methods: ['grid', 'xy'] } })),
  ], ['additive', 'breaking']);
  ok('census: Traits stay off the stem and the census', !E.addableTypes(c0, { level: 'stem' }).includes('traits') && validateTemplate({ ...withT, components: withT.components.map((c) => (c.key === t1.key ? { ...c, level: 'stem' } : c)) }).length > 0);
}

// ── 10. interactions (2F) ──────────────────────────────────────────────────
{
  const occ = { level: 'occurrence' };
  const cl = E.blankTemplate('checklist', 'user:inter', E.makeLabel('交互'), null);
  ok('interaction: offered on the occurrence level only', E.addableTypes(cl, occ).includes('interaction') && !E.addableTypes(cl, { level: 'survey' }).includes('interaction'));
  const a = E.addComponent(cl, 'interaction', occ);
  const t0 = a.template;
  eq('interaction: added with every built-in type, the count and two photos', t0.components.find((c) => c.key === a.key).params, { builtin: BUILTIN_INTERACTIONS.map((b) => b.code), count: true, photos: 2 });
  eq('interaction: valid as added', [validateTemplate(t0), E.draftIssues(t0)], [[], []]);
  ok('interaction: once per occurrence', !E.addableTypes(t0, occ).includes('interaction'));
  ok('interaction: not in a census', !E.addableTypes(E.copyTemplate(STEMMAP_TEMPLATE, 'user:c', E.makeLabel('c')), { level: 'individual' }).includes('interaction'));
  // built-in types on and off
  let t1 = E.setInteractionBuiltin(t0, a.key, 'parasitism', false);
  t1 = E.setInteractionBuiltin(t1, a.key, 'parasitism', true);
  eq('interaction: built-ins keep the app’s order whatever the order ticked', t1.components.find((c) => c.key === a.key).params.builtin, BUILTIN_INTERACTIONS.map((b) => b.code));
  let none = t0;
  for (const b of BUILTIN_INTERACTIONS) none = E.setInteractionBuiltin(none, a.key, b.code, false);
  eq('interaction: no type at all is an issue and refused', [E.draftIssues(none).map((i) => i.code), validateTemplate(none).some((p) => p.includes('offers no interaction type'))], [['interaction_none'], true]);
  // its own types: a list made on the first one
  const own = E.addInteractionType(none, a.key, E.makeLabel('交互作用類型'));
  let t2 = own.template;
  eq('interaction: the first own type makes the list and names it', [t2.codelists.map((l) => l.id), t2.components.find((c) => c.key === a.key).params.list, E.isInteractionList(t2, own.listId)], [[own.listId], own.listId, true]);
  t2 = E.updateCode(t2, own.listId, own.index, { name: { text: '產卵於', en: 'lays eggs on' }, inverse: { text: '被產卵', en: '' }, iri: ' ' }, null);
  eq('interaction: an own type with its name and reading from B', t2.codelists[0].items[0], { code: '1', label: { text: '產卵於', tr: { en: 'lays eggs on' } }, inverse: { text: '被產卵' } });
  eq('interaction: one own type is enough', [E.draftIssues(t2), validateTemplate(t2)], [[], []]);
  eq('interaction: its list is in use (cannot be deleted)', [E.codeListUsers(t2, own.listId).map((c) => c.key), E.removeCodeList(t2, own.listId) === t2], [[a.key], true]);
  const both = E.updateCode(t2, own.listId, 0, { mutual: true }, null);
  eq('interaction: both ways drops the reading from B', [both.codelists[0].items[0].mutual, 'inverse' in both.codelists[0].items[0]], [true, false]);
  const saved = { ...t2 };
  ok('interaction: a saved type keeps its direction', !E.updateCode(t2, own.listId, 0, { mutual: true }, saved).codelists[0].items[0].mutual);
  eq('interaction: turning a type both ways breaks; renaming it does not', [classifyChange(saved, both), classifyChange(saved, E.updateCode(t2, own.listId, 0, { name: { text: '產卵', en: '' } }, saved))], ['breaking', 'additive']);
  has('interaction: an IRI must be an address', validateTemplate(E.updateCode(t2, own.listId, 0, { iri: 'RO_0002470' }, null)), 'iri must be an http(s) address');
  eq('interaction: an http(s) IRI passes', validateTemplate(E.updateCode(t2, own.listId, 0, { iri: 'http://purl.obolibrary.org/obo/RO_0002470' }, null)), []);
  const clash = E.updateCode(t2, own.listId, 0, { code: 'feeding' }, null);
  eq('interaction: an own code may not be a built-in one', [E.draftIssues(clash).map((i) => i.code), validateTemplate(clash).some((p) => p.includes('is a built-in interaction type'))], [['interaction_code'], true]);
  has('interaction: a list the template lacks', validateTemplate({ ...t2, codelists: [] }), 'unknown code list');
  // what a running survey can take
  const d = componentDef('interaction');
  const p0 = { builtin: ['feeding'], count: false, photos: 1 };
  eq('interaction: more types, a list where there was none, the count on, more photos — additive', [
    paramsChangeOf(d, p0, { ...p0, builtin: ['feeding', 'flower_visit'] }),
    paramsChangeOf(d, p0, { ...p0, list: 'list_1' }),
    paramsChangeOf(d, p0, { ...p0, count: true }),
    paramsChangeOf(d, p0, { ...p0, photos: 3 }),
  ], ['additive', 'additive', 'additive', 'additive']);
  eq('interaction: a type less, another list, the count off, fewer photos — breaking', [
    paramsChangeOf(d, p0, { ...p0, builtin: [] }),
    paramsChangeOf(d, { ...p0, list: 'list_1' }, { ...p0, list: 'list_2' }),
    paramsChangeOf(d, { ...p0, count: true }, p0),
    paramsChangeOf(d, p0, { ...p0, photos: 0 }),
  ], ['breaking', 'breaking', 'breaking', 'breaking']);
  has('interaction: parameters are checked', d.checkParams({ builtin: ['eats'], count: 1, photos: 30 }, 'occurrence'), 'builtin must list built-in types');
  // Built-in names are i18n keys built at run time: every language has them.
  const LOCALES = ['zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es'];
  for (const loc of LOCALES) {
    const tree = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${loc}.json`, import.meta.url), 'utf8'));
    const at = (key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), tree);
    const keys = [
      ...BUILTIN_INTERACTIONS.flatMap((b) => ['name', 'verb', ...(b.mutual ? [] : ['inverse'])].map((part) => `survey.interaction.type.${b.code}.${part}`)),
      ...['forward', 'backward', 'mutual'].flatMap((d2) => [`survey.interaction.dir.${d2}`, `survey.interaction.sentence.${d2}`]),
    ];
    const missing = keys.filter((k) => typeof at(k) !== 'string');
    eq(`interaction: ${loc} names every built-in type, direction and sentence`, missing, []);
  }
}

// ── 4b. 調查法 and 開闊度 (2G-f) ──────────────────────────────────────────────
{
  const keys = SAMPLING_METHODS.map((m) => m.key);
  eq('method: built-in keys distinct', keys.length, new Set(keys).size);
  eq('method: Chinese names distinct', SAMPLING_METHODS.length, new Set(SAMPLING_METHODS.map((m) => m.zh)).size);
  ok('method: every group has methods, every method a known group', METHOD_GROUPS.every((g) => SAMPLING_METHODS.some((m) => m.group === g)) && SAMPLING_METHODS.every((m) => METHOD_GROUPS.includes(m.group)));
  ok('method: a size names units, an effort a unit', SAMPLING_METHODS.every((m) => (!m.size || SIZE_UNITS[m.size]?.length) && (m.effort == null || /^[a-z]+-[a-z]+$/.test(m.effort))));
  ok('method: the custom key is not a built-in', !keys.includes(CUSTOM_METHOD));
  const md = componentDef('method');
  eq('method: default parameters pass', md.checkParams(md.defaultParams, 'survey'), []);
  ok('method: an unknown method is refused', md.checkParams({ methods: ['nope'], fixed: null, custom: true }, 'survey').length === 1);
  ok('method: a fixed method must be built in', md.checkParams({ methods: [], fixed: 'custom', custom: true }, 'survey').length === 1);
  const all = { methods: [], fixed: null, custom: true };
  eq('method: from all to some narrows it', pc('method', all, { ...all, methods: ['plot_survey'] }), 'breaking');
  eq('method: more methods widen it', pc('method', { ...all, methods: ['plot_survey'] }, { ...all, methods: ['plot_survey', 'inventory'] }), 'additive');
  eq('method: from some to all widens it', pc('method', { ...all, methods: ['plot_survey'] }, all), 'additive');
  eq('method: fewer methods narrow it', pc('method', { ...all, methods: ['plot_survey', 'inventory'] }, { ...all, methods: ['inventory'] }), 'breaking');
  eq('method: fixing a method changes it', pc('method', all, { ...all, fixed: 'plot_survey' }), 'breaking');
  eq('method: no longer allowing one’s own narrows it', pc('method', all, { ...all, custom: false }), 'breaking');
  eq('method: allowing one’s own widens it', pc('method', { ...all, custom: false }, all), 'additive');
  const env = componentDef('environment');
  const names = (p) => env.fields(p, 'survey', 'env').map((f) => f.field);
  ok('openness: a percentage by default', names({ fields: ['openness'] }).join() === 'openness_pct');
  ok('openness: a grade when a list is named', names({ fields: ['openness'], openness_list: 'o' }).join() === 'openness_grade');
  ok('openness: the export follows the field', exportMapOf(env, { fields: ['openness'], openness_list: 'o' }, 'survey').mof.openness_grade && !exportMapOf(env, { fields: ['openness'] }, 'survey').mof.openness_grade);
  eq('openness: environment changing from % to grades needs a new survey', pc('environment', { fields: ['openness'] }, { fields: ['openness'], openness_list: 'o' }), 'breaking');
  const T = withRequired({ ...base, id: 'user:open', version: 1, style: 'plot', units: [], components: [{ key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['openness'], openness_list: 'missing' } }], codelists: [] });
  ok('openness: an unknown list is refused', validateTemplate(T).some((e) => /unknown code list missing/.test(e)));
}

// ── 11. schema 2: 空間資料 modules and comments by level (2026-10-04) ──────
{
  const v1 = {
    schema: 1,
    id: 'user:old',
    version: 3,
    origin: 'user',
    name: { text: '舊模板' },
    style: 'checklist',
    components: [
      { key: 'site', type: 'choice', level: 'survey', required: false, params: { list: 'l', multi: false } },
      { key: 'occ_notes', type: 'comments', level: 'occurrence', required: true, params: {} },
    ],
    codelists: [{ id: 'l', label: { text: 'L' }, items: [{ code: 'a', label: { text: 'A' } }, { code: 'b', label: { text: 'B' } }] }],
    quick_add: true,
  };
  const n = normalizeTemplate(withRequired(v1));
  eq('normalize: schema 2', n.schema, 2);
  eq(
    'normalize: the three modules added on the survey level, after the rest; a taken key gets a suffix',
    n.components.filter((c) => SPATIAL_TYPES.includes(c.type)).map((c) => `${c.type}:${c.key}:${c.level}:${c.required}`),
    ['centre:centre:survey:false', 'site:site_2:survey:false', 'track:track:survey:false'],
  );
  ok('normalize: a schema-1 species comment was fixed, not 必填', n.components.find((c) => c.key === 'occ_notes').required === false && !requiredByAuthor(n.components.find((c) => c.key === 'occ_notes')));
  ok('normalize: idempotent and deterministic', JSON.stringify(normalizeTemplate(n)) === JSON.stringify(n) && JSON.stringify(normalizeTemplate(withRequired(v1))) === JSON.stringify(n));
  eq('normalize: valid', validateTemplate(n), []);
  ok('normalize: a census template is left as it is', normalizeTemplate(STEMMAP_TEMPLATE) === STEMMAP_TEMPLATE);
  ok('normalize: a schema-2 template is left as it is', normalizeTemplate(n) === n || JSON.stringify(normalizeTemplate(n)) === JSON.stringify(n));
  eq('parseSnapshot: the stored text, normalized', parseSnapshot(JSON.stringify(v1)).components.filter((c) => SPATIAL_TYPES.includes(c.type)).length, 3);
  // Dropping a module the old template implicitly had: not a change a running survey can take.
  eq('normalize: removing the centre from a schema-1 template is breaking', classifyChange(n, { ...n, version: 4, components: n.components.filter((c) => c.type !== 'centre') }), 'breaking');
  eq('normalize: the same template saved as schema 2 is the same', classifyChange(n, { ...n, version: 4 }), 'same');
  // comments: always present on the survey level only
  ok('fixedAt: comments on the survey level only', fixedAt(componentDef('comments'), 'survey') && !fixedAt(componentDef('comments'), 'occurrence') && !fixedAt(componentDef('comments'), 'unit'));
  ok('fixedAt: taxon wherever it sits', fixedAt(componentDef('taxon'), 'occurrence') && fixedAt(componentDef('taxon'), 'individual'));
  const occR = { ...n, components: n.components.map((c) => (c.key === 'occ_notes' ? { ...c, required: true } : c)) };
  eq('comments: a species\' comments may be 必填', validateTemplate(occR), []);
  ok('comments: … and then is the author\'s', requiredByAuthor(occR.components.find((c) => c.key === 'occ_notes')));
  ok('comments: never the survey\'s', !requiredByAuthor(n.components.find((c) => c.type === 'comments' && c.level === 'survey')));
  const noSurveyNotes = { ...n, components: n.components.filter((c) => !(c.type === 'comments' && c.level === 'survey')) };
  ok('comments: missing on the survey level is reported even with a species\' comments', validateTemplate(noSurveyNotes).includes('missing required component comments'));
  const back = withRequired(noSurveyNotes);
  ok('comments: withRequired puts the survey\'s back, under a free key', back.components.filter((c) => c.type === 'comments' && c.level === 'survey').length === 1 && new Set(back.components.map((c) => c.key)).size === back.components.length);
  ok('comments: the survey\'s cannot be optional', validateTemplate({ ...n, components: n.components.map((c) => (c.type === 'comments' && c.level === 'survey' ? { ...c, required: false } : c)) }).some((p) => p.includes('is always required')));
  const bare = { ...n, components: n.components.filter((c) => c.key !== 'occ_notes') };
  ok('comments: addable on a species and a unit, not on the survey', E.addableTypes(bare, { level: 'occurrence' }).includes('comments') && !E.addableTypes(bare, { level: 'survey' }).includes('comments'));
  const plotT = E.blankTemplate('plot', 'user:p', E.makeLabel('P'), E.makeLabel('小區'));
  ok('comments: addable on a unit level', E.addableTypes(plotT, { level: 'unit', unit: plotT.units[0].key }).includes('comments'));
  ok('comments: a species\' comments can be removed and made 必填; the survey\'s cannot', !E.isFixedComponent(occR, occR.components.find((c) => c.key === 'occ_notes')) && E.isFixedComponent(n, n.components.find((c) => c.type === 'comments' && c.level === 'survey')) && E.updateComponent(n, 'occ_notes', { required: true }).components.find((c) => c.key === 'occ_notes').required === true);
  // spatial modules in the builder
  const noSpace = { ...n, components: n.components.filter((c) => !SPATIAL_TYPES.includes(c.type)) };
  ok('spatial: addable on the survey level of a checklist / plot template', SPATIAL_TYPES.every((type) => E.addableTypes(noSpace, { level: 'survey' }).includes(type)));
  ok('spatial: once each', SPATIAL_TYPES.every((type) => !E.addableTypes(n, { level: 'survey' }).includes(type)));
  ok('spatial: not in a census', SPATIAL_TYPES.every((type) => !componentDef(type).styles.includes('individual')));
  ok('spatial: removable', E.removeComponent(n, 'centre').components.every((c) => c.type !== 'centre'));
  ok('spatial: the survey row\'s columns, no export map of their own', SPATIAL_TYPES.every((type) => componentDef(type).rowFixed === true));
  // Every template read goes through normalize: no other parse of a template (the census keeps schema 1).
  const PARSE_OK = new Set(['src/survey/template/normalize.ts', 'src/survey/db/stemmapCore.ts', 'src/survey/stemmap/censusTables.ts', 'src/db/migrations.ts']);
  const raw = [];
  for (const f of readdirRecursive('src')) {
    if (PARSE_OK.has(f) || !/\.(ts|tsx)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    if (/(?<!normalizeTemplate\()JSON\.parse\([^)]*\)\s*as\s*SurveyTemplate/.test(text) || /JSON\.parse\([^;]*template_snapshot/.test(text)) raw.push(f);
  }
  eq('normalize: no template is parsed around it', raw, []);
}

// ── 5. hash ─────────────────────────────────────────────────────────────────
const reordered = Object.fromEntries(Object.entries(base).reverse());
eq('hash ignores key order', templateHash(reordered), templateHash(base));
ok('hash changes with content', templateHash(v2({})) !== templateHash(base));

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ templates: built-ins valid, registry complete, validator and change rules hold');
