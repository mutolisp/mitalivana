/**
 * A tree census as a file and back (docs/planned/Modular_survey.md §7.4, §9 1D).
 *
 * The document holds the census and every earlier census of its series
 * (decided 2026-10-01): a teammate who imports it can start the next census
 * and compute growth. Permanent data — trees, stems, correction history — is
 * written once, as it stands now; each census carries what belongs to it
 * (quadrat rows, measurements, values, photos) and this device's merge base
 * for it.
 *
 * Bringing a document in works census by census, oldest first, each as a
 * slice (sliceCore.ts): a census not here is created (finished, like any
 * imported record) and filled; one already here — by uuid, or by plot +
 * series + number as team sync matches them — is overwritten, skipped, or
 * left to the census merge (censusSyncCore.ts) as the person chose.
 *
 * Takes a context (db, clock, uuid) like stemmapCore; check:census-export runs
 * it on node:sqlite.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import type { BaseEntry, Row } from '../../lib/mergeEngine';
import { fgQuadratCounts, formatFgQuadratCode } from '../stemmap/coords';
import { censusByIdent, censusIdent, THIS_CENSUS } from './censusSyncCore';
import { buildSlice, fillSlice, insertCensusFromDoc, restoreSlice, type CensusSlice } from './sliceCore';
import { frameGeometry, getSurvey, type Ctx, type SurveyDb } from './stemmapCore';

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];

/** What one census adds to the permanent data. */
export type CensusPart = {
  survey: Row;
  quadrats: Row[];
  measures: Row[];
  stemValues: Row[];
  treeValues: Row[];
  /** Photos: `uri` on this device when built; the bundle swaps it for `file` (its name in the zip). */
  media: Row[];
  /** This device's merge base for the census (team merge, Team_merge.md). */
  base: BaseEntry[];
};

export type CensusExportDoc = {
  record_type: 'census_export';
  schema: 1;
  exported_at: number;
  frame: Row;
  series: Row;
  /** Every tree of the exported censuses, as corrected now (Condit's permanent database). */
  trees: Row[];
  stems: Row[];
  history: Row[];
  /** Oldest first, up to the one exported. */
  censuses: CensusPart[];
  /** Scientific name per taxon id, to re-point an id the receiving device's checklist lacks. */
  taxa: Record<string, string>;
};

export function isCensusExport(doc: unknown): doc is CensusExportDoc {
  const d = doc as CensusExportDoc | null;
  return !!d && d.record_type === 'census_export' && !!d.frame && !!d.series && Array.isArray(d.censuses) && d.censuses.length > 0 && Array.isArray(d.trees);
}

/** Every quadrat code of a frame row. */
function allCodes(frame: Row): string[] {
  const { cols, rows: rr } = fgQuadratCounts(
    frameGeometry(frame as unknown as Parameters<typeof frameGeometry>[0]),
  );
  const out: string[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rr; r++) out.push(formatFgQuadratCode(c, r));
  return out;
}

const baseOfCensus = (ctx: { db: SurveyDb }, uuid: string): BaseEntry[] =>
  rows<{ tbl: string; row_key: string; hash: string }>(ctx, `SELECT tbl, row_key, hash FROM sync_base WHERE record_kind = 'survey' AND record_uuid = ?`, [uuid]).map(
    (r) => [r.tbl, r.row_key, r.hash],
  );

/**
 * The census and the earlier censuses of its series. `names`: scientific name
 * per taxon id (the app's checklist; the tree's own used name wins).
 */
export function buildCensusExport(ctx: Ctx, surveyId: number, names: (taxonId: string) => string | null = () => null): CensusExportDoc {
  const s = getSurvey(ctx, surveyId);
  if (!s) throw new Error(`no census ${surveyId}`);
  const ids = rows<{ id: number }>(ctx, `SELECT id FROM fw_surveys WHERE series_id = ? AND census_no <= ? ORDER BY census_no`, [s.series_id, s.census_no]).map((r) => r.id);
  const frame = one<Row>(ctx, `SELECT * FROM fw_frames WHERE id = ?`, [s.frame_id])!;
  const codes = allCodes(frame);
  const slices = ids.map((id) => buildSlice(ctx, id, codes));
  // The last census sees every tree of the earlier ones.
  const last = slices[slices.length - 1];
  const taxa: Record<string, string> = {};
  for (const t of last.trees) {
    const id = t.taxon_id as string;
    const name = (t.used_scientific_name as string | null) ?? names(id);
    if (id && name && !taxa[id]) taxa[id] = name;
  }
  return {
    record_type: 'census_export',
    schema: 1,
    exported_at: ctx.now(),
    frame: last.frame,
    series: last.series,
    trees: last.trees,
    stems: last.stems,
    history: last.history,
    censuses: slices.map((sl) => ({
      survey: sl.survey,
      quadrats: sl.quadrats,
      measures: sl.measures,
      stemValues: sl.stemValues,
      treeValues: sl.treeValues,
      media: sl.media,
      base: baseOfCensus(ctx, sl.survey.uuid as string),
    })),
    taxa,
  };
}

/**
 * The document as one slice per census, oldest first, for restoring or
 * merging. A tree belongs to a census if it was first recorded in it or
 * before (or in another series); photos keep only those whose file is here
 * (`mediaUri` gives this device's file for a zip name, or null).
 */
