/**
 * Fixed-plot quadrats on the app's connection. The rules live in
 * quadratsCore.ts (tested under node); this file binds them to the user DB,
 * the clock and uuid generation, and keeps taxon names readable offline.
 */
import { getUserDb, withTransaction } from './init';
import { addPlotSpecies, type FixedLayer } from './plots';
import { ensureTaxonSelfSufficient } from './taxonCache';
import { generateUuid } from './uuid';
import * as core from './quadratsCore';

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

/** Add the quadrat taxa missing from the plot list to its herb layer. */
export function addQuadratTaxaToPlot(plotId: number): number {
  const missing = quadratTaxaNotInPlot(plotId);
  withTransaction(() => {
    for (const taxon_id of missing) addPlotSpecies({ plot_survey_id: plotId, taxon_id, layer: QUADRAT_HERB_LAYER });
  });
  return missing.length;
}
