/**
 * One GLORIA survey → rows for each tab of the Taiwan vegetation sheet
 * (headers in sheetHeaders.ts). Pure: the caller loads everything into a
 * `GloriaExportData` first, so `check:gloria` can run this in Node.
 *
 * Row rules:
 *   - A method not done leaves its cells blank; done-and-nothing-found is 0.
 *   - 14_ gets rows only for quadrats where frequency was done.
 *   - 31_/32_ get rows only for squares with any data.
 *   - Coordinates derived from distance / compass (02_ hsp_*, p_*, lon/lat)
 *     are left blank: the app stores what was measured.
 */

import { F_COLUMNS, SURFACE_CODES, popcount, surfaceHits, type SurfaceCode } from '../model/grid';
import { POINTS, pointNumberOf, type Direction, type P5mCorner } from '../model/units';
import { speciesCoverSum, vascularCoverOk, type TopCover } from '../model/validate';
import { linePoint, walkOrder, type WalkOption } from '../model/walk';
import { bySpeciesOrder } from '../model/speciesOrder';
import {
  DISTURBANCES,
  H00_PLOT_COORDINATES,
  H01_SUMMITS_SURVEY_INFO,
  H02_POINTS,
  H10_1X1_PLOTINFO,
  H11_1X1_ENV,
  H12_13_1X1_SP_FREQ,
  H14_1X1_DISTURBANCE,
  H21_SAS_ENV,
  H22_SAS_SP,
  H31_10X10_ENV,
  H32_10X10_SP,
  PROTOCOL,
  SAS_ABUNDANCE_CODE,
} from './sheetHeaders';

export type ExportSummit = {
  full_code: string;
  country: string;
  target_region: string;
  summit: string;
  decimal_latitude?: number | null;
  decimal_longitude?: number | null;
  twd97x?: number | null;
  twd97y?: number | null;
  elevation_m?: number | null;
  veg_zone?: string | null;
};

export type ExportSurvey = {
  uuid: string;
  mocy: number;
  year: number | null;
  start_ts: number;
  stop_ts: number | null;
  recorded_by: string | null;
  notes: string | null;
};

export type ExportPoint = {
  point_key: string;
  is_p5m: number;
  distance_m: number | null;
  compass_deg: number | null;
  comments: string | null;
  uuid: string;
};

export type ExportUnit = {
  code: string;
  unit_type: 'quadrat' | 'sas' | 'square';
  start_ts: number | null;
  stop_ts: number | null;
  freq_start_ts: number | null;
  freq_stop_ts: number | null;
  recorded_by: string | null;
  aspect_deg: number | null;
  slope_deg: number | null;
  cov_vascular: number | null;
  cov_solid_rock: number | null;
  cov_scree: number | null;
  cov_lichens: number | null;
  cov_bryophytes: number | null;
  cov_bare_ground: number | null;
  cov_litter: number | null;
  sub_lich_below_vasc: number | null;
  sub_lich_on_rock: number | null;
  sub_lich_on_scree: number | null;
  sub_bry_below_vasc: number | null;
  sub_bry_on_rock: number | null;
  sub_bry_on_scree: number | null;
  dist_hi1: string | null;
  dist_hi2: string | null;
  dist_hi3: string | null;
  freq_mode?: 'cells' | 'count' | null;
  dist_hi1_n?: number | null;
  dist_hi2_n?: number | null;
  dist_hi3_n?: number | null;
  point_surface: string | null;
  walk_option: WalkOption | null;
  /** JSON {R,S,L,B,G,T: hits} for imported history without per-point data. */
  legacy_surface_hits: string | null;
  comments: string | null;
  /** 1 = a shrub quadrat: no frequency / point-framing (v62), so no times for them. */
  freq_skipped?: number | null;
  /** 1 = start_ts is a date only (filled from the survey date): no startTime. */
  date_only?: number | null;
  uuid: string;
};

/**
 * Comments cell text for a shrub quadrat (freq_skipped, v62): its frequency
 * and point-framing go out as 0 with this note. Text the app writes into a
 * sheet is always 「原文(English)」 (user's rule, 2026-09-27); what the user
 * typed is exported as typed.
 */
