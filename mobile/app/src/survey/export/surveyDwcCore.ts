/**
 * Darwin Core Archive rows (Event core, Occurrence, Humboldt, extended
 * MeasurementOrFact) for a tree census and for a checklist / plot-style survey
 * (Phase 2E-b; Modular_survey.md §7.4), zipped by lib/dwcArchive.ts with the
 * other record kinds (lib/dwcRows.ts).
 *
 * A tree census: an event per census (`locationID` the permanent plot) with a
 * child event per 20 m quadrat; an occurrence per tree handled in the census
 * (measured, coded dead, or waiting for the big-tree team — decided
 * 2026-10-03), `organismID` its uuid, `vitality` by status.ts; each stem's
 * measurements on it, with the stem's tag, date and recorder.
 *
 * A checklist / plot-style survey: an event, a child event per unit; each
 * occurrence with the DwC terms its components declare (registry exportMap),
 * their other values as measurements on the occurrence or the event. A
 * species of the previous survey not found on the recheck is an absence
 * (decided 2026-10-03). What the user named — traits, code lists, their codes
 * — is written in English when the template gives an English name, else as
 * named (decided 2026-10-03).
 *
 * Taxon columns come from the caller (`taxonCols`): the checklists are on the
 * app's connection. Pure otherwise: check:survey-dwc runs it under Node.
 */
import { localIso, multiToPipe } from '../../lib/bundleYaml';
import type { DwcRow } from '../../lib/dwcArchive';
import { locationTerms } from '../../lib/dwcLocation';
import { establishmentDwcValue, individualCountOf } from '../../lib/dwcMultiValue';
import type { Row } from '../../lib/mergeEngine';
import { AMS_VARIABLES, amsField, amsValueOf, type AmsSurvival } from '../codesets/forestgeoAms2021';
import type { CensusExportDoc } from '../db/censusExportCore';
import { frameGeometry, type FrameRow } from '../db/stemmapCore';
import type { SurveyDoc } from '../db/surveyDocCore';
import { BUILTIN_CODESETS, componentDef, exportMapOf, healthCodesets, type TraitDef } from '../registry';
import { fgQuadratCounts, parseFgQuadratCode, toLatLng } from '../stemmap/coords';
import { stemIsDead, vitality, type StemCensusInput } from '../stemmap/status';
import type { ComponentInstance, Label, SurveyLevel, SurveyTemplate } from '../template/types';
import { templateOf, unitEventId, unitPaths, type Words } from './surveyExportCore';

/** An occurrence's taxon as DwC columns (taxonID, scientificName, hierarchy …). */
export type TaxonCols = (t: { taxon_id: string; used_name_id: number | null; used_scientific_name: string | null }) => DwcRow;

export type DwcParts = { events: DwcRow[]; occurrences: DwcRow[]; humboldt: DwcRow[]; measurements: DwcRow[]; creators: string[] };

const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (ts: unknown) => (typeof ts === 'number' ? localIso(ts) : '');
const dateRange = (start: unknown, end: unknown) => (typeof start !== 'number' ? '' : typeof end === 'number' ? `${localIso(start)}/${localIso(end)}` : localIso(start));
const listOf = (v: unknown): string[] => {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};
const snapshot = (survey: Row): SurveyTemplate | null => {
  try {
    return JSON.parse(str(survey.template_snapshot)) as SurveyTemplate;
  } catch {
    return null;
  }
};

/** A user's name for a measurement: its English name when the template gives one, else the name (decided 2026-10-03). */
export function enOr(label: Label | undefined | null, words: Pick<Words, 'i18n'>, fallback: string): string {
  if (!label) return fallback;
  if ('i18n' in label) return words.i18n(label.i18n) || fallback;
  return label.tr?.en?.trim() || label.text.trim() || fallback;
}

/** Automatic remarks: the app's words with English beside them (export notes convention). */
export const REMARKS = {
  presumedDead: '普查代碼 DN：推定死亡，樹牌與樹幹都找不到(census code DN: presumed dead, neither tag nor stem found)',
  notFound: 'AMS 存活狀態 NF：分支與樹牌都找不到(AMS survival NF: stem and tag not found)',
  absentOnRecheck: '前次調查有，本次盲測後複查未找到(recorded in the previous survey; not found on the recheck after the blind survey)',
} as const;

