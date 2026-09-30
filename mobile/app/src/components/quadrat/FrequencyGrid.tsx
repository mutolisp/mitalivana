/**
 * The n × n frequency grid shared by GLORIA's 1×1 m quadrats and the fixed
 * plot's quadrats (06-plot-quadrats.md §5): the cells, their R / C labels,
 * the centre cross, and the paint gesture.
 *
 * Brush mode paints a whole stroke and commits once when the finger lifts;
 * the first cell decides whether the stroke paints or erases. Cell mode only
 * reports which cell was tapped. Count mode has no grid — the caller shows
 * its own list instead.
 *
 * The caller owns the masks. While painting, `onPaint` streams the growing
 * mask so counts elsewhere on screen follow the finger; `onStrokeBegin` hands
 * over the mask as it was (the caller's undo step); `onCommit` is the single
 * write. A stroke still open when the app leaves the foreground or the grid
 * unmounts is committed anyway, and `flush()` (via ref) does the same before
 * the caller's undo / redo / lock, so a device that never delivers the
 * gesture's finalize loses neither the stroke nor its undo step.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSwipeBlock } from '~/components/SwipeNavigator';
import { emptyMask, getBit, setBits } from '~/lib/grid';
import { useThemeColors } from '~/theme/colors';

export type FrequencyGridHandle = {
  /** Commit a stroke whose finalize never came. */
  flush: () => void;
};

type Props = {
  /** Cells per side. */
  n: number;
  /** Mask per target key. */
  masks: Readonly<Record<string, string>>;
  /** Target painted in brush mode. */
  active: string | null;
  /** Fill of the active target's cells (default: accent). */
  activeColor?: string;
  mode: 'brush' | 'cell';
  /** Cell mode: the current cell, and where a tap moves it. */
  sel?: number;
  onSelectCell?: (i: number) => void;
  /** Inverse fill: empty cells show a × ("absent here"). */
  inverse?: boolean;
  /** Extra targets drawn as a corner square in their tone and not counted
   *  among the other species (GLORIA's grazing features). */
  tones?: Readonly<Record<string, string>>;
  /** Label above the grid: which edge is row R1. */
  topEdgeLabel: string;
  /** Rotated labels beside the grid (left, right), when the sides have names. */
  leftRightLabels?: readonly [string, string];
  locked: boolean;
  /** Largest grid side in pt, when the caller must fit more below it. */
  maxSize?: number;
  /** A touch on a locked grid (brush mode). */
  onLocked?: () => void;
  onStrokeBegin?: (key: string, before: string) => void;
  /** The owner's current mask, read at the start of a stroke (props lag a render). */
  readMask?: (key: string) => string | undefined;
  onPaint: (key: string, mask: string) => void;
  onCommit: (key: string, mask: string) => void;
  accessibilityLabel?: string;
};