export const SHRUB_NOTE = '灌叢不點擊(Shrubs, not point-framed)';

const withNote = (note: string | null, text: string): string => [note, text].filter(Boolean).join('; ');

/** A species row's comments cell: the morphospecies label first, then the notes. */
export function speciesComments(s: Pick<ExportSpecies, 'comments' | 'morpho_label'>): string {
  return [s.morpho_label, s.comments].filter(Boolean).join('; ');
}

export type ExportSpecies = {
  unit_code: string;
  occurrence_id: string;
  serial: number;
  /** v55: the user's list order; the sp-N numbering follows it. */
  sort_order?: number | null;
  cover_pct: number | null;
  abundance: string | null;
  freq_cells: string | null;
  freq_count?: number | null;
  point_hits: string | null;
  legacy_hits: number | null;
  comments: string | null;
  /** Morphospecies label (sp1, sp2; roster `verbatim_identification`). The
   *  sheet has no column for it: it goes first in `comments`, and
   *  scientificName stays the genus / family the determination reached. */
  morpho_label?: string | null;
  /** Scientific name with authorship, as the sheet writes it. */
  scientific_name: string;
  vernacular_name: string;
  taxon_rank: string;
  family: string;
};

export type GloriaExportData = {
  summit: ExportSummit;
  survey: ExportSurvey;
  points: ExportPoint[];
  units: ExportUnit[];
  species: ExportSpecies[];
};

export type SheetTable = { name: string; header: readonly string[]; rows: string[][] };

// ── formatting ────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
export function localDate(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function localTime(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const num = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '' : String(Math.round(v * 1000) / 1000));
/** Decimal degrees keep their full precision (num() rounds to 0.001 = ~100 m). */
const coord = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '' : String(v));
/** App stores people comma-joined; the sheet joins them with '|'. */
export const researchers = (s: string | null): string =>
  (s ?? '')
    .split(/\s*[,，|]\s*/)
    .filter(Boolean)
    .join('|');

