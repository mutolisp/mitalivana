/**
 * Everything a GLORIA screen needs about one survey, loaded in one go and
 * reloaded on focus. Status and issues are derived here so the overview, the
 * unit screens and the overview panel agree on them.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  getGloriaSurvey,
  getSummit,
  listPoints,
  listSurveySpecies,
  listUnits,
  p5mOf,
  type GloriaPoint,
  type GloriaSummit,
  type GloriaSurvey,
  type GloriaUnit,
  type GloriaUnitSpeciesWithTaxon,
} from './db';
import { validateSurvey, type Issue, type QuadratInput, type RequiredInput, type TopCover, type UnitSpecies } from './model/validate';
import { visitedCount } from './model/grid';
import type { Direction, P5mCorner } from './model/units';
import type { TaxonGroup } from '~/db/types';

/**
 * GLORIA records vascular plants, so every GLORIA search box starts filtered
 * to them, whatever group the user last picked elsewhere (SearchBox scopeGroups).
 */
export const GLORIA_SEARCH_GROUPS: TaxonGroup[] = ['Tracheophyta'];

export type UnitStatus = 'none' | 'progress' | 'done' | 'warn';
export type SurveySpecies = GloriaUnitSpeciesWithTaxon & { unit_code: string };

export type SurveyState = {
  survey: GloriaSurvey;
  summit: GloriaSummit;
  points: GloriaPoint[];
  units: GloriaUnit[];
  species: SurveySpecies[];
  p5m: Partial<Record<Direction, P5mCorner>>;
  issues: Issue[];
  unit: (code: string) => GloriaUnit | undefined;
  speciesOf: (code: string) => SurveySpecies[];
  statusOf: (code: string) => UnitStatus;
};

export function topOf(u: GloriaUnit): TopCover {
  return {
    vascular: u.cov_vascular,
    solidRock: u.cov_solid_rock,
    scree: u.cov_scree,
    lichens: u.cov_lichens,
    bryophytes: u.cov_bryophytes,
    bareGround: u.cov_bare_ground,
    litter: u.cov_litter,
  };
}

/** The species' name, with its morphospecies label (「薹屬 sp1」) when it has one. */
export function displayName(s: {
  common_name_c?: string;
  simple_name?: string;
  taxon_id: string;
  verbatim_identification?: string | null;
}): string {
  const name = s.common_name_c || s.simple_name || s.taxon_id;
  return s.verbatim_identification ? `${name} ${s.verbatim_identification}` : name;
}

export function toUnitSpecies(s: SurveySpecies): UnitSpecies {
  return {
    key: String(s.gloria_taxon_id),
    name: displayName(s),
    cover_pct: s.cover_pct,
    freq_cells: s.freq_cells,
    freq_count: s.freq_count,
    point_hits: s.point_hits,
  };
}

export function quadratInput(u: GloriaUnit, spp: SurveySpecies[]): QuadratInput {
  return {
    code: u.code,
    top: topOf(u),
    subtypes: [u.sub_lich_below_vasc, u.sub_lich_on_rock, u.sub_lich_on_scree, u.sub_bry_below_vasc, u.sub_bry_on_rock, u.sub_bry_on_scree],
    species: spp.map(toUnitSpecies),
    // A skipped quadrat (shrubs) has no frequency to cross-check.
    freqDone:
      u.freq_skipped !== 1 &&
      (u.freq_mode != null ||
      [u.dist_hi1, u.dist_hi2, u.dist_hi3].some((m) => m != null) ||
      spp.some((s) => s.freq_cells != null || s.freq_count != null)),
    point_surface: u.point_surface,
  };
}

