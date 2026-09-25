/**
 * GLORIA sampling units and measurement points — pure, no RN / DB imports.
 *
 * Source: Pauli et al. 2015, GLORIA Field Manual 5th ed.
 *   - Quadrat codes (p.39 Fig 4.1): direction letter, then column (numbered
 *     left → right when looking toward the summit), then row (bottom → top).
 *     Only the four corner quadrats of each 3×3 m grid are recorded (p.38).
 *   - Summit area sections (p.28): four in the 5-m and four in the 10-m
 *     summit area. Codes follow the Taiwan sheet (`N05`, `N10`), not the
 *     manual's `N-5m-SA`.
 *   - 10×10 m squares (p.57): one per cardinal direction, centred on the
 *     lower corner of the 3×3 m grid that lies on the principal measurement
 *     line — i.e. the p5m point.
 *   - Measurement points (Form 1 notes 5–7, and sheet 02_): per direction
 *     the four outer corners of the 3×3 m grid plus the 10-m point, and two
 *     points (5 m / 10 m) on each of the four intersection lines. Exactly one
 *     of the two lower corners (11 / 31) lies on the principal line: "p5m-N11
 *     or p5m-N31, both are not possible".
 */

export const DIRECTIONS = ['N', 'E', 'S', 'W'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DIAGONALS = ['NE', 'SE', 'SW', 'NW'] as const;
export type Diagonal = (typeof DIAGONALS)[number];

/** Corner quadrat positions in sheet order (02_ lists 11, 31, 33, 13). */
export const CORNERS = ['11', '31', '33', '13'] as const;
export type Corner = (typeof CORNERS)[number];

/** Which lower corner is the p5m point. */
export type P5mCorner = '11' | '31';

export type UnitType = 'quadrat' | 'sas' | 'square';

export const QUADRAT_CODES: readonly string[] = DIRECTIONS.flatMap((d) => CORNERS.map((c) => d + c));
export const SAS_CODES: readonly string[] = [
  ...DIRECTIONS.map((d) => `${d}05`),
  ...DIRECTIONS.map((d) => `${d}10`),
];
/** A 10×10 m square is identified by its direction alone, as in sheet 31_/32_. */
export const SQUARE_CODES: readonly string[] = [...DIRECTIONS];

export type UnitDef = { code: string; type: UnitType; direction: Direction };

/** All 28 units of one summit survey, in display order. */
export const ALL_UNITS: readonly UnitDef[] = [
  ...QUADRAT_CODES.map((code) => ({ code, type: 'quadrat' as const, direction: code[0] as Direction })),
  ...SAS_CODES.map((code) => ({ code, type: 'sas' as const, direction: code[0] as Direction })),
  ...SQUARE_CODES.map((code) => ({ code, type: 'square' as const, direction: code as Direction })),
];

export function unitTypeOf(code: string): UnitType | null {
  if (QUADRAT_CODES.includes(code)) return 'quadrat';
  if (SAS_CODES.includes(code)) return 'sas';
  if (SQUARE_CODES.includes(code)) return 'square';
  return null;
}

/** The four quadrats of one direction (also the four inside that 10×10 square). */
export function quadratsOf(direction: Direction): string[] {
  return CORNERS.map((c) => direction + c);
}

/** Upper (5-m) SAS a quadrat lies in; its species list must contain the quadrat's (p.42). */
export function upperSasOf(quadratCode: string): string {
  return `${quadratCode[0]}05`;
}

/** Grid position inside the 3×3 m cluster: col 1..3 (left → right facing
 *  the summit), row 1..3 (bottom → top). */
export function quadratCell(code: string): { col: number; row: number } {
  return { col: Number(code[1]), row: Number(code[2]) };
}

// ── Measurement points (sheet 02_) ────────────────────────────────────────

export type PointLine = 'main line' | 'intersection line';

/**
 * A stable key per point that does not depend on the p5m choice, so a p5m
 * correction never renames the row. `pointNumber` (the sheet's label) is
 * derived with `pointNumberOf`.
 */
export type PointDef = {
  key: string; // 'N11' | 'N10m' | 'NE5' | 'NE10'
  direction: Direction | Diagonal;
  line: PointLine;
  /** Quadrat this corner belongs to (sheet `quadrat1x1`), null otherwise. */
  quadrat: string | null;
};

/** The 28 points of one survey, in sheet 02_ order. */
export const POINTS: readonly PointDef[] = [
  ...DIRECTIONS.flatMap((d): PointDef[] => [
    ...CORNERS.map((c) => ({ key: d + c, direction: d, line: 'main line' as const, quadrat: d + c })),
    { key: `${d}10m`, direction: d, line: 'main line', quadrat: null },
  ]),
  ...DIAGONALS.flatMap((g): PointDef[] => [
    { key: `${g}5`, direction: g, line: 'intersection line', quadrat: null },
    { key: `${g}10`, direction: g, line: 'intersection line', quadrat: null },
  ]),
];

/** Sheet `pointNumber`: p5m-N31 / p-N11 / p10m-N / pNE-5. */
export function pointNumberOf(key: string, p5m: Partial<Record<Direction, P5mCorner>>): string {
  const diag = /^(NE|SE|SW|NW)(5|10)$/.exec(key);
  if (diag) return `p${diag[1]}-${diag[2]}`;
  const ten = /^([NESW])10m$/.exec(key);
  if (ten) return `p10m-${ten[1]}`;
  const d = key[0] as Direction;
  return `${p5m[d] === key.slice(1) ? 'p5m' : 'p'}-${key}`;
}
