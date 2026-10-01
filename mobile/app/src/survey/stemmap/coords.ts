/**
 * Stem-map coordinates: plot-wide x,y in metres, x along the plot's columns
 * (eastward when the main bearing is north), y along its rows.
 *
 * Grid and numbering follow Condit (1998) ch. 2.1 (book p.24–25, PDF p.35–36):
 * quadrat `CCRR` = column + row, both from 00 at the corner stake 0000; the
 * 5 × 5 m subquadrats are numbered i,j from 1,1 (column, row). A plot not laid
 * on north uses a main bearing in place of north. Slope distances convert with
 * Condit eq. 2.1.1 (book p.20, PDF p.31): horizontal = slope distance × cos θ.
 *
 * Angles are degrees clockwise from north. The plot's y axis points along its
 * TRUE bearing β: the bearing itself when recorded as true, plus the magnetic
 * declination (east positive) when recorded as magnetic. The app has no
 * geomagnetic model, so the declination is whatever the user entered.
 *
 * Pure: check:stemmap runs it under Node.
 */
export type FrameGeometry = {
  sizeXM: number;
  sizeYM: number;
  quadratM: number;
  subquadratM: number;
  /** Stake 0000 (the bottom-left corner). Null until surveyed. */
  originLat: number | null;
  originLng: number | null;
  bearingDeg: number;
  bearingRef: 'true' | 'magnetic';
  /** Magnetic declination, degrees, east positive. */
  declinationDeg: number;
};

export type XY = { x: number; y: number };

const RAD = Math.PI / 180;
/** Mean Earth radius (m), the value src/components/map/geodesicCircle.ts uses. */
const EARTH_RADIUS_M = 6_371_008.8;
/** Quadrat codes are two digits per axis. */
const MAX_QUADRATS_PER_AXIS = 100;

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;
const isMultiple = (a: number, b: number) => b > 0 && Math.abs(a / b - Math.round(a / b)) < 1e-9;

/** The plot's y-axis direction as a true bearing. */
export function trueBearing(f: FrameGeometry): number {
  return norm360(f.bearingRef === 'true' ? f.bearingDeg : f.bearingDeg + f.declinationDeg);
}

export function quadratCounts(f: FrameGeometry): { cols: number; rows: number; subPerSide: number } {
  return {
    cols: Math.round(f.sizeXM / f.quadratM),
    rows: Math.round(f.sizeYM / f.quadratM),
    subPerSide: Math.round(f.quadratM / f.subquadratM),
  };
}

export type GeometryProblem = 'size_not_multiple' | 'quadrat_not_multiple' | 'too_many_quadrats' | 'not_positive';

export function validateGeometry(f: FrameGeometry): GeometryProblem[] {
  const out: GeometryProblem[] = [];
  if (!(f.sizeXM > 0 && f.sizeYM > 0 && f.quadratM > 0 && f.subquadratM > 0)) return ['not_positive'];
  if (!isMultiple(f.sizeXM, f.quadratM) || !isMultiple(f.sizeYM, f.quadratM)) out.push('size_not_multiple');
  if (!isMultiple(f.quadratM, f.subquadratM)) out.push('quadrat_not_multiple');
  const { cols, rows } = quadratCounts(f);
  if (cols > MAX_QUADRATS_PER_AXIS || rows > MAX_QUADRATS_PER_AXIS) out.push('too_many_quadrats');
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatQuadratCode(col: number, row: number): string {
  return `${pad2(col)}${pad2(row)}`;
}

export function parseQuadratCode(code: string): { col: number; row: number } | null {
  const m = /^(\d{2})(\d{2})$/.exec(code.trim());
  return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
}

/** Subquadrat i,j (1-based, column then row) of a position inside a quadrat. */
export function subquadratOf(localX: number, localY: number, f: FrameGeometry): { i: number; j: number } {
  const n = quadratCounts(f).subPerSide;
  const idx = (v: number) => Math.min(n, Math.max(1, Math.floor(v / f.subquadratM + 1e-9) + 1));
  return { i: idx(localX), j: idx(localY) };
}

export type Located = {
  col: number;
  row: number;
  code: string;
  localX: number;
  localY: number;
  sub: { i: number; j: number };
  inside: boolean;
};

/** The quadrat, local position and subquadrat of a plot-wide point. A point on
 *  a shared edge belongs to the quadrat above / to the right, except on the
 *  plot's own far edges, which stay in the last quadrat. */
export function locate(p: XY, f: FrameGeometry): Located {
  const { cols, rows } = quadratCounts(f);
  const inside = p.x >= -1e-9 && p.y >= -1e-9 && p.x <= f.sizeXM + 1e-9 && p.y <= f.sizeYM + 1e-9;
  const cell = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v / f.quadratM + 1e-9)));
  const col = cell(p.x, cols);
  const row = cell(p.y, rows);
  const localX = p.x - col * f.quadratM;
  const localY = p.y - row * f.quadratM;
  return { col, row, code: formatQuadratCode(col, row), localX, localY, sub: subquadratOf(localX, localY, f), inside };
}