// ── a tree census ─────────────────────────────────────────────────────────

const HANDLED = (m: Row | undefined) => !!m && (m.dbh_cm != null || m.stem_dead === 1 || m.stem_dead === true || m.pending != null);

/**
 * Every census a census file carries (it and the earlier ones of its series).
 * `eventIds`: by census number (censusTables.censusEventIds).
 */
export function censusDwcRows(
  doc: CensusExportDoc,
  opts: { eventIds: ReadonlyMap<number, string>; uniqueEventId: (base: string) => string; taxonCols: TaxonCols; words: Pick<Words, 'i18n'> },
): DwcParts {
  const out: DwcParts = { events: [], occurrences: [], humboldt: [], measurements: [], creators: [] };
  const frame = doc.frame;
  const g = frameGeometry(frame as unknown as FrameRow);
  const { cols, rows } = fgQuadratCounts(g);
  const q = g.quadratM;
  const area = g.sizeXM * g.sizeYM;
  const acc = num(frame.origin_accuracy_m);
  const centre = toLatLng({ x: g.sizeXM / 2, y: g.sizeYM / 2 }, g);
  const threshold = Number(frame.dbh_min_cm);
  const stemsOf = new Map<string, Row[]>();
  for (const st of [...doc.stems].sort((a, b) => Number(a.stem_no) - Number(b.stem_no))) {
    const list = stemsOf.get(str(st.tree_uuid));
    if (list) list.push(st);
    else stemsOf.set(str(st.tree_uuid), [st]);
  }

  for (const c of doc.censuses) {
    const no = Number(c.survey.census_no);
    const tpl = snapshot(c.survey);
    const sets = healthCodesets(tpl?.components ?? []);
    const ams = sets.includes('forestgeo-ams-2021');
    const lists = new Map((tpl?.codelists ?? []).filter((l) => !(BUILTIN_CODESETS as readonly string[]).includes(l.id) && sets.includes(l.id)).map((l) => [l.id, l]));
    const traits = (tpl?.components ?? []).filter((x) => x.type === 'traits' && x.level === 'individual');
    const protocol = `ForestGEO tree census${ams ? '; ForestGEO tree mortality and damage (AMS)' : ''}`;
    const eventID = opts.uniqueEventId(opts.eventIds.get(no) ?? `${str(frame.code)}_${no}`);
    const investigators = str(c.survey.investigators);
    if (investigators) out.creators.push(investigators);
    out.events.push({
      eventID,
      eventDate: dateRange(c.survey.start_ts, c.survey.stop_ts),
      samplingProtocol: protocol,
      sampleSizeValue: area,
      sampleSizeUnit: 'm²',
      locationID: str(frame.uuid),
      locality: str(frame.name) || str(frame.code),
      decimalLatitude: centre?.lat,
      decimalLongitude: centre?.lng,
      // The plot as a point: its centre, and how far its corners reach (plus the origin's accuracy).
      coordinateUncertaintyInMeters: centre ? Math.ceil(Math.hypot(g.sizeXM, g.sizeYM) / 2 + (acc ?? 0)) : null,
      ...(centre ? locationTerms(centre.lat, null, null) : {}),
      recordedBy: investigators,
      eventRemarks: str(c.survey.notes),
    });
    out.humboldt.push({
      coreEventID: eventID,
      siteCount: cols * rows,
      siteNestingDescription: `${cols} × ${rows} quadrats of ${q} × ${q} m`,
      totalAreaSampledValue: area,
      totalAreaSampledUnit: 'm²',
      protocolNames: protocol,
      samplingPerformedBy: investigators,
      // Each tree is an occurrence of one individual.
      isAbundanceReported: true,
      isVegetationCoverReported: false,
      isAbsenceReported: false,
    });

    const measureOf = new Map(c.measures.map((m) => [str(m.stem_uuid), m]));
    const stemValues = new Map<string, Row[]>();
    for (const v of c.stemValues) (stemValues.get(str(v.stem_uuid)) ?? stemValues.set(str(v.stem_uuid), []).get(str(v.stem_uuid))!).push(v);
    const treeValues = new Map<string, Row[]>();
    for (const v of c.treeValues) (treeValues.get(str(v.tree_uuid)) ?? treeValues.set(str(v.tree_uuid), []).get(str(v.tree_uuid))!).push(v);
    const quadratOf = new Map(c.quadrats.map((qq) => [str(qq.quadrat_code), qq]));
    const quadratEvents = new Map<string, string>();
    const quadratEvent = (code: string) => {
      const known = quadratEvents.get(code);
      if (known) return known;
      const qq = quadratOf.get(code);
      const at = parseFgQuadratCode(code);
      const mid = at ? toLatLng({ x: at.col * q + q / 2, y: at.row * q + q / 2 }, g) : null;
      const id = opts.uniqueEventId(`${eventID}-${code}`);
      quadratEvents.set(code, id);
      out.events.push({
        eventID: id,
        parentEventID: eventID,
        eventDate: dateRange(qq?.started_at ?? c.survey.start_ts, qq?.ended_at ?? c.survey.stop_ts),
        sampleSizeValue: q * q,
        sampleSizeUnit: 'm²',
        locationID: str(frame.uuid),
        decimalLatitude: mid?.lat,
        decimalLongitude: mid?.lng,
        coordinateUncertaintyInMeters: mid ? Math.ceil((q * Math.SQRT2) / 2 + (acc ?? 0)) : null,
        ...(mid ? locationTerms(mid.lat, null, null) : {}),
        recordedBy: str(qq?.recorded_by),
      });
      return id;
    };

    for (const t of doc.trees) {
      const tu = str(t.uuid);
      // Only stems handled in this census: one left untouched was not seen alive.
      const stems = (stemsOf.get(tu) ?? []).filter((st) => HANDLED(measureOf.get(str(st.uuid))));
      const tv = treeValues.get(tu) ?? [];
      const treeCodes = listOf(tv.find((v) => v.component === 'health' && v.field === 'census_tree_codes')?.value_text);
      if (!stems.length && !treeCodes.length) continue;
      const stemInputs = stems.map((st): StemCensusInput & { st: Row; m: Row; values: Row[] } => {
        const m = measureOf.get(str(st.uuid))!;
        const values = stemValues.get(str(st.uuid)) ?? [];
        const survival = values.find((v) => v.field === amsField('survival_status'))?.value_text;
        return {
          st,
          m,
          values,
          censusCodes: listOf(values.find((v) => v.field === 'census_codes')?.value_text),
          stemDead: m.stem_dead === 1 || m.stem_dead === true,
          dbhCm: num(m.dbh_cm),
          pending: m.pending === 'big_tree' ? 'big_tree' : null,
          ...(ams ? { amsSurvival: (survival as AmsSurvival | undefined) ?? null } : {}),
        };
      });
      const vit = vitality({ treeCodes, stems: stemInputs, existed: true, thresholdCm: threshold });
      const main = stemInputs.find((x) => x.m.is_main === 1 || x.m.is_main === true) ?? stemInputs[0];
      const quadrat = quadratOf.get(str(t.quadrat_code));
      const at = toLatLng({ x: Number(t.x_m), y: Number(t.y_m) }, g);
      const occurrenceID = `${tu}:${no}`;
      const remarks = [
        treeCodes.includes('DN') ? REMARKS.presumedDead : '',
        stemInputs.length && stemInputs.every((x) => x.amsSurvival === 'NF') ? REMARKS.notFound : '',
        str(t.notes),
      ].filter(Boolean);
      out.occurrences.push({
        coreEventID: quadratEvent(str(t.quadrat_code)),
        occurrenceID,
        organismID: tu,
        basisOfRecord: 'HumanObservation',
        occurrenceStatus: 'present',
        vitality: vit ?? '',
        individualCount: 1,
        ...opts.taxonCols({ taxon_id: str(t.taxon_id), used_name_id: num(t.used_name_id), used_scientific_name: t.used_scientific_name == null ? null : str(t.used_scientific_name) }),
        verbatimIdentification: str(t.verbatim_identification),
        eventDate: iso(main?.m.measured_at ?? quadrat?.started_at ?? c.survey.start_ts),
        decimalLatitude: at?.lat,
        decimalLongitude: at?.lng,
        coordinateUncertaintyInMeters: at && acc != null ? Math.ceil(acc) : null,
        ...(at ? locationTerms(at.lat, null, null) : {}),
        recordedBy: str(main?.m.recorded_by) || str(quadrat?.recorded_by),
        occurrenceRemarks: remarks.join('; '),
      });
      const m = (id: string, row: DwcRow) => out.measurements.push({ measurementID: `${occurrenceID}:${id}`, occurrenceID, ...row });
      m('x', { measurementType: 'plot x', measurementValue: str(t.x_m), measurementUnit: 'm' });
      m('y', { measurementType: 'plot y', measurementValue: str(t.y_m), measurementUnit: 'm' });
      for (const code of treeCodes) m(`code:${code}`, { measurementType: 'ForestGEO census code', measurementValue: code });
      const height = tv.find((v) => v.component === 'height' && v.field === 'height_m')?.value_num;
      if (height != null) m('height', { measurementType: 'tree height', measurementValue: str(height), measurementUnit: 'm' });
      for (const comp of traits) {
        for (const tr of (Array.isArray(comp.params.traits) ? comp.params.traits : []) as TraitDef[]) {
          const v = tv.find((x) => x.component === comp.key && x.field === tr.id)?.value_num;
          if (v != null) m(`${comp.key}.${tr.id}`, { measurementType: enOr(tr.label as Label, opts.words, tr.id), measurementValue: str(v), measurementUnit: tr.unit ?? '' });
        }
      }
      for (const x of stemInputs) {
        const tag = `${str(t.tag)}-${str(x.st.stem_no)}`;
        const stemRow = (id: string, row: DwcRow) =>
          m(`stem${str(x.st.stem_no)}:${id}`, { measurementRemarks: tag, measurementDeterminedDate: iso(x.m.measured_at), measurementDeterminedBy: str(x.m.recorded_by), ...row });
        if (x.dbhCm != null) stemRow('dbh', { measurementType: 'DBH', measurementValue: str(x.dbhCm), measurementUnit: 'cm' });
        if (x.m.pom_m != null) stemRow('pom', { measurementType: 'point of measurement height', measurementValue: str(x.m.pom_m), measurementUnit: 'm', measurementMethod: `POM ${str(x.m.pom_seq)}` });
        stemRow('vitality', { measurementType: 'stem vitality', measurementValue: stemIsDead(x, treeCodes) ? 'dead' : 'alive' });
        for (const code of x.censusCodes) stemRow(`code:${code}`, { measurementType: 'ForestGEO census code', measurementValue: code });
        if (ams) {
          for (const v of AMS_VARIABLES) {
            const row = x.values.find((r) => r.field === amsField(v.field));
            if (!row) continue;
            const value = amsValueOf(v, num(row.value_num), row.value_text == null ? null : str(row.value_text));
            const type = `ForestGEO AMS ${v.field.replace(/_/g, ' ')}`;
            for (const one of Array.isArray(value) ? value : value == null ? [] : [value]) {
              stemRow(`ams:${v.field}${Array.isArray(value) ? `:${one}` : ''}`, { measurementType: type, measurementValue: str(one), measurementUnit: v.kind === 'number' && typeof one === 'number' ? v.unit : '' });
            }
          }
        }
        for (const [id, list] of lists) {
          for (const code of listOf(x.values.find((r) => r.field === `codes_${id}`)?.value_text)) {
            const item = list.items.find((it) => it.code === code);
            stemRow(`codes_${id}:${code}`, { measurementType: enOr(list.label, opts.words, id), measurementValue: enOr(item?.label, opts.words, code) });
          }
        }
      }
    }
  }
  return out;
}

