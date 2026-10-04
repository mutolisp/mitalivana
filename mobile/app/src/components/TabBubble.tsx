/**
 * The tab bar folded into one round button (decided 2026-10-04; geometry and
 * the menu order are in src/lib/tabBubbleCore.ts). It shows the current tab.
 *
 * - Tap: the tab menu. ＋ sits nearest the button, then the tabs in the bar's
 *   order going away from the ＋. The scrim, the button (now ✕) or Android
 *   back closes it.
 * - Drag: anywhere up or down, snapping to the nearer edge; dropped near the
 *   bottom it settles into the bottom slot, where the docked search boxes and
 *   the map's corner controls make room for it (tabBubbleCore.ts). The place
 *   is kept in settings.
 * - Long press: the bar comes back. (Long-pressing a tab in the bar folds it:
 *   app/(tabs)/_layout.tsx. The settings page switches it too.)
 *
 * Drawn as the tab navigator's `tabBar` while folded, so it covers the tab
 * area only, and hidden while the keyboard is up. With a team sync folded to
 * its button, the progress is this button's ring and the menu has a row that
 * unfolds the sync strip; SyncProgressHost leaves its own button out while
 * this one is on screen (useTabChrome).
 */
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { CommonActions, useIsFocused } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useKeyboardState } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { longPressPlus, pressPlus } from '~/components/plusAction';
import {
  BUBBLE_SIZE,
  BUBBLE_MARGIN,
  MENU_GAP,
  bottomRange,
  clampBottom,
  menuOpensUp,
  menuOrder,
  sideOf,
  snapBottom,
  xOf,
  type BubbleArea,
  type BubbleSide,
} from '~/lib/tabBubbleCore';
import { useSettings } from '~/stores/settings';
import { syncRatio, useSyncProgress } from '~/stores/syncProgress';
import { useTabChrome } from '~/stores/tabChrome';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';

const ITEM = 48;
const RING = 4;

function MenuRow({
  label,
  icon,
  tone,
  right,
  onPress,
  onLongPress,
}: {
  label: string;
  icon: ReactNode;
  tone: 'plus' | 'current' | 'plain';
  /** The button is on the right edge: label first, circle at the edge. */
  right: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  // The pressed look comes from the row's Pressable. An `active:` class on the
  // circle itself would make NativeWind turn it into its own touch target, and
  // a tap on the icon would never reach the row (2026-10-04).
  const circleOf = (pressed: boolean) =>
    tone === 'plus'
      ? `items-center justify-center ${pressed ? 'bg-acorn-pressed' : 'bg-acorn'}`
      : tone === 'current'
        ? 'items-center justify-center border-2 border-accent bg-accent-100 dark:border-accent-400 dark:bg-accent-900'
        : `items-center justify-center border border-line dark:border-line-dark ${pressed ? 'bg-gray-100 dark:bg-gray-800' : 'bg-card dark:bg-card-dark'}`;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityState={{ selected: tone === 'current' }}
      style={{ flexDirection: right ? 'row' : 'row-reverse' }}
      className="items-center gap-2.5"
    >
      {({ pressed }) => (
        <>
          <View className="h-8 justify-center rounded-full border border-line bg-card px-3 dark:border-line-dark dark:bg-card-dark">
            <Text className="text-sm font-bold text-ink dark:text-gray-100">{label}</Text>
          </View>
          <View style={{ width: ITEM, height: ITEM, borderRadius: ITEM / 2 }} className={circleOf(pressed)}>
            {icon}
          </View>
        </>
      )}
    </Pressable>
  );
}

