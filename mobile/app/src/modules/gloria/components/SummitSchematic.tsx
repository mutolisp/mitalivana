/**
 * Summit overview drawn as in manual Fig. 5.4: the 5-m (dashed) and 10-m
 * summit areas as diamonds with their corners on the N/E/S/W principal lines,
 * cut into eight sections by the intersection lines. Each 3×3 m cluster is
 * drawn with its p5m corner on the 5-m line, rotated so its rows run
 * uphill (quadrat 11 = lower left seen from below the cluster).
 */
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { CORNERS, DIRECTIONS, type Direction, type P5mCorner } from '../model/units';
import { STATUS_COLOR, type UnitStatus } from '../useSurvey';

const VERTEX: Record<Direction, [number, number]> = { N: [150, 66], E: [234, 150], S: [150, 234], W: [66, 150] };
const OUT: Record<Direction, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const SAS_LABEL: Array<[string, number, number]> = [
  ['N05', 186, 118], ['N10', 192, 58], ['E05', 186, 190], ['E10', 246, 196],
  ['S05', 114, 190], ['S10', 108, 250], ['W05', 114, 118], ['W10', 54, 112],
];
const CELL = 13;

// Summit-area geometry (viewBox 300): diamond corners on the principal lines,
// intersection points at the edge midpoints.
const HSP = '150,150';
const P5 = { N: '150,66', E: '234,150', S: '150,234', W: '66,150', NE: '192,108', SE: '192,192', SW: '108,192', NW: '108,108' };
const P10 = { N: '150,14', E: '286,150', S: '150,286', W: '14,150', NE: '218,82', SE: '218,218', SW: '82,218', NW: '82,82' };
const SIDES: Record<Direction, [keyof typeof P5, keyof typeof P5]> = { N: ['NW', 'NE'], E: ['NE', 'SE'], S: ['SE', 'SW'], W: ['SW', 'NW'] };
const SAS_POLYS: Array<[string, string]> = DIRECTIONS.flatMap((d): Array<[string, string]> => {
  const [a, b] = SIDES[d];
  return [
    [`${d}05`, [HSP, P5[a], P5[d], P5[b]].join(' ')],
    [`${d}10`, [P5[a], P10[a], P10[d], P10[b], P5[b], P5[d]].join(' ')],
  ];
});

type Props = {
  p5m: Partial<Record<Direction, P5mCorner>>;
  statusOf: (code: string) => UnitStatus;
  onUnit: (code: string) => void;
  onCluster: (d: Direction) => void;
};

