/**
 * Form 6-S sketch of a 10×10 m walk option: the square as a diamond under
 * the HSP, the principal line through its top and bottom corners, and the
 * start line along its edge with the walking direction (model/walk.ts).
 * With `line`, the line being walked now is drawn too, in its direction.
 */
import type { TFunction } from 'i18next';
import Svg, { Circle, Line, Polygon, Text as SvgText } from 'react-native-svg';
import { SQUARE_N } from '../model/grid';
import { WALK_OPTION_INFO, type WalkOption } from '../model/walk';

const T = { x: 50, y: 20 };
const R = { x: 84, y: 54 };
const B = { x: 50, y: 88 };
const L = { x: 16, y: 54 };
const GREY = '#9ca3af';
const START = '#00A2A5';
const NOW = '#d97706';

/** A point of the square from canonical a (from the lower-left edge) and b (from the lower-right edge), both 0..1. */
const at = (a: number, b: number) => ({ x: B.x + a * (R.x - B.x) + b * (L.x - B.x), y: B.y + a * (R.y - B.y) + b * (L.y - B.y) });

/** The ends of a line across the square, `across` 0..1 on the fixed coordinate, from free 0 to 1 (or back). */
function ends(option: WalkOption, across: number, forward: boolean) {
  const { fixed } = WALK_OPTION_INFO[option];
  const p = (free: number) => (fixed === 'b' ? at(free, across) : at(across, free));
  const [s, e] = [p(0.04), p(0.96)];
  return forward ? { s, e } : { s: e, e: s };
}

function Arrow({ s, e, color, width }: { s: { x: number; y: number }; e: { x: number; y: number }; color: string; width: number }) {
  const len = Math.hypot(e.x - s.x, e.y - s.y) || 1;
  const d = { x: (e.x - s.x) / len, y: (e.y - s.y) / len };
  const n = { x: -d.y, y: d.x };
  const head = `${e.x},${e.y} ${e.x - 8 * d.x + 4.5 * n.x},${e.y - 8 * d.y + 4.5 * n.y} ${e.x - 8 * d.x - 4.5 * n.x},${e.y - 8 * d.y - 4.5 * n.y}`;
  return (
    <>
      <Line x1={s.x} y1={s.y} x2={e.x - 6 * d.x} y2={e.y - 6 * d.y} stroke={color} strokeWidth={width} strokeLinecap="round" />
      <Polygon points={head} fill={color} />
      <Circle cx={s.x} cy={s.y} r={width} fill={color} />
    </>
  );
}

export function WalkDiagram({ option, size = 72, line }: { option: WalkOption; size?: number; line?: number }) {
  const { fromFar } = WALK_OPTION_INFO[option];
  const start = ends(option, fromFar ? 0.97 : 0.03, true);
  let now = null as null | { s: { x: number; y: number }; e: { x: number; y: number } };
  if (line != null && line >= 1 && line <= SQUARE_N) {
    const k = line - 1;
    const pos = (0.25 + 0.5 * (fromFar ? SQUARE_N - 1 - k : k)) / 10; // 0.25 m in, 0.5 m apart (§5.3.1)
    now = ends(option, pos, k % 2 === 0);
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <SvgText x={50} y={11} fontSize={10} fill={GREY} textAnchor="middle" fontWeight="bold">
        HSP
      </SvgText>
      <Line x1={50} y1={13} x2={50} y2={97} stroke={GREY} strokeWidth={1} />
      <Polygon points={`${T.x},${T.y} ${R.x},${R.y} ${B.x},${B.y} ${L.x},${L.y}`} fill="none" stroke={GREY} strokeWidth={1.5} />
      <Arrow s={start.s} e={start.e} color={START} width={3} />
      {now ? <Arrow s={now.s} e={now.e} color={NOW} width={2.5} /> : null}
    </Svg>
  );
}

/** Literal t() calls so check:i18n sees every key. */
export function walkOptionLabel(t: TFunction, o: WalkOption): string {
  switch (o) {
    case 1:
      return t('gloria.square.option1');
    case 2:
      return t('gloria.square.option2');
    case 3:
      return t('gloria.square.option3');
    case 4:
      return t('gloria.square.option4');
  }
}
