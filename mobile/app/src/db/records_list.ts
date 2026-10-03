/**
 * Unified "records" list combining `sessions` (checklist), `plot_surveys` (plot
 * survey) and `collection_trips` (specimen collecting).
 *
 * The Records tab displays every kind of field-data entity in one list.
 * Keeping a dedicated helper avoids spreading kind-switching across the UI.
 */
import { getUserDb } from './init';
import i18n from '~/i18n';
import {
  listPlotSurveysWithMeta,
  plotCanAcceptSpecies,
  type PlotSurvey,
  type PlotSurveyWithMeta,
} from './plots';
import { listSessions, type SessionWithStats } from './sessions';
import { listCollectionTrips, type CollectionTripWithStats } from './collections';
import { listGloriaSurveysWithMeta, type GloriaSurveyWithMeta } from '~/modules/gloria/db';
import { listCensuses, type CensusListRow } from '~/survey/db/stemmap';
import { listSurveys } from '~/survey/db/surveys';
import type { SurveyListRow } from '~/survey/db/surveyCore';
import type { BundleItem } from '~/lib/bundleExport';

/**
 * 'perm_survey': a tree census on a permanent plot; 'modular': a checklist /
 * plot-style survey of the survey framework (Phase 2C; same table, fw_surveys,
 * but nothing a census path does applies to them). Renamed from 'survey'
 * 2026-10-03; what is stored or sent keeps 'survey' (record_versions,
 * sync_links, team-sync objects, export manifests), so files and teammates on
 * older versions still read.
 */
export type RecordKind = 'session' | 'plot' | 'collection' | 'gloria' | 'perm_survey' | 'modular';

/** Records-tab filter: a single kind, or every kind. */
export type RecordFilter = 'all' | RecordKind;

export type RecordItem = {
  kind: RecordKind;
  id: number;
  title: string;
  subtitle: string;
  active: boolean;
  /** Sort key (ms). For sessions = started_at; for plots = start_ts ?? created_at. */
  startedAt: number;
  recordCount: number;
  /** Starred (v34). Starred records sort above unstarred ones. */
  starred: boolean;
  /** `subtitle` minus the project name — for the byProject view, where the
   *  group header already names the project. Built from its own i18n template
   *  (NOT by string-stripping `subtitle`, which breaks the moment a locale
   *  orders the template differently). Equals `subtitle` for kinds whose
   *  subtitle carries no project (plots). */
  subtitlePlain: string;
  projectId: number;
  projectName: string;
  /** Plot-only: hard-gate not yet satisfied (plotid + lat/lng + uncertainty). */
  notReady?: boolean;
  /** Plot-only: backing PlotSurvey (so row can read protocol / size). */
  plot?: PlotSurvey;
  /** Session-only: backing SessionWithStats. */
  session?: SessionWithStats;
  /** Collection-only: backing CollectionTripWithStats. */
  trip?: CollectionTripWithStats;
  /** GLORIA-only: backing survey with summit code. */
  gloria?: GloriaSurveyWithMeta;
  /** Census-only: backing census with its permanent plot. */
  survey?: CensusListRow;
  /** Checklist / plot-style survey only. */
  modular?: SurveyListRow;
};

function sessionToItem(s: SessionWithStats): RecordItem {
  return {
    kind: 'session',
    id: s.id,
    title: s.name,
    subtitle: i18n.t('recordsList.sessionSubtitle', {
      count: s.record_count,
      project: s.project_name,
    }),
    subtitlePlain: i18n.t('recordsList.sessionSubtitleNoProject', { count: s.record_count }),
    active: s.status === 'active',
    startedAt: s.started_at,
    recordCount: s.record_count,
    starred: s.starred === 1,
    projectId: s.project_id,
    projectName: s.project_name,
    session: s,
  };
}