export function SummitSchematic({ p5m, statusOf, onUnit, onCluster }: Props) {
  const dark = useColorScheme().colorScheme === 'dark';
  const ink = dark ? '#f3f4f6' : '#111827';
  const faint = dark ? '#4b5563' : '#d1d5db';
  const mute = dark ? '#9ca3af' : '#6b7280';
  const paper = dark ? '#111827' : '#ffffff';
  const axis = dark ? '#d1d5db' : '#374151';

  return (
    <Svg viewBox="0 0 300 300" width="100%" style={{ aspectRatio: 1 }}>
      {/* Summit area sections (Fig. 3.6, Work Step G): each is bounded by
          the intersection lines to NE / SE / SW / NW and by the 5-m / 10-m
          lines; tinted by status and tappable, so their extent reads at a
          glance. */}
      {SAS_POLYS.map(([code, pts]) => (
        <Polygon
          key={code}
          points={pts}
          fill={STATUS_COLOR[statusOf(code)]}
          fillOpacity={statusOf(code) === 'none' ? 0.06 : 0.16}
          onPress={() => onUnit(code)}
        />
      ))}
      {/* Principal measurement lines HSP → N / E / S / W run through the
          middle of each section — dashed, so they don't read as boundaries. */}
      <G stroke={axis} strokeWidth={1.2} strokeDasharray="5 4" opacity={0.7}>
        <Line x1={150} y1={150} x2={150} y2={14} />
        <Line x1={150} y1={150} x2={286} y2={150} />
        <Line x1={150} y1={150} x2={150} y2={286} />
        <Line x1={150} y1={150} x2={14} y2={150} />
      </G>
      {/* Section boundaries: the two summit-area outlines and the intersection lines. */}
      <G fill="none" stroke={axis} strokeWidth={1.6}>
        <Polygon points="150,14 286,150 150,286 14,150" />
        <Polygon points="150,66 234,150 150,234 66,150" />
        <Line x1={150} y1={150} x2={218} y2={82} />
        <Line x1={150} y1={150} x2={218} y2={218} />
        <Line x1={150} y1={150} x2={82} y2={218} />
        <Line x1={150} y1={150} x2={82} y2={82} />
      </G>
      {SAS_LABEL.map(([code, x, y]) => (
        <G key={code} onPress={() => onUnit(code)}>
          <Rect x={x - 16} y={y - 11} width={32} height={16} rx={4} fill={paper} stroke={STATUS_COLOR[statusOf(code)]} strokeWidth={1.5} />
          <SvgText x={x} y={y + 1} fontSize={9} fill={mute} textAnchor="middle">{code}</SvgText>
        </G>
      ))}
      <Circle cx={150} cy={150} r={4} fill={ink} />
      <SvgText x={150} y={166} fontSize={9} fill={mute} textAnchor="middle">HSP</SvgText>
      {DIRECTIONS.map((d) => {
        const o = OUT[d];
        const f: [number, number] = [-o[0], -o[1]]; // facing the summit
        const rt: [number, number] = [-f[1], f[0]]; // viewer's right
        const corner = p5m[d] ?? '11';
        // Put the p5m corner on the vertex: shift sideways by 1.5 cells, and
        // move the cluster 1.5 cells uphill of the vertex.
        const sh = corner === '11' ? 1.5 * CELL : -1.5 * CELL;
        const c: [number, number] = [VERTEX[d][0] - o[0] * 1.5 * CELL, VERTEX[d][1] - o[1] * 1.5 * CELL];
        const at = (u: number, v: number): [number, number] => [
          c[0] + (u + sh) * rt[0] + v * f[0],
          c[1] + (u + sh) * rt[1] + v * f[1],
        ];
        const mid = at(0, 0);
        const pc = at(corner === '11' ? -1.5 * CELL : 1.5 * CELL, -1.5 * CELL);
        const lp = at(corner === '11' ? -1.5 * CELL : 1.5 * CELL, -1.5 * CELL - 11);
        return (
          <G key={d}>
            <Rect
              x={mid[0] - 1.5 * CELL}
              y={mid[1] - 1.5 * CELL}
              width={3 * CELL}
              height={3 * CELL}
              fill={paper}
              stroke={mute}
              strokeDasharray="2 2"
              onPress={() => onCluster(d)}
            />
            {CORNERS.map((q) => {
              const p = at((Number(q[0]) - 2) * CELL, (Number(q[1]) - 2) * CELL);
              return (
                <Rect
                  key={q}
                  x={p[0] - CELL / 2 + 0.5}
                  y={p[1] - CELL / 2 + 0.5}
                  width={CELL - 1}
                  height={CELL - 1}
                  fill={STATUS_COLOR[statusOf(d + q)]}
                  onPress={() => onUnit(d + q)}
                />
              );
            })}
            <Circle cx={pc[0]} cy={pc[1]} r={3.4} fill={ink} stroke={paper} strokeWidth={1} />
            <SvgText x={lp[0]} y={lp[1] + 3} fontSize={9} fontWeight="700" fill="#00797b" textAnchor="middle">
              {`p5m ${d}${corner}`}
            </SvgText>
          </G>
        );
      })}
      <G fontSize={12} fontWeight="700" fill={ink}>
        <SvgText x={150} y={11} textAnchor="middle">N</SvgText>
        <SvgText x={293} y={154} textAnchor="middle">E</SvgText>
        <SvgText x={150} y={299} textAnchor="middle">S</SvgText>
        <SvgText x={7} y={154} textAnchor="middle">W</SvgText>
      </G>
    </Svg>
  );
}

