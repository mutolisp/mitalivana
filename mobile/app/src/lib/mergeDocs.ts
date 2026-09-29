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
import { LOGGER_FIELDS, UNIT_FIELDS } from '../modules/gloria/export/yaml';
import { buildTrackGeoJSON, parseTrackSegments } from './track';
import { defaultDecision, type Combiners, type Decision, type MergeItem, type MergeRow, type MergeSide, type Row } from './mergeEngine';

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
  plot: {
    record: { recorded_by: surveyors, start_ts: minTime, stop_ts: endTime, track_geojson: trackUnion },
    // A quadrat's working time spans both copies' (06-plot-quadrats.md phase D).
    quadrat: { started_at: minTime, ended_at: maxTime },
  },
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
const PLOT_OUT = [
  'uuid', 'project_name', 'site', 'layers', 'subplots', 'species', 'env_photo_files', 'track_finalized',
  // Quadrats (v77) are rows of their own below; the config is compared setting by setting.
  'quadrat_config', 'quadrats',
  ...PLOT_COMBINED,
];
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
    ...quadratTables(p),
  };
}

// ── plot quadrats (v77) ────────────────────────────────────────────────────
//
// Keyed by number, not uuid: two devices that each switched the module on
// both made a Q1, and it is the same place in the plot. A species in a quadrat
// is keyed by quadrat number and taxon (the table is UNIQUE on them). Each
// setting of the config is a row of its own, so changing the grid on one
// device and the layout on another is no conflict. Locks are shared progress,
// carried as 1 or null like GLORIA's.

/** A quadrat's size, grid and top edge: its masks are indexed by them. */
export const QUADRAT_GEOMETRY = ['size_m', 'grid_n', 'top_edge'] as const;
const QUADRAT_EXTRA = ['uuid', 'started_at', 'ended_at', 'photo_files'] as const;

function quadratTables(p: ImportedPlot): MergeSide {
  const quadrats = p.quadrats ?? [];
  let config: Row | null = null;
  try {
    config = p.quadrat_config ? (JSON.parse(p.quadrat_config) as Row) : null;
  } catch {
    config = null;
  }
  const out: MergeSide = {};
  // Only present tables: a plot without quadrats hashes as it did before v77.
  // One row per setting: the engine decides per row, so the grid changed here
  // and the layout changed there both come through without a question.
  if (config) out.qconfig = Object.entries(config).map(([k, v]) => ({ key: k, data: { value: v }, label: k }));
  if (quadrats.length) {
    out.quadrat = quadrats.map((q) => {
      const { species: _s, ...rest } = q;
      return {
        key: String(q.idx),
        data: { ...omit(rest as unknown as Row, QUADRAT_EXTRA), locked: q.locked ? 1 : null },
        extra: Object.fromEntries(QUADRAT_EXTRA.map((k) => [k, q[k] ?? null])),
        label: q.label,
      };
    });
    out.qsp = quadrats.flatMap((q) =>
      q.species.map((s) => ({
        key: `${q.idx}:${s.taxon_id}`,
        data: omit(s as unknown as Row, ['name', 'cname']),
        extra: { name: s.name ?? null, cname: s.cname ?? null },
        label: s.cname || s.name || s.taxon_id,
        group: q.label,
      })),
    );
  }
  return out;
}

/** Some quadrat's cells here that the sender's copy lacks (they would not fit a new grid). */
function paintedHere(items: readonly MergeItem[], local: MergeSide, quadratKey?: string): boolean {
  const remoteMask = new Map<string, unknown>();
  for (const it of items) if (it.tbl === 'qsp' && it.remote) remoteMask.set(it.key, it.remote.data.freq_cells ?? null);
  return (local.qsp ?? []).some(
    (r) =>
      (quadratKey == null || r.key.startsWith(`${quadratKey}:`)) &&
      r.data.freq_cells != null &&
      (remoteMask.get(r.key) ?? null) !== r.data.freq_cells,
  );
}

/**
 * After the diff: a new geometry the sender changed alone would be taken
 * automatically, but painted cells here that the sender's copy lacks cannot
 * survive it — so it is asked instead. The grid is the plot's (the `gridN`
 * setting; every quadrat shares it), size and top edge are per quadrat.
 */
export function askQuadratGeometry(items: MergeItem[], local: MergeSide): MergeItem[] {
  return items.map((it) => {
    if (it.kind !== 'auto' || !it.local || !it.remote) return it;
    if (it.tbl === 'qconfig' && it.key === 'gridN') return paintedHere(items, local) ? { ...it, kind: 'conflict' } : it;
    if (it.tbl !== 'quadrat' || !QUADRAT_GEOMETRY.some((f) => it.fields.includes(f))) return it;
    return paintedHere(items, local, it.key) ? { ...it, kind: 'conflict' } : it;
  });
}

/**
 * A quadrat whose geometry the two copies disagree on is taken whole from one
 * side (user decision 2026-09-29): its frequency masks are indexed by that
 * geometry, so its species cannot be picked field by field. The grid is one
 * for the whole plot, so the side chosen for the `gridN` setting decides it
 * for every quadrat whose grid differs; size or top edge alone go by the
 * quadrat's own choice. Every item of such a quadrat follows its side.
 */