function plotToItem(p: PlotSurveyWithMeta): RecordItem {
  const n = p.species_count;
  const sizeStr = p.sample_size_value ? ` · ${p.sample_size_value}${p.sample_size_unit ?? ''}` : '';
  const protocol = p.sampling_protocol || i18n.t('plots.noProtocol');
  const projectName = p.project_name || i18n.t('plot.uncategorized');
  return {
    kind: 'plot',
    id: p.id,
    title: p.plotid,
    subtitle: i18n.t('recordsList.plotSubtitle', { count: n, protocol, size: sizeStr }),
    subtitlePlain: i18n.t('recordsList.plotSubtitle', { count: n, protocol, size: sizeStr }),
    active: p.status === 'active',
    startedAt: p.start_ts ?? p.created_at,
    recordCount: n,
    starred: p.starred === 1,
    projectId: p.project_id,
    projectName,
    notReady: !plotCanAcceptSpecies(p),
    plot: p,
  };
}

function tripToItem(c: CollectionTripWithStats): RecordItem {
  return {
    kind: 'collection',
    id: c.id,
    title: c.name,
    subtitle: i18n.t('recordsList.collectionSubtitle', {
      count: c.specimen_count,
      project: c.project_name,
    }),
    subtitlePlain: i18n.t('recordsList.collectionSubtitleNoProject', { count: c.specimen_count }),
    active: c.status === 'active',
    startedAt: c.started_at,
    recordCount: c.specimen_count,
    starred: c.starred === 1,
    projectId: c.project_id,
    projectName: c.project_name,
    trip: c,
  };
}

function gloriaToItem(g: GloriaSurveyWithMeta): RecordItem {
  const projectName = g.project_name || i18n.t('plot.uncategorized');
  const subtitle = i18n.t('recordsList.gloriaSubtitle', { count: g.species_count, mocy: g.mocy, units: g.units_started });
  return {
    kind: 'gloria',
    id: g.id,
    title: g.full_code,
    subtitle,
    subtitlePlain: subtitle,
    active: g.status === 'active',
    startedAt: g.start_ts,
    recordCount: g.species_count,
    starred: g.starred === 1,
    projectId: g.project_id,
    projectName,
    gloria: g,
  };
}

function surveyToItem(c: CensusListRow): RecordItem {
  const projectName = c.project_name || i18n.t('plot.uncategorized');
  // A plot with several census series (2D-b): which one, after the number.
  const base = i18n.t('recordsList.surveySubtitle', { count: c.tree_count, n: c.census_no });
  const subtitle = c.series_code ? `${base} · ${c.series_code}` : base;
  return {
    kind: 'perm_survey',
    id: c.id,
    title: c.frame_name ? `${c.frame_code} ${c.frame_name}` : c.frame_code,
    subtitle,
    subtitlePlain: subtitle,
    active: c.status === 'active',
    startedAt: c.start_ts,
    recordCount: c.tree_count,
    starred: c.starred === 1,
    projectId: c.project_id,
    projectName,
    survey: c,
  };
}

function modularToItem(s: SurveyListRow): RecordItem {
  const projectName = s.project_name || i18n.t('plot.uncategorized');
  // Surveys of one permanent plot share its code as their name; the number tells them apart.
  const style = i18n.t(`surveyForm.style.${s.style}`);
  const subtitle = i18n.t('recordsList.modularSubtitle', {
    count: s.species_count,
    style: s.census_no == null ? style : `${style} · ${i18n.t('surveyForm.surveyNo', { n: s.census_no })}`,
  });
  return {
    kind: 'modular',
    id: s.id,
    title: s.name ?? '',
    subtitle,
    subtitlePlain: subtitle,
    active: s.status === 'active',
    startedAt: s.start_ts,
    recordCount: s.species_count,
    starred: s.starred === 1,
    projectId: s.project_id,
    projectName,
    modular: s,
  };
}

/** Record-list items as export items. */
export function bundleItemsOf(items: readonly { kind: RecordKind; id: number }[]): BundleItem[] {
  return items.map((it) => ({ kind: it.kind, id: it.id }));
}