/** Quadrat code + position inside it → plot-wide x,y. */
export function fromGrid(code: string, localX: number, localY: number, f: FrameGeometry): (XY & { warnings: string[] }) | null {
  const q = parseQuadratCode(code);
  if (!q) return null;
  const { cols, rows } = quadratCounts(f);
  const warnings: string[] = [];
  if (q.col >= cols || q.row >= rows) warnings.push('quadrat_outside_plot');
  if (localX < 0 || localY < 0 || localX > f.quadratM || localY > f.quadratM) warnings.push('local_outside_quadrat');
  return { x: q.col * f.quadratM + localX, y: q.row * f.quadratM + localY, warnings };
}

export type StakeCorner = 'SW' | 'NW' | 'NE' | 'SE';

/** A quadrat corner stake. Corners are in plot-axis terms (N = along y). */
export function stakeXY(code: string, corner: StakeCorner, f: FrameGeometry): XY | null {
  const q = parseQuadratCode(code);
  if (!q) return null;
  const dx = corner === 'NE' || corner === 'SE' ? 1 : 0;
  const dy = corner === 'NW' || corner === 'NE' ? 1 : 0;
  return { x: (q.col + dx) * f.quadratM, y: (q.row + dy) * f.quadratM };
}

/** Horizontal distance from a distance taped along the ground at slope θ. */
export function horizontalDistance(distanceM: number, slopeDeg: number | null): number {
  return slopeDeg == null ? distanceM : distanceM * Math.cos(slopeDeg * RAD);
}

/** Distance + azimuth from a reference point. A compass reading is magnetic. */
export function fromPolar(
  ref: XY,
  distanceM: number,
  azimuthDeg: number,
  azimuthRef: 'magnetic' | 'true',
  slopeDeg: number | null,
  f: FrameGeometry,
): XY {
  const trueAz = azimuthRef === 'magnetic' ? azimuthDeg + f.declinationDeg : azimuthDeg;
  const alpha = (trueAz - trueBearing(f)) * RAD;
  const h = horizontalDistance(distanceM, slopeDeg);
  return { x: ref.x + h * Math.sin(alpha), y: ref.y + h * Math.cos(alpha) };
}

/** GPS → plot x,y: local equirectangular metres around stake 0000, rotated
 *  onto the plot axes. Null without a surveyed origin. */
export function fromGps(lat: number, lng: number, f: FrameGeometry): XY | null {
  if (f.originLat == null || f.originLng == null) return null;
  const east = (lng - f.originLng) * RAD * EARTH_RADIUS_M * Math.cos(f.originLat * RAD);
  const north = (lat - f.originLat) * RAD * EARTH_RADIUS_M;
  const b = trueBearing(f) * RAD;
  return { x: east * Math.cos(b) - north * Math.sin(b), y: east * Math.sin(b) + north * Math.cos(b) };
}

/** Plot x,y → GPS (the inverse of fromGps). */
export function toLatLng(p: XY, f: FrameGeometry): { lat: number; lng: number } | null {
  if (f.originLat == null || f.originLng == null) return null;
  const b = trueBearing(f) * RAD;
  const east = p.x * Math.cos(b) + p.y * Math.sin(b);
  const north = -p.x * Math.sin(b) + p.y * Math.cos(b);
  return {
    lat: f.originLat + north / EARTH_RADIUS_M / RAD,
    lng: f.originLng + east / (EARTH_RADIUS_M * Math.cos(f.originLat * RAD)) / RAD,
  };
}
