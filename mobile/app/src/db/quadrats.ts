/**
 * Fixed-plot quadrats on the app's connection. The rules live in
 * quadratsCore.ts (tested under node); this file binds them to the user DB,
 * the clock and uuid generation, and keeps taxon names readable offline.
 */
import { getUserDb, withTransaction } from './init';
import { addPlotSpecies, type FixedLayer } from './plots';
import { ensureTaxonSelfSufficient } from './taxonCache';
import { generateUuid } from './uuid';
import { EMPTY_TAXON_FIELDS, resolveTaxa, type TaxonFields } from './taxonLookup';
import * as core from './quadratsCore';
import type { QuadratDocInput } from '~/lib/quadratYaml';

export {
  DEFAULT_QUADRAT_CONFIG,
  MAX_GRID_N,
  MAX_QUADRATS,
  MIN_GRID_N,
  MIN_QUADRATS,
  QuadratError,
  SURFACE_COLUMNS,
  TOP_EDGES,
  parseQuadratConfig,
  positionFor,
  type FreqMode,
  type Quadrat,
  type QuadratConfig,
  type QuadratLayout,
  type QuadratPatch,
  type QuadratSpecies,
  type QuadratSpeciesPatch,
  type SurfaceColumn,
  type TopEdge,
} from './quadratsCore';

/** The layer quadrat species join the plot list in (§3.2 "加入草本層"). */
export const QUADRAT_HERB_LAYER: FixedLayer = 'E2';

const db = () => getUserDb();

export const getQuadratConfig = (plotId: number) => core.getQuadratConfig(db(), plotId);
export const setQuadratConfig = (plotId: number, patch: Partial<core.QuadratConfig>) =>
  core.setQuadratConfig(db(), plotId, patch, Date.now());
export const listQuadrats = (plotId: number) => core.listQuadrats(db(), plotId);
export const getQuadrat = (id: number) => core.getQuadrat(db(), id);
export const quadratHasData = (id: number) => core.quadratHasData(db(), id);
export const gridChangeable = (plotId: number) => core.gridChangeable(db(), plotId);
export const addQuadrat = (plotId: number) => core.addQuadrat(db(), plotId, generateUuid(), Date.now());
/** Returns the quadrats that stayed because they hold data. */
export const setQuadratCount = (plotId: number, count: number) =>
  withTransaction(() => core.setQuadratCount(db(), plotId, count, Date.now(), generateUuid));
export const updateQuadrat = (id: number, patch: core.QuadratPatch) => core.updateQuadrat(db(), id, patch, Date.now());
export const setQuadratLocked = (id: number, locked: boolean) => core.setQuadratLocked(db(), id, locked, Date.now());
export const setFreqMode = (id: number, mode: core.FreqMode) => core.setFreqMode(db(), id, mode, Date.now());
export const deleteQuadrat = (id: number) => withTransaction(() => core.deleteQuadrat(db(), id, Date.now()));
export const listQuadratSpecies = (quadratId: number) => core.listQuadratSpecies(db(), quadratId);
export const updateQuadratSpecies = (id: number, patch: core.QuadratSpeciesPatch) =>
  core.updateQuadratSpecies(db(), id, patch, Date.now());
export const deleteQuadratSpecies = (id: number) => core.deleteQuadratSpecies(db(), id, Date.now());
export const quadratTaxaNotInPlot = (plotId: number) => core.quadratTaxaNotInPlot(db(), plotId);

export function addQuadratSpecies(quadratId: number, taxonId: string): number {
  ensureTaxonSelfSufficient(taxonId);
  return core.addQuadratSpecies(db(), quadratId, taxonId, Date.now());
}

/** Add the quadrat taxa missing from the plot list to a layer (the herb
 *  layer unless the plot has fewer layers), names only. */
export function addQuadratTaxaToPlot(plotId: number, layer: FixedLayer = QUADRAT_HERB_LAYER): number {
  const missing = quadratTaxaNotInPlot(plotId);
  withTransaction(() => {
    for (const taxon_id of missing) addPlotSpecies({ plot_survey_id: plotId, taxon_id, layer });
  });
  return missing.length;
}

