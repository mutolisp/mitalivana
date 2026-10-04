/**
 * A checklist / plot-style survey's export (Phase 2E-a), made from its
 * document (db/surveyDocCore.ts — the same one versions, merges and team
 * sync use):
 *
 *   - eventIDs: the plot rule (plotEventIds) inside a series, its base the
 *     plot code plus the series code (Modular_survey.md §7.4); off a plot, the
 *     survey's name;
 *   - the round-trip file: the document with each photo and recording named
 *     by a file in the zip instead of a path on this device, and back;
 *   - spreadsheet tables: the survey, its units, its occurrences — a column
 *     per component field, named `key.field` — with a field dictionary, the
 *     template's code lists and the recheck results;
 *   - community tables (plot style): unit × species, one per abundance scale
 *     (decided 2026-10-03: a survey's own scale, Braun-Blanquet as cover by
 *     the tables in vegMatrix.ts), and presence;
 *   - the project's matrices: per template, per scale, only surveys that use
 *     that one scale;
 *   - interactions (2F-b): a table of them with both sides and the type's
 *     relation, the template's types, and per type a species × species
 *     table. An occurrence made only as an interaction's other side is
 *     marked in the occurrence table and left out of every community table
 *     and matrix (decided 2026-10-03).
 *
 * Pure: check:survey-export runs it under Node.
 */
import { checklistIdentity } from '../../lib/checklistIdentity';
import { isoDate, isoStamp } from '../../lib/datetime';
import { kindForType, type QuantityKind } from '../../lib/dwcAbundanceCore';
import type { Row } from '../../lib/mergeEngine';
import { assignPlotEventIds } from '../../lib/plotEventIds';
import { aggregateCell, cellString, type CsvTable } from '../../lib/vegMatrix';
import { interactionTypes, type InteractionType } from '../db/interactionCore';
import type { SurveyDoc } from '../db/surveyDocCore';
import { methodDwc, methodZh } from '../codesets/samplingMethods';
import { componentDef, exportMapOf, type FieldDef } from '../registry';
import { parseSnapshot } from '../template/normalize';
import type { Label, SurveyLevel, SurveyTemplate } from '../template/types';

export type { CsvTable };

/** Scientific and vernacular name of a taxon here (the checklists, else the taxon cache). */
export type Names = (taxonId: string) => { scientific: string | null; vernacular: string | null };

/** Words the tables need from the app: a component type's name, and an i18n key (a built-in's label). */
export type Words = { typeName: (type: string) => string; i18n: (key: string) => string };

const str = (v: unknown) => (v == null ? '' : String(v));
const short = (uuid: unknown) => str(uuid).slice(0, 8);
const clean = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60);
/** A file name's stem as the importer keeps it (recordImportZip.safeMediaBasename), so names come back unchanged. */
const fileStem = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60).replace(/^_+|_+$/g, '');

export function templateOf(doc: Pick<SurveyDoc, 'survey'>): SurveyTemplate | null {
  try {
    return parseSnapshot(str(doc.survey.template_snapshot));
  } catch {
    return null;
  }
}

function labelParts(label: Label | undefined | null, words: Words): { text: string; en: string } {
  if (!label) return { text: '', en: '' };
  if ('i18n' in label) return { text: words.i18n(label.i18n), en: '' };
  return { text: label.text, en: label.tr?.en ?? '' };
}

// ── eventIDs ──────────────────────────────────────────────────────────────

/** What an eventID starts from: a plot's code (and its series code), else the survey's name. */
export function eventBase(s: { frameCode: string | null; seriesCode: string | null; name: string | null; uuid: string }): string {
  if (s.frameCode) return s.seriesCode ? `${s.frameCode}_${s.seriesCode}` : s.frameCode;
  return s.name?.trim() || `survey_${short(s.uuid)}`;
}

/**
 * eventIDs for surveys that share bases (every local survey, so one gets the
 * same id alone or in a project): the earliest keeps the base, later ones get
 * `_YYYYMMDD`, then `_2`… (plotEventIds).
 */
export function surveyEventIds(inputs: readonly { id: number; base: string; startTs: number | null }[]): Map<number, string> {
  return assignPlotEventIds(inputs.map((i) => ({ id: i.id, plotid: i.base, start_ts: i.startTs })));
}

/** A unit's own event: the survey's eventID and the unit's path. */
export const unitEventId = (eventId: string, path: string) => `${eventId}-${path.replace(/\//g, '-')}`;

