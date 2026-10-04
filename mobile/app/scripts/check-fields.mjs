/**
 * 自訂欄位 (six-item plan C, 2026-10-04): the definitions and their rules
 * (template/obsField.ts), the field component (registry), adding one to a
 * template, the library on the real migrations (v90, fieldsCore.ts), and a
 * field's values in a survey's DwC measurements and spreadsheet tables.
 *
 * Run: npm run check:fields
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import { componentProblems, storeBlockers } from '../src/survey/componentRules.ts';
import * as fl from '../src/survey/db/fieldsCore.ts';
import * as c from '../src/survey/db/surveyCore.ts';
import * as d from '../src/survey/db/surveyDocCore.ts';
import * as tp from '../src/survey/db/templatesCore.ts';
import { surveyDwcRows, REMARKS } from '../src/survey/export/surveyDwcCore.ts';
import { surveyTables } from '../src/survey/export/surveyExportCore.ts';
import { componentDef, groupOfType, paramsChangeOf } from '../src/survey/registry.ts';
import * as E from '../src/survey/template/edit.ts';
import { convertLegacyComponents, fitTemplateFields } from '../src/survey/template/legacyFields.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import {
  checkFieldDef,
  datetimeValue,
  fieldChange,
  fieldDefOf,
  formatOk,
  libraryFit,
  mergeFieldDefs,
  normalizeDna,
  parseAllowedInput,
  suggestKey,
  syncTemplateFields,
  valueToTs,
} from '../src/survey/template/obsField.ts';
import { classifyChange, validateTemplate, withRequired } from '../src/survey/template/validate.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsCode = (fn, code, msg) => {
  try {
    fn();
  } catch (e) {
    ok(e?.code === code, `${msg} (threw ${e?.code ?? e?.message})`);
    return;
  }
  ok(false, `${msg} (did not throw)`);
};

const yesNo = { key: 'flowering', name: '開花', name_en: 'Flowering', datatype: 'text', allowed: [{ value: '是', en: 'yes' }, { value: '否', en: 'no' }] };
const leafLen = { key: 'leaf_len', name: '葉長', datatype: 'numeric', numeric_kind: 'float', min: 0, max: 50, unit: 'cm' };

// ── definitions ──
ok(checkFieldDef(yesNo).length === 0 && checkFieldDef(leafLen).length === 0, 'def: a text field with values and a numeric one are valid');
for (const dt of ['date', 'time', 'datetime', 'taxon', 'dna']) ok(checkFieldDef({ key: `f_${dt}`, name: dt, datatype: dt }).length === 0, `def: a ${dt} field is valid`);
ok(checkFieldDef({ ...yesNo, key: 'Flowering' }).length > 0 && checkFieldDef({ ...yesNo, key: '1x' }).length > 0 && checkFieldDef({ ...yesNo, key: 'a-b' }).length > 0, 'def: a key is lower-case, starts with a letter, letters digits _');
ok(checkFieldDef({ ...yesNo, name: '  ' }).length > 0, 'def: a name is required');
ok(checkFieldDef({ ...yesNo, datatype: 'boolean' }).length > 0, 'def: only the seven types');
ok(checkFieldDef({ ...yesNo, allowed: [{ value: '是' }] }).length > 0, 'def: at least two allowed values (iNaturalist)');
ok(checkFieldDef({ ...yesNo, allowed: [{ value: '是' }, { value: '是' }] }).length > 0, 'def: allowed values are distinct');
ok(checkFieldDef({ ...yesNo, allowed: [{ value: 'a|b' }, { value: 'c' }] }).length > 0, 'def: no | in a value (it separates them)');
ok(checkFieldDef({ ...leafLen, allowed: [{ value: 'a' }, { value: 'b' }] }).length > 0, 'def: allowed values on text only');
ok(checkFieldDef({ ...yesNo, unit: 'cm' }).length > 0 && checkFieldDef({ ...yesNo, min: 1 }).length > 0, 'def: range and unit on numeric only');
ok(checkFieldDef({ key: 'free', name: 'x', datatype: 'text', multi: true }).length > 0, 'def: several values only with allowed values');
ok(checkFieldDef({ ...leafLen, min: 60 }).length > 0, 'def: min not above max');
ok(eq(fieldDefOf({ ...yesNo, min: 3, unit: 'x' }), fieldDefOf(yesNo)) && fieldDefOf({ ...yesNo, min: 3 }).min === undefined, 'def: what does not belong to the type is dropped when read');
ok(fieldDefOf({ key: 'x', name: 'x', datatype: 'nope' }) === null, 'def: not a definition → null');

// ── change rules ──
const ch = (a, b) => fieldChange(fieldDefOf(a), fieldDefOf(b));
ok(ch(yesNo, yesNo) === 'same', 'change: same');
ok(ch(yesNo, { ...yesNo, name: '開花中', name_en: 'In flower', description: '花或花苞' }) === 'additive', 'change: names and description');
ok(ch(yesNo, { ...yesNo, allowed: [...yesNo.allowed, { value: '不確定' }] }) === 'additive', 'change: a value added');
ok(ch(yesNo, { ...yesNo, allowed: [{ value: '是', en: 'Yes', deprecated: true }, { value: '否', en: 'no' }] }) === 'additive', 'change: a value renamed in English or deprecated');
ok(ch(yesNo, { ...yesNo, allowed: [{ value: '是' }, { value: '不是' }] }) === 'breaking', 'change: a value dropped or recoded');
ok(ch({ key: 'f', name: 'f', datatype: 'text' }, { key: 'f', name: 'f', datatype: 'text', allowed: [{ value: 'a' }, { value: 'b' }] }) === 'breaking', 'change: a free text field restricted');
ok(ch(yesNo, { ...yesNo, allowed: undefined }) === 'additive', 'change: a restricted field freed');
ok(ch(yesNo, { ...yesNo, multi: true }) === 'breaking', 'change: one value → several (stored differently)');
ok(ch(yesNo, { ...yesNo, key: 'flower' }) === 'breaking' && ch(yesNo, { ...yesNo, datatype: 'dna', allowed: undefined }) === 'breaking', 'change: key and type stay');
ok(ch(leafLen, { ...leafLen, min: -1, max: 80 }) === 'additive', 'change: a range widened');
ok(ch(leafLen, { ...leafLen, max: 30 }) === 'breaking' && ch(leafLen, { ...leafLen, min: 1 }) === 'breaking', 'change: a range narrowed');
ok(ch({ ...leafLen, min: undefined }, leafLen) === 'breaking', 'change: a bound added where there was none');
ok(ch({ ...leafLen, numeric_kind: 'integer' }, leafLen) === 'additive' && ch(leafLen, { ...leafLen, numeric_kind: 'integer' }) === 'breaking', 'change: integer → decimal only');
ok(ch(leafLen, { ...leafLen, unit: 'mm' }) === 'breaking', 'change: the unit stays');
ok(paramsChangeOf(componentDef('field'), yesNo, { ...yesNo, allowed: [...yesNo.allowed, { value: '?' }] }) === 'additive', 'change: the registry uses the field rules');

// ── input helpers ──
ok(eq(parseAllowedInput(' yes | no |yes\n maybe '), ['yes', 'no', 'maybe']), 'input: | or lines, trimmed, repeats dropped');
ok(suggestKey('Leaf length (cm)', new Set()) === 'leaf_length_cm' && suggestKey('Leaf length', new Set(['leaf_length'])) === 'leaf_length_2', 'key: from the English name, unique');
ok(suggestKey('葉長', new Set()) === 'field' && suggestKey('2nd try', new Set()) === 'nd_try', 'key: a name without letters falls back; it starts with a letter');
ok(formatOk('date', '2026-10-04') && !formatOk('date', '2026-02-30') && !formatOk('date', '2026-1-4'), 'format: a real calendar date');
ok(formatOk('time', '08:05') && formatOk('time', '23:59') && !formatOk('time', '24:00') && !formatOk('time', '8:05'), 'format: HH:MM');
ok(formatOk('datetime', '2026-10-04T08:05+08:00') && formatOk('datetime', '2026-10-04T08:05:30Z') && formatOk('datetime', '2026-10-04T08:05') && !formatOk('datetime', '2026-10-04 08:05'), 'format: ISO 8601 date and time');
ok(formatOk('dna', 'ATCG GATTACA') && !formatOk('dna', 'atcg') && !formatOk('dna', 'ATCGN') && !formatOk('dna', 'AT  CG'), 'format: DNA');
ok(normalizeDna(' at cg\n gattaca ') === 'AT CG GATTACA', 'dna: upper case, one space');
const stamp = new Date(2026, 9, 4, 8, 5).getTime();
ok(valueToTs('datetime', datetimeValue(stamp)) === stamp && formatOk('datetime', datetimeValue(stamp)), `datetime: written with its offset and read back (${datetimeValue(stamp)})`);
ok(valueToTs('date', '2026-02-30') === null && valueToTs('time', '08:05') != null, 'datetime: only a value of its form is read');

// ── the component ──
const fd = componentDef('field');
const fieldsOf = (p) => fd.fields(p, 'occurrence', 'k').map((f) => `${f.field}:${f.storage.valueType}`);
ok(eq(fieldsOf(yesNo), ['value:text']) && eq(fieldsOf({ ...yesNo, multi: true }), ['value:json']) && eq(fieldsOf(leafLen), ['value:num']), 'component: text, several values, number');
ok(eq(fieldsOf({ key: 't', name: 't', datatype: 'taxon' }), ['value:text', 'name:text', 'cname:text', 'rank:text', 'kingdom:text']), 'component: a taxon keeps its names as picked');
ok(fd.group === undefined && groupOfType('field') === 'basic' && fd.levels.join() === 'survey,unit,occurrence' && fd.cardinality === 'many', 'component: 基本資料 on the survey, on units and species, any number');
const probs = (p, v) => componentProblems(fd, p, 'occurrence', 'k', v).map((x) => x.code);
ok(eq(probs(yesNo, { value: '是' }), []) && eq(probs(yesNo, { value: '也許' }), ['not_allowed']), 'values: only an allowed value');
ok(eq(probs({ ...yesNo, multi: true }, { value: ['是', '否'] }), []) && eq(probs({ ...yesNo, multi: true }, { value: '是' }), ['not_a_list']), 'values: several as a list');
ok(eq(probs(leafLen, { value: 60 }), ['above_max']) && eq(probs({ ...leafLen, numeric_kind: 'integer' }, { value: 2.5 }), ['not_integer']), 'values: range and integer');
ok(eq(probs({ key: 'd', name: 'd', datatype: 'date' }, { value: '2026-13-01' }), ['bad_format']) && eq(probs({ key: 'd', name: 'd', datatype: 'dna' }, { value: 'ATCG' }), []), 'values: a date or DNA of its form');
ok(storeBlockers(fd, { key: 'd', name: 'd', datatype: 'time' }, 'occurrence', 'k', { value: '25:00' }).some((p) => p.code === 'bad_format'), 'values: a value of the wrong form is refused');

// ── templates ──
const blank = E.blankTemplate('checklist', 'user:f', E.makeLabel('欄位'), null);
const occ = { level: 'occurrence' };
ok(E.addableTypes(blank, occ).includes('field') && E.addableTypes(blank, { level: 'survey' }, 'basic').includes('field') && !E.addableTypes(blank, { level: 'survey' }, 'method').includes('field'), 'template: offered on species and on 基本資料');
const a1 = E.addField(blank, occ, yesNo);
const a2 = E.addField(a1.template, { level: 'survey' }, yesNo);
ok(a1.key === 'flowering' && a2.key === 'flowering_2', `template: keyed by the field, a suffix the second time (${a1.key}, ${a2.key})`);
ok(eq(a2.template.components.find((x) => x.key === 'flowering').params, yesNo), 'template: the definition is carried whole');
const v1 = withRequired(a2.template);
ok(validateTemplate(v1).length === 0, `template: valid (${validateTemplate(v1)})`);
const odd = { ...v1, components: v1.components.map((x) => (x.key === 'flowering_2' ? { ...x, params: { ...yesNo, name: '別名' } } : x)) };
ok(validateTemplate(odd).some((p) => /differs from its other copy/.test(p)), 'template: two copies of one field must agree');
const lib = new Map([['flowering', fieldDefOf({ ...yesNo, allowed: [...yesNo.allowed, { value: '不確定', en: 'unsure' }] })]]);
const synced = syncTemplateFields(v1, lib);
ok(synced !== v1 && synced.components.filter((x) => x.type === 'field').every((x) => x.params.allowed.length === 3), 'sync: every copy brought up to the library');
ok(syncTemplateFields(synced, lib) === synced && syncTemplateFields(v1, new Map()) === v1, 'sync: the same object when nothing changes, or the library lacks the field');
ok(classifyChange({ ...v1, version: 1 }, { ...synced, version: 2 }) === 'additive', 'sync: a value added to the field is an additive template change');

// ── the library on the real schema ──
const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
const db = {
  executeSync(sql, params = []) {
    const stmt = sqlite.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: stmt.all(...params) };
    const res = stmt.run(...params);
    return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
  },
};
await runUserMigrations(db);
let clock = 1000;
let n = 0;
const ctx = { db, now: () => ++clock, uuid: () => `u-${++n}` };
const rejects = (sql, msg) => {
  try {
    sqlite.prepare(sql).run();
  } catch {
    return;
  }
  ok(false, `${msg} (was accepted)`);
};
rejects(`INSERT INTO observation_fields (uuid, key, name, datatype, created_at, updated_at) VALUES ('x', 'ok', 'n', 'boolean', 1, 1)`, 'schema: an unknown type');
rejects(`INSERT INTO observation_fields (uuid, key, name, datatype, created_at, updated_at) VALUES ('x', 'Bad', 'n', 'text', 1, 1)`, 'schema: a key with upper case');
rejects(`INSERT INTO observation_fields (uuid, key, name, datatype, allowed_json, created_at, updated_at) VALUES ('x', 'ok', 'n', 'numeric', '[]', 1, 1)`, 'schema: allowed values on a number');
rejects(`INSERT INTO observation_fields (uuid, key, name, datatype, min, max, created_at, updated_at) VALUES ('x', 'ok', 'n', 'numeric', 5, 1, 1, 1)`, 'schema: min above max');

fl.saveField(ctx, yesNo);
fl.saveField(ctx, leafLen);
ok(eq(fl.listFields(ctx).map((r) => r.def.key).sort(), ['flowering', 'leaf_len']), 'library: both listed');
ok(eq(fl.getField(ctx, 'flowering').def, fieldDefOf(yesNo)), 'library: read back as saved');
throwsCode(() => fl.saveField(ctx, { ...leafLen, name: '另一個' }), 'field_key_taken', 'library: a key another field has');
throwsCode(() => fl.saveField(ctx, { ...leafLen, key: 'x2', min: 9, max: 1 }), 'field_invalid', 'library: an invalid definition');
// Not used yet: anything may change, the key too.
fl.saveField(ctx, { ...leafLen, key: 'leaf_length', unit: 'mm' }, 'leaf_len');
ok(fl.getField(ctx, 'leaf_len') === null && fl.getField(ctx, 'leaf_length')?.def.unit === 'mm', 'library: an unused field may be rekeyed and changed');
// Used by a saved template.
const tpl = tp.saveTemplate(ctx, v1);
ok((fl.fieldUseCounts(ctx).get('flowering') ?? 0) === 1 && !fl.fieldUseCounts(ctx).has('leaf_length'), 'library: use counted from the saved templates');
tp.saveDraft(ctx, E.addField(blank, occ, fieldDefOf({ ...leafLen, key: 'leaf_length', unit: 'mm' })).template, null);
ok((fl.fieldUseCounts(ctx).get('leaf_length') ?? 0) === 1, 'library: a draft counts too');
throwsCode(() => fl.saveField(ctx, { ...yesNo, key: 'flower' }, 'flowering'), 'field_in_use', 'library: a used field keeps its key');
throwsCode(() => fl.saveField(ctx, { ...yesNo, allowed: [{ value: '是' }, { value: '不是' }] }, 'flowering'), 'field_in_use', 'library: a used field keeps its values');
fl.saveField(ctx, { ...yesNo, allowed: [...yesNo.allowed, { value: '不確定', en: 'unsure' }] }, 'flowering');
ok(fl.getField(ctx, 'flowering').def.allowed.length === 3, 'library: a value added to a used field');
throwsCode(() => fl.deleteField(ctx, 'flowering'), 'field_in_use', 'library: a used field is not deleted');
fl.setFieldDeprecated(ctx, 'flowering', true);
ok(fl.listFields(ctx).every((r) => r.def.key !== 'flowering') && fl.listFields(ctx, { deprecated: true }).some((r) => r.def.key === 'flowering' && r.deprecated), 'library: deprecated, listed only when asked');
fl.saveField(ctx, { key: 'spare', name: '備用', datatype: 'dna' });
fl.deleteField(ctx, 'spare');
ok(fl.getField(ctx, 'spare') === null, 'library: an unused field is deleted');
ok(eq([...fl.fieldLibrary(ctx).keys()].sort(), ['flowering', 'leaf_length']), 'library: the map the builder syncs from, deprecated ones too');

// ── a survey's values and exports ──
const T = tp.saveTemplate(
  ctx,
  withRequired({
    ...blank,
    id: 'user:fexp',
    components: [
      ...blank.components,
      { key: 'flowering', type: 'field', level: 'occurrence', required: false, params: { ...yesNo, allowed: [...yesNo.allowed, { value: '不確定', en: 'unsure' }], multi: true } },
      { key: 'leaf', type: 'field', level: 'occurrence', required: false, params: leafLen },
      { key: 'host', type: 'field', level: 'occurrence', required: false, params: { key: 'host', name: '寄主', name_en: 'Host plant', datatype: 'taxon' } },
      { key: 'seen', type: 'field', level: 'survey', required: false, params: { key: 'seen', name: '日期', datatype: 'date' } },
    ],
  }),
);
const S = c.createSurvey(ctx, { template: T, investigators: '甲' });
const o = c.addOccurrence(ctx, S, { taxon_id: 't1' });
c.writeComponent(ctx, { kind: 'occurrence', id: o }, 'flowering', { value: ['是', '不確定'] });
c.writeComponent(ctx, { kind: 'occurrence', id: o }, 'leaf', { value: 4.5 });
c.writeComponent(ctx, { kind: 'occurrence', id: o }, 'host', { value: 't9', name: 'Quercus glauca', cname: '狹葉櫟', rank: 'Species', kingdom: 'Plantae' });
c.writeComponent(ctx, { kind: 'survey', id: S }, 'seen', { value: '2026-10-04' });
throwsCode(() => c.writeComponent(ctx, { kind: 'survey', id: S }, 'seen', { value: '10/04/2026' }), 'bad_value', 'survey: a date of the wrong form is refused');
throwsCode(() => c.writeComponent(ctx, { kind: 'occurrence', id: o }, 'flowering', { value: ['也許'] }), 'bad_value', 'survey: a value not allowed is refused');
const doc = d.buildSurveyDoc(ctx, S);
const words = { typeName: (x) => `<${x}>`, i18n: (k) => `[${k}]` };
const used = new Set();
const parts = surveyDwcRows(doc, {
  eventId: 'F1',
  uniqueEventId: (b) => {
    let id = b;
    for (let i = 2; used.has(id); i++) id = `${b}_${i}`;
    used.add(id);
    return id;
  },
  taxonCols: (x) => ({ taxonID: x.taxon_id, scientificName: `Name ${x.taxon_id}` }),
  words,
});
const ms = parts.measurements;
const of = (type) => ms.filter((m) => m.measurementType === type);
ok(eq(of('Flowering').map((m) => m.measurementValue).sort(), ['unsure', 'yes']), `dwc: one row per value, in English (${of('Flowering').map((m) => m.measurementValue)})`);
ok(of('葉長')[0]?.measurementValue === '4.5' && of('葉長')[0]?.measurementUnit === 'cm', 'dwc: a number with its unit; the name when there is no English one');
const host = of('Host plant')[0];
ok(host?.measurementValue === 'Quercus glauca' && host?.measurementRemarks === REMARKS.fieldTaxon('t9'), 'dwc: a taxon as its scientific name, the id in the remarks');
ok(of('日期')[0]?.measurementValue === '2026-10-04' && of('日期')[0]?.occurrenceID === '', 'dwc: a survey-level field on the event');
ok(of('Flowering').every((m) => m.occurrenceID && ms.filter((x) => x.measurementID === m.measurementID).length === 1), 'dwc: on the occurrence, ids unique');
const tables = surveyTables(doc, { eventId: 'F1', names: () => ({ scientific: null, vernacular: null }), words });
const head = tables.occurrences.header;
ok(['flowering.value', 'flowering.value_en', 'leaf.value', 'host.value', 'host.name', 'host.cname'].every((h) => head.includes(h)), `csv: the field's columns (${head.filter((h) => /flowering|leaf|host/.test(h))})`);
const row = tables.occurrences.rows[0];
const cell = (h) => row[head.indexOf(h)];
ok(cell('flowering.value') === '是;不確定' && cell('flowering.value_en') === 'yes;unsure' && cell('host.name') === 'Quercus glauca', 'csv: values, their English names, the taxon');
const dict = tables.fields;
const drow = dict.rows.find((r) => r[dict.header.indexOf('column')] === 'flowering.value');
const dget = (h) => drow?.[dict.header.indexOf(h)];
ok(dget('field_datatype') === 'text' && dget('allowed_values') === '是=yes|否=no|不確定=unsure' && dget('component_name') === '開花' && dget('component_name_en') === 'Flowering', 'csv: the dictionary says type, values and names');

// ── the library takes definitions from elsewhere (D) ──
{
  const F = (x) => fieldDefOf(x);
  const lib = F({ key: 'micro', name: '微棲地', datatype: 'text', allowed: [{ value: '岩石' }, { value: '苔蘚', deprecated: true }], multi: true });
  const inc = F({ key: 'micro', name: 'Micro', datatype: 'text', allowed: [{ value: '倒木', en: 'Log' }, { value: '岩石', en: 'Rock' }], multi: true });
  const m = mergeFieldDefs(lib, inc);
  ok(eq(m?.allowed.map((a) => a.value), ['岩石', '苔蘚', '倒木']) && m.name === '微棲地' && m.allowed[1].deprecated === true, `merge: the library's values and names first, then the new values (${m?.allowed.map((a) => a.value)})`);
  ok(fieldChange(lib, m) === 'additive', 'merge: a change every template using the field can take');
  const n1 = F({ key: 'n', name: 'n', datatype: 'numeric', numeric_kind: 'integer', min: 0, max: 10, unit: 'cm' });
  const nm = mergeFieldDefs(n1, F({ ...n1, numeric_kind: 'float', min: -2, max: undefined }));
  ok(nm?.numeric_kind === 'float' && nm.min === -2 && nm.max === undefined && fieldChange(n1, nm) === 'additive', 'merge: the wider range (a missing bound wins), decimal over integer');
  ok(mergeFieldDefs(n1, F({ ...n1, unit: 'mm' })) === null && mergeFieldDefs(lib, F({ ...inc, multi: false })) === null, 'merge: not across units or single / several');
  const one = F({ key: 'k', name: 'k', datatype: 'text', allowed: [{ value: 'a' }, { value: 'b' }] });
  const free = F({ key: 'k', name: 'k', datatype: 'text' });
  ok(mergeFieldDefs(one, free) === null && mergeFieldDefs(free, one) === null && mergeFieldDefs(free, F({ key: 'k', name: 'k', datatype: 'dna' })) === null, 'merge: not restricted with free text, nor across types');
  const L = new Map([['micro', lib]]);
  const f1 = libraryFit(L, inc);
  ok(f1.def.key === 'micro' && f1.write?.prevKey === 'micro' && f1.write.def.allowed.length === 3, 'fit: merged into the field of the same key');
  ok(libraryFit(new Map([['micro', m]]), inc).write === null, 'fit: nothing to write when the library has it already');
  const other = F({ key: 'micro', name: 'Microscope', datatype: 'numeric' });
  const f2 = libraryFit(L, other);
  ok(f2.def.key === 'micro_2' && !f2.write.prevKey, 'fit: a different field under the same key goes to key_2');
  ok(libraryFit(new Map([['micro', lib], ['micro_2', f2.def]]), other).def.key === 'micro_2' && libraryFit(new Map([['micro', lib], ['micro_2', f2.def]]), other).write === null, 'fit: the same file again lands on key_2, no new field');
}
{
  // An older checklist template with two 自訂選項 and a Traits component.
  const base = E.blankTemplate('checklist', 'user:legacy', E.makeLabel('舊模板'), null);
  const legacy = withRequired({
    ...base,
    codelists: [
      { id: 'list_1', label: { text: '微棲地', tr: { en: 'Microhabitat' } }, items: [{ code: 'rock', label: { text: '岩石', tr: { en: 'Rock' } } }, { code: 'log', label: { text: '倒木' } }, { code: 'old', label: { text: '舊值' }, deprecated: true }] },
      { id: 'list_2', label: { text: '單一' }, items: [{ code: 'x', label: { text: 'X' } }] },
      { id: 'list_3', label: { text: '等級' }, items: [{ code: '1', label: { text: '封閉' } }, { code: '5', label: { text: '開闊' } }] },
    ],
    components: [
      ...base.components,
      { key: 'micro', type: 'choice', level: 'occurrence', required: true, params: { list: 'list_1', multi: true } },
      { key: 'one', type: 'choice', level: 'survey', required: false, params: { list: 'list_2', multi: false } },
      { key: 'leaf', type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'leaf_length', label: { text: '葉長', tr: { en: 'Leaf length' } }, unit: 'cm', min: 0, max: 30 }, { id: 'leaves', label: { text: '葉數' }, integer: true, min: 0 }] } },
      { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['openness'], openness_list: 'list_3' } },
    ],
  });
  ok(validateTemplate(legacy).length === 0, `legacy: the older template is valid (${validateTemplate(legacy)})`);
  const conv = convertLegacyComponents(legacy, new Map());
  const T2 = conv.template;
  const fields = T2.components.filter((c) => c.type === 'field');
  ok(conv.converted === 3 && !T2.components.some((c) => c.type === 'choice' || c.type === 'traits'), 'convert: every 自訂選項 and Traits component');
  const micro = fields.find((c) => c.params.key === 'microhabitat');
  ok(micro && micro.params.name === '微棲地' && micro.params.name_en === 'Microhabitat' && micro.required && micro.level === 'occurrence' && micro.params.multi === true, 'convert: a choice → one text field, named as it was, 必填 and several kept');
  ok(eq(micro.params.allowed, [{ value: '岩石', en: 'Rock' }, { value: '倒木' }, { value: '舊值', deprecated: true }]), `convert: the codes' names are the values, English names and retired codes kept (${JSON.stringify(micro?.params.allowed)})`);
  const one = fields.find((c) => c.params.key === 'one');
  ok(one && one.params.allowed === undefined && one.level === 'survey', 'convert: a list of one name becomes free text (two at least)');
  const len = fields.find((c) => c.params.key === 'leaf_length');
  const n = fields.find((c) => c.params.key === 'leaves');
  ok(len?.params.numeric_kind === 'float' && len.params.min === 0 && len.params.max === 30 && len.params.unit === 'cm' && len.params.name_en === 'Leaf length', 'convert: a trait → a numeric field, range and unit kept');
  ok(n?.params.numeric_kind === 'integer' && n.params.min === 0, 'convert: an integer trait stays integer');
  const order = T2.components.filter((c) => c.level === 'occurrence').map((c) => c.key);
  ok(order.indexOf('microhabitat') < order.indexOf('leaf_length') && order.indexOf('leaf_length') + 1 === order.indexOf('leaves'), `convert: in place, a trait after another (${order})`);
  ok(eq(T2.codelists.map((l) => l.id), ['list_3']), 'convert: the lists only the choices used go; the openness grades stay');
  ok(validateTemplate(T2).length === 0, `convert: the result is valid (${validateTemplate(T2)})`);
  ok(conv.writes.length === 4 && conv.writes.every((w) => !w.prevKey), 'convert: four new fields for the library');
  ok(classifyChange({ ...legacy, version: 1 }, { ...T2, version: 2 }) === 'breaking', 'convert: a breaking change (surveys started stay on their version)');
  const after = new Map(conv.writes.map((w) => [w.def.key, w.def]));
  ok(convertLegacyComponents(T2, after).template === T2 && convertLegacyComponents(T2, after).converted === 0, 'convert: once');
  const stem = E.copyTemplate({ ...STEMMAP_TEMPLATE }, 'user:census', E.makeLabel('普查'));
  const census = E.addComponent(stem, 'traits', { level: 'individual' }).template;
  ok(census.components.some((c) => c.type === 'traits') && convertLegacyComponents(census, new Map()).template === census, 'convert: a tree census keeps its Traits');
  // With the library holding a field of the same key.
  const libHas = new Map([
    ['microhabitat', fieldDefOf({ key: 'microhabitat', name: '微棲地', datatype: 'text', allowed: [{ value: '岩石' }, { value: '苔蘚' }], multi: true })],
    ['leaf_length', fieldDefOf({ key: 'leaf_length', name: '葉長', datatype: 'numeric', unit: 'mm' })],
  ]);
  const conv2 = convertLegacyComponents(legacy, libHas);
  const m2 = conv2.template.components.find((c) => c.params?.key === 'microhabitat');
  ok(eq(m2?.params.allowed.map((a) => a.value), ['岩石', '苔蘚', '倒木', '舊值']) && conv2.writes.some((w) => w.prevKey === 'microhabitat'), 'convert: shares a library field it fits, widened with its values');
  ok(conv2.template.components.some((c) => c.params?.key === 'leaf_length_2') && !conv2.template.components.some((c) => c.params?.key === 'leaf_length'), 'convert: a library field of another unit keeps its key; the trait takes key_2');
  // Stored on the real schema: new fields, and a used field widened.
  const sq = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const db2 = {
    executeSync(sql, params = []) {
      const stmt = sq.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: stmt.all(...params) };
      const res = stmt.run(...params);
      return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
    },
  };
  await runUserMigrations(db2);
  let c2 = 0;
  const ctx2 = { db: db2, now: () => ++c2, uuid: () => `w-${++c2}` };
  fl.saveField(ctx2, libHas.get('microhabitat'));
  tp.saveTemplate(ctx2, E.addField(E.blankTemplate('checklist', 'user:uses', E.makeLabel('用'), null), { level: 'occurrence' }, libHas.get('microhabitat')).template);
  fl.storeLibraryWrites(ctx2, conv2.writes);
  ok(fl.getField(ctx2, 'microhabitat').def.allowed.length === 4 && fl.getField(ctx2, 'leaf_length_2')?.def.unit === 'cm', 'store: a used field widened, the others added');
}
{
  // A template file's fields join the library.
  const base = E.blankTemplate('checklist', 'user:file', E.makeLabel('檔案'), null);
  const fileT = E.addField(E.addField(base, { level: 'occurrence' }, fieldDefOf(yesNo)).template, { level: 'occurrence' }, fieldDefOf({ key: 'stage', name: 'Stage', datatype: 'numeric' })).template;
  const libX = new Map([
    ['flowering', fieldDefOf({ key: 'flowering', name: '花期', datatype: 'date' })],
    ['stage', fieldDefOf({ key: 'stage', name: '階段', datatype: 'numeric', min: 0 })],
  ]);
  const fit = fitTemplateFields(fileT, libX);
  const keys = fit.template.components.filter((c) => c.type === 'field').map((c) => c.params.key);
  ok(eq(keys, ['flowering_2', 'stage']) && eq(fit.renamed, ['flowering']), `import: a field that differs comes in under key_2, one that fits keeps its key (${keys})`);
  const stage = fit.template.components.find((c) => c.params?.key === 'stage');
  ok(stage.params.name === '階段' && stage.params.min === undefined && fit.writes.some((w) => w.prevKey === 'stage'), 'import: merged with the library (its names, the wider range)');
  ok(validateTemplate(withRequired(fit.template)).length === 0, 'import: the template stays valid');
  const lib2 = new Map([...libX, ...fit.writes.map((w) => [w.def.key, w.def])]);
  const again = fitTemplateFields(fileT, lib2);
  ok(again.writes.length === 0 && eq(again.template.components.filter((c) => c.type === 'field').map((c) => c.params.key), ['flowering_2', 'stage']), 'import: the same file again adds nothing');
  ok(fitTemplateFields(base, libX).template === base, 'import: a template without fields as it is');
}

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ fields: definitions, change rules, formats, the component, templates, the library and exports hold');