/**
 * The 3×3 m cluster seen from below, HSP up (Fig. 4.1): corner quadrats
 * highlighted, the four outer corner points named p5m-/p- with their
 * measured distance and bearing, and the p5m corner ringed on the 5-m line.
 */
export function P5mDiagram({
  direction,
  corner,
  measure,
}: {
  direction: Direction;
  corner: P5mCorner;
  measure: (key: string) => { distance: number | null; compass: number | null };
}) {
  const dark = useColorScheme().colorScheme === 'dark';
  const ink = dark ? '#f3f4f6' : '#111827';
  const mute = dark ? '#9ca3af' : '#6b7280';
  // Same light green in both themes; its labels are always dark (below).
  const quad = '#A8D8B9';
  const paper = dark ? '#111827' : '#ffffff';
  const L = 60, T = 34, W = 60;
  const pX = corner === '11' ? L : L + 3 * W;
  const pts: Array<[string, number, number, 'bottom' | 'top']> = [
    ['11', L, T + 3 * W, 'bottom'],
    ['31', L + 3 * W, T + 3 * W, 'bottom'],
    ['13', L, T, 'top'],
    ['33', L + 3 * W, T, 'top'],
  ];
  const cells = [];
  for (let col = 1; col <= 3; col++) {
    for (let row = 1; row <= 3; row++) {
      const x = L + (col - 1) * W;
      const y = T + (3 - row) * W;
      const isCorner = col !== 2 && row !== 2;
      cells.push(
        <G key={`${col}${row}`}>
          <Rect x={x} y={y} width={W} height={W} fill={isCorner ? quad : paper} stroke={mute} strokeWidth={1.2} />
          <SvgText x={x + W / 2} y={y + W / 2 + 5} fontSize={isCorner ? 15 : 13} fontWeight={isCorner ? '800' : '400'} fill={isCorner ? '#111827' : ink} textAnchor="middle">
            {`${direction}${col}${row}`}
          </SvgText>
        </G>,
      );
    }
  }
  return (
    <Svg viewBox="0 0 300 250" width="100%" style={{ aspectRatio: 300 / 250 }}>
      {/* The 5-m contour passes through the p5m corner (Fig. 3.2). */}
      <Path d={`M ${pX - 50} ${T + 3 * W + 22} Q ${pX} ${T + 3 * W - 6} ${pX + 50} ${T + 3 * W + 22}`} fill="none" stroke="#00A2A5" strokeWidth={2} />
      {cells}
      {pts.map(([q, x, y, pos]) => {
        const isP = q === corner;
        const m = measure(direction + q);
        const ty = pos === 'bottom' ? y + 22 : y - 12;
        const tx = x < 150 ? Math.max(4, x - 50) : Math.min(296, x + 50);
        const anchor = x < 150 ? 'start' : 'end';
        return (
          <G key={q}>
            {isP ? <Circle cx={x} cy={y} r={11} fill="none" stroke="#00A2A5" strokeWidth={3} /> : null}
            <Circle cx={x} cy={y} r={6} fill={ink} />
            <SvgText x={tx} y={ty} fontSize={11} fontWeight={isP ? '800' : '600'} fill={isP ? '#00797b' : mute} textAnchor={anchor}>
              {`${isP ? 'p5m' : 'p'}-${direction}${q}`}
            </SvgText>
            <SvgText x={tx} y={ty + (pos === 'bottom' ? 12 : -12)} fontSize={9} fill={mute} textAnchor={anchor}>
              {`${m.distance ?? '—'} m · ${m.compass ?? '—'}°`}
            </SvgText>
          </G>
        );
      })}
      <Line x1={L + 3 * W + 30} y1={T + 2 * W} x2={L + 3 * W + 30} y2={T + W / 2} stroke={ink} strokeWidth={2} />
      <Polygon points={`${L + 3 * W + 25},${T + W / 2 + 6} ${L + 3 * W + 30},${T + W / 2 - 3} ${L + 3 * W + 35},${T + W / 2 + 6}`} fill={ink} />
      <SvgText x={L + 3 * W + 30} y={T + 2 * W + 16} fontSize={10} fontWeight="700" fill={ink} textAnchor="middle">HSP</SvgText>
    </Svg>
  );
}
