/**
 * A plot-style survey's second unit level drawn as the fixed plot's quadrats
 * (2G-d4): what its template records there, and an occurrence and a unit in
 * the shape the fixed plot's quadrat progress reads.
 *
 * Pure: check:survey-core runs it under Node.
 */
import { kindForType } from '../../lib/dwcAbundanceCore';
import { COVER_FIELDS, type ComponentValues } from '../registry';
import type { ComponentInstance, SurveyTemplate } from '../template/types';
import { formComponents } from './occurrenceForm';

/** The template's ground covers as GLORIA's surface keys, whose names the fixed plot's quadrat uses. */
export const SURFACE_OF = {
  vascular_cover_pct: 'cov_vascular',
  bryophyte_cover_pct: 'cov_bryophytes',
  lichen_cover_pct: 'cov_lichens',
  litter_cover_pct: 'cov_litter',
  rock_cover_pct: 'cov_solid_rock',
  gravel_cover_pct: 'cov_scree',
  bareland_cover_pct: 'cov_bare_ground',
} as const satisfies Readonly<Record<(typeof COVER_FIELDS)[number], string>>;

export type SurfaceKey = (typeof SURFACE_OF)[keyof typeof SURFACE_OF];

export type QuadratSetup = {
  level: string;
  abundance: ComponentInstance | null;
  /** A cover per species: the template's abundance takes percentages. */
  recordCover: boolean;
  freq: ComponentInstance | null;
  n: number;
  mode: 'cells' | 'count';
  topEdge: string;
  /** The level's environment component and the ground covers it asks for. */
  env: ComponentInstance | null;
  surface: (typeof COVER_FIELDS)[number][];
  photos: ComponentInstance | null;
};

/** What the second unit level records, or null when the template has no second level. */
export function quadratSetup(t: SurveyTemplate): QuadratSetup | null {
  const level = t.units?.[1]?.key;
  if (!level) return null;
  const occ = formComponents(t, 'occurrence');
  const here = formComponents(t, { unit: level });
  const abundance = occ.find((c) => c.type === 'abundance') ?? null;
  const freq = occ.find((c) => c.type === 'frequency') ?? null;
  const env = here.find((c) => c.type === 'environment') ?? null;
  const asked = env && Array.isArray(env.params.fields) ? (env.params.fields as string[]) : [];
  return {
    level,
    abundance,
    recordCover: !!abundance && Array.isArray(abundance.params.kinds) && (abundance.params.kinds as string[]).includes('percent'),
    freq,
    n: Number(freq?.params.n) || 10,
    mode: freq?.params.mode === 'count' ? 'count' : 'cells',
    topEdge: String(freq?.params.top_edge ?? 'N'),
    env,
    surface: COVER_FIELDS.filter((f) => asked.includes(f)),
    photos: here.find((c) => c.type === 'photos') ?? null,
  };
}

/** An occurrence's cover: its abundance when kept as a percentage. */
export function coverOf(o: { organism_quantity: string | null; organism_quantity_type: string | null }): number | null {
  if (kindForType(o.organism_quantity_type) !== 'percent' || o.organism_quantity == null) return null;
  const v = Number(o.organism_quantity);
  return Number.isFinite(v) ? v : null;
}

/** A unit in the shape quadratProgress reads: done, the method, the ground covers under GLORIA's keys. */
export function quadratLike(done: boolean, mode: string, envValues: ComponentValues): Record<SurfaceKey, number | null> & { locked: number; freq_mode: string } {
  const out = {} as Record<SurfaceKey, number | null>;
  for (const [f, k] of Object.entries(SURFACE_OF)) out[k] = typeof envValues[f] === 'number' ? (envValues[f] as number) : null;
  return { ...out, locked: done ? 1 : 0, freq_mode: mode };
}

/** The herb layer, as the fixed plot's quadrats use it (the moss layer when there is one layer only). */
export const herbLayer = (layerCount: number): 'E1' | 'E2' => (layerCount >= 2 ? 'E2' : 'E1');

type UnitLike = { id: number; parent_id: number | null; level_key: string };
type OccLike = { taxon_id: string; unit_id: number | null; via_interaction?: number | null };

/**
 * Taxa recorded in a quadrat (the second level or below) that the plot list
 * lacks — the plot list being what was recorded outside the quadrats, at the
 * survey or the first level — each with the subplot of the first quadrat that
 * has it (null: the quadrat has none). The fixed plot's 「小樣方有 n 種不在樣區名錄」.
 */
export function taxaNotInPlotList(units: readonly UnitLike[], occurrences: readonly OccLike[], levelKeys: readonly string[]): { taxon_id: string; parentId: number | null }[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const depth = (u: UnitLike) => levelKeys.indexOf(u.level_key);
  /** The first-level unit above a quadrat, or null. */
  const subplotOf = (u: UnitLike): number | null => {
    let cur: UnitLike | undefined = u;
    while (cur && depth(cur) > 0) cur = cur.parent_id == null ? undefined : byId.get(cur.parent_id);
    return cur && depth(cur) === 0 ? cur.id : null;
  };
  const inQuadrat = (o: OccLike) => {
    const u = o.unit_id == null ? undefined : byId.get(o.unit_id);
    return !!u && depth(u) >= 1;
  };
  const counted = occurrences.filter((o) => !o.via_interaction);
  const listed = new Set(counted.filter((o) => !inQuadrat(o)).map((o) => o.taxon_id));
  const out = new Map<string, number | null>();
  for (const o of counted) {
    if (!inQuadrat(o) || listed.has(o.taxon_id) || out.has(o.taxon_id)) continue;
    out.set(o.taxon_id, subplotOf(byId.get(o.unit_id as number) as UnitLike));
  }
  return [...out].map(([taxon_id, parentId]) => ({ taxon_id, parentId }));
}