export function TabBubble({ state, descriptors, navigation, order }: BottomTabBarProps & { order: readonly string[] }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const keyboardUp = useKeyboardState((k) => k.isVisible);
  const fabSide = useSettings((s) => s.fab_side);
  const place = useSettings((s) => s.tab_bubble);
  const setSetting = useSettings((s) => s.set);
  const sync = useSyncProgress((s) => s.current);
  const syncFolded = useSyncProgress((s) => s.collapsed);
  const setSyncFolded = useSyncProgress((s) => s.setCollapsed);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [open, setOpen] = useState(false);

  const shown = focused && !keyboardUp;
  useEffect(() => {
    useTabChrome.setState({ bubbleShown: shown });
    if (!shown) setOpen(false);
    return () => useTabChrome.setState({ bubbleShown: false });
  }, [shown]);
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const area: BubbleArea | null = size && size.width > 0 && size.height > 0 ? { ...size, insetTop: insets.top, insetBottom: insets.bottom } : null;
  const side: BubbleSide = place.side ?? fabSide;
  const bottom = area ? clampBottom(area, place.bottom) : 0;

  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  // Put in place outright when the area is first measured or changes size (a
  // first layout can report a zero size; flying in from there looks broken),
  // and moved with a spring when only its place changes (a drop's snap).
  const measured = useRef('');
  useEffect(() => {
    if (!area || area.width <= 0 || area.height <= 0) return;
    const tx = xOf(area, side);
    const ty = area.height - bottom - BUBBLE_SIZE;
    const key = `${area.width}x${area.height}/${insets.top}/${insets.bottom}`;
    if (measured.current !== key) {
      measured.current = key;
      x.value = tx;
      y.value = ty;
    } else {
      x.value = withSpring(tx, { damping: 18 });
      y.value = withSpring(ty, { damping: 18 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size?.width, size?.height, insets.top, insets.bottom, side, bottom]);
  const moveStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }] }));

  const savePlace = (s: BubbleSide, b: number | null) => setSetting('tab_bubble', { side: s, bottom: b });
  const unfold = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setOpen(false);
    setSetting('tab_bar_mode', 'bar');
    useToast.getState().show(t('tabBubble.unfolded'));
  };
  const toggle = () => setOpen((o) => !o);

  const pan = Gesture.Pan()
    .minDistance(6)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
      runOnJS(setOpen)(false);
    })
    .onUpdate((e) => {
      if (!area) return;
      const r = bottomRange(area);
      x.value = startX.value + e.translationX;
      y.value = Math.min(area.height - r.min - BUBBLE_SIZE, Math.max(area.height - r.max - BUBBLE_SIZE, startY.value + e.translationY));
    })
    .onEnd(() => {
      if (!area) return;
      const s = sideOf(area, x.value);
      x.value = withSpring(xOf(area, s), { damping: 18 });
      // Near the bottom it settles into the bottom slot, where the docks make room for it.
      const b = snapBottom(area, area.height - y.value - BUBBLE_SIZE);
      if (b == null) y.value = withSpring(area.height - bottomRange(area).min - BUBBLE_SIZE, { damping: 18 });
      runOnJS(savePlace)(s, b);
    });
  const longPress = Gesture.LongPress()
    .minDuration(500)
    .maxDistance(10)
    .onStart(() => {
      runOnJS(unfold)();
    });
  const tap = Gesture.Tap().onEnd((_e, success) => {
    if (success) runOnJS(toggle)();
  });

  const current = state.routes[state.index];
  const iconOf = (key: string, color: string, isFocused: boolean) =>
    descriptors[key]?.options.tabBarIcon?.({ focused: isFocused, color, size: 22 }) ?? null;
  const titleOf = (key: string) => descriptors[key]?.options.title ?? '';
  const goTo = (key: string) => {
    setOpen(false);
    const route = state.routes.find((r) => r.key === key);
    if (!route) return;
    // As the bar's own tab button does it (BottomTabBar onPress): listeners see the press.
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (route.key !== current.key && !event.defaultPrevented) {
      navigation.dispatch({ ...CommonActions.navigate(route), target: state.key });
    }
  };

  const ratio = sync && syncFolded ? syncRatio(sync) : undefined;
  const pct = ratio == null ? null : Math.round(ratio * 100);
  const syncLabel = pct == null ? t('teamSync.progress.bubble') : t('teamSync.progress.bubblePct', { pct });

  let menuStyle: ViewStyle | null = null;
  if (area) {
    const up = menuOpensUp(area, bottom);
    const edge = BUBBLE_MARGIN + (BUBBLE_SIZE - ITEM) / 2;
    menuStyle = {
      position: 'absolute',
      ...(side === 'right' ? { right: edge, alignItems: 'flex-end' } : { left: edge, alignItems: 'flex-start' }),
      ...(up ? { bottom: bottom + BUBBLE_SIZE + MENU_GAP, flexDirection: 'column-reverse' } : { top: area.height - bottom + MENU_GAP, flexDirection: 'column' }),
      gap: 12,
    };
  }

  const r = (BUBBLE_SIZE - RING) / 2;
  const around = 2 * Math.PI * r;

  return (
    <View
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
    >
      {shown && area && open && menuStyle ? (
        <>
          <Pressable
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel={t('tabBubble.closeMenu')}
            style={StyleSheet.absoluteFill}
            className="bg-black/30"
          />
          <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(90)} style={menuStyle} accessibilityRole="menu">
            {menuOrder(order).map((name) => {
              if (name === 'plus') {
                return (
                  <MenuRow
                    key="plus"
                    label={t('record.createChooserTitle')}
                    icon={<Ionicons name="add" size={26} color={c.onAcorn} />}
                    tone="plus"
                    right={side === 'right'}
                    onPress={() => {
                      setOpen(false);
                      pressPlus();
                    }}
                    onLongPress={() => {
                      setOpen(false);
                      longPressPlus();
                    }}
                  />
                );
              }
              const route = state.routes.find((rt) => rt.name === name);
              if (!route) return null;
              const on = route.key === current.key;
              return (
                <MenuRow
                  key={route.key}
                  label={titleOf(route.key)}
                  icon={iconOf(route.key, on ? c.accent : c.overlayIcon, on)}
                  tone={on ? 'current' : 'plain'}
                  right={side === 'right'}
                  onPress={() => goTo(route.key)}
                />
              );
            })}
            {ratio !== undefined ? (
              <MenuRow
                label={syncLabel}
                icon={<Ionicons name="sync" size={22} color={c.overlayIcon} />}
                tone="plain"
                right={side === 'right'}
                onPress={() => {
                  setOpen(false);
                  setSyncFolded(false);
                }}
              />
            ) : null}
          </Animated.View>
        </>
      ) : null}
      {shown && area ? (
        <GestureDetector gesture={Gesture.Exclusive(pan, longPress, tap)}>
          <Animated.View
            style={[{ position: 'absolute', left: 0, top: 0, width: BUBBLE_SIZE, height: BUBBLE_SIZE, borderRadius: BUBBLE_SIZE / 2 }, moveStyle]}
            className="items-center justify-center bg-accent-700 shadow-lg"
            accessible
            accessibilityRole="button"
            accessibilityLabel={
              (open ? t('tabBubble.closeMenu') : t('tabBubble.label', { tab: titleOf(current.key) })) +
              (ratio !== undefined ? `, ${syncLabel}` : '')
            }
            accessibilityHint={t('tabBubble.hint')}
            accessibilityState={{ expanded: open }}
            accessibilityActions={[{ name: 'activate' }, { name: 'longpress', label: t('tabBubble.unfold') }]}
            onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'longpress' ? unfold() : toggle())}
          >
            {ratio !== undefined ? (
              <Svg width={BUBBLE_SIZE} height={BUBBLE_SIZE} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
                <Circle cx={BUBBLE_SIZE / 2} cy={BUBBLE_SIZE / 2} r={r} stroke="white" strokeOpacity={0.3} strokeWidth={RING} fill="none" />
                {ratio == null ? null : (
                  <Circle
                    cx={BUBBLE_SIZE / 2}
                    cy={BUBBLE_SIZE / 2}
                    r={r}
                    stroke="white"
                    strokeWidth={RING}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${around} ${around}`}
                    strokeDashoffset={around * (1 - ratio)}
                  />
                )}
              </Svg>
            ) : null}
            {open ? <Ionicons name="close" size={26} color="white" /> : iconOf(current.key, 'white', true)}
          </Animated.View>
        </GestureDetector>
      ) : null}
    </View>
  );
}