export function listRecords(filter: RecordFilter = 'all'): RecordItem[] {
  const items: RecordItem[] = [];
  if (filter === 'all' || filter === 'session') {
    items.push(...listSessions().map(sessionToItem));
  }
  if (filter === 'all' || filter === 'plot') {
    // One query with project name + species count (no per-plot COUNT — that
    // N+1 made the records tab O(plots) queries on every focus).
    items.push(...listPlotSurveysWithMeta().map(plotToItem));
  }
  if (filter === 'all' || filter === 'collection') {
    items.push(...listCollectionTrips().map(tripToItem));
  }
  if (filter === 'all' || filter === 'gloria') {
    items.push(...listGloriaSurveysWithMeta().map(gloriaToItem));
  }
  if (filter === 'all' || filter === 'perm_survey') {
    items.push(...listCensuses().map(surveyToItem));
  }
  if (filter === 'all' || filter === 'modular') {
    items.push(...listSurveys().map(modularToItem));
  }
  items.sort(byActiveThenStarredThenNewest);
  return items;
}

/**
 * Active first → starred → newest by `startedAt`.
 *
 * Active outranks starred on purpose: at most one record is active app-wide
 * and it is the one being filled in right now, so burying it under a pinned
 * record would hide the thing the user is actually doing.
 */
function byActiveThenStarredThenNewest(a: RecordItem, b: RecordItem): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.starred !== b.starred) return a.starred ? -1 : 1;
  return b.startedAt - a.startedAt;
}

export type ProjectGroup = {
  projectId: number;
  projectName: string;
  items: RecordItem[];
};

/** Items grouped by project, preserving "active first → newest first" inside
 *  each group. Groups themselves are ordered by their newest item. */
export function listRecordsByProject(filter: RecordFilter = 'all'): ProjectGroup[] {
  return groupByProject(listRecords(filter));
}

function groupByProject(flat: RecordItem[]): ProjectGroup[] {
  const groups = new Map<number, ProjectGroup>();
  for (const it of flat) {
    let g = groups.get(it.projectId);
    if (!g) {
      g = { projectId: it.projectId, projectName: it.projectName, items: [] };
      groups.set(it.projectId, g);
    }
    g.items.push(it);
  }
  const result = Array.from(groups.values());
  // Sort each group's items (already sorted by listRecords, but be defensive).
  for (const g of result) g.items.sort(byActiveThenStarredThenNewest);
  // Sort groups by newest item's startedAt desc.
  result.sort((a, b) => (b.items[0]?.startedAt ?? 0) - (a.items[0]?.startedAt ?? 0));
  return result;
}

export type RecordsSummary = {
  /** Flat list under `filter` (active first, newest first). */
  items: RecordItem[];
  /** `items` grouped by project. */
  groups: ProjectGroup[];
  /** Per-kind totals over ALL records (filter-independent, for the tab chips). */
  counts: Record<'all' | RecordKind, number>;
};

/**
 * Everything the records tab needs from ONE walk of the tables. The tab used
 * to call listRecords('all') for the counters, listRecords(filter) for the
 * list and listRecordsByProject(filter) (which itself calls listRecords) for
 * the grouping — three identical table walks per focus. Counts, filtered
 * items and groups all derive from a single 'all' query here.
 */
export function listRecordsSummary(filter: RecordFilter = 'all'): RecordsSummary {
  const all = listRecords('all');
  const counts: RecordsSummary['counts'] = { all: all.length, session: 0, plot: 0, collection: 0, gloria: 0, perm_survey: 0, modular: 0 };
  for (const it of all) counts[it.kind] += 1;
  const items = filter === 'all' ? all : all.filter((it) => it.kind === filter);
  return { items, groups: groupByProject(items), counts };
}

/** Column holding the parent id, per record kind. */
/**
 * Every existing name of one record kind, for the duplicate dialog's
 * collision check.
 *
 * Queried straight from the tables rather than through `listRecords`:
 * `listSessions` INNER JOINs projects, so a session whose project was deleted
 * is missing from it — and a name missing from this set is a collision the
 * dialog would fail to warn about.
 */
