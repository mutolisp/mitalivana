/**
 * Map on the left, the record list on the right, a divider between them
 * (design 18j / 18k / 18m; docs/planned/UI_modes_impl.md M3) — or the map
 * above the list: a button in the list's heading switches between the two.
 *
 * - Drag the divider to resize; tap it to step through three sizes
 *   (`SPLIT_PRESETS`, `SPLIT_PRESETS_V`). The size lives in a Reanimated shared
 *   value while the finger moves — no React state per frame — and is saved on
 *   release.
 * - Side by side, the list folds to a tab on the right edge (its count and a
 *   chevron) and the map takes the full width. Map above, it folds down to its
 *   heading, which stays as a bar under the map: a floating tab there would sit
 *   on the map's own bottom controls (記在這裡, the scale bar).
 * - Direction, both sizes and folding are remembered per usage mode (setting
 *   `split_map`), shared by every screen that has the map.
 *
 * Layout only: the caller passes the map (FieldMap) and the list rows. The
 * docked search box stays below this view at full width, so the screen's
 * KeyboardStickyView pairing (check:dock) is untouched.
 *
 * With `topInset` the view runs under the status bar (casual mode's map tab):
 * side by side, the list starts below it, and while the list is open a
 * translucent band covers the map's strip so the status bar icons, which then
 * follow the theme (app/_layout.tsx), stay legible over any basemap. Map
 * above, the whole strip is map and the icons follow the basemap instead.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { layoutFor, nextPreset, splitBounds, type SplitAxis, type SplitLayout } from '~/lib/splitMap';
import { useUsageMode } from '~/lib/useUsageMode';
import { useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

const DIVIDER = 14;
const ROW_HEIGHT = 56;

function useSplitLayout(): [SplitLayout, (patch: Partial<SplitLayout>) => void] {
  const mode = useUsageMode();
  const setting = useSettings((s) => s.split_map);
  const save = (patch: Partial<SplitLayout>) => {
    const cur = useSettings.getState().split_map;
    useSettings.getState().set('split_map', { ...cur, [mode]: { ...layoutFor(cur, mode), ...patch } });
  };
  return [layoutFor(setting, mode), save];
}

/** Side by side or map above, for screens that lay out their map's chrome by it. */
export function useSplitAxis(): SplitAxis {
  return useSplitLayout()[0].axis;
}

/** Whether the map is switched on for `screen`, remembered per usage mode. */
export function useSplitMapOpen(screen: 'session' | 'plot'): [boolean, (open: boolean) => void] {
  const [layout, save] = useSplitLayout();
  return [!!layout.open[screen], (open) => save({ open: { ...layout.open, [screen]: open } })];
}