export function censusSlicesOf(doc: CensusExportDoc, mediaUri: (file: string) => string | null = () => null): CensusSlice[] {
  const noOf = new Map(doc.censuses.map((c) => [c.survey.uuid as string, Number(c.survey.census_no)]));
  const codes = allCodes(doc.frame);
  return doc.censuses.map((c) => {
    const n = Number(c.survey.census_no);
    const seen = (first: unknown) => first == null || !noOf.has(first as string) || noOf.get(first as string)! <= n;
    const trees = doc.trees.filter((t) => seen(t.first_survey_uuid));
    const treeSet = new Set(trees.map((t) => t.uuid as string));
    const stems = doc.stems.filter((st) => treeSet.has(st.tree_uuid as string) && seen(st.first_survey_uuid));
    const media = c.media.flatMap((m) => {
      const uri = typeof m.file === 'string' ? mediaUri(m.file) : null;
      return uri ? [{ uuid: m.uuid, tree_uuid: m.tree_uuid, stem_uuid: m.stem_uuid, component: m.component, kind: m.kind, uri }] : [];
    });
    return {
      record_type: 'census_slice' as const,
      schema: 1 as const,
      taken_at: doc.exported_at,
      scope: codes,
      frame: doc.frame,
      series: doc.series,
      survey: c.survey,
      quadrats: c.quadrats,
      trees,
      stems,
      measures: c.measures,
      stemValues: c.stemValues,
      treeValues: c.treeValues,
      history: doc.history.filter((h) => treeSet.has(h.tree_uuid as string)),
      media,
    };
  });
}

/** One census of the document, and whether it is here. */
export type ImportTarget = { uuid: string; censusNo: number; localId: number | null };

export type ImportPlan = {
  /** Another plot here holds this plot's code: nothing can be imported. */
  frameCodeTaken: boolean;
  censuses: ImportTarget[];
};

/** Census here: by uuid, or by plot + series + number (two phones that each started it). */
function localCensus(ctx: { db: SurveyDb }, doc: CensusExportDoc, survey: Row): number | null {
  const byUuid = one<{ id: number }>(ctx, `SELECT id FROM fw_surveys WHERE uuid = ?`, [survey.uuid as string])?.id;
  if (byUuid != null) return byUuid;
  return censusByIdent(ctx, censusIdent(doc.frame.uuid as string, doc.series.uuid as string, Number(survey.census_no)));
}

export function planCensusImport(ctx: { db: SurveyDb }, doc: CensusExportDoc): ImportPlan {
  const frameHere = one(ctx, `SELECT id FROM fw_frames WHERE uuid = ?`, [doc.frame.uuid as string]);
  const codeTaken = !frameHere && !!one(ctx, `SELECT id FROM fw_frames WHERE code = ?`, [doc.frame.code as string]);
  return {
    frameCodeTaken: codeTaken,
    censuses: doc.censuses.map((c) => ({ uuid: c.survey.uuid as string, censusNo: Number(c.survey.census_no), localId: localCensus(ctx, doc, c.survey) })),
  };
}

export type ImportChoice = 'merge' | 'overwrite' | 'skip';

export type ImportResult = {
  created: number[];
  overwritten: number[];
  skipped: number[];
  /** Censuses to merge (the census merge, with its clashes and review), oldest first. */
  merges: Array<{ surveyId: number; slice: CensusSlice; base: BaseEntry[] }>;
};

/**
 * Bring the document in: censuses not here are created and filled with what
 * this device lacks (a tree already here keeps its fields: permanent data
 * follows the choice made for the censuses already here). Those here are
 * handled per `choice`. Overwriting makes the census equal to the file within
 * the plot (sliceCore's restore rules: trees and stems added here after the
 * export go, history stays). The caller runs it in a transaction and keeps
 * versions of what it overwrites.
 */
export function importCensusDoc(ctx: Ctx, doc: CensusExportDoc, choice: ImportChoice, mediaUri: (file: string) => string | null = () => null): ImportResult {
  const out: ImportResult = { created: [], overwritten: [], skipped: [], merges: [] };
  const slices = censusSlicesOf(doc, mediaUri);
  doc.censuses.forEach((c, i) => {
    const here = localCensus(ctx, doc, c.survey);
    const slice = slices[i];
    if (here == null) {
      const id = insertCensusFromDoc(ctx, { frame: doc.frame, series: doc.series, survey: c.survey }, { status: 'done', projectId: 0 });
      fillSlice(ctx, id, slice);
      out.created.push(id);
      return;
    }
    // The census here may have another uuid (started on another phone): the file's rows name it as THIS_CENSUS.
    const localUuid = getSurvey(ctx, here)!.uuid;
    const local = swapUuid(slice, c.survey.uuid as string, localUuid);
    if (choice === 'skip') out.skipped.push(here);
    else if (choice === 'overwrite') {
      restoreSlice(ctx, here, local);
      out.overwritten.push(here);
    } else out.merges.push({ surveyId: here, slice: swapUuid(slice, c.survey.uuid as string, THIS_CENSUS), base: c.base });
  });
  return out;
}

/** A slice with one census uuid written as another (this device's, or THIS_CENSUS for a merge). */
function swapUuid(sl: CensusSlice, from: string, to: string): CensusSlice {
  if (from === to) return sl;
  const sw = (v: unknown) => (v === from ? to : v);
  return {
    ...sl,
    survey: { ...sl.survey, uuid: sw(sl.survey.uuid) },
    trees: sl.trees.map((t) => ({ ...t, first_survey_uuid: sw(t.first_survey_uuid) })),
    stems: sl.stems.map((st) => ({ ...st, first_survey_uuid: sw(st.first_survey_uuid) })),
    history: sl.history.map((h) => ({ ...h, survey_uuid: sw(h.survey_uuid) })),
  };
}
