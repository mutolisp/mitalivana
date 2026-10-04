/**
 * A checklist / plot-style survey's export files (Phase 2E-a; rules in
 * export/surveyExportCore.ts), on the app's connection: the round-trip file
 * (its document as JSON, which is YAML, with the survey before it on its plot —
 * decided 2026-10-03, as team sync carries it), the spreadsheet CSVs, the
 * community tables of a plot-style survey, and its photos and recordings. The
 * zip itself — manifest, README, signing — is bundleExport.ts's.
 */
import { strToU8 } from 'fflate';
import i18n from '~/i18n';
import { getUserDb } from '~/db/init';
import { syncBlockFor } from '~/db/syncBase';
import { resolveTaxa } from '~/db/taxonLookup';
import { generateUuid } from '~/db/uuid';
import { tableToCsv } from '~/lib/vegMatrix';
import { toCsv } from '~/modules/gloria/export/sheetRows';
import { buildSurveyDoc, type SurveyDoc } from './db/surveyDocCore';
import { componentDef } from './registry';
import {
  docForFile,
  eventBase,
  surveyCommunityTables,
  surveyInteractionTables,
  surveyEventIds,
  surveyTables,
  type CsvTable,
  type FileRef,
  type Names,
  type Words,
} from './export/surveyExportCore';

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const clean = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 80) || 'survey';

export type SurveyEntry = { name: string; bytes: Uint8Array };

/** Names from the checklists, else the taxon cache. */
export function surveyNames(taxonIds: readonly string[]): Names {
  const found = resolveTaxa([...new Set(taxonIds)]);
  return (id) => {
    const f = found.get(id);
    return { scientific: f?.simple_name ?? null, vernacular: f?.common_name_c ?? null };
  };
}

export const surveyWords = (): Words => ({
  typeName: (type) => {
    const def = componentDef(type);
    return def ? i18n.t(def.labelKey) : type;
  },
  i18n: (key) => i18n.t(key),
});

/** Every checklist / plot-style survey's eventID here (one survey gets the same id alone or in a project). */
export function modularEventIds(): Map<number, string> {
  const rows = (getUserDb().executeSync(
    `SELECT s.id, s.uuid, s.name, s.start_ts, f.code AS frame_code, se.series_code
       FROM fw_surveys s LEFT JOIN fw_frames f ON f.id = s.frame_id LEFT JOIN fw_frame_series se ON se.id = s.series_id
      WHERE s.style <> 'individual'`,
  ).rows ?? []) as { id: number; uuid: string; name: string | null; start_ts: number | null; frame_code: string | null; series_code: string | null }[];
  return surveyEventIds(rows.map((r) => ({ id: r.id, base: eventBase({ frameCode: r.frame_code, seriesCode: r.series_code, name: r.name, uuid: r.uuid }), startTs: r.start_ts })));
}

export async function buildSurveyEntries(
  surveyId: number,
  opts: {
    includePhotos: boolean;
    /** A file's bytes, or null when it cannot be read (gone from the device: the document still names it). */
    readFile: (ref: FileRef) => Promise<Uint8Array | null>;
    extOf: (uri: string) => string;
    onFile?: (done: number, total: number) => void;
    eventIds?: ReadonlyMap<number, string>;
  },
): Promise<{ entries: SurveyEntry[]; folderName: string; uuid: string; name: string; occurrences: number; files: number; doc: SurveyDoc; eventId: string }> {
  const live = buildSurveyDoc(ctx(), surveyId, { previous: true });
  const names = surveyNames([...live.occurrences, ...(live.previous?.occurrences ?? [])].map((o) => String(o.taxon_id)));
  const eventId = (opts.eventIds ?? modularEventIds()).get(surveyId) ?? String(live.survey.uuid);
  const { doc, files } = docForFile(live, { names, extOf: opts.extOf });
  const base = clean(eventId);
  const entries: SurveyEntry[] = [];

  let written = 0;
  if (opts.includePhotos) {
    for (let i = 0; i < files.length; i++) {
      opts.onFile?.(i, files.length);
      const bytes = await opts.readFile(files[i]);
      if (!bytes) continue;
      entries.push({ name: `${base}/${files[i].kind === 'audio' ? 'audio' : 'photos'}/${files[i].file}`, bytes });
      written += 1;
    }
  }

  // The project id is this device's: a file carries none. The sync block is
  // this device's common ancestor, as every other record's file carries: a
  // merge from the file then knows what a teammate deleted (code review M13).
  const { project_id: _p, ...fileDoc } = doc;
  const sync = syncBlockFor('modular', String(live.survey.uuid));
  entries.push({ name: `${base}/${base}.yml`, bytes: strToU8(JSON.stringify({ ...fileDoc, sync })) });
  const tables = surveyTables(doc, { eventId, names, words: surveyWords() });
  const csv = (suffix: string, t: CsvTable | null) => {
    if (t) entries.push({ name: `${base}/${base}_${suffix}.csv`, bytes: strToU8(toCsv(t.header, t.rows)) });
  };
  csv('survey', tables.survey);
  csv('units', tables.units);
  csv('occurrences', tables.occurrences);
  csv('fields', tables.fields);
  csv('codelists', tables.codelists);
  csv('rechecks', tables.rechecks);
  csv('interactions', tables.interactions);
  csv('interaction_types', tables.interactionTypes);
  // R-first, as the project's analysis tables: no BOM.
  for (const tb of [...surveyCommunityTables(doc, { eventId, names }).tables.map((t) => ({ ...t, name: `vegan_${t.name}` })), ...surveyInteractionTables(doc, { names })]) {
    entries.push({ name: `${base}/${base}_${tb.name}.csv`, bytes: strToU8(tableToCsv(tb.table)) });
  }
  const s = live.survey;
  return {
    entries,
    folderName: base,
    uuid: String(s.uuid),
    name: live.frame ? `${String(live.frame.code)} #${String(s.census_no)}` : String(s.name ?? eventId),
    occurrences: live.occurrences.length,
    files: written,
    doc,
    eventId,
  };
}