export function tieQuadratGeometry(items: readonly MergeItem[], decisions: ReadonlyMap<string, Decision>): Map<string, Decision> {
  const out = new Map(decisions);
  const sideOf = (it: MergeItem, fields: readonly string[]): 'local' | 'remote' => {
    const d = out.get(it.id) ?? defaultDecision(it);
    return d.pick === 'remote' || fields.some((f) => d.fields?.[f] === 'remote') ? 'remote' : 'local';
  };
  const grid = items.find((it) => it.tbl === 'qconfig' && it.key === 'gridN' && it.local && it.remote);
  const gridSide = grid ? sideOf(grid, ['value']) : null;
  if (grid && gridSide) out.set(grid.id, { pick: gridSide });
  for (const it of items) {
    if (it.tbl !== 'quadrat' || !it.local || !it.remote) continue;
    const geo = QUADRAT_GEOMETRY.filter((f) => it.fields.includes(f));
    if (!geo.length) continue;
    const side = gridSide && geo.includes('grid_n') ? gridSide : sideOf(it, geo);
    out.set(it.id, { pick: side });
    for (const sp of items) {
      if (sp.tbl === 'qsp' && sp.key.startsWith(`${it.key}:`)) out.set(sp.id, { pick: side });
    }
  }
  return out;
}

// ── GLORIA ─────────────────────────────────────────────────────────────────

/** Unit columns that are not survey data: identity, media, stamps. */
const UNIT_OUT = ['code', 'uuid', 'updated_at', 'photo_paths'];
export const GLORIA_UNIT_DATA = UNIT_FIELDS.filter((k) => !UNIT_OUT.includes(k));
/**
 * 完成 locks are merged too: in a team they are shared progress (the leader
 * marks N11 done, the members see it done). Carried as 1 or null — never 0 —
 * so an unlocked unit hashes exactly as it did before the locks were merged
 * and existing bases stay valid; written back as 0 (the columns are NOT NULL).
 * Until 2026-09-27 they were left out, and a teammate's 完成 never arrived.
 */
export const GLORIA_UNIT_LOCKS = ['done_locked', 'freq_locked', 'pf_locked'];
/** Logger columns compared in a merge: all but identity, stamps and media. */
const GLORIA_LOGGER_DATA = LOGGER_FIELDS.filter(
  (k) => !['uuid', 'updated_at', 'sort_order', 'photo_open_uri', 'photo_closed_uri', 'data_files'].includes(k),
);
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
      data: Object.fromEntries(
        GLORIA_UNIT_DATA.map((k) => [k, GLORIA_UNIT_LOCKS.includes(k) ? (u[k] ? 1 : null) : (u[k] ?? null)]),
      ),
      label: u.code,
      group: u.code,
    })),
    sp: d.species.map((s) => {
      const t = taxonBySerial.get(s.serial);
      const taxonId = t?.taxon_id ?? `serial-${s.serial}`;
      const rec = s as unknown as Row;
      return {
        key: s.occurrence_id,
        // The morphospecies label (sp1, sp2) is part of what the species IS:
        // data, so a relabel merges like any change, and in the duplicate key,
        // so 薹屬 sp1 and sp2 in one unit are never offered as the same row.
        data: {
          unit: s.unit,
          taxon_id: taxonId,
          verbatim_identification: t?.verbatim_identification ?? null,
          ...Object.fromEntries(GLORIA_SP_DATA.map((k) => [k, rec[k] ?? null])),
        },
        extra: {
          sort_order: s.sort_order ?? null,
          used_name_id: t?.used_name_id ?? null,
          used_scientific_name: t?.used_scientific_name ?? null,
          scientific_name: t?.scientific_name ?? null,
        },
        dupKey: `${s.unit}|${taxonId}|${t?.verbatim_identification ?? ''}`,
        label: [t?.scientific_name || t?.used_scientific_name || taxonId, t?.verbatim_identification].filter(Boolean).join(' '),
        group: s.unit,
      };
    }),
    check: (d.photo_checks ?? []).map((c) => ({ key: c.item, data: { checked: c.checked ? 1 : 0 }, label: c.item })),
    // Temperature-logger visits of the cycle and their loggers (v65). Files
    // and photos stay out, like every other medium; ticks and locks are 1 / null.
    visit: (d.logger_visits ?? []).map((v) => ({
      key: String(v.uuid),
      data: { visit_ts: v.visit_ts ?? null, researchers: v.researchers ?? null, comments: v.comments ?? null, locked: v.locked ? 1 : null },
      label: `LOG ${typeof v.visit_ts === 'number' ? new Date(v.visit_ts).toISOString().slice(0, 10) : ''}`,
    })),
    logger: (d.logger_visits ?? []).flatMap((v) =>
      v.loggers.map((l) => ({
        key: String(l.uuid),
        data: {
          visit: String(v.uuid),
          ...Object.fromEntries(GLORIA_LOGGER_DATA.map((k) => [k, k === 'photo_open' || k === 'photo_closed' ? (l[k] ? 1 : null) : (l[k] ?? null)])),
        },
        dupKey: l.serial ? `${String(v.uuid)}|${String(l.role)}|${String(l.serial)}` : undefined,
        label: `${String(l.quadrat)}${String(l.label ?? '')} ${String(l.serial ?? '')}`.trim(),
        group: String(l.direction),
      })),
    ),
  };
}
