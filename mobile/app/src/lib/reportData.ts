/**
 * DB → report-model assembly. The impure half of the report pipeline: it does
 * the querying and hands plain data to the pure builders in `reportModel.ts`,
 * which is what lets those be unit-checked under Node.
 */
import {
  getPlotLayers,
  getPlotSurvey,
  getProject,
  getSession,
  getSubplotLayers,
  listPlotSpecies,
  listPlotSurveys,
  listRecordsSummary,
  listSessionRecords,
  listSitesByProject,
  listSubplots,
  parseTrackSegments,
} from '~/db';
import type {
  PlotReportInput,
  ProjectReportInput,
  SessionReportInput,
} from './reportModel';
import {
  getGloriaSurvey,
  getSummit,
  listGloriaSurveysWithMeta,
  listSurveySpecies,
  listUnits,
  type GloriaSummit,
  type GloriaSurvey,
  type GloriaSurveyWithMeta,
} from '~/modules/gloria/db';
import type { SpeciesFieldRow, UnitKind } from '~/modules/gloria/model/stats';
import type { GloriaCycle, GloriaProjectReportInput, GloriaReportInput } from './reportGloria';
import { listQuadrats, listQuadratSpeciesWithTaxon, parseQuadratConfig } from '~/db/quadrats';
import type { ReportQuadrat } from './reportQuadrats';

/**
 * Everything a plot report needs, in one pass. Mirrors the assembly
 * `projectExport.ts` already does for relevés, so a report and the exported
 * matrices are built from the same reads.
 */
export function collectPlotReportInput(plotId: number): PlotReportInput | null {
  const plot = getPlotSurvey(plotId);
  if (!plot) return null;
  const project = getProject(plot.project_id);
  const subplots = listSubplots(plot.id);
  return {
    plot,
    projectName: project?.name ?? '',
    layers: getPlotLayers(plot.id).map((l) => ({
      layer_index: l.layer_index,
      cover_pct: l.cover_pct,
      height_cm: l.height_cm,
      height_unit: l.height_unit,
      method: l.method,
    })),
    subplots: subplots.map((s) => ({
      id: s.id,
      label: s.label,
      width_m: s.width_m,
      length_m: s.length_m,
    })),
    species: listPlotSpecies(plot.id),
    trackSegments: parseTrackSegments(plot.track_geojson),
    ...quadratReportInput(plot),
  };
}

/** A fixed plot's quadrats and plot-grid frequency settings, as the report takes them. */
function quadratReportInput(plot: { id: number; plot_type: string; quadrat_config: string | null }) {
  if (plot.plot_type !== 'fixed') return {};
  const cfg = parseQuadratConfig(plot.quadrat_config);
  const quadrats: ReportQuadrat[] = listQuadrats(plot.id).map((q) => ({
    ...q,
    species: listQuadratSpeciesWithTaxon(q.id).map((s) => ({
      ...s,
      // Cover is its own column here; the plot-list abundance fields do not apply.
      organism_quantity: null,
      organism_quantity_type: null,
      cells: q.freq_mode === 'count' ? s.freq_count : s.freq_cells != null ? [...s.freq_cells].filter((c) => c === '1').length : null,
    })),
  }));
  return {
    quadrats,
    plotFrequency: cfg.freqEnabled ? { gridN: cfg.freqGridN, topEdge: cfg.freqTopEdge, mode: cfg.freqMode } : null,
  };
}

/** Subplot-layer detail, kept separate because only some reports need it. */
export function collectSubplotLayers(subplotId: number) {
  return getSubplotLayers(subplotId);
}

/**
 * Project report input. Analysis is plots-only — the same scope rule
 * `projectExport.ts` states — so sessions and collections contribute counts
 * but no statistics.
 */