const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A component's values on the survey, by field (one value each). */
export function surveyComponentValues(doc: Pick<SurveyDoc, 'survey_values'>, key: string): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  for (const v of doc.survey_values) if (v.component === key && Number(v.idx ?? 0) === 0) out[str(v.field)] = (v.value_num as number | null) ?? (v.value_text as string | null) ?? null;
  return out;
}

/**
 * A unit's size: its own (v89), else the permanent plot layout's, else — a
 * quadrat (the second unit level) — the size the survey's 調查法 gives every
 * quadrat (2G-f). A frame unit may be a circle instead.
 */
export function unitSizeOf(doc: Pick<SurveyDoc, 'frame_units' | 'survey_values'>, template: SurveyTemplate | null, u: Row): { w: number | null; l: number | null; r: number | null } {
  const fu = u.on_frame ? doc.frame_units.find((f) => f.level_key === u.level_key && f.code === u.code) : undefined;
  const method = template && template.units?.[1]?.key === u.level_key ? template.components.find((c) => c.type === 'method' && c.level === 'survey') : undefined;
  const shared = method ? surveyComponentValues(doc, method.key) : {};
  return {
    w: numOf(u.width_m) ?? numOf(fu?.width_m) ?? numOf(shared.quadrat_w_m),
    l: numOf(u.length_m) ?? numOf(fu?.length_m) ?? numOf(shared.quadrat_l_m),
    r: numOf(fu?.radius_m),
  };
}

// ── the round-trip file ───────────────────────────────────────────────────

export type FileRef = { uri: string; file: string; kind: 'photo' | 'audio' };

/** Unit key → codes from the top ("A/A1"). */
export function unitPaths(doc: Pick<SurveyDoc, 'units'>): Map<string, string> {
  const parent = new Map(doc.units.map((u) => [`${str(u.level_key)}:${str(u.code)}`, (u.parent as string | null) ?? null]));
  const code = new Map(doc.units.map((u) => [`${str(u.level_key)}:${str(u.code)}`, str(u.code)]));
  const out = new Map<string, string>();
  for (const key of code.keys()) {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let k: string | null = key; k != null && !seen.has(k); k = parent.get(k) ?? null) {
      seen.add(k);
      parts.unshift(code.get(k) ?? k);
    }
    out.set(key, parts.join('/'));
  }
  return out;
}

/**
 * The document as the file carries it: each photo and recording (and a
 * morphospecies photo) named by its file in the zip — `file` / `photo_file`
 * instead of a path on this device. Files are named by place and species, so
 * a person finds them without the document.
 */
export function docForFile(doc: SurveyDoc, opts: { names: Names; extOf: (uri: string) => string }): { doc: SurveyDoc; files: FileRef[] } {
  const paths = unitPaths(doc);
  const taxonOf = new Map(doc.occurrences.map((o) => [str(o.uuid), str(o.taxon_id)]));
  const subjectOf = new Map((doc.interactions ?? []).map((i) => [str(i.uuid), str(i.subject)]));
  const sciOf = (occ: string) => opts.names(taxonOf.get(occ) ?? '').scientific ?? taxonOf.get(occ) ?? 'occurrence';
  const files: FileRef[] = [];
  const taken = new Set<string>();
  const name = (stem: string, uri: string, kind: FileRef['kind']) => {
    const ext = (opts.extOf(uri) || (kind === 'audio' ? 'm4a' : 'jpg')).toLowerCase();
    const base = fileStem(stem) || kind;
    let file = `${base}.${ext}`;
    for (let n = 2; taken.has(file); n++) file = `${base}_${n}.${ext}`;
    taken.add(file);
    files.push({ uri, file, kind });
    return file;
  };
  const media = doc.media.map((m) => {
    const uri = str(m.uri);
    const kind = m.kind === 'audio' ? 'audio' : 'photo';
    const where = m.occurrence != null
      ? sciOf(str(m.occurrence))
      : m.interaction != null
        ? `interaction_${sciOf(subjectOf.get(str(m.interaction)) ?? '')}`
        : m.unit != null
          ? (paths.get(str(m.unit)) ?? str(m.unit))
          : 'survey';
    const { uri: _u, ...rest } = m;
    return uri ? { ...rest, file: name(`${where}_${short(m.uuid)}`, uri, kind) } : rest;
  });
  const frameLabels = doc.frame_labels.map((l) => {
    const uri = str(l.photo_uri);
    const { photo_uri: _p, ...rest } = l;
    return uri ? { ...rest, photo_file: name(`label_${str(l.verbatim_identification) || short(l.uuid)}_${short(l.uuid)}`, uri, 'photo') } : rest;
  });
  return { doc: { ...doc, media, frame_labels: frameLabels }, files };
}

