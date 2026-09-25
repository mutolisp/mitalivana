/**
 * Summit overview drawn as in manual Fig. 5.4: the 5-m (dashed) and 10-m
 * summit areas as diamonds with their corners on the N/E/S/W principal lines,
 * cut into eight sections by the intersection lines. Each 3×3 m cluster is
 * drawn with its p5m corner on the 5-m line, rotated so its rows run
 * uphill (quadrat 11 = lower left seen from below the cluster).
 *
 * Zoom: two fingers pinch (1–4×, around the fingers) and move the view; the
 * ＋ / − / reset buttons do the same one-handed. One finger is left to the
 * page's own scrolling. Zooming changes the SVG viewBox, so lines and labels
 * are redrawn sharp at every size, and every unit stays tappable.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { CORNERS, DIRECTIONS, type Direction, type P5mCorner } from '../model/units';
import { STATUS_COLOR, type UnitStatus } from '../useSurvey';

const VERTEX: Record<Direction, [number, number]> = { N: [150, 66], E: [234, 150], S: [150, 234], W: [66, 150] };
const OUT: Record<Direction, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
// Label centres (32×16 boxes). A cluster takes 39×39 next to its vertex on
// either side of the principal line, depending on where p5m is, so the 05
// labels sit on the principal line between HSP and the cluster, and the 10
// labels clear both possible cluster positions.
const SAS_LABEL: Array<[string, number, number]> = [
  ['N05', 150, 120], ['N10', 192, 58], ['E05', 178, 150], ['E10', 246, 201],
  ['S05', 150, 180], ['S10', 108, 250], ['W05', 122, 150], ['W10', 54, 99],
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
  /** True while two fingers are on the drawing — the page should stop scrolling. */
  onInteract?: (active: boolean) => void;
};

const FULL = 300;
const MIN_SIZE = FULL / 4; // 4× at most
type ViewBox = { x: number; y: number; s: number };
const HOME: ViewBox = { x: 0, y: 0, s: FULL };

function clampView(v: ViewBox): ViewBox {
  const s = Math.min(FULL, Math.max(MIN_SIZE, v.s));
  return { s, x: Math.min(FULL - s, Math.max(0, v.x)), y: Math.min(FULL - s, Math.max(0, v.y)) };
}

export function SummitSchematic({ p5m, statusOf, onUnit, onCluster, onInteract }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<ViewBox>(HOME);
  const [width, setWidth] = useState(0);
  // Gesture state lives in refs: callbacks run on the JS thread (runOnJS)
  // and must see the view as it was when the gesture began.
  const base = useRef<ViewBox>(HOME);
  const focal = useRef({ x: 0, y: 0 });
  const pinching = useRef(false);
  const unitsPerPx = (v: ViewBox) => (width > 0 ? v.s / width : 1);

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart((e) => {
      pinching.current = true;
      base.current = view;
      const k = unitsPerPx(view);
      // The drawing point under the fingers stays under them.
      focal.current = { x: view.x + e.focalX * k, y: view.y + e.focalY * k };
      onInteract?.(true);
    })
    .onUpdate((e) => {
      const s = base.current.s / e.scale;
      const k = width > 0 ? s / width : 1;
      setView(clampView({ s, x: focal.current.x - e.focalX * k, y: focal.current.y - e.focalY * k }));
    })
    .onFinalize(() => {
      pinching.current = false;
      onInteract?.(false);
    });
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minPointers(2)
    .onStart(() => {
      base.current = view;
      onInteract?.(true);
    })
    .onUpdate((e) => {
      if (pinching.current) return;
      const k = unitsPerPx(base.current);
      setView(clampView({ ...base.current, x: base.current.x - e.translationX * k, y: base.current.y - e.translationY * k }));
    })
    .onFinalize(() => onInteract?.(false));
  const zoomBy = (f: number) =>
    setView((v) => {
      const s = v.s / f;
      return clampView({ s, x: v.x + v.s / 2 - s / 2, y: v.y + v.s / 2 - s / 2 });
    });
  const zoomed = view.s < FULL - 0.5;

  const dark = useColorScheme().colorScheme === 'dark';
  const ink = dark ? '#f3f4f6' : '#111827';
  const faint = dark ? '#4b5563' : '#d1d5db';
  const mute = dark ? '#9ca3af' : '#6b7280';
  const paper = dark ? '#111827' : '#ffffff';
  const axis = dark ? '#d1d5db' : '#374151';

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan)}>
    <View collapsable={false}>
    <Svg viewBox={`${view.x} ${view.y} ${view.s} ${view.s}`} width="100%" style={{ aspectRatio: 1 }}>
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
        const lift = d === 'E' || d === 'W' ? (mid[1] < 150 ? 13 : -9) : 0;
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
            {/* On E / W the label would sit on the horizontal principal line:
                move it off the line to the side the cluster is NOT on (with
                p5m E11 the cluster is above the line, so the label goes below),
                and give every label a paper backing. */}
            <Rect
              x={lp[0] - 23}
              y={lp[1] + lift - 5}
              width={46}
              height={11}
              rx={3}
              fill={paper}
              fillOpacity={0.9}
            />
            <SvgText
              x={lp[0]}
              y={lp[1] + lift + 3}
              fontSize={9}
              fontWeight="700"
              fill="#00797b"
              textAnchor="middle"
            >
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
    </View>
    </GestureDetector>
      <View className="absolute right-1 top-1 flex-row gap-1">
        {[
          { icon: 'add' as const, label: t('gloria.zoom.in'), on: () => zoomBy(1.5), off: view.s <= MIN_SIZE + 0.5 },
          { icon: 'remove' as const, label: t('gloria.zoom.out'), on: () => zoomBy(1 / 1.5), off: !zoomed },
          { icon: 'scan-outline' as const, label: t('gloria.zoom.reset'), on: () => setView(HOME), off: !zoomed },
        ].map((b) => (
          <Pressable
            key={b.icon}
            onPress={b.on}
            disabled={b.off}
            accessibilityRole="button"
            accessibilityLabel={b.label}
            hitSlop={4}
            className={`h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-white/90 dark:border-gray-600 dark:bg-gray-900/90 ${b.off ? 'opacity-40' : ''}`}
          >
            <Ionicons name={b.icon} size={16} color="#00A2A5" />
          </Pressable>
        ))}
      </View>
    </View>
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