// ── a checklist / plot-style survey ───────────────────────────────────────

const EVENT_DWC = new Set(['decimalLatitude', 'decimalLongitude', 'coordinateUncertaintyInMeters', 'recordedBy', 'eventRemarks']);
const OCC_DWC = new Set([
  'organismQuantity',
  'organismQuantityType',
  'sex',
  'lifeStage',
  'reproductiveCondition',
  'degreeOfEstablishment',
  'decimalLatitude',
  'decimalLongitude',
  'coordinateUncertaintyInMeters',
  'recordedBy',
  'identifiedBy',
  'occurrenceRemarks',
]);

/** A DwC value as the term wants it: multi-valued ones pipe-joined, establishment by its vocabulary. */
function dwcValue(term: string, v: unknown): string {
  if (v == null || v === '') return '';
  if (term === 'sex' || term === 'reproductiveCondition') return multiToPipe(str(v));
  if (term === 'degreeOfEstablishment') return establishmentDwcValue(str(v));
  return str(v);
}

type Owner = { kind: 'survey' } | { kind: 'unit'; key: string; levelKey: string } | { kind: 'occurrence'; uuid: string };

/**
 * One survey (its document) as DwC rows. `eventId`: the survey's (2E-a,
 * surveyExportCore.surveyEventIds); units are its children.
 */
