/**
 * Stem map (design 13b; Modular_survey.md §7.7): circles of area ∝ basal area
 * at the trees' plot x,y — y up along the plot's main bearing, so the SVG's y
 * is flipped.
 *
 * - One Tap gesture turns the touch into plot coordinates: the nearest circle
 *   within reach is picked, empty ground inside the current quadrat asks to
 *   add a tree there. Shapes handle no presses (svg 點擊 trap: an unfilled
 *   shape still hit-tests by area on Android), so the Svg takes no touches.
 * - Pinch and drag zoom and move the view; only trees inside it are drawn.
 *   When more than MAX_DRAWN would show, the quadrats are drawn instead,
 *   shaded by progress, and a tap opens one.
 * - Colours are theme tokens (check:palette baseline 0).
 */
import { memo, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';
import type { TreeState } from '~/survey/db/stemmapCore';
import { fgQuadratCounts, formatFgQuadratCode, parseFgQuadratCode, type FrameGeometry } from '~/survey/stemmap/coords';
import type { TreeChip } from '~/survey/stemmap/review';
import { useThemeColors } from '~/theme/colors';

/** Above this many trees in view the quadrat overview is drawn instead. */
const MAX_DRAWN = 1500;
/** Tag labels only when this few trees are in view. */
const MAX_LABELLED = 160;
/** Reach of a tap, in screen points. */
const TOUCH_PT = 22;
/** Smallest circle, in screen points (seedlings stay visible). */
const MIN_R_PT = 2.5;

export type MapMode = 'quadrat' | 'whole';

/** What must be visible: a centre and the extents (m) to fit in both directions. */
type View2 = { cx: number; cy: number; w: number; h: number };

export type StemMapProps = {
  geometry: FrameGeometry;
  states: readonly TreeState[];
  quadrat: string;
  mode: MapMode;
  /** Chips of the current quadrat's trees (problems are known only there). */
  chips: ReadonlyMap<number, TreeChip>;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Empty ground tapped inside the current quadrat (plot x,y). */
  onAddAt: (p: { x: number; y: number }) => void;
  /** A quadrat tapped in the overview. */
  onPickQuadrat: (code: string) => void;
};

const radiusM = (d2: number) => Math.sqrt(d2) / 25;

function homeView(g: FrameGeometry, mode: MapMode, quadrat: string): View2 {
  if (mode === 'whole') return { cx: g.sizeXM / 2, cy: g.sizeYM / 2, w: g.sizeXM * 1.04, h: g.sizeYM * 1.04 };
  const q = parseFgQuadratCode(quadrat) ?? { col: 0, row: 0 };
  return { cx: (q.col + 0.5) * g.quadratM, cy: (q.row + 0.5) * g.quadratM, w: g.quadratM * 1.15, h: g.quadratM * 1.15 };
}

export function StemMap(props: StemMapProps) {
  const { geometry: g, mode, quadrat } = props;
  const { t } = useTranslation();
  const c = useThemeColors();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View2>(() => homeView(g, mode, quadrat));
  const [moving, setMoving] = useState(false);
  // Reset the view when the quadrat or the mode changes (state adjusted
  // during render, not in an effect, so no frame shows the old view).
  const key = `${mode}:${quadrat}:${g.sizeXM}x${g.sizeYM}`;
  const [viewKey, setViewKey] = useState(key);
  if (viewKey !== key) {
    setViewKey(key);
    setView(homeView(g, mode, quadrat));
  }

  // The view fits both extents into the box, whatever its shape (it changes
  // height when the tree card opens).
  const fit = (v: View2) => {
    const ew = size.w > 0 && size.h > 0 ? Math.max(v.w, (v.h * size.w) / size.h) : v.w;
    return { ew, eh: size.w > 0 ? (ew * size.h) / size.w : v.h };
  };
  const { ew, eh: viewH } = fit(view);
  const pxPerM = size.w > 0 ? size.w / ew : 1;
  const x0 = view.cx - ew / 2;
  const y0 = view.cy - viewH / 2; // plot y of the bottom edge
  const toPlot = (px: number, py: number) => ({ x: x0 + px / pxPerM, y: y0 + viewH - py / pxPerM });

  const inView = useMemo(() => {
    const pad = 3;
    return props.states.filter((s) => s.x >= x0 - pad && s.x <= x0 + ew + pad && s.y >= y0 - pad && s.y <= y0 + viewH + pad);
  }, [props.states, x0, y0, ew, viewH]);
  const overview = inView.length > MAX_DRAWN;

  // Pinch / drag: the view follows; start values captured at gesture start.
  const start = useRef({ view, fx: 0, fy: 0 });
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart((e) => {
      start.current = { view, fx: e.focalX, fy: e.focalY };
      setMoving(true);
    })
    .onUpdate((e) => {
      const s = start.current;
      const k = Math.min(Math.max(1 / e.scale, g.subquadratM / s.view.w), (Math.max(g.sizeXM, g.sizeYM) * 1.5) / s.view.w);
      // Keep the plot point under the fingers where it was.
      const f0 = fit(s.view);
      const fx = s.view.cx - f0.ew / 2 + (s.fx * f0.ew) / size.w;
      const fy = s.view.cy + f0.eh / 2 - (s.fy * f0.ew) / size.w;
      setView({ cx: fx + (s.view.cx - fx) * k, cy: fy + (s.view.cy - fy) * k, w: s.view.w * k, h: s.view.h * k });
    })
    .onEnd(() => setMoving(false));
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(8)
    .onStart(() => {
      start.current = { view, fx: 0, fy: 0 };
      setMoving(true);
    })
    .onUpdate((e) => {
      const s = start.current;
      const k = fit(s.view).ew / Math.max(size.w, 1);
      setView({ ...s.view, cx: s.view.cx - e.translationX * k, cy: s.view.cy + e.translationY * k });
    })
    .onEnd(() => setMoving(false));
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e, ok) => {
      if (!ok || size.w === 0) return;
      const p = toPlot(e.x, e.y);
      if (overview) {
        const { cols, rows } = fgQuadratCounts(g);
        const col = Math.floor(p.x / g.quadratM);
        const row = Math.floor(p.y / g.quadratM);
        if (col >= 0 && row >= 0 && col < cols && row < rows) props.onPickQuadrat(formatFgQuadratCode(col, row));
        return;
      }
      const reach = TOUCH_PT / pxPerM;
      let best: TreeState | null = null;
      let bestD = Infinity;
      for (const s of inView) {
        const d = Math.hypot(s.x - p.x, s.y - p.y) - radiusM(s.d2);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best && bestD <= reach) {
        props.onSelect(best.id);
        return;
      }
      const q = parseFgQuadratCode(quadrat);
      const inQuadrat =
        q != null && p.x >= q.col * g.quadratM && p.x <= (q.col + 1) * g.quadratM && p.y >= q.row * g.quadratM && p.y <= (q.row + 1) * g.quadratM;
      if (props.selectedId != null) props.onSelect(null);
      else if (inQuadrat) props.onAddAt({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
    });
  const gesture = Gesture.Race(Gesture.Simultaneous(pinch, pan), tap);

  const zoom = (factor: number) =>
    setView((v) => {
      const k = Math.min(Math.max(factor, g.subquadratM / v.w), (Math.max(g.sizeXM, g.sizeYM) * 1.5) / v.w);
      return { ...v, w: v.w * k, h: v.h * k };
    });
  const home = homeView(g, mode, quadrat);
  const moved = Math.abs(view.w - home.w) > 0.01 || Math.abs(view.cx - home.cx) > 0.01 || Math.abs(view.cy - home.cy) > 0.01;

  const onLayout = (e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const svgY = (y: number) => g.sizeYM - y;
  const viewBox = `${x0} ${svgY(y0 + viewH)} ${ew} ${viewH}`;
  const unit = 1 / pxPerM; // one screen point, in metres

  return (
    <View className="flex-1 overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark" onLayout={onLayout}>
      <GestureDetector gesture={gesture}>
        <View className="flex-1" collapsable={false}>
          {size.w > 0 ? (
            <Svg width={size.w} height={size.h} viewBox={viewBox} pointerEvents="none">
              <Grid g={g} unit={unit} c={c} quadrat={quadrat} showSub={ew <= g.quadratM * 3} />
              {overview ? (
                <Overview g={g} states={props.states} c={c} />
              ) : (
                <Trees
                  trees={inView}
                  chips={props.chips}
                  selectedId={props.selectedId}
                  sizeY={g.sizeYM}
                  unit={unit}
                  labels={!moving && inView.length <= MAX_LABELLED}
                  c={c}
                />
              )}
            </Svg>
          ) : null}
        </View>
      </GestureDetector>
      <View className="absolute bottom-2 right-2 gap-1.5" pointerEvents="box-none">
        {moved ? <MapButton label={t('survey.map.home')} glyph="⌂" onPress={() => setView(home)} /> : null}
        <MapButton label={t('survey.map.zoomIn')} glyph="＋" onPress={() => zoom(0.7)} />
        <MapButton label={t('survey.map.zoomOut')} glyph="－" onPress={() => zoom(1 / 0.7)} />
      </View>
      {overview ? (
        <View className="absolute left-2 top-2 rounded-lg bg-card/90 px-2 py-1 dark:bg-card-dark/90" pointerEvents="none">
          <Text className="text-xs text-ink-2 dark:text-gray-300">{t('survey.map.overview')}</Text>
        </View>
      ) : null}
    </View>
  );
}

function MapButton({ label, glyph, onPress }: { label: string; glyph: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="h-10 w-10 items-center justify-center rounded-full border border-line bg-card active:opacity-70 dark:border-line-dark dark:bg-card-dark"
    >
      <Text className="text-lg text-ink dark:text-gray-100">{glyph}</Text>
    </Pressable>
  );
}

type Colors = ReturnType<typeof useThemeColors>;

/** Quadrat lines (and subquadrat lines when zoomed in); the current quadrat outlined. */
const Grid = memo(function Grid({ g, unit, c, quadrat, showSub }: { g: FrameGeometry; unit: number; c: Colors; quadrat: string; showSub: boolean }) {
  const { cols, rows } = fgQuadratCounts(g);
  const parts: string[] = [];
  if (showSub) {
    for (let x = 0; x <= g.sizeXM + 1e-9; x += g.subquadratM) parts.push(`M${x} 0V${g.sizeYM}`);
    for (let y = 0; y <= g.sizeYM + 1e-9; y += g.subquadratM) parts.push(`M0 ${y}H${g.sizeXM}`);
  }
  const major: string[] = [];
  for (let i = 0; i <= cols; i++) major.push(`M${i * g.quadratM} 0V${g.sizeYM}`);
  for (let j = 0; j <= rows; j++) major.push(`M0 ${j * g.quadratM}H${g.sizeXM}`);
  const q = parseFgQuadratCode(quadrat);
  return (
    <>
      <Rect x={0} y={0} width={g.sizeXM} height={g.sizeYM} fill={c.paper} />
      {parts.length ? <Path d={parts.join('')} stroke={c.line} strokeWidth={0.6 * unit} /> : null}
      <Path d={major.join('')} stroke={c.outline} strokeWidth={unit} />
      <Rect x={0} y={0} width={g.sizeXM} height={g.sizeYM} fill="none" stroke={c.cupule} strokeWidth={1.4 * unit} />
      {q ? (
        <Rect
          x={q.col * g.quadratM}
          y={g.sizeYM - (q.row + 1) * g.quadratM}
          width={g.quadratM}
          height={g.quadratM}
          fill="none"
          stroke={c.ink}
          strokeWidth={2 * unit}
        />
      ) : null}
    </>
  );
});

const Overview = memo(function Overview({ g, states, c }: { g: FrameGeometry; states: readonly TreeState[]; c: Colors }) {
  const cells = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const s of states) {
      const e = m.get(s.quadratCode) ?? { done: 0, total: 0 };
      e.total += 1;
      if (s.done) e.done += 1;
      m.set(s.quadratCode, e);
    }
    return [...m.entries()];
  }, [states]);
  return (
    <>
      {cells.map(([code, e]) => {
        const q = parseFgQuadratCode(code);
        if (!q) return null;
        return (
          <Rect
            key={code}
            x={q.col * g.quadratM}
            y={g.sizeYM - (q.row + 1) * g.quadratM}
            width={g.quadratM}
            height={g.quadratM}
            fill={c.accent}
            fillOpacity={0.12 + 0.68 * (e.total ? e.done / e.total : 0)}
          />
        );
      })}
    </>
  );
});