const TAKEN_NAMES_SQL: Record<RecordKind, string> = {
  plot: `SELECT plotid AS name FROM plot_surveys`,
  session: `SELECT name FROM sessions`,
  gloria: `SELECT s.full_code || ' mocy ' || v.mocy AS name FROM gloria_surveys v JOIN gloria_summits s ON s.id = v.summit_id`,
  collection: `SELECT name FROM collection_trips`,
  // Censuses are not duplicated; listed for completeness.
  perm_survey: `SELECT f.code AS name FROM fw_surveys s JOIN fw_frames f ON f.id = s.frame_id`,
  modular: `SELECT name FROM fw_surveys WHERE style <> 'individual'`,
};

export function takenRecordNames(kind: RecordKind): Set<string> {
  const db = getUserDb();
  const sql = TAKEN_NAMES_SQL[kind];
  const rows = (db.executeSync(sql).rows ?? []) as { name?: string }[];
  return new Set(rows.map((r) => (r.name ?? '').trim()).filter(Boolean));
}

/** Table holding each record kind's own row. */
const RECORD_TABLE: Record<RecordKind, string> = {
  session: 'sessions',
  plot: 'plot_surveys',
  collection: 'collection_trips',
  gloria: 'gloria_surveys',
  perm_survey: 'fw_surveys',
  modular: 'fw_surveys',
};

/**
 * Star / unstar a record.
 *
 * A plain UPDATE rather than `updateSession` / `updatePlotSurvey` /
 * `updateCollectionTrip`: two of those three gate writes behind a key
 * allowlist, and `starred` is device-local organisation that has no business
 * in the patch types those functions take (or in the export round-trip).
 */
export function setRecordStarred(kind: RecordKind, id: number, starred: boolean): void {
  getUserDb().executeSync(`UPDATE ${RECORD_TABLE[kind]} SET starred = ? WHERE id = ?`, [
    starred ? 1 : 0,
    id,
  ]);
}

const RECORD_SPECIES_SOURCE: Record<RecordKind, { table: string; fk: string }> = {
  session: { table: 'checklist_records', fk: 'session_id' },
  plot: { table: 'plot_species_records', fk: 'plot_survey_id' },
  collection: { table: 'collection_specimens', fk: 'trip_id' },
  // The roster: every taxon the survey holds, recorded in a unit or not.
  gloria: { table: 'gloria_taxa', fk: 'survey_id' },
  // The trees the census sees (added in it or an earlier census of its series).
  perm_survey: {
    table: `(SELECT i.id, i.taxon_id, s.id AS survey_id FROM fw_surveys s
              JOIN fw_individuals i ON i.frame_id = s.frame_id
              LEFT JOIN fw_surveys fi ON fi.id = i.first_survey_id
             WHERE s.style = 'individual' AND (fi.id IS NULL OR fi.series_id <> s.series_id OR fi.census_no <= s.census_no))`,
    fk: 'survey_id',
  },
  modular: { table: 'fw_occurrences', fk: 'survey_id' },
};

/**
 * Distinct taxon_ids recorded under one record, in insertion order.
 *
 * Deliberately does NOT go through listSessionRecords / listPlotSpecies /
 * listSpecimens — those resolve every row against twnamelist.db to build
 * display fields, which is wasted work when the caller only needs ids (the
 * favourites import re-resolves each id once via searchByTaxonId anyway).
 */
export function taxonIdsOfRecord(kind: RecordKind, id: number): string[] {
  const { table, fk } = RECORD_SPECIES_SOURCE[kind];
  const res = getUserDb().executeSync(
    // GROUP BY (not DISTINCT) so ORDER BY MIN(id) is a legal aggregate —
    // `SELECT DISTINCT … ORDER BY MIN(id)` throws "misuse of aggregate".
    `SELECT taxon_id FROM ${table}
       WHERE ${fk} = ? AND taxon_id IS NOT NULL AND taxon_id != ''
       GROUP BY taxon_id ORDER BY MIN(id);`,
    [id],
  );
  return ((res.rows ?? []) as { taxon_id?: string }[])
    .map((row) => String(row.taxon_id ?? ''))
    .filter(Boolean);
}