export function collectProjectReportInput(projectId: number): ProjectReportInput | null {
  const project = getProject(projectId);
  if (!project) return null;
  const plots = listPlotSurveys().filter((p) => p.project_id === projectId);
  const summary = listRecordsSummary('all');
  const mine = summary.items.filter((it) => it.projectId === projectId);
  return {
    project: {
      id: project.id,
      name: project.name,
      abstract: project.abstract,
      location_description: project.location_description,
      notes: project.notes,
    },
    plots: plots.map((plot) => ({
      plot,
      species: listPlotSpecies(plot.id),
      subplotIds: listSubplots(plot.id).map((s) => s.id),
    })),
    counts: {
      session: mine.filter((it) => it.kind === 'session').length,
      plot: mine.filter((it) => it.kind === 'plot').length,
      collection: mine.filter((it) => it.kind === 'collection').length,
      gloria: mine.filter((it) => it.kind === 'gloria').length,
    },
    siteCount: listSitesByProject(projectId).length,
  };
}

export function collectSessionReportInput(sessionId: number): SessionReportInput | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const project = getProject(session.project_id);
  return {
    session: {
      id: session.id,
      name: session.name,
      started_at: session.started_at,
      ended_at: session.ended_at,
      recorded_by: session.recorded_by,
      gps_mode: session.gps_mode,
      notes: session.notes,
    },
    projectName: project?.name ?? '',
    species: listSessionRecords(session.id),
  };
}

// ── GLORIA ──────────────────────────────────────────────────────────────────

/** A survey's species rows in the shape the statistics take. */
function gloriaRows(surveyId: number): SpeciesFieldRow[] {
  const types = new Map(listUnits(surveyId).map((u) => [u.code, u.unit_type as UnitKind]));
  return listSurveySpecies(surveyId).map((s) => ({
    unit_code: s.unit_code,
    unit_type: types.get(s.unit_code) ?? 'quadrat',
    // A morphospecies (sp1, sp2 of one genus) is its own species here: the
    // label is part of the key. Labels are per survey, so the previous-cycle
    // comparison matches them by label text only.
    taxon_id: s.verbatim_identification ? `${s.taxon_id}|${s.verbatim_identification}` : s.taxon_id,
    name: [s.common_name_c || s.simple_name || s.used_scientific_name || s.taxon_id, s.verbatim_identification].filter(Boolean).join(' '),
    cover_pct: s.cover_pct,
    freq_cells: s.freq_cells,
    freq_count: s.freq_count,
    point_hits: s.point_hits,
    legacy_hits: s.legacy_hits,
    abundance: s.abundance,
  }));
}

function gloriaCycle(v: GloriaSurvey): GloriaCycle {
  return {
    id: v.id,
    mocy: v.mocy,
    year: v.year,
    status: v.status,
    start_ts: v.start_ts,
    stop_ts: v.stop_ts,
    recorded_by: v.recorded_by,
    rows: gloriaRows(v.id),
  };
}

/** One survey, and the previous cycle of its summit (`prev_survey_id`). */
export function collectGloriaReportInput(surveyId: number): GloriaReportInput | null {
  const survey = getGloriaSurvey(surveyId);
  if (!survey) return null;
  const summit = getSummit(survey.summit_id);
  if (!summit) return null;
  const prev = survey.prev_survey_id != null ? getGloriaSurvey(survey.prev_survey_id) : null;
  return { summit, survey: gloriaCycle(survey), prev: prev ? gloriaCycle(prev) : null };
}

/** Every GLORIA survey of a project, grouped by summit, cycles in mocy order. */
export function collectGloriaProjectReportInput(projectId: number): GloriaProjectReportInput | null {
  const project = getProject(projectId);
  const surveys = listGloriaSurveysWithMeta().filter((v) => v.project_id === projectId);
  if (surveys.length === 0) return null;
  const bySummit = new Map<number, GloriaSurveyWithMeta[]>();
  for (const v of surveys) bySummit.set(v.summit_id, [...(bySummit.get(v.summit_id) ?? []), v]);
  const summits = [...bySummit]
    .map(([summitId, list]) => ({
      summit: getSummit(summitId),
      cycles: [...list].sort((a, b) => a.mocy - b.mocy).map(gloriaCycle),
    }))
    .filter((s): s is { summit: GloriaSummit; cycles: GloriaCycle[] } => s.summit != null)
    .sort((a, b) => a.summit.full_code.localeCompare(b.summit.full_code));
  return { projectName: project?.name ?? '', summits };
}
