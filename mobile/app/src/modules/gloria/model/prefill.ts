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
};

export type PrefillPlan = {
  mocy: number;
  p5m: Partial<Record<Direction, P5mCorner>>;
  points: PrevPoint[];
  walkOptions: Array<{ code: string; walk_option: WalkOption | null }>;
};

export function planPrefill(prev: PrevSurvey | null): PrefillPlan {
  if (!prev) return { mocy: 1, p5m: {}, points: [], walkOptions: [] };
  return {
    mocy: prev.mocy + 1,
    p5m: { ...prev.p5m },
    points: prev.points.map((p) => ({ ...p })),
    walkOptions: prev.walkOptions.filter((w) => w.walk_option != null).map((w) => ({ ...w })),
  };
}

/** Next free serial on a roster. */
export function nextSerial(roster: ReadonlyArray<{ serial: number }>): number {
  return roster.reduce((m, t) => Math.max(m, t.serial), 0) + 1;
}