/**
 * Back from a file: a named file becomes the path it was written to here
 * (`uriOf`); a path (a merge backup, a record version of this device) stays
 * when the file is still here (`present`). Rows whose file is not here go.
 */
export function docFromFile(doc: SurveyDoc, uriOf: (file: string, kind: FileRef['kind']) => string | null, present: (uri: string) => boolean): SurveyDoc {
  const media: Row[] = [];
  for (const m of doc.media) {
    const kind = m.kind === 'audio' ? 'audio' : 'photo';
    const uri = m.file != null ? uriOf(str(m.file), kind) : m.uri != null && present(str(m.uri)) ? str(m.uri) : null;
    if (!uri) continue;
    const { file: _f, ...rest } = m;
    media.push({ ...rest, uri });
  }
  const frameLabels = doc.frame_labels.map((l) => {
    const uri = l.photo_file != null ? uriOf(str(l.photo_file), 'photo') : l.photo_uri != null && present(str(l.photo_uri)) ? str(l.photo_uri) : null;
    const { photo_file: _f, ...rest } = l;
    return { ...rest, photo_uri: uri };
  });
  return { ...doc, media, frame_labels: frameLabels };
}

// ── spreadsheet tables ────────────────────────────────────────────────────

type Owner = { level: 'survey' } | { level: 'unit'; key: string; levelKey: string } | { level: 'occurrence'; uuid: string };

type Column = { name: string; value: (owner: Owner, row: Row) => string; dict: Row };

const STAMP_COLS = new Set(['start_ts', 'stop_ts', 'observed_at']);
const DICT_HEADER = ['file', 'column', 'component_key', 'component_type', 'component_name', 'component_name_en', 'level', 'unit_level', 'field', 'value_type', 'unit', 'dwc_term', 'measurement_type'];