export function SplitMapView({
  map,
  list,
  title,
  count,
  onShowAll,
  onTitlePress,
  topInset = 0,
  bottomInset = 0,
}: {
  map: ReactNode;
  list: ReactNode;
  /** The list's heading: 「物種 12」, or 「這一段 3 種」 while a stretch is picked. */
  title: string;
  /** Shown on the folded tab. */
  count: number;
  /** Given while the list is narrowed to a stretch: a 「全部」 button clears it. */
  onShowAll?: () => void;
  /** Makes the heading a button with a ▾ (casual mode: today or all days). */
  onTitlePress?: () => void;
  /** The status bar's height when the view runs under it. */
  topInset?: number;
  /** Room for a floating tab bar under the view: the folded heading (map above) stays clear of it. */
  bottomInset?: number;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const [layout, save] = useSplitLayout();
  const column = layout.axis === 'column';
  const { min, max } = splitBounds(layout.axis);
  const saved = column ? layout.ratioV : layout.ratio;
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const ratio = useSharedValue(saved);
  const start = useSharedValue(saved);

  // Another screen, or a mode switch, changed the saved size.
  useEffect(() => {
    ratio.value = saved;
  }, [saved, ratio]);

  const saveRatio = (r: number) => save(column ? { ratioV: r } : { ratio: r });
  const stepSize = () => {
    const next = nextPreset(ratio.value, layout.axis);
    ratio.value = withTiming(next, { duration: 180 });
    saveRatio(next);
  };
  const switchAxis = () => {
    const next: SplitAxis = column ? 'row' : 'column';
    // Now, not in the effect: the first frame of the new layout already has its size.
    ratio.value = next === 'column' ? layout.ratioV : layout.ratio;
    save({ axis: next });
  };

  const pan = Gesture.Pan()
    .minDistance(4)
    .onStart(() => {
      start.value = ratio.value;
    })
    .onUpdate((e) => {
      const span = column ? height.value : width.value;
      if (span <= 0) return;
      const moved = column ? e.translationY : e.translationX;
      ratio.value = Math.max(min, Math.min(max, start.value + moved / span));
    })
    .onEnd(() => {
      runOnJS(saveRatio)(ratio.value);
    });
  const tap = Gesture.Tap().onEnd(() => {
    runOnJS(stepSize)();
  });
  const divider = Gesture.Exclusive(pan, tap);

  // Both dimensions every time: an animated style that stops returning a key
  // leaves its last value on the view, so a width from side by side would
  // otherwise stay on the map once it moved above the list.
  const mapStyle = useAnimatedStyle(() => {
    if (column) {
      return {
        width: '100%',
        height: height.value > 0 ? ratio.value * height.value : `${Math.round(ratio.value * 100)}%`,
      };
    }
    return {
      width: width.value > 0 ? ratio.value * width.value : `${Math.round(ratio.value * 100)}%`,
      height: '100%',
    };
  }, [column]);

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
    height.value = e.nativeEvent.layout.height;
  };

  // One tree whether folded or not: folding only widens the map, so the map
  // keeps its camera instead of being mounted again.
  return (
    <View
      className={`flex-1 ${column ? 'flex-col' : 'flex-row'} ${topInset > 0 ? '' : 'border-t border-line dark:border-line-dark'}`}
      onLayout={onLayout}
      // Without the border this view is layout-only and Fabric flattens it;
      // when a recording bar appears (topInset → 0) the border comes back and
      // the view is created, moving the map under a new parent mid-frame. That
      // crashed the casual map tab now and then ("Unable to find viewState").
      collapsable={false}
    >
      <Animated.View style={[{ overflow: 'hidden' }, layout.collapsed ? { flex: 1 } : mapStyle]}>
        {map}
        {topInset > 0 && !layout.collapsed && !column ? (
          <View
            pointerEvents="none"
            className="absolute left-0 right-0 top-0 bg-card/85 dark:bg-card-dark/85"
            style={{ height: topInset }}
          />
        ) : null}
      </Animated.View>
      {layout.collapsed && !column ? (
        <Pressable
          onPress={() => save({ collapsed: false })}
          accessibilityRole="button"
          accessibilityLabel={t('splitMap.openList', { count })}
          className="absolute right-0 items-center justify-center gap-1.5 rounded-l-2xl border border-r-0 border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
          style={{ top: '38%', width: 40, height: 104 }}
        >
          <Ionicons name="chevron-back" size={16} color={c.ink} />
          <Ionicons name="list-outline" size={18} color={c.ink2} />
          <Text className="text-sm font-bold text-gray-900 dark:text-gray-100">{count}</Text>
        </Pressable>
      ) : null}
      {layout.collapsed && !column ? null : (
        <>
      {layout.collapsed ? null : (
      <GestureDetector gesture={divider}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t(column ? 'splitMap.dividerV' : 'splitMap.divider')}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
          onAccessibilityAction={(e) => {
            const step = e.nativeEvent.actionName === 'increment' ? 0.1 : e.nativeEvent.actionName === 'decrement' ? -0.1 : 0;
            if (step === 0) return stepSize();
            const next = Math.max(min, Math.min(max, ratio.value + step));
            ratio.value = withTiming(next, { duration: 180 });
            saveRatio(next);
          }}
          className="items-center justify-center bg-disc dark:bg-disc-dark"
          style={column ? { height: DIVIDER } : { width: DIVIDER }}
        >
          <View className="rounded-sm bg-gray-400 dark:bg-gray-500" style={column ? { width: 40, height: 4 } : { width: 4, height: 40 }} />
        </View>
      </GestureDetector>
      )}
      <View
        // Map above and folded: only the heading is left, as a bar under the map.
        className={`${layout.collapsed ? 'border-t border-line dark:border-line-dark' : 'flex-1'} bg-card dark:bg-card-dark`}
        style={{ paddingTop: column ? 0 : topInset, paddingBottom: layout.collapsed ? bottomInset : 0 }}
      >
        <View className="flex-row items-center gap-1 border-b border-disc py-1.5 pl-3 pr-1 dark:border-gray-800">
          {onTitlePress ? (
            <Pressable
              onPress={onTitlePress}
              accessibilityRole="button"
              hitSlop={4}
              className="flex-1 flex-row items-center gap-0.5 active:opacity-60"
              style={{ minHeight: 32 }}
            >
              <Text className="flex-shrink text-sm font-bold text-gray-900 dark:text-gray-100" numberOfLines={1}>
                {title}
              </Text>
              <Ionicons name="chevron-down" size={14} color={c.ink2} />
            </Pressable>
          ) : (
            <Text className="flex-1 text-sm font-bold text-gray-900 dark:text-gray-100" numberOfLines={1}>
              {title}
            </Text>
          )}
          {onShowAll ? (
            <Pressable
              onPress={onShowAll}
              accessibilityRole="button"
              className="justify-center rounded-full border border-line bg-paper px-2.5 active:bg-gray-100 dark:border-line-dark dark:bg-paper-dark dark:active:bg-gray-800"
              style={{ minHeight: 32 }}
            >
              <Text className="text-xs text-gray-900 dark:text-gray-100">{t('records.filterAll')}</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={switchAxis}
            accessibilityRole="button"
            accessibilityLabel={t(column ? 'splitMap.toRow' : 'splitMap.toColumn')}
            hitSlop={4}
            className="h-9 w-9 items-center justify-center active:opacity-60"
          >
            <SplitGlyph axis={column ? 'row' : 'column'} color={c.ink2} />
          </Pressable>
          <Pressable
            onPress={() => save({ collapsed: !layout.collapsed })}
            accessibilityRole="button"
            accessibilityLabel={layout.collapsed ? t('splitMap.openList', { count }) : t('splitMap.foldList')}
            hitSlop={4}
            className="h-9 w-9 items-center justify-center active:opacity-60"
          >
            <Ionicons
              name={!column ? 'chevron-forward' : layout.collapsed ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={c.ink2}
            />
          </Pressable>
        </View>
        {layout.collapsed ? null : list}
      </View>
        </>
      )}
    </View>
  );
}

/** The layout a tap switches to: a frame split down the middle or across it, the map's half filled. */
function SplitGlyph({ axis, color }: { axis: SplitAxis; color: string }) {
  const row = axis === 'row';
  return (
    <View
      style={{
        width: 18,
        height: 16,
        borderWidth: 1.5,
        borderColor: color,
        borderRadius: 3,
        overflow: 'hidden',
        flexDirection: row ? 'row' : 'column',
      }}
    >
      <View style={{ flex: 1, backgroundColor: color, opacity: 0.35 }} />
      <View style={row ? { width: 1.5, backgroundColor: color } : { height: 1.5, backgroundColor: color }} />
      <View style={{ flex: 1 }} />
    </View>
  );
}

export type SplitRow = { id: number; title: string; meta: string };

/**
 * The narrow list beside the map: a name and one line of detail per record.
 * The first tap picks a record (its pin is ringed and the map moves to it);
 * a tap on the picked one opens it.
 */
export function SplitRecordList({
  rows,
  picked,
  onPick,
  onOpen,
  empty,
  bottomInset = 0,
}: {
  rows: SplitRow[];
  picked: number | null;
  onPick: (id: number) => void;
  onOpen: (id: number) => void;
  empty: string;
  /** Room for the floating tab bar when the list runs to the screen's bottom edge. */
  bottomInset?: number;
}) {
  const ref = useRef<FlatList<SplitRow>>(null);
  // A pin tapped on the map brings its row into view.
  useEffect(() => {
    if (picked == null) return;
    const i = rows.findIndex((r) => r.id === picked);
    if (i >= 0) ref.current?.scrollToIndex({ index: i, viewPosition: 0.3, animated: true });
    // Only when the pick changes, not on every reload of the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);
  return (
    <FlatList
      ref={ref}
      data={rows}
      keyExtractor={(r) => String(r.id)}
      getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 12 + bottomInset }}
      ListEmptyComponent={<Text className="px-3 py-6 text-center text-xs text-gray-500 dark:text-gray-400">{empty}</Text>}
      renderItem={({ item }) => {
        const on = item.id === picked;
        return (
          <Pressable
            onPress={() => (on ? onOpen(item.id) : onPick(item.id))}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            className={`justify-center border-b border-disc px-2.5 dark:border-gray-800 ${on ? 'bg-accent-tint dark:bg-accent-950/40' : 'active:bg-gray-100 dark:active:bg-gray-800'}`}
            style={{ height: ROW_HEIGHT }}
          >
            <Text className="text-sm font-bold text-gray-900 dark:text-gray-100" numberOfLines={1}>
              {item.title}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
              {item.meta}
            </Text>
          </Pressable>
        );
      }}
    />
  );
}

/** 「地圖」 — turns the split map on and off (filter row or tab row, never the header). */
export function MapToggle({ on, onPress }: { on: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={t('splitMap.toggle')}
      hitSlop={4}
      className={`flex-row items-center gap-1 rounded-full border px-3 ${
        on
          ? 'border-ink bg-ink dark:border-gray-100 dark:bg-gray-100'
          : 'border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800'
      }`}
      style={{ minHeight: 34 }}
    >
      <Ionicons name="map-outline" size={16} color={on ? c.card : c.ink} />
      <Text className={`text-sm font-bold ${on ? 'text-card dark:text-gray-950' : 'text-gray-900 dark:text-gray-100'}`}>
        {t('splitMap.toggle')}
      </Text>
    </Pressable>
  );
}