const Trees = memo(function Trees({
  trees,
  chips,
  selectedId,
  sizeY,
  unit,
  labels,
  c,
}: {
  trees: readonly TreeState[];
  chips: ReadonlyMap<number, TreeChip>;
  selectedId: number | null;
  sizeY: number;
  unit: number;
  labels: boolean;
  c: Colors;
}) {
  return (
    <>
      {trees.map((s) => {
        const r = Math.max(radiusM(s.d2), MIN_R_PT * unit);
        const chip = chips.get(s.id);
        const dead = s.deadNow || (!s.done && (s.prev === 'dead' || s.prev === 'missing'));
        const look =
          chip === 'warn'
            ? { fill: c.alert, fillOpacity: 0.8, stroke: c.alert, dash: undefined }
            : dead
              ? { fill: 'none', fillOpacity: 1, stroke: c.ink2, dash: `${3 * unit} ${2 * unit}` }
              : s.isNew
                ? { fill: c.acorn, fillOpacity: 1, stroke: c.acornDeep, dash: undefined }
                : s.done
                  ? { fill: c.accent, fillOpacity: 0.78, stroke: c.accentPressed, dash: undefined }
                  : { fill: c.card, fillOpacity: 1, stroke: c.accent, dash: undefined };
        const cy = sizeY - s.y;
        return (
          <TreeMark
            key={s.id}
            x={s.x}
            y={cy}
            r={r}
            look={look}
            selected={s.id === selectedId}
            tag={labels ? s.tag : null}
            unit={unit}
            c={c}
          />
        );
      })}
    </>
  );
});

function TreeMark({
  x,
  y,
  r,
  look,
  selected,
  tag,
  unit,
  c,
}: {
  x: number;
  y: number;
  r: number;
  look: { fill: string; fillOpacity: number; stroke: string; dash: string | undefined };
  selected: boolean;
  tag: string | null;
  unit: number;
  c: Colors;
}) {
  return (
    <>
      <Circle cx={x} cy={y} r={r} fill={look.fill} fillOpacity={look.fillOpacity} stroke={look.stroke} strokeWidth={1.2 * unit} strokeDasharray={look.dash} />
      {/* Selection: a ring outside the circle, in ink — new trees are acorn already. */}
      {selected ? <Circle cx={x} cy={y} r={r + 4 * unit} fill="none" stroke={c.ink} strokeWidth={2.5 * unit} /> : null}
      {tag ? (
        <SvgText x={x} y={y + r + 9 * unit} fontSize={9 * unit} textAnchor="middle" fill={c.ink2}>
          {tag}
        </SvgText>
      ) : null}
    </>
  );
}
