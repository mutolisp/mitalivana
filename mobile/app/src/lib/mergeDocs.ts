/**
 * Export documents → merge sides (src/lib/mergeEngine.ts), one converter per
 * record kind. Pure, so check:merge feeds it fixtures.
 *
 * Both sides of a merge go through these, built from the same parsed shape
 * (this device's record is exported and re-parsed first), so a value hashes
 * the same whichever device wrote it.
 *
 * What is compared is data a surveyor entered. Kept out:
 *   - display names (a checklist update renames without anyone editing);
 *   - media paths (device URIs, or zip filenames that differ per export);
 *   - per-device state: locks, sort order, row uuids of units and points.
 * Surveyors, the time span, the track and GLORIA's 3×3 m grid ticks are
 * combined, never asked about.
 */
import type { ImportedPlot, ImportedSession } from '../db';
import { unionSurveyors } from '../db/merge';
import type { GloriaDoc } from '../modules/gloria/export/yaml';
import { UNIT_FIELDS } from '../modules/gloria/export/yaml';
import { buildTrackGeoJSON, parseTrackSegments } from './track';
import type { Combiners, MergeRow, MergeSide, Row } from './mergeEngine';

export type MergeKind = 'session' | 'plot' | 'gloria';

const omit = (o: Row, keys: readonly string[]): Row =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

// ── combiners ──────────────────────────────────────────────────────────────