export const FrequencyGrid = forwardRef<FrequencyGridHandle, Props>(function FrequencyGrid(
  {
    n,
    masks,
    active,
    activeColor,
    mode,
    sel = -1,
    onSelectCell,
    inverse = false,
    tones = {},
    topEdgeLabel,
    leftRightLabels,
    locked,
    maxSize = 360,
    onLocked,
    onStrokeBegin,
    readMask,
    onPaint,
    onCommit,
    accessibilityLabel,
  },
  ref,
) {
  const tc = useThemeColors();
  const cells = n * n;
  // Side of the grid: the row's width less the labels, capped by the caller.
  const [width, setWidth] = useState(0);
  const sideW = leftRightLabels ? 40 : 0;
  const fit = width ? Math.max(0, Math.min(width - 22 - sideW, maxSize)) : 300;
  // R / C labels grow with a grid larger than 360 (10 → 14 pt); up to 360
  // they stay 10 pt in a 22 pt column, as before.
  const labelFs = Math.min(14, Math.max(10, Math.round((10 * fit) / 360)));
  const labelW = Math.round(labelFs * 2.2);
  const size = width ? Math.max(0, Math.min(width - labelW - sideW, maxSize)) : 300;
  // Last cell the finger landed on, shown as e.g. "R3C7" until the next touch.
  const [touched, setTouched] = useState<number | null>(null);

  // The stroke's own copy of its mask: gesture callbacks must not read a
  // stale render's props.
  const stroke = useRef<{ key: string; on: boolean; seen: Set<number>; before: string; mask: string } | null>(null);
  // Latest callbacks and masks for callbacks bound in an earlier render.
  const latest = useRef({ masks, readMask, onCommit, onPaint, onStrokeBegin, onLocked, onSelectCell });
  latest.current = { masks, readMask, onCommit, onPaint, onStrokeBegin, onLocked, onSelectCell };
  const flush = useRef(() => {
    const s = stroke.current;
    stroke.current = null;
    if (s && s.mask !== s.before) latest.current.onCommit(s.key, s.mask);
  }).current;
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') flush();
    });
    return () => {
      sub.remove();
      flush();
    };
  }, [flush]);

  const swipeBlock = useSwipeBlock();
  // Memoised on what cannot change mid-stroke, so a re-render while painting
  // never swaps the gesture out from under the finger.
  const gesture = useMemo(() => {
    const cellAt = (x: number, y: number) => {
      const c = Math.floor((x / size) * n);
      const r = Math.floor((y / size) * n);
      return c < 0 || r < 0 || c >= n || r >= n ? -1 : r * n + c;
    };
    const pan = Gesture.Pan()
      .minDistance(0)
      .runOnJS(true)
      .onBegin((e) => {
        const i = cellAt(e.x, e.y);
        if (i < 0) return;
        setTouched(i);
        if (mode === 'cell') {
          latest.current.onSelectCell?.(i);
          return;
        }
        if (locked) {
          latest.current.onLocked?.();
          return;
        }
        if (!active) return;
        flush(); // a previous stroke whose finalize never came
        // From the owner's copy, read now: the props lag a render behind, and a
        // quick second tap started from them undid the first.
        const before = latest.current.readMask?.(active) ?? latest.current.masks[active] ?? emptyMask(cells);
        // The first cell decides: paint where it was empty, erase where it was set.
        const on = !getBit(before, i);
        const mask = setBits(before, [i], on);
        stroke.current = { key: active, on, seen: new Set([i]), before, mask };
        latest.current.onStrokeBegin?.(active, before);
        latest.current.onPaint(active, mask);
      })
      .onUpdate((e) => {
        const st = stroke.current;
        if (!st) return;
        const i = cellAt(e.x, e.y);
        if (i < 0 || st.seen.has(i)) return;
        st.seen.add(i);
        st.mask = setBits(st.mask, [i], st.on);
        latest.current.onPaint(st.key, st.mask);
      })
      // iOS never finalizes a pan that did not activate (a tap): the stroke
      // stayed open until the next touch, whose late write then reset the grid
      // under the new stroke (seen as "needs two taps" and cells jumping). The
      // raw touch-up always comes, on both platforms; finalize stays as a
      // second net, and flush() is a no-op once the stroke is written.
      .onTouchesUp(() => flush())
      .onTouchesCancelled(() => flush())
      .onFinalize(() => flush());
    // On a screen that swipes sideways between tabs (a plot's), that swipe
    // waits for the brush: otherwise a sideways stroke switched tab or
    // dragged the whole page instead of painting.
    return swipeBlock ? pan.blocksExternalGesture(swipeBlock) : pan;
  }, [mode, active, size, n, cells, flush, locked, swipeBlock]);

  const cellPx = size / n;
  const keys = Object.keys(masks);
  const toneKeys = Object.keys(tones);

  return (
    <>
      <View className="flex-row items-center justify-center">
        {touched != null ? (
          <Text
            accessibilityLiveRegion="polite"
            className="absolute left-0 rounded bg-gray-800 px-1.5 py-0.5 text-xs font-bold text-white dark:bg-gray-200 dark:text-gray-900"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {`R${Math.floor(touched / n) + 1}C${(touched % n) + 1}`}
          </Text>
        ) : null}
        <Text className="text-center text-xs font-semibold text-accent-700 dark:text-accent-300">{topEdgeLabel}</Text>
      </View>
      {/* The whole block (side labels, row labels, grid) is centred; the grid's
          size comes from the row's width: side labels + the row labels. */}
      <View
        className="flex-row items-center justify-center"
        onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
      >
        {leftRightLabels ? (
          <Text className="w-5 text-center text-[11px] font-bold text-gray-700 dark:text-gray-200" style={{ transform: [{ rotate: '-90deg' }] }}>
            {leftRightLabels[0]}
          </Text>
        ) : null}
        <View style={{ width: size + labelW }}>
          <View className="flex-row" style={{ marginLeft: labelW }}>
            {Array.from({ length: n }, (_, c) => (
              <Text key={c} style={{ width: cellPx, fontSize: labelFs }} className="text-center font-semibold text-gray-700 dark:text-gray-200">{`C${c + 1}`}</Text>
            ))}
          </View>
          <View className="flex-row">
            <View style={{ width: labelW }}>
              {Array.from({ length: n }, (_, r) => (
                <Text key={r} style={{ height: cellPx, lineHeight: cellPx, fontSize: labelFs }} className="font-semibold text-gray-700 dark:text-gray-200">{`R${r + 1}`}</Text>
              ))}
            </View>
            {/* Drawn at an exact pixel size: percentage cells in a flex-wrap
                row under a max-width clamp wrapped at 9 columns on iPad. */}
            <GestureDetector gesture={gesture}>
              <View style={{ width: size, height: size }} accessibilityLabel={accessibilityLabel}>
                {Array.from({ length: cells }, (_, i) => {
                  const on = mode === 'brush' && active != null && getBit(masks[active] ?? '', i);
                  const others = keys.filter((k) => k !== (mode === 'brush' ? active : '') && !tones[k] && getBit(masks[k] ?? '', i)).length;
                  const graze =
                    mode === 'cell' || !(active && tones[active]) ? toneKeys.find((k) => getBit(masks[k] ?? '', i)) : undefined;
                  return (
                    <View
                      key={i}
                      style={{
                        position: 'absolute',
                        left: (i % n) * cellPx,
                        top: Math.floor(i / n) * cellPx,
                        width: cellPx,
                        height: cellPx,
                        backgroundColor: on ? (activeColor ?? tc.accent) : undefined,
                        borderWidth: mode === 'cell' && i === sel ? 2 : 0.5,
                        borderColor: mode === 'cell' && i === sel ? tc.acorn : tc.line,
                      }}
                      className={on ? '' : 'bg-card dark:bg-gray-900'}
                    >
                      {inverse && !on ? <Text className="text-center text-[11px] font-bold text-red-500">×</Text> : null}
                      {others > 0 && !inverse ? (
                        <View className="absolute bottom-0.5 left-0.5 flex-row">
                          {Array.from({ length: Math.min(others, 4) }, (_, k) => (
                            <View key={k} className={`mr-px h-[3px] w-[3px] rounded-full ${on ? 'bg-gray-800' : 'bg-gray-400'}`} />
                          ))}
                        </View>
                      ) : null}
                      {graze ? <View className="absolute right-0.5 top-0.5 h-[5px] w-[5px] rounded-sm" style={{ backgroundColor: tones[graze] }} /> : null}
                    </View>
                  );
                })}
                {/* Centre lines split the grid into quarters, the way the
                    field frame is read. Only on an even grid: on an odd one
                    they would cut through the middle row and column. */}
                {n % 2 === 0 ? (
                  <>
                    <View pointerEvents="none" className="absolute bottom-0 top-0 bg-gray-800 dark:bg-gray-200" style={{ left: '50%', width: 2, marginLeft: -1 }} />
                    <View pointerEvents="none" className="absolute left-0 right-0 bg-gray-800 dark:bg-gray-200" style={{ top: '50%', height: 2, marginTop: -1 }} />
                  </>
                ) : null}
                {/* Frame drawn over the cells, so it takes no room from them. */}
                <View pointerEvents="none" className="absolute inset-0 border-2 border-gray-600 dark:border-gray-400" />
              </View>
            </GestureDetector>
          </View>
        </View>
        {leftRightLabels ? (
          <Text className="w-5 text-center text-[11px] font-bold text-gray-700 dark:text-gray-200" style={{ transform: [{ rotate: '90deg' }] }}>
            {leftRightLabels[1]}
          </Text>
        ) : null}
      </View>
    </>
  );
});