function topOf(u: ExportUnit): TopCover {
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

function surfaceHitsOf(u: ExportUnit): Record<SurfaceCode, number> | null {
  if (u.point_surface) return surfaceHits(u.point_surface);
  if (u.legacy_surface_hits) {
    try {
      const o = JSON.parse(u.legacy_surface_hits) as Partial<Record<SurfaceCode, number>>;
      const out = {} as Record<SurfaceCode, number>;
      for (const c of SURFACE_CODES) out[c] = Number(o[c] ?? 0);
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

const hitsOf = (s: ExportSpecies): number | null =>
  s.point_hits != null ? popcount(s.point_hits) : s.legacy_hits;

// ── build ─────────────────────────────────────────────────────────────────

/** One sheet 00_plot_coordinates row. Also the summit-list CSV export. */
export function summitRow(sm: ExportSummit): string[] {
  return [sm.full_code, sm.target_region, sm.summit, coord(sm.decimal_longitude), '', coord(sm.decimal_latitude), '',
    num(sm.twd97x), num(sm.twd97y), num(sm.elevation_m), sm.veg_zone ?? ''];
}

/** The 28 sheet 02_p5_p10m_direction rows of one survey. Also the point CSV export. */
export function pointRows(sm: ExportSummit, mocy: number, points: ExportPoint[]): string[][] {
  const p5m: Partial<Record<Direction, P5mCorner>> = {};
  for (const p of points) if (p.is_p5m) p5m[p.point_key[0] as Direction] = p.point_key.slice(1) as P5mCorner;
  const pointByKey = new Map(points.map((p) => [p.point_key, p]));
  return POINTS.map((def) => {
    const p = pointByKey.get(def.key);
    const label = pointNumberOf(def.key, p5m);
    return [
      `${sm.full_code}-${def.direction}-${label}`,
      `${sm.full_code}-${def.quadrat ?? 'NA'}`,
      sm.country, sm.target_region, sm.summit, def.direction, def.line, label,
      p?.is_p5m ? 'TRUE' : 'FALSE',
      def.quadrat ?? 'NA',
      p?.distance_m != null ? p.distance_m.toFixed(2) : '',
      num(p?.compass_deg), String(mocy), '', '', '', '', '', '', p?.comments ?? '', p?.uuid ?? '',
    ];
  });
}

export function buildSheetTables(d: GloriaExportData): SheetTable[] {
  const { summit: sm, survey: sv } = d;
  const m = sv.mocy;
  const base = [String(m), sm.country, sm.target_region, sm.summit];
  const present = d.species;
  const speciesOf = (code: string) => present.filter((s) => s.unit_code === code).sort(bySpeciesOrder);
  const quadrats = d.units.filter((u) => u.unit_type === 'quadrat');
  const sas = d.units.filter((u) => u.unit_type === 'sas');
  const squares = d.units.filter((u) => u.unit_type === 'square');
  const unitResearcher = (u: ExportUnit) => researchers(u.recorded_by ?? sv.recorded_by);
  const unitDate = (u: ExportUnit) => localDate(u.start_ts ?? sv.start_ts);
  // A date filled from the survey carries no time of day.
  const unitStart = (u: ExportUnit) => (u.date_only === 1 ? '' : localTime(u.start_ts));

  // 00_plot_coordinates — one row per summit; the sheet leaves the
  // degree-minute Longitude / Latitude columns empty.
  const t00: string[][] = [summitRow(sm)];

  // 01_summits_survey_info — scanned-form identifiers are left for the office.
  const t01: string[][] = [
    [String(m), String(sv.year ?? new Date(sv.start_ts).getFullYear()), sm.target_region, sm.summit,
      localDate(sv.start_ts), localDate(sv.stop_ts), '', '', '', '', '', sv.notes ?? '', ''],
  ];

  // 02_p5_p10m_direction
  const t02 = pointRows(sm, m, d.points);

  // 10_1x1m_plotinfo
  const t10 = quadrats.map((u) => [
    `${sm.full_code}-${u.code}`, sm.country, sm.target_region, sm.summit, u.code[0], u.code, num(u.aspect_deg), num(u.slope_deg),
  ]);

  // 11_1x1m_env
  const t11 = quadrats.map((u) => {
    const spp = speciesOf(u.code);
    const ok = vascularCoverOk(topOf(u), spp.map((s) => ({ key: s.occurrence_id, name: '', cover_pct: s.cover_pct, freq_cells: null, point_hits: null })));
    const hits = surfaceHitsOf(u);
    const shrub = u.freq_skipped === 1;
    // Shrub quadrat: no point-framing, so every surface total is 0.
    const tph = (c: SurfaceCode) => (shrub ? '0' : hits ? String(hits[c]) : '');
    const sum = spp.some((s) => s.cover_pct != null)
      ? num(speciesCoverSum(spp.map((s) => ({ key: '', name: '', cover_pct: s.cover_pct, freq_cells: null, point_hits: null }))))
      : '';
    return [
      '', `${sm.full_code}-${u.code}-mocy_${m}-1x1_env`, PROTOCOL.quadrat, ...base, u.code[0], u.code, unitDate(u),
      unitStart(u), localTime(u.stop_ts),
      // Times kept in the app from before the quadrat was marked as shrubs are not exported.
      u.freq_skipped === 1 ? '' : localTime(u.freq_start_ts), u.freq_skipped === 1 ? '' : localTime(u.freq_stop_ts),
      unitResearcher(u), sum, ok == null ? '' : ok ? 'TRUE' : 'FALSE', String(spp.length),
      withNote(shrub ? SHRUB_NOTE : null, u.comments ?? ''),
      num(u.cov_vascular), num(u.cov_solid_rock), num(u.cov_scree), num(u.cov_lichens), num(u.cov_bryophytes),
      num(u.cov_bare_ground), num(u.cov_litter),
      num(u.sub_lich_below_vasc), num(u.sub_lich_on_rock), num(u.sub_lich_on_scree),
      num(u.sub_bry_below_vasc), num(u.sub_bry_on_rock), num(u.sub_bry_on_scree),
      tph('R'), tph('S'), tph('L'), tph('B'), tph('G'), tph('T'), u.uuid, '',
    ];
  });

  // 12_ + 13_ merged
  const t1213: string[][] = [];
  for (const u of quadrats) {
    const shrub = u.freq_skipped === 1;
    speciesOf(u.code).forEach((s, i) => {
      const cells = s.freq_cells;
      const hits = hitsOf(s);
      // Count-only frequency: the total goes in `freq`, the 100 cells stay blank.
      const freq = cells != null ? String(popcount(cells)) : s.freq_count != null ? String(s.freq_count) : '';
      // Shrub quadrat: hits, frequency and all 100 cells are 0, whatever
      // was recorded before it was marked (still kept in the app).
      t1213.push([
        s.occurrence_id, `${sm.full_code}-${u.code}-mocy_${m}-1x1_sp-${i + 1}`, PROTOCOL.quadrat, ...base, u.code[0], u.code,
        String(i + 1), s.vernacular_name, s.scientific_name, s.taxon_rank, s.family, num(s.cover_pct),
        shrub ? '0' : hits == null ? '' : String(hits), shrub ? '0' : freq,
        ...F_COLUMNS.map((_, idx) => (shrub ? '0' : cells == null ? '' : cells[idx] === '1' ? '1' : '0')),
        withNote(shrub ? SHRUB_NOTE : null, speciesComments(s)),
      ]);
    });
  }

  // 14_1x1m_disturbance
  const t14: string[][] = [];
  for (const u of quadrats) {
    const masks = [u.dist_hi1, u.dist_hi2, u.dist_hi3];
    const counts = [u.dist_hi1_n, u.dist_hi2_n, u.dist_hi3_n];
    const byCount = u.freq_mode === 'count';
    const freqDone =
      byCount || masks.some((x) => x != null) || speciesOf(u.code).some((s) => s.freq_cells != null || s.freq_count != null);
    // Shrub quadrat: disturbance frequency is 0 too, rows always present.
    if (u.freq_skipped === 1) {
      DISTURBANCES.forEach((dist) => {
        t14.push([`${sm.full_code}-${u.code}-mocy_${m}-1x1_disturb-${dist.code}`, ...base, u.code, dist.code, dist.type, '0', ...F_COLUMNS.map(() => '0')]);
      });
      continue;
    }
    if (!freqDone) continue;
    DISTURBANCES.forEach((dist, k) => {
      const id = `${sm.full_code}-${u.code}-mocy_${m}-1x1_disturb-${dist.code}`;
      if (byCount) {
        t14.push([id, ...base, u.code, dist.code, dist.type, counts[k] == null ? '' : String(counts[k]), ...F_COLUMNS.map(() => '')]);
        return;
      }
      const mask = masks[k] ?? '0'.repeat(100);
      t14.push([id, ...base, u.code, dist.code, dist.type, String(popcount(mask)), ...F_COLUMNS.map((_, idx) => (mask[idx] === '1' ? '1' : '0'))]);
    });
  }

  // 21_sas_env / 22_sas_sp
  const t21 = sas.map((u) => [
    `${sm.full_code}-${u.code}-mocy_${m}-SAS_env`, PROTOCOL.sas, ...base, u.code[0], u.code, unitDate(u),
    unitStart(u), localTime(u.stop_ts), unitResearcher(u),
    num(u.cov_vascular), num(u.cov_solid_rock), num(u.cov_scree), num(u.cov_lichens), num(u.cov_bryophytes),
    num(u.cov_bare_ground), num(u.cov_litter), String(speciesOf(u.code).length), '', u.comments ?? '', u.uuid,
  ]);
  const t22: string[][] = [];
  for (const u of sas) {
    speciesOf(u.code).forEach((s, i) => {
      t22.push([
        `${sm.full_code}-${u.code}-mocy_${m}-SAS_sp-${i + 1}`, PROTOCOL.sas, ...base, u.code[0], u.code, String(i + 1),
        s.vernacular_name, s.scientific_name, s.taxon_rank, s.family, s.abundance ?? '',
        s.abundance ? String(SAS_ABUNDANCE_CODE[s.abundance] ?? '') : '', speciesComments(s), s.occurrence_id,
      ]);
    });
  }

  // 31_10x10m_env / 32_10x10m_sp — hits out of 400.
  const t31: string[][] = [];
  const t32: string[][] = [];
  for (const u of squares) {
    const spp = speciesOf(u.code);
    const hits = surfaceHitsOf(u);
    if (!hits && spp.length === 0) continue;
    const h = (c: SurfaceCode) => (hits ? String(hits[c]) : '');
    t31.push([
      `${sm.full_code}-${u.code}-mocy_${m}-10x10_env`, PROTOCOL.square, ...base, u.code, unitDate(u),
      unitStart(u), localTime(u.stop_ts), unitResearcher(u),
      h('R'), h('S'), h('L'), h('B'), h('G'), h('T'), String(spp.length), u.comments ?? '', u.uuid,
    ]);
    spp.forEach((s, i) => {
      const hitsN = hitsOf(s);
      t32.push([
        `${sm.full_code}-${u.code}-mocy_${m}-10x10_sp-${i + 1}`, PROTOCOL.square, ...base, u.code, String(i + 1),
        s.vernacular_name, s.scientific_name, s.taxon_rank, s.family, hitsN == null ? '0' : String(hitsN),
        speciesComments(s), s.occurrence_id,
      ]);
    });
  }

  return [
    { name: '00_plot_coordinates', header: H00_PLOT_COORDINATES, rows: t00 },
    { name: '01_summits_survey_info', header: H01_SUMMITS_SURVEY_INFO, rows: t01 },
    { name: '02_p5_p10m_direction', header: H02_POINTS, rows: t02 },
    { name: '10_1x1m_plotinfo', header: H10_1X1_PLOTINFO, rows: t10 },
    { name: '11_1x1m_env', header: H11_1X1_ENV, rows: t11 },
    { name: '12_13_1x1m_sp_freq', header: H12_13_1X1_SP_FREQ, rows: t1213 },
    { name: '14_1x1m_disturbance', header: H14_1X1_DISTURBANCE, rows: t14 },
    { name: '21_sas_env', header: H21_SAS_ENV, rows: t21 },
    { name: '22_sas_sp', header: H22_SAS_SP, rows: t22 },
    { name: '31_10x10m_env', header: H31_10X10_ENV, rows: t31 },
    { name: '32_10x10m_sp', header: H32_10X10_SP, rows: t32 },
  ];
}

/** Long table of every visited point (1×1 m point-framing and 10×10 m squares). */
export const POINT_HITS_HEADER = [
  'mocy', 'fullSummitCode', 'unitCode', 'walkSeq', 'line', 'point', 'cellIndex', 'hitType', 'scientificName', 'surfaceType',
] as const;

export function buildPointHitRows(d: GloriaExportData): string[][] {
  const out: string[][] = [];
  const present = d.species.filter((s) => s.point_hits != null);
  for (const u of d.units) {
    // A shrub quadrat was not point-framed: no points, whatever the app still holds.
    if (!u.point_surface || u.freq_skipped === 1) continue;
    const size = u.point_surface.length;
    const n = Math.round(Math.sqrt(size));
    const order = walkOrder(n, u.unit_type === 'square' ? u.walk_option : null);
    const spp = present.filter((s) => s.unit_code === u.code);
    order.forEach((idx, seq) => {
      const ch = u.point_surface![idx];
      if (ch === '.') return;
      const { line, point } = linePoint(seq, n);
      const common = [String(d.survey.mocy), d.summit.full_code, u.code, String(seq + 1), String(line), String(point), String(idx)];
      const hit = spp.filter((s) => s.point_hits![idx] === '1');
      if (hit.length) for (const s of hit) out.push([...common, 'species', s.scientific_name, '']);
      else out.push([...common, 'surface', '', ch]);
    });
  }
  return out;
}

export function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** UTF-8 BOM CSV, like the other exports. */
export function toCsv(header: readonly string[], rows: string[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