const minTime = (a: unknown, b: unknown) => {
  const xs = [a, b].filter((v): v is number => typeof v === 'number');
  return xs.length ? Math.min(...xs) : null;
};
const maxTime = (a: unknown, b: unknown) => {
  const xs = [a, b].filter((v): v is number => typeof v === 'number');
  return xs.length ? Math.max(...xs) : null;
};
/** This device still recording (no end) stays open; otherwise the later end. */
const endTime = (local: unknown, remote: unknown) => (local == null ? null : maxTime(local, remote));
const surveyors = (a: unknown, b: unknown) => unionSurveyors([(a as string) ?? null, (b as string) ?? null]);
/** Segment union without repeats, so merging the same file twice adds nothing. */
export function trackUnion(a: unknown, b: unknown): string | null {
  const seen = new Set<string>();
  const segs = [...parseTrackSegments((a as string) ?? null), ...parseTrackSegments((b as string) ?? null)].filter((s) => {
    const k = JSON.stringify(s);
    if (s.length === 0 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return segs.length ? buildTrackGeoJSON(segs) : null;
}

/** 3×3 m grid checks per aspect: ticked on either side stays ticked. */
const gridTicks = (a: unknown, b: unknown) => {
  const x = (a ?? {}) as Record<string, number>;
  const y = (b ?? {}) as Record<string, number>;
  return Object.fromEntries(['N', 'E', 'S', 'W'].map((d) => [d, x[d] || y[d] ? 1 : 0]));
};

export const COMBINERS: Record<MergeKind, Combiners> = {
  session: { record: { recorded_by: surveyors, started_at: minTime, ended_at: endTime, track_geojson: trackUnion } },
  plot: { record: { recorded_by: surveyors, start_ts: minTime, stop_ts: endTime, track_geojson: trackUnion } },
  gloria: { survey: { recorded_by: surveyors, start_ts: minTime, stop_ts: endTime, grid_ok: gridTicks } },
};

// ── session (快速名錄) ──────────────────────────────────────────────────────

const SESSION_COMBINED = ['recorded_by', 'started_at', 'ended_at', 'track_geojson'] as const;
const SESSION_OUT = ['uuid', 'project_name', 'site', 'records', ...SESSION_COMBINED];
const RECORD_OUT = ['occurrence_id', 'name', 'family', 'photo_files', 'audio_files'];

export function sessionSide(s: ImportedSession): MergeSide {
  const parent: MergeRow = {
    key: 'record',
    data: omit(s as unknown as Row, SESSION_OUT),
    extra: Object.fromEntries(SESSION_COMBINED.map((k) => [k, s[k] ?? null])),
    label: s.name,
  };
  return {
    record: [parent],
    rec: s.records.map((r, i) => ({
      key: r.occurrence_id || `row-${i}`,
      data: omit(r as unknown as Row, RECORD_OUT),
      extra: { photo_files: r.photo_files ?? [], audio_files: r.audio_files ?? [], name: r.name ?? null, family: r.family ?? null },
      dupKey: `${r.taxon_id}|${r.used_scientific_name ?? ''}`,
      label: r.used_scientific_name || r.name || r.taxon_id,
    })),
  };
}

// ── plot (樣區調查) ─────────────────────────────────────────────────────────

const PLOT_COMBINED = ['recorded_by', 'start_ts', 'stop_ts', 'track_geojson'] as const;
const PLOT_OUT = ['uuid', 'project_name', 'site', 'layers', 'subplots', 'species', 'env_photo_files', 'track_finalized', ...PLOT_COMBINED];
const PLOT_SP_OUT = ['occurrence_id', 'name', 'family', 'photo_files', 'audio_files'];

export function plotSide(p: ImportedPlot): MergeSide {
  return {
    record: [
      {
        key: 'record',
        data: omit(p as unknown as Row, PLOT_OUT),
        extra: Object.fromEntries(PLOT_COMBINED.map((k) => [k, p[k] ?? null])),
        label: p.plotid,
      },
    ],
    layer: (p.layers ?? []).map((l) => ({ key: String(l.layer_index), data: { ...l }, label: `E${l.layer_index}` })),
    subplot: (p.subplots ?? []).map((s) => ({
      key: String(s.idx),
      data: { label: s.label, width_m: s.width_m, length_m: s.length_m },
      label: s.label,
    })),
    sublayer: (p.subplots ?? []).flatMap((s) =>
      s.layers.map((l) => ({ key: `${s.idx}:${l.layer_index}`, data: { ...l }, label: `${s.label} E${l.layer_index}`, group: s.label })),
    ),
    sp: p.species.map((r, i) => ({
      key: r.occurrence_id || `row-${i}`,
      data: omit(r as unknown as Row, PLOT_SP_OUT),
      extra: { photo_files: r.photo_files ?? [], audio_files: r.audio_files ?? [], name: r.name ?? null, family: r.family ?? null },
      dupKey: `${r.taxon_id}|${r.layer ?? ''}|${r.subplot ?? ''}|${r.used_scientific_name ?? ''}`,
      label: r.used_scientific_name || r.name || r.taxon_id,
      group: r.subplot ?? undefined,
    })),
  };
}

// ── GLORIA ─────────────────────────────────────────────────────────────────

/** Unit columns that are not survey data: identity, media, locks, stamps. */
const UNIT_OUT = ['code', 'uuid', 'updated_at', 'photo_paths', 'done_locked', 'freq_locked', 'pf_locked'];
export const GLORIA_UNIT_DATA = UNIT_FIELDS.filter((k) => !UNIT_OUT.includes(k));
const GLORIA_SP_DATA = [
  'cover_pct', 'abundance', 'layer', 'cf', 'freq_cells', 'freq_count', 'point_hits', 'legacy_hits',
  'reproductive_condition', 'leaf_phenology', 'comments',
] as const;

export function gloriaSide(d: GloriaDoc): MergeSide {
  const taxonBySerial = new Map(d.taxa.map((t) => [t.serial, t]));
  const sv = d.survey;
  return {
    survey: [
      {
        key: 'survey',
        data: { year: sv.year, notes: sv.notes },
        extra: { recorded_by: sv.recorded_by, start_ts: sv.start_ts, stop_ts: sv.stop_ts, grid_ok: sv.grid_ok },
        label: `${d.summit.full_code} mocy ${sv.mocy}`,
      },
    ],
    point: d.points.map((p) => ({
      key: p.point_key,
      data: { is_p5m: p.is_p5m, distance_m: p.distance_m, compass_deg: p.compass_deg, comments: p.comments },
      label: p.point_key,
    })),
    unit: d.units.map((u) => ({
      key: u.code,
      data: Object.fromEntries(GLORIA_UNIT_DATA.map((k) => [k, u[k] ?? null])),
      label: u.code,
      group: u.code,
    })),
    sp: d.species.map((s) => {
      const t = taxonBySerial.get(s.serial);
      const taxonId = t?.taxon_id ?? `serial-${s.serial}`;
      const rec = s as unknown as Row;
      return {
        key: s.occurrence_id,
        data: { unit: s.unit, taxon_id: taxonId, ...Object.fromEntries(GLORIA_SP_DATA.map((k) => [k, rec[k] ?? null])) },
        extra: {
          sort_order: s.sort_order ?? null,
          used_name_id: t?.used_name_id ?? null,
          used_scientific_name: t?.used_scientific_name ?? null,
          verbatim_identification: t?.verbatim_identification ?? null,
          scientific_name: t?.scientific_name ?? null,
        },
        dupKey: `${s.unit}|${taxonId}`,
        label: t?.scientific_name || t?.used_scientific_name || taxonId,
        group: s.unit,
      };
    }),
    check: (d.photo_checks ?? []).map((c) => ({ key: c.item, data: { checked: c.checked ? 1 : 0 }, label: c.item })),
  };
}
