/**
 * How big a census's sync blocks are (docs/planned/Modular_survey.md §7.9).
 *
 * One sync object per block. Two server limits bound the choice: the size of
 * one object and the number of objects a team may hold (one per block per
 * device that uploaded it). The defaults mirror the public server's
 * DEFAULT_LIMITS in mobile/sync-worker/src/quota.js — check:stemmap fails if
 * they drift apart.
 *
 * Decided once when a census starts and fixed for it (server objects are named
 * by block). The density and bytes-per-stem inputs are estimates until Phase 1
 * measures real data.
 *
 * Pure: check:stemmap runs it under Node.
 */
export const SYNC_LIMITS = {
  maxObjectBytes: 5 * 1024 * 1024,
  maxTeamObjects: 500,
};

/** Sealed payloads travel as base64url text: 4 bytes per 3. */
export const BASE64_FACTOR = 4 / 3;

/**
 * Bytes one stem takes in a block upload — JSON, deflated, sealed, before
 * base64 (BASE64_FACTOR adds that) — with its merge base, census codes only.
 * Measured 248 B on the 1E test plot (a 1 ha block of 1 233 stems, random
 * uuids, base as large as the rows; 2026-10-02; the Android emulator agreed),
 * plus about 30 % for longer notes and names. check:census-stress fails if a
 * block grows past it. AMS codes are not in Phase 1; measure again when they are.
 */
export const BYTES_PER_STEM = 320;
/**
 * The same with every AMS variable recorded on every stem: measured 828 B on
 * the same 1 ha block (2B, 2026-10-03; each value is its own row with a uuid),
 * plus about 30 % as above. Replaces §7.9's assumed 600 B.
 */
export const BYTES_PER_STEM_AMS = 1100;

/** Bytes a stem takes for a census recording these code sets. */
export function bytesPerStemFor(codesets: readonly string[]): number {
  return codesets.includes('forestgeo-ams-2021') ? BYTES_PER_STEM_AMS : BYTES_PER_STEM;
}
/** Stems per hectare assumed before any census has data (§7.9). */
export const DEFAULT_STEMS_PER_HA = 6000;

export type SyncBlockInput = {
  quadratsX: number;
  quadratsY: number;
  quadratM: number;
  stemsPerHa: number;
  bytesPerStem: number;
  /** Average number of devices that upload each block. */
  devicesPerBlock?: number;
  limits?: { maxObjectBytes: number; maxTeamObjects: number };
  /** Share of maxObjectBytes one block may fill (head-room for the sync base and growth). */
  targetFraction?: number;
  /** Share of maxTeamObjects the census may use. */
  objectFraction?: number;
};

export type SyncBlockChoice = {
  /** Block edge in quadrats; for a whole-plot block, the longer side. */
  edgeQuadrats: number;
  wholePlot: boolean;
  blocks: number;
  estimatedBytes: number;
  estimatedObjects: number;
  /** Even single-quadrat blocks exceed the size target. */
  tooLarge: boolean;
  /** More objects than the team budget: raise the team's limit. */
  overObjectBudget: boolean;
};

export const EDGE_CANDIDATES: readonly number[] = [5, 4, 3, 2, 1];

export function chooseSyncBlock(input: SyncBlockInput): SyncBlockChoice {
  const limits = input.limits ?? SYNC_LIMITS;
  const devices = input.devicesPerBlock ?? 1.5;
  const target = limits.maxObjectBytes * (input.targetFraction ?? 0.4);
  const objectBudget = limits.maxTeamObjects * (input.objectFraction ?? 0.6);
  const haOf = (qx: number, qy: number) => (qx * input.quadratM * qy * input.quadratM) / 10000;
  const bytesFor = (ha: number) => input.stemsPerHa * ha * input.bytesPerStem * BASE64_FACTOR;

  const plotHa = haOf(input.quadratsX, input.quadratsY);
  if (plotHa <= 1) {
    const estimatedBytes = bytesFor(plotHa);
    return {
      edgeQuadrats: Math.max(input.quadratsX, input.quadratsY),
      wholePlot: true,
      blocks: 1,
      estimatedBytes,
      estimatedObjects: devices,
      tooLarge: estimatedBytes > target,
      overObjectBudget: devices > objectBudget,
    };
  }
  let edge = EDGE_CANDIDATES[EDGE_CANDIDATES.length - 1];
  let tooLarge = true;
  for (const k of EDGE_CANDIDATES) {
    if (bytesFor(haOf(k, k)) <= target) {
      edge = k;
      tooLarge = false;
      break;
    }
  }
  const blocks = Math.ceil(input.quadratsX / edge) * Math.ceil(input.quadratsY / edge);
  const estimatedObjects = blocks * devices;
  return {
    edgeQuadrats: edge,
    wholePlot: false,
    blocks,
    estimatedBytes: bytesFor(haOf(edge, edge)),
    estimatedObjects,
    tooLarge,
    overObjectBudget: estimatedObjects > objectBudget,
  };
}
