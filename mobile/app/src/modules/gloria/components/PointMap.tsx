/**
 * The point grid of a point walk, large and zoomable: a 10×10 m square as the
 * diamond it is on the slope (HSP up, as on Form 6-S), a 1×1 m quadrat as its
 * 10 × 10 crosshairs (R1 at the top, uphill). Tap a point to go back to it.
 *
 * Zoom works as on the summit overview (SummitSchematic): two fingers pinch
 * and move, ＋ / − / reset one-handed; it changes the SVG viewBox, so every
 * point stays tappable at any size.
 */
import { Ionicons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Line, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { SURFACE_UNVISITED, SURFACE_VASCULAR } from '../model/grid';
import { useThemeColors } from '~/theme/colors';

const FULL = 300;
const MIN_SIZE = FULL / 5; // 5× at most: a 10×10 m point is ~9 units wide
type ViewBox = { x: number; y: number; s: number };
const HOME: ViewBox = { x: 0, y: 0, s: FULL };
const clampView = (v: ViewBox): ViewBox => {
  const s = Math.min(FULL, Math.max(MIN_SIZE, v.s));
  return { s, x: Math.min(FULL - s, Math.max(0, v.x)), y: Math.min(FULL - s, Math.max(0, v.y)) };
};

// Square: corners top (uphill) / right / bottom / left; canonical a runs
// bottom → right corner, b bottom → left corner (model/walk.ts).
const B = { x: 150, y: 282 };
const R = { x: 282, y: 150 };
const L = { x: 18, y: 150 };
const sq = (a: number, b: number, n: number) => ({
  x: B.x + (a / n) * (R.x - B.x) + (b / n) * (L.x - B.x),
  y: B.y + (a / n) * (R.y - B.y) + (b / n) * (L.y - B.y),
});

export function PointMap({
  n,
  square,
  surface,
  current,
  onPoint,
  onInteract,
}: {
  n: number;
  square: boolean;
  /** One char per canonical point (model/grid.ts). */
  surface: string;
  /** Canonical index of the point being recorded, or null when all are done. */
  current: number | null;
  onPoint: (canonical: number) => void;
  /** True while two fingers are on the map — the page should stop scrolling. */
  onInteract?: (active: boolean) => void;
}) {
  const tc = useThemeColors();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === 'dark';
  const [view, setView] = useState<ViewBox>(HOME);
  const [width, setWidth] = useState(0);
  const base = useRef<ViewBox>(HOME);
  const focal = useRef({ x: 0, y: 0 });
  const pinching = useRef(false);
  const k = (v: ViewBox) => (width > 0 ? v.s / width : 1);

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart((e) => {
      pinching.current = true;
      base.current = view;
      focal.current = { x: view.x + e.focalX * k(view), y: view.y + e.focalY * k(view) };
      onInteract?.(true);
    })
    .onUpdate((e) => {
      const s = base.current.s / e.scale;
      const u = width > 0 ? s / width : 1;
      setView(clampView({ s, x: focal.current.x - e.focalX * u, y: focal.current.y - e.focalY * u }));
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
      const u = k(base.current);
      setView(clampView({ ...base.current, x: base.current.x - e.translationX * u, y: base.current.y - e.translationY * u }));
    })
    .onFinalize(() => onInteract?.(false));
  /** Centre of a point in drawing units. */
  const centreOf = (i: number) => {
    if (square) return sq(Math.floor(i / n) + 0.5, (i % n) + 0.5, n);
    const side = 264 / n;
    return { x: 18 + ((i % n) + 0.5) * side, y: 24 + (Math.floor(i / n) + 0.5) * side };
  };
  // ＋ / − zoom around the point being recorded, so it stays in view one-handed.
  const zoomBy = (f: number) =>
    setView((v) => {
      const s = v.s / f;
      const c = current != null ? centreOf(current) : { x: v.x + v.s / 2, y: v.y + v.s / 2 };
      return clampView({ s, x: c.x - s / 2, y: c.y - s / 2 });
    });
  const zoomed = view.s < FULL - 0.5;

  const empty = tc.outline;
  const edge = dark ? '#111827' : '#ffffff';
  const ink = tc.ink2;
  const fill = (i: number) => {
    if (i === current) return '#d97706';
    const ch = surface[i];
    if (ch === SURFACE_VASCULAR) return tc.accent;
    if (ch && ch !== SURFACE_UNVISITED) return tc.ink3;
    return empty;
  };

  const cells: React.ReactNode[] = [];
  if (square) {
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        const i = a * n + b;
        const pts = [sq(a, b, n), sq(a + 1, b, n), sq(a + 1, b + 1, n), sq(a, b + 1, n)].map((p) => `${p.x},${p.y}`).join(' ');
        cells.push(<Polygon key={i} points={pts} fill={fill(i)} stroke={edge} strokeWidth={0.8} onPress={() => onPoint(i)} />);
      }
  } else {
    const side = 264 / n;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        cells.push(
          <Rect key={i} x={18 + c * side} y={24 + r * side} width={side} height={side} fill={fill(i)} stroke={edge} strokeWidth={1} onPress={() => onPoint(i)} />,
        );
      }
  }

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <GestureDetector gesture={Gesture.Simultaneous(pinch, pan)}>
        <View collapsable={false}>
          <Svg viewBox={`${view.x} ${view.y} ${view.s} ${view.s}`} width="100%" style={{ aspectRatio: 1 }}>
            {square ? (
              <>
                <Line x1={150} y1={16} x2={150} y2={298} stroke={ink} strokeWidth={0.8} strokeDasharray="3 3" />
                <SvgText x={150} y={12} fontSize={10} fontWeight="bold" fill={ink} textAnchor="middle">
                  HSP
                </SvgText>
              </>
            ) : (
              <SvgText x={150} y={16} fontSize={10} fontWeight="bold" fill={ink} textAnchor="middle">
                {t('gloria.freq.uphill')}
              </SvgText>
            )}
            {cells}
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
            className={`h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-card/90 dark:border-gray-600 dark:bg-gray-900/90 ${b.off ? 'opacity-40' : ''}`}
          >
            <Ionicons name={b.icon} size={16} color={tc.accent} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
