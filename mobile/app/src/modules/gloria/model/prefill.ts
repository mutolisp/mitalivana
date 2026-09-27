/**
 * What a new survey of a summit carries over from the previous one — pure.
 *
 * Only plot re-establishment data: the measurement points (distance and
 * compass from the HSP), the p5m choice, and each square's walk option.
 *
 * Species lists and every recorded value are NOT carried, and the app shows
 * no previous data while recording. Manual Box 4.5 (p.48): "All standard
 * recording procedures in the 1-m² quadrats and in the summit area sections
 * must be repeated 'blind', i.e. without any aid of old data … Neither the
 * previous plot data such as species lists or cover values, nor photos of
 * the quadrats are used during resurveys." The same box asks teams to bring
 * "the measurement data of plot positions", and p.57 advises repeating the
 * 10×10 m walk "in the same way".
 *
 * Each 1×1 m quadrat's aspect and slope are carried too (the user's call,
 * 2026-09-27): they describe the ground the quadrat sits on, not what grows
 * there, so they are neither a species list nor a cover value.
 */

import type { Direction, P5mCorner } from './units';
import type { WalkOption } from './walk';

export type PrevPoint = {
  key: string;
  distance_m: number | null;
  compass_deg: number | null;
  comments: string | null;
};

export type PrevSurvey = {
  mocy: number;
  p5m: Partial<Record<Direction, P5mCorner>>;
  points: PrevPoint[];
  walkOptions: Array<{ code: string; walk_option: WalkOption | null }>;
  topo?: PrevTopo[];
};

export type PrevTopo = { code: string; aspect_deg: number | null; slope_deg: number | null };

export type PrefillPlan = {
  mocy: number;
  p5m: Partial<Record<Direction, P5mCorner>>;
  points: PrevPoint[];
  walkOptions: Array<{ code: string; walk_option: WalkOption | null }>;
  topo: PrevTopo[];
};

export function planPrefill(prev: PrevSurvey | null): PrefillPlan {
  if (!prev) return { mocy: 1, p5m: {}, points: [], walkOptions: [], topo: [] };
  return {
    mocy: prev.mocy + 1,
    p5m: { ...prev.p5m },
    points: prev.points.map((p) => ({ ...p })),
    walkOptions: prev.walkOptions.filter((w) => w.walk_option != null).map((w) => ({ ...w })),
    topo: (prev.topo ?? []).filter((x) => x.aspect_deg != null || x.slope_deg != null).map((x) => ({ ...x })),
  };
}

/**
 * Aspect / slope to fill into an existing survey's quadrats from an earlier
 * one: only where the quadrat has neither, so nothing typed is overwritten.
 */
export function planTopoFill(
  current: ReadonlyArray<PrevTopo>,
  prev: ReadonlyArray<PrevTopo>,
): Array<{ code: string; aspect_deg: number | null; slope_deg: number | null }> {
  const from = new Map(prev.map((x) => [x.code, x]));
  const out: Array<{ code: string; aspect_deg: number | null; slope_deg: number | null }> = [];
  for (const c of current) {
    const p = from.get(c.code);
    if (!p) continue;
    const aspect = c.aspect_deg == null ? p.aspect_deg : null;
    const slope = c.slope_deg == null ? p.slope_deg : null;
    if (aspect != null || slope != null) out.push({ code: c.code, aspect_deg: aspect, slope_deg: slope });
  }
  return out;
}

/** Next free serial on a roster. */
export function nextSerial(roster: ReadonlyArray<{ serial: number }>): number {
  return roster.reduce((m, t) => Math.max(m, t.serial), 0) + 1;
}