export function surveyDwcRows(doc: SurveyDoc, opts: { eventId: string; uniqueEventId: (base: string) => string; taxonCols: TaxonCols; words: Pick<Words, 'i18n'> }): DwcParts {
  const out: DwcParts = { events: [], occurrences: [], humboldt: [], measurements: [], creators: [] };
  const tpl = templateOf(doc);
  const s = doc.survey;
  const paths = unitPaths(doc);
  const lists = new Map((tpl?.codelists ?? []).map((l) => [l.id, l]));
  const components = tpl?.components ?? [];
  const tName = tpl ? enOr(tpl.name, opts.words, str(s.template_id)) : str(s.template_id);
  const protocol = `${tName} (Mitalivana survey template ${str(s.template_id)} v${str(s.template_version)})`;
  const eventID = opts.uniqueEventId(opts.eventId);
  const investigators = str(s.investigators);
  if (investigators) out.creators.push(investigators);
  const frameUnit = new Map(doc.frame_units.map((u) => [`${str(u.level_key)}:${str(u.code)}`, u]));

  const valuesOf = (o: Owner): Row[] =>
    o.kind === 'survey' ? doc.survey_values : o.kind === 'unit' ? doc.unit_values.filter((v) => v.unit === o.key) : doc.occurrence_values.filter((v) => v.occurrence === o.uuid);
  const placed = (c: ComponentInstance, level: SurveyLevel, o: Owner) => c.level === level && (o.kind !== 'unit' || c.unit == null || c.unit === o.levelKey);

  /** The DwC terms the components on this owner's level declare, with their values (from the owner's row). */
  const dwcOf = (level: SurveyLevel, o: Owner, row: Row, allowed: Set<string>): DwcRow => {
    const cols: DwcRow = {};
    for (const c of components) {
      const def = componentDef(c.type);
      if (!def || c.type === 'taxon' || !placed(c, level, o)) continue;
      const map = exportMapOf(def, c.params, level).dwc ?? {};
      for (const f of def.fields(c.params, level, c.key)) {
        const term = map[f.field];
        if (!term || !allowed.has(term) || !('col' in f.storage)) continue;
        const col = f.storage.col.slice(f.storage.col.indexOf('.') + 1);
        const v = dwcValue(term, row[col]);
        if (v) cols[term] = v;
      }
    }
    return cols;
  };

  /** Measurements of the components on this owner's level: on the occurrence when it is one, else on the event. */
  const measurementsOf = (level: SurveyLevel, o: Owner, row: Row, coreEventID: string, idBase: string) => {
    const occurrenceID = o.kind === 'occurrence' ? o.uuid : '';
    const push = (id: string, r: DwcRow) => out.measurements.push({ coreEventID, measurementID: `${idBase}:${id}`, occurrenceID, ...r });
    for (const c of components) {
      const def = componentDef(c.type);
      if (!def || !placed(c, level, o)) continue;
      const mof = exportMapOf(def, c.params, level).mof ?? {};
      for (const f of def.fields(c.params, level, c.key)) {
        const spec = mof[f.field];
        if (!spec) continue;
        if (c.type === 'frequency') {
          // Cells occupied (or counted) as a share of the grid, as the plots' frequency rows.
          const n = Number(c.params.n) || 10;
          const cells = f.field === 'freq_cells' ? (typeof row.freq_cells === 'string' ? [...row.freq_cells].filter((ch) => ch === '1').length : null) : num(row.freq_count);
          if (cells == null) continue;
          push(`${c.key}`, { measurementType: 'frequency', measurementValue: String(Math.round((cells / (n * n)) * 10000) / 100), measurementUnit: '%', measurementMethod: `${cells} of ${n} × ${n} cells` });
          continue;
        }
        const type =
          c.type === 'traits'
            ? enOr(((c.params.traits as TraitDef[] | undefined) ?? []).find((x) => x.id === f.field)?.label as Label | undefined, opts.words, f.field)
            : c.type === 'choice'
              ? enOr(lists.get(String(c.params.list))?.label, opts.words, String(c.params.list))
              : spec.measurementType;
        const unit = spec.unit ?? ('values' in f.storage ? (f.storage.unit ?? '') : '');
        const one = (id: string, value: unknown, extra: DwcRow = {}) => {
          if (value == null || value === '') return;
          push(id, { measurementType: type, measurementValue: str(value), measurementUnit: unit, ...extra });
        };
        if ('col' in f.storage) {
          const col = f.storage.col.slice(f.storage.col.indexOf('.') + 1);
          if (f.storage.valueType === 'json') for (const x of listOf(row[col])) one(`${c.key}.${f.field}:${x}`, x);
          else one(`${c.key}.${f.field}`, row[col]);
          continue;
        }
        if (!('values' in f.storage)) continue;
        const st = f.storage;
        for (const v of valuesOf(o).filter((x) => x.component === st.component && x.field === st.field)) {
          const idx = Number(v.idx);
          const at = st.repeat ? `[${idx}]` : '';
          const remark = st.repeat ? { measurementRemarks: c.type === 'structure' ? `E${idx}` : String(idx) } : {};
          if (c.type === 'choice') {
            const list = lists.get(String(c.params.list));
            const codes = st.valueType === 'json' ? listOf(v.value_text) : [str(v.value_text)].filter(Boolean);
            for (const code of codes) one(`${c.key}:${code}`, enOr(list?.items.find((it) => it.code === code)?.label, opts.words, code));
            continue;
          }
          if (st.valueType === 'json') for (const x of listOf(v.value_text)) one(`${c.key}.${f.field}${at}:${x}`, x, remark);
          else one(`${c.key}.${f.field}${at}`, v.value_num ?? v.value_text, remark);
        }
      }
    }
  };

  // The survey's event.
  const elevation = doc.survey_values.find((v) => v.field === 'elevation_m' && v.value_num != null)?.value_num;
  const lat = num(s.lat);
  out.events.push({
    eventID,
    eventDate: dateRange(s.start_ts, s.stop_ts),
    samplingProtocol: protocol,
    locationID: str(doc.frame?.uuid),
    locality: str(doc.frame?.name) || str(doc.frame?.code) || str(s.name),
    decimalLatitude: lat,
    decimalLongitude: num(s.lng),
    coordinateUncertaintyInMeters: num(s.accuracy),
    ...locationTerms(lat, num(elevation), null),
    recordedBy: investigators,
    eventRemarks: str(s.notes),
  });
  measurementsOf('survey', { kind: 'survey' }, s, eventID, eventID);

  // Its units, parents first (the document's order).
  const unitEvent = new Map<string, string>();
  for (const u of doc.units) {
    const key = `${str(u.level_key)}:${str(u.code)}`;
    const id = opts.uniqueEventId(unitEventId(eventID, paths.get(key) ?? str(u.code)));
    unitEvent.set(key, id);
    const fu = u.on_frame ? frameUnit.get(key) : undefined;
    const w = num(fu?.width_m);
    const l = num(fu?.length_m);
    const r = num(fu?.radius_m);
    const size = w != null && l != null ? w * l : r != null ? Math.round(Math.PI * r * r * 100) / 100 : null;
    const owner: Owner = { kind: 'unit', key, levelKey: str(u.level_key) };
    out.events.push({
      eventID: id,
      parentEventID: u.parent != null ? (unitEvent.get(str(u.parent)) ?? eventID) : eventID,
      eventDate: dateRange(s.start_ts, s.stop_ts),
      sampleSizeValue: size,
      sampleSizeUnit: size != null ? 'm²' : '',
      locationID: str(doc.frame?.uuid),
      recordedBy: investigators,
      ...locationTerms(num(u.lat), null, null),
      // The unit's own location, recorder and comment (its components) over the survey's.
      ...dwcOf('unit', owner, u, EVENT_DWC),
    });
    measurementsOf('unit', owner, u, id, id);
  }

  // Its occurrences.
  for (const o of doc.occurrences) {
    const coreEventID = (o.unit != null ? unitEvent.get(str(o.unit)) : null) ?? eventID;
    const owner: Owner = { kind: 'occurrence', uuid: str(o.uuid) };
    const latO = num(o.lat);
    out.occurrences.push({
      coreEventID,
      occurrenceID: str(o.uuid),
      basisOfRecord: 'HumanObservation',
      occurrenceStatus: 'present',
      ...opts.taxonCols({ taxon_id: str(o.taxon_id), used_name_id: num(o.used_name_id), used_scientific_name: o.used_scientific_name == null ? null : str(o.used_scientific_name) }),
      verbatimIdentification: str(o.verbatim_identification),
      ...dwcOf('occurrence', owner, o, OCC_DWC),
      individualCount: individualCountOf(o.organism_quantity == null ? null : str(o.organism_quantity), o.organism_quantity_type == null ? null : str(o.organism_quantity_type)),
      eventDate: iso(o.observed_at),
      ...locationTerms(latO, num(o.elevation_m), o.elevation_source == null ? null : str(o.elevation_source)),
    });
    measurementsOf('occurrence', owner, o, coreEventID, str(o.uuid));
  }

  // The previous survey's species not found on the recheck: absences where they were looked for.
  let absences = 0;
  for (const r of doc.rechecks) {
    if (r.outcome !== 'not_found') continue;
    absences += 1;
    out.occurrences.push({
      coreEventID: (r.place != null ? unitEvent.get(str(r.place)) : null) ?? eventID,
      occurrenceID: str(r.uuid),
      basisOfRecord: 'HumanObservation',
      occurrenceStatus: 'absent',
      ...opts.taxonCols({ taxon_id: str(r.prev_taxon_id), used_name_id: null, used_scientific_name: null }),
      verbatimIdentification: str(r.prev_verbatim_identification),
      eventDate: iso(r.checked_at),
      occurrenceRemarks: REMARKS.absentOnRecheck,
    });
  }

  // Humboldt: what the survey reports.
  const abundance = components.find((c) => c.type === 'abundance');
  const kinds = Array.isArray(abundance?.params.kinds) ? (abundance.params.kinds as string[]) : [];
  const levelCounts = (tpl?.units ?? []).map((lv) => ({ name: enOr(lv.label, opts.words, lv.key), n: doc.units.filter((u) => u.level_key === lv.key).length })).filter((x) => x.n);
  const minutes = typeof s.start_ts === 'number' && typeof s.stop_ts === 'number' ? Math.round((s.stop_ts - s.start_ts) / 60000) : null;
  out.humboldt.push({
    coreEventID: eventID,
    siteCount: doc.units.length || null,
    siteNestingDescription: levelCounts.map((x) => `${x.n} × ${x.name}`).join('; '),
    eventDurationValue: minutes,
    eventDurationUnit: minutes != null ? 'minutes' : null,
    protocolNames: protocol,
    samplingPerformedBy: investigators,
    isAbundanceReported: !!abundance,
    isVegetationCoverReported: kinds.includes('BB') || kinds.includes('percent') || components.some((c) => c.type === 'structure'),
    isAbsenceReported: absences > 0,
  });
  return out;
}