/** A started 1×1 m quadrat or SAS, for the required-field check (model/validate missingRequired). */
export function requiredInput(u: GloriaUnit, spp: SurveySpecies[], surveyBy: string | null): RequiredInput {
  const base = {
    code: u.code,
    researchers: u.no_researchers === 1 ? null : u.recorded_by || surveyBy,
    start_ts: u.start_ts,
    stop_ts: u.stop_ts,
    date_only: u.date_only,
    top: topOf(u),
  };
  if (u.unit_type === 'sas')
    return { ...base, type: 'sas', species: spp.map((s) => ({ name: displayName(s), value: s.abundance })) };
  const q = quadratInput(u, spp);
  return {
    ...base,
    type: 'quadrat',
    species: spp.map((s) => ({ name: displayName(s), value: s.cover_pct })),
    aspect_deg: u.aspect_deg,
    slope_deg: u.slope_deg,
    subtypes: q.subtypes,
    skipped: u.freq_skipped === 1,
    freqDone: q.freqDone,
    pfDone: visitedCount(u.point_surface) > 0,
    freq_start_ts: u.freq_start_ts,
    freq_stop_ts: u.freq_stop_ts,
  };
}

export function loadSurveyState(id: number): SurveyState | null {
  const survey = getGloriaSurvey(id);
  if (!survey) return null;
  const summit = getSummit(survey.summit_id);
  if (!summit) return null;
  const points = listPoints(id);
  const units = listUnits(id);
  const species = listSurveySpecies(id);
  const byUnit = new Map<string, SurveySpecies[]>();
  for (const s of species) byUnit.set(s.unit_code, [...(byUnit.get(s.unit_code) ?? []), s]);
  const speciesOf = (code: string) => byUnit.get(code) ?? [];
  const p5m = p5mOf(points);
  // A date filled from the survey (date_only) is not a start.
  const started = (u: GloriaUnit) =>
    u.done_locked === 1 ||
    (u.start_ts != null && u.date_only !== 1) ||
    u.point_surface != null ||
    u.cov_vascular != null ||
    speciesOf(u.code).length > 0;
  const issues = validateSurvey({
    required: units.filter((u) => (u.unit_type === 'quadrat' || u.unit_type === 'sas') && started(u)).map((u) => requiredInput(u, speciesOf(u.code), survey.recorded_by)),
    p5m,
    quadrats: units.filter((u) => u.unit_type === 'quadrat').map((u) => quadratInput(u, speciesOf(u.code))),
    sas: units
      .filter((u) => u.unit_type === 'sas')
      .map((u) => ({ code: u.code, top: topOf(u), species: speciesOf(u.code).map(toUnitSpecies) })),
    squares: units
      .filter((u) => u.unit_type === 'square')
      .map((u) => ({ code: u.code, species: speciesOf(u.code).map(toUnitSpecies), point_surface: u.point_surface })),
  });
  const unitMap = new Map(units.map((u) => [u.code, u]));
  const statusOf = (code: string): UnitStatus => {
    const u = unitMap.get(code);
    if (!u) return 'none';
    if (issues.some((i) => i.unit === code)) return 'warn';
    if (u.done_locked === 1) return 'done';
    return started(u) ? 'progress' : 'none';
  };
  return { survey, summit, points, units, species, p5m, issues, unit: (c) => unitMap.get(c), speciesOf, statusOf };
}

/** Load on mount and on every focus; `reload` after writes. */
export function useSurvey(id: number): { state: SurveyState | null; reload: () => void } {
  const [state, setState] = useState<SurveyState | null>(() => loadSurveyState(id));
  const reload = useCallback(() => setState(loadSurveyState(id)), [id]);
  useFocusEffect(reload);
  return { state, reload };
}

export const STATUS_COLOR: Record<UnitStatus, string> = {
  none: '#d1d5db',
  progress: '#F9DE41',
  done: '#059669',
  warn: '#dc2626',
};
/** Label colour on a STATUS_COLOR fill: the light fills need dark text. */
export const STATUS_TEXT: Record<UnitStatus, string> = {
  none: '#374151',
  progress: '#422006',
  done: '#ffffff',
  warn: '#ffffff',
};