/** Settings change from the environment tab: stored, then the layout and the
 *  new-quadrat geometry are applied to the quadrats that can take them.
 *  Returns how many quadrats kept their geometry because they hold data. */
export function changeQuadratConfig(plotId: number, patch: Partial<core.QuadratConfig>): number {
  return withTransaction(() => {
    const now = Date.now();
    // The grid is shared by every quadrat: it changes only before any frequency data.
    if (patch.gridN != null && patch.gridN !== core.getQuadratConfig(db(), plotId).gridN && !core.gridChangeable(db(), plotId)) {
      throw new core.QuadratError('geometry-locked');
    }
    // The plot grid likewise, before any species record has frequency data.
    if (patch.freqGridN != null && patch.freqGridN !== core.getQuadratConfig(db(), plotId).freqGridN && !core.plotFreqChangeable(db(), plotId)) {
      throw new core.QuadratError('geometry-locked');
    }
    core.setQuadratConfig(db(), plotId, patch, now);
    if ('layout' in patch) core.applyLayout(db(), plotId, now);
    return 'sizeM' in patch || 'gridN' in patch || 'topEdge' in patch ? core.applyGeometryDefaults(db(), plotId, now) : 0;
  });
}

export const switchFreqMode = (id: number, mode: core.FreqMode) => core.switchFreqMode(db(), id, mode, Date.now());
export const previousQuadratTaxa = (plotId: number, idx: number) => core.previousQuadratTaxa(db(), plotId, idx);

export type QuadratSpeciesWithTaxon = core.QuadratSpecies & TaxonFields;

/** A quadrat's species with their names, in the order they were added. */
export function listQuadratSpeciesWithTaxon(quadratId: number): QuadratSpeciesWithTaxon[] {
  const rows = core.listQuadratSpecies(db(), quadratId);
  const taxa = resolveTaxa(rows.map((r) => r.taxon_id));
  return rows.map((r) => ({ ...(taxa.get(r.taxon_id) ?? EMPTY_TAXON_FIELDS), ...r }));
}

/** Layout change: one per subplot also brings the count to the subplots'. */
export function changeQuadratLayout(plotId: number, layout: core.QuadratLayout): core.Quadrat[] {
  return withTransaction(() => {
    const now = Date.now();
    core.setQuadratConfig(db(), plotId, { layout }, now);
    let kept: core.Quadrat[] = [];
    if (layout === 'perSubplot') {
      const n = (db().executeSync(`SELECT COUNT(*) AS n FROM plot_subplots WHERE plot_survey_id = ?`, [plotId]).rows?.[0] as { n: number }).n;
      if (n > 0) kept = core.setQuadratCount(db(), plotId, n, now, generateUuid);
    }
    core.applyLayout(db(), plotId, now);
    return kept;
  });
}

/** Turn the module on; the first time, quadrats are created for the layout. */
export function enableQuadrats(plotId: number, on: boolean): void {
  withTransaction(() => {
    const now = Date.now();
    const cfg = core.setQuadratConfig(db(), plotId, { enabled: on }, now);
    if (!on || core.listQuadrats(db(), plotId).length > 0) return;
    const subplots = (db().executeSync(`SELECT COUNT(*) AS n FROM plot_subplots WHERE plot_survey_id = ?`, [plotId]).rows?.[0] as { n: number }).n;
    core.setQuadratCount(db(), plotId, cfg.layout === 'perSubplot' && subplots > 0 ? subplots : 5, now, generateUuid);
  });
}

/** The plot's quadrats with their species, as the yml builder takes them. */
export function quadratsForDoc(plotId: number): QuadratDocInput[] {
  return core.listQuadrats(db(), plotId).map((q) => ({ ...q, species: listQuadratSpeciesWithTaxon(q.id) }));
}

export const plotFreqChangeable = (plotId: number) => core.plotFreqChangeable(db(), plotId);
export const setPlotSpeciesFreq = (recordId: number, patch: { freq_cells?: string | null; freq_count?: number | null }) =>
  core.setPlotSpeciesFreq(db(), recordId, patch, Date.now());
export const switchPlotFreqMode = (plotId: number, mode: core.FreqMode) =>
  withTransaction(() => core.switchPlotFreqMode(db(), plotId, mode, Date.now()));