function listOf(v: unknown): string[] {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function cellOf(v: Row | undefined, valueType: string): string {
  if (!v) return '';
  if (valueType === 'json') return listOf(v.value_text).join(';');
  return v.value_num != null ? str(v.value_num) : str(v.value_text);
}

/**
 * A column per field of each component on `level` (Taxon is the table's
 * own). A repeated field (a layer's cover) gets one column per index found;
 * a choice also gets its codes' names; photos and recordings list their files.
 */
function componentColumns(doc: SurveyDoc, template: SurveyTemplate, level: 'survey' | 'unit' | 'occurrence', file: string, words: Words): Column[] {
  const valuesOf = (o: Owner): Row[] =>
    o.level === 'survey' ? doc.survey_values : o.level === 'unit' ? doc.unit_values.filter((v) => v.unit === o.key) : doc.occurrence_values.filter((v) => v.occurrence === o.uuid);
  const mediaOf = (o: Owner) =>
    doc.media.filter((m) => (o.level === 'survey' ? m.unit == null && m.occurrence == null : o.level === 'unit' ? m.unit === o.key : m.occurrence === o.uuid));
  const indexes = (component: string, field: string) => {
    const rows = level === 'survey' ? doc.survey_values : level === 'unit' ? doc.unit_values : doc.occurrence_values;
    return [...new Set(rows.filter((v) => v.component === component && v.field === field).map((v) => Number(v.idx)))].sort((a, b) => a - b);
  };
  const lists = new Map(template.codelists.map((l) => [l.id, l]));
  const out: Column[] = [];
  for (const c of template.components) {
    if (c.level !== level || c.type === 'taxon') continue;
    const def = componentDef(c.type);
    // 空間資料 modules: their values are the survey row's own columns, already in survey.csv.
    if (!def || def.rowFixed) continue;
    const name = labelParts(c.label, words);
    const map = exportMapOf(def, c.params, c.level as SurveyLevel);
    const applies = (o: Owner) => o.level !== 'unit' || c.unit == null || o.levelKey === c.unit;
    const dict = (column: string, f: FieldDef, extra: Row = {}): Row => ({
      file,
      column,
      component_key: c.key,
      component_type: c.type,
      component_name: name.text || words.typeName(c.type),
      component_name_en: name.en,
      level: c.level,
      unit_level: c.unit ?? '',
      field: f.field,
      value_type: 'media' in f.storage ? f.storage.media : 'col' in f.storage && STAMP_COLS.has(f.storage.col.slice(f.storage.col.indexOf('.') + 1)) ? 'datetime' : f.storage.valueType,
      unit: 'values' in f.storage ? (f.storage.unit ?? '') : '',
      dwc_term: map.dwc?.[f.field] ?? '',
      measurement_type: c.type === 'choice' ? (labelParts(lists.get(String(c.params.list))?.label, words).text || String(c.params.list)) : (map.mof?.[f.field]?.measurementType ?? ''),
      ...extra,
    });
    for (const f of def.fields(c.params, c.level as SurveyLevel, c.key)) {
      const s = f.storage;
      const column = `${c.key}.${f.field}`;
      if ('col' in s) {
        const colName = s.col.slice(s.col.indexOf('.') + 1);
        out.push({
          name: column,
          value: (o, row) => {
            if (!applies(o)) return '';
            const v = row[colName];
            if (v == null || v === '') return '';
            if (STAMP_COLS.has(colName) && typeof v === 'number') return isoStamp(v);
            return s.valueType === 'json' ? listOf(v).join(';') : str(v);
          },
          dict: dict(column, f),
        });
      } else if ('values' in s) {
        const one = (idx: number) => (o: Owner) => (applies(o) ? cellOf(valuesOf(o).find((v) => v.component === s.component && v.field === s.field && Number(v.idx) === idx), s.valueType) : '');
        if (s.repeat) {
          for (const idx of indexes(s.component, s.field)) {
            const get = one(idx);
            out.push({ name: `${column}[${idx}]`, value: (o) => get(o), dict: dict(`${column}[${idx}]`, f) });
          }
        } else {
          const get = one(0);
          out.push({ name: column, value: (o) => get(o), dict: dict(column, f) });
          if (c.type === 'method' && f.field === 'protocol') {
            // The method's names next to its key (2G-f): the regulation's Chinese, the English DwC gets; a custom one as typed.
            const named = (o: Owner) => Object.fromEntries(valuesOf(o).filter((v) => v.component === c.key).map((v) => [str(v.field), v.value_num ?? v.value_text]));
            out.push(
              { name: `${column}_zh`, value: (o) => (applies(o) ? methodZh(named(o), c.params) : ''), dict: dict(`${column}_zh`, f, { value_type: 'text', dwc_term: '' }) },
              { name: `${column}_en`, value: (o) => (applies(o) ? methodDwc(named(o), c.params).samplingProtocol : ''), dict: dict(`${column}_en`, f, { value_type: 'text' }) },
            );
          }
          if (c.type === 'choice') {
            const list = lists.get(String(c.params.list));
            const nameOf = (code: string) => labelParts(list?.items.find((x) => x.code === code)?.label, words).text || code;
            out.push({
              name: `${column}_name`,
              value: (o) => get(o).split(';').filter(Boolean).map(nameOf).join(';'),
              dict: dict(`${column}_name`, f, { value_type: 'text', measurement_type: '' }),
            });
          }
        }
      } else {
        out.push({
          name: column,
          value: (o) => (applies(o) ? mediaOf(o).filter((m) => m.component === c.key && (m.kind === 'audio') === (s.media === 'audio')).map((m) => str(m.file ?? m.uri)).join(';') : ''),
          dict: dict(column, f),
        });
      }
    }
  }
  return out;
}

export type SurveyTables = {
  survey: CsvTable;
  /** Plot style only. */
  units: CsvTable | null;
  occurrences: CsvTable;
  /** What every component column holds (component, field, unit, DwC term or measurement type). */
  fields: CsvTable;
  codelists: CsvTable | null;
  rechecks: CsvTable | null;
  /** 2F-b: its interactions, and the types its template offers or used; null without an Interaction component. */
  interactions: CsvTable | null;
  interactionTypes: CsvTable | null;
};

/** An interaction's side in its table: the occurrence and its taxon. */
const SIDE_COLS = ['occurrenceID', 'taxonID', 'scientificName', 'vernacularName', 'verbatimIdentification'] as const;

/** The survey as spreadsheet tables (a document from docForFile names photos by file). */
export function surveyTables(doc: SurveyDoc, opts: { eventId: string; names: Names; words: Words }): SurveyTables {
  const template = templateOf(doc);
  const { words, names, eventId } = opts;
  const paths = unitPaths(doc);
  const levelName = new Map((template?.units ?? []).map((u) => [u.key, labelParts(u.label, words).text || u.key]));
  const tName = labelParts(template?.name, words);
  const s = doc.survey;

  const surveyCols = template ? componentColumns(doc, template, 'survey', 'survey.csv', words) : [];
  const surveyHeader = [
    'eventID', 'survey_uuid', 'name', 'style', 'template_id', 'template_version', 'template_name', 'plot_code', 'plot_name', 'series_code', 'survey_no', 'status', 'blind_closed_at',
    // Where it was (2G-b, v88): the located point, the survey's elevation and a recorded track's range.
    'lat', 'lng', 'accuracy', 'gps_mode', 'elevation_m', 'elevation_source', 'elevation_min_m', 'elevation_max_m',
  ];
  const survey: CsvTable = {
    header: [...surveyHeader, ...surveyCols.map((c) => c.name)],
    rows: [
      [
        eventId,
        str(s.uuid),
        str(s.name),
        str(s.style),
        str(s.template_id),
        str(s.template_version),
        tName.text,
        str(doc.frame?.code),
        str(doc.frame?.name),
        str(doc.series?.series_code),
        str(s.census_no),
        str(s.status),
        typeof s.blind_closed_at === 'number' ? isoStamp(s.blind_closed_at) : '',
        str(s.lat),
        str(s.lng),
        str(s.accuracy),
        str(s.gps_mode),
        str(s.elevation_m),
        str(s.elevation_source),
        str(s.elevation_min_m),
        str(s.elevation_max_m),
        ...surveyCols.map((c) => c.value({ level: 'survey' }, s)),
      ],
    ],
  };

  let units: CsvTable | null = null;
  const unitCols = template && s.style === 'plot' ? componentColumns(doc, template, 'unit', 'units.csv', words) : [];
  if (s.style === 'plot') {
    units = {
      header: ['eventID', 'parentEventID', 'unit', 'level_key', 'level_name', 'code', 'label', 'on_plot', 'width_m', 'length_m', 'done_at', ...unitCols.map((c) => c.name)],
      rows: doc.units.map((u) => {
        const key = `${str(u.level_key)}:${str(u.code)}`;
        const size = unitSizeOf(doc, template, u);
        const path = paths.get(key) ?? str(u.code);
        const parent = u.parent != null ? paths.get(str(u.parent)) : null;
        const owner: Owner = { level: 'unit', key, levelKey: str(u.level_key) };
        return [
          unitEventId(eventId, path),
          parent ? unitEventId(eventId, parent) : eventId,
          path,
          str(u.level_key),
          levelName.get(str(u.level_key)) ?? str(u.level_key),
          str(u.code),
          str(u.label),
          u.on_frame ? '1' : '0',
          str(size.w),
          str(size.l),
          typeof u.done_at === 'number' ? isoStamp(u.done_at) : '',
          ...unitCols.map((c) => c.value(owner, u)),
        ];
      }),
    };
  }

  const occCols = template ? componentColumns(doc, template, 'occurrence', 'occurrences.csv', words) : [];
  const occurrences: CsvTable = {
    header: [
      'occurrenceID',
      'eventID',
      'unit',
      'taxonID',
      'scientificName',
      'vernacularName',
      'usedScientificName',
      'verbatimIdentification',
      'phase',
      // 1: recorded only as an interaction's other side (2F; not in any community table).
      'interaction_partner',
      ...occCols.map((c) => c.name),
    ],
    rows: doc.occurrences.map((o) => {
      const path = o.unit != null ? (paths.get(str(o.unit)) ?? '') : '';
      const n = names(str(o.taxon_id));
      return [
        str(o.uuid),
        path ? unitEventId(eventId, path) : eventId,
        path,
        str(o.taxon_id),
        str(n.scientific),
        str(n.vernacular),
        str(o.used_scientific_name),
        str(o.verbatim_identification),
        str(o.phase),
        o.via_interaction ? '1' : '',
        ...occCols.map((c) => c.value({ level: 'occurrence', uuid: str(o.uuid) }, o)),
      ];
    }),
  };

  const fields: CsvTable = {
    header: DICT_HEADER,
    rows: [...surveyCols, ...unitCols, ...occCols].map((c) => DICT_HEADER.map((h) => str(c.dict[h]))),
  };

  const codelists: CsvTable | null = template?.codelists.length
    ? {
        header: ['list_id', 'list_name', 'list_name_en', 'code', 'name', 'name_en', 'deprecated'],
        rows: template.codelists.flatMap((l) => {
          const ln = labelParts(l.label, words);
          return l.items.map((it) => {
            const n = labelParts(it.label, words);
            return [l.id, ln.text, ln.en, it.code, n.text, n.en, it.deprecated ? '1' : '0'];
          });
        }),
      }
    : null;

  const framePaths = unitPaths({ units: doc.frame_units });
  const rechecks: CsvTable | null = doc.rechecks.length
    ? {
        header: ['eventID', 'unit', 'previous_taxonID', 'previous_scientificName', 'previous_verbatimIdentification', 'outcome', 'occurrenceID', 'checked_at'],
        rows: doc.rechecks.map((r) => [
          eventId,
          r.place != null ? (framePaths.get(str(r.place)) ?? str(r.place)) : '',
          str(r.prev_taxon_id),
          str(names(str(r.prev_taxon_id)).scientific),
          str(r.prev_verbatim_identification),
          str(r.outcome),
          str(r.occurrence),
          typeof r.checked_at === 'number' ? isoStamp(r.checked_at) : '',
        ]),
      }
    : null;

  const types = template ? interactionTypes(template) : [];
  const hasInteractions = types.length > 0 || (doc.interactions ?? []).length > 0;
  const typeOf = new Map(types.map((t) => [t.code, t]));
  const occByUuid = new Map(doc.occurrences.map((o) => [str(o.uuid), o]));
  const side = (uuid: unknown) => {
    const o = occByUuid.get(str(uuid));
    const n = names(str(o?.taxon_id));
    return [str(uuid), str(o?.taxon_id), str(n.scientific), str(n.vernacular), str(o?.verbatim_identification)];
  };
  const interactions: CsvTable | null = hasInteractions
    ? {
        header: [
          'interactionID',
          'eventID',
          'unit',
          'type_code',
          'type_name',
          'relationship',
          'relationship_iri',
          'both_ways',
          ...SIDE_COLS.map((h) => `subject_${h}`),
          ...SIDE_COLS.map((h) => `object_${h}`),
          'count',
          'observed_at',
          'recorded_by',
          'notes',
          'photos',
          'phase',
        ],
        rows: (doc.interactions ?? []).map((i) => {
          const ty = typeOf.get(str(i.type_code));
          const path = i.unit != null ? (paths.get(str(i.unit)) ?? '') : '';
          return [
            str(i.uuid),
            path ? unitEventId(eventId, path) : eventId,
            path,
            str(i.type_code),
            ty ? labelParts(ty.label, words).text : '',
            ty?.en ?? '',
            ty?.iri ?? '',
            i.mutual ? '1' : '0',
            ...side(i.subject),
            ...side(i.object),
            str(i.count),
            typeof i.observed_at === 'number' ? isoStamp(i.observed_at) : '',
            str(i.recorded_by),
            str(i.notes),
            doc.media.filter((m) => m.interaction === i.uuid).map((m) => str(m.file ?? m.uri)).join(';'),
            str(i.phase),
          ];
        }),
      }
    : null;
  const interactionTypesTable: CsvTable | null = types.length
    ? {
        header: ['code', 'builtin', 'name', 'relationship', 'reads_from_object', 'reads_from_object_en', 'both_ways', 'relationship_iri', 'offered'],
        rows: types.map((t) => {
          const inv = t.inverse ? labelParts(t.inverse, words) : { text: '', en: '' };
          return [t.code, t.builtin ? '1' : '0', labelParts(t.label, words).text, t.en, inv.text, t.builtin ? '' : inv.en, t.mutual ? '1' : '0', t.iri ?? '', t.offered ? '1' : '0'];
        }),
      }
    : null;

  return { survey, units, occurrences, fields, codelists, rechecks, interactions, interactionTypes: interactionTypesTable };
}

/**
 * Per interaction type, a species × species table (decided 2026-10-03: the
 * visitor × plant kind): subjects (A, the one doing it) by rows, objects by
 * columns, the times added up (a row without a count is one). Named by type
 * code; both-ways types as stored.
 */
export function surveyInteractionTables(doc: SurveyDoc, opts: { names: Names }): NamedTable[] {
  const list = doc.interactions ?? [];
  if (!list.length) return [];
  const occ = new Map(doc.occurrences.map((o) => [str(o.uuid), o]));
  const nameOf = (uuid: unknown) => {
    const o = occ.get(str(uuid));
    if (!o) return str(uuid);
    const base = str(o.used_scientific_name) || opts.names(str(o.taxon_id)).scientific || str(o.taxon_id);
    return o.verbatim_identification ? `${base} ${str(o.verbatim_identification)}` : base;
  };
  const out: NamedTable[] = [];
  for (const code of [...new Set(list.map((i) => str(i.type_code)))].sort()) {
    const mine = list.filter((i) => str(i.type_code) === code);
    const rows = [...new Set(mine.map((i) => nameOf(i.subject)))].sort((a, b) => a.localeCompare(b));
    const cols = [...new Set(mine.map((i) => nameOf(i.object)))].sort((a, b) => a.localeCompare(b));
    const sum = new Map<string, number>();
    for (const i of mine) {
      const k = `${nameOf(i.subject)}\u0000${nameOf(i.object)}`;
      sum.set(k, (sum.get(k) ?? 0) + (typeof i.count === 'number' ? i.count : 1));
    }
    out.push({
      name: `interactions_${fileStem(code) || 'type'}`,
      table: { header: ['subject', ...cols], rows: rows.map((r) => [r, ...cols.map((c) => String(sum.get(`${r}\u0000${c}`) ?? 0))]) },
    });
  }
  return out;
}

/** The types a document's interactions carry, by code (its template's). */
export function interactionTypesOf(doc: Pick<SurveyDoc, 'survey'>): Map<string, InteractionType> {
  const t = templateOf(doc);
  return new Map((t ? interactionTypes(t) : []).map((x) => [x.code, x]));
}

// ── community tables ──────────────────────────────────────────────────────

/** The scales a community table is made for, and its file name. Custom quantity types have no table. */
const SCALES: readonly { kind: Exclude<QuantityKind, 'custom'>; slug: string }[] = [
  { kind: 'BB', slug: 'bb_cover_pct' },
  { kind: 'percent', slug: 'percent_cover' },
  { kind: 'count', slug: 'count' },
  { kind: 'DBH', slug: 'basal_area_cm2' },
];

type Occ = { organism_quantity: string | null; organism_quantity_type: string | null; taxon_id: string; used_scientific_name: string | null; verbatim_identification: string | null };

const occOf = (o: Row): Occ => ({
  organism_quantity: o.organism_quantity == null || o.organism_quantity === '' ? null : str(o.organism_quantity),
  organism_quantity_type: o.organism_quantity_type == null || o.organism_quantity_type === '' ? null : str(o.organism_quantity_type),
  taxon_id: str(o.taxon_id),
  used_scientific_name: o.used_scientific_name == null ? null : str(o.used_scientific_name),
  verbatim_identification: o.verbatim_identification == null ? null : str(o.verbatim_identification),
});

/** A matrix row: a unit holding occurrences (or the survey for those outside units). */
type Releve = { id: string; occs: Occ[] };

/** The occurrences a community table counts: not those made only as an interaction's other side. */
const sampled = (doc: Pick<SurveyDoc, 'occurrences'>) => doc.occurrences.filter((o) => !o.via_interaction);

function relevesOf(doc: SurveyDoc, eventId: string): Releve[] {
  const paths = unitPaths(doc);
  const by = new Map<string, Occ[]>();
  for (const o of sampled(doc)) {
    const path = o.unit != null ? (paths.get(str(o.unit)) ?? '') : '';
    const id = path ? unitEventId(eventId, path) : eventId;
    (by.get(id) ?? by.set(id, []).get(id)!).push(occOf(o));
  }
  return [...by].map(([id, occs]) => ({ id, occs })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Species columns (taxon + name used + morphospecies label), named by scientific name; repeated names take the taxon id. */
function speciesCols(releves: Releve[], names: Names): { key: string; name: string }[] {
  const by = new Map<string, string>();
  for (const r of releves) {
    for (const o of r.occs) {
      const key = checklistIdentity(o);
      if (by.has(key)) continue;
      const base = o.used_scientific_name || names(o.taxon_id).scientific || o.taxon_id;
      by.set(key, o.verbatim_identification ? `${base} ${o.verbatim_identification}` : base);
    }
  }
  const cols = [...by].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  const count = new Map<string, number>();
  for (const c of cols) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  for (const c of cols) if ((count.get(c.name) ?? 0) > 1) c.name = `${c.name}_${c.key.split('|')[0]}`;
  return cols;
}

function matrix(releves: Releve[], names: Names, cell: (occs: Occ[]) => string): CsvTable {
  const cols = speciesCols(releves, names);
  return {
    header: ['eventID', ...cols.map((c) => c.name)],
    rows: releves.map((r) => {
      const by = new Map<string, Occ[]>();
      for (const o of r.occs) {
        const k = checklistIdentity(o);
        (by.get(k) ?? by.set(k, []).get(k)!).push(o);
      }
      return [r.id, ...cols.map((c) => (by.has(c.key) ? cell(by.get(c.key)!) : '0'))];
    }),
  };
}

const presence = () => '1';
/** One scale's cell: Braun-Blanquet as cover %, the others as recorded (vegMatrix.aggregateCell). */
const scaleCell = (occs: Occ[]) => cellString(aggregateCell(occs, 'cover'), 'cover');

export type NamedTable = { name: string; table: CsvTable };

/**
 * A plot-style survey's community tables: presence, and one per abundance
 * scale its occurrences use (each table only the occurrences of that scale).
 * `customLeftOut`: occurrences whose quantity has a custom type (in no table but presence).
 */
export function surveyCommunityTables(doc: SurveyDoc, opts: { eventId: string; names: Names }): { tables: NamedTable[]; customLeftOut: number } {
  if (doc.survey.style !== 'plot' || !sampled(doc).length) return { tables: [], customLeftOut: 0 };
  const releves = relevesOf(doc, opts.eventId);
  const tables: NamedTable[] = [{ name: 'presence', table: matrix(releves, opts.names, presence) }];
  for (const sc of SCALES) {
    const only = releves
      .map((r) => ({ id: r.id, occs: r.occs.filter((o) => o.organism_quantity != null && kindForType(o.organism_quantity_type) === sc.kind) }))
      .filter((r) => r.occs.length);
    if (only.length) tables.push({ name: sc.slug, table: matrix(only, opts.names, scaleCell) });
  }
  const customLeftOut = sampled(doc).filter((o) => o.organism_quantity != null && o.organism_quantity !== '' && kindForType(o.organism_quantity_type == null ? null : str(o.organism_quantity_type)) === 'custom').length;
  return { tables, customLeftOut };
}

/** The one abundance scale a survey's quantities use; 'none' without any, 'mixed' with several or a custom type. */
export function surveyScale(doc: SurveyDoc): QuantityKind | 'none' | 'mixed' {
  const kinds = new Set(sampled(doc).filter((o) => o.organism_quantity != null && o.organism_quantity !== '').map((o) => kindForType(str(o.organism_quantity_type))));
  if (!kinds.size) return 'none';
  if (kinds.size > 1 || kinds.has('custom')) return 'mixed';
  return [...kinds][0];
}

/**
 * The project's matrices of plot-style surveys (decided 2026-10-03): per
 * template, presence over all its surveys, and per scale over the surveys
 * that use only that scale. Rows are units (eventIDs). `left`: surveys in no
 * scale matrix (mixed or custom scales), by eventID.
 */
export function projectSurveyMatrices(items: readonly { doc: SurveyDoc; eventId: string }[], names: Names): { tables: NamedTable[]; left: string[] } {
  const groups = new Map<string, { doc: SurveyDoc; eventId: string }[]>();
  for (const it of items) {
    if (it.doc.survey.style !== 'plot') continue;
    const id = str(it.doc.survey.template_id);
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(it);
  }
  const tables: NamedTable[] = [];
  const left: string[] = [];
  for (const [templateId, list] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const tpl = templateOf(list[0].doc);
    const stem = `${clean(tpl && 'text' in tpl.name ? tpl.name.text : '') || 'template'}_${clean(templateId.split(':').pop() ?? templateId).slice(0, 8)}`;
    const all = list.flatMap((it) => relevesOf(it.doc, it.eventId));
    if (all.length) tables.push({ name: `${stem}_presence`, table: matrix(all, names, presence) });
    for (const sc of SCALES) {
      const these = list.filter((it) => surveyScale(it.doc) === sc.kind);
      if (these.length) tables.push({ name: `${stem}_${sc.slug}`, table: matrix(these.flatMap((it) => relevesOf(it.doc, it.eventId)), names, scaleCell) });
    }
    for (const it of list) if (surveyScale(it.doc) === 'mixed') left.push(it.eventId);
  }
  return { tables, left };
}

/** `YYYY-MM-DD` of the survey's start (file names, README). */
export const surveyDate = (doc: Pick<SurveyDoc, 'survey'>) => (typeof doc.survey.start_ts === 'number' ? isoDate(doc.survey.start_ts) : '');
