/**
 * The ⋯ menu (02-components.md `OverflowMenu`): a small card that drops from
 * its button, with no dimming — the rest of the screen stays as it was.
 *
 *   const id = await showMenu(anchorRef, sections);
 *
 * Resolves with the id of the `action` chosen, or null. `radio`, `segmented`
 * and `stepper` items act through their own callbacks and keep the menu open,
 * so the result is visible; pass `sections` as a function to have it rebuilt
 * after each of those (read fresh values from refs inside it).
 *
 * `<MenuHost />` is a plain absolutely-positioned View in app/_layout.tsx, NOT
 * an RN `Modal`: opening it from a header never meets iOS's Modal-over-Modal
 * refusal, and ToastHost still paints above it. The flip side: do not call
 * showMenu from inside an open `<Modal>` — the host would be underneath it.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { usePathname } from 'expo-router';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccessibilityInfo,
  BackHandler,
  Dimensions,
  findNodeHandle,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { create } from 'zustand';

import { useThemeColors } from '~/theme/colors';

export type MenuIcon = keyof typeof Ionicons.glyphMap;

type StepperKey = { label: string; icon: MenuIcon; count: number; onPress: () => void };

export type MenuItem =
  | {
      kind: 'action';
      id: string;
      label: string;
      icon?: MenuIcon;
      /** A value shown at the right, cut to one line (a record's project, its surveyors). */
      detail?: string;
      /** The detail asks for attention: still unset, or required and missing. */
      attention?: boolean;
      destructive?: boolean;
    }
  | { kind: 'radio'; id: string; group: string; label: string; icon?: MenuIcon; checked: boolean; onSelect: () => void }
  | {
      kind: 'segmented';
      id: string;
      label: string;
      value: string;
      options: { value: string; icon: MenuIcon; label: string }[];
      onChange: (value: string) => void;
    }
  | { kind: 'stepper'; id: string; undo: StepperKey; redo: StepperKey };

export type MenuSection = { title?: string; items: MenuItem[] };
type Sections = MenuSection[] | (() => MenuSection[]);
type Rect = { x: number; y: number; w: number; h: number };

type MenuState = {
  req: { rect: Rect; sections: Sections; resolve: (id: string | null) => void } | null;
  open: (req: NonNullable<MenuState['req']>) => void;
  close: (id: string | null) => void;
};

const useMenu = create<MenuState>((set, get) => ({
  req: null,
  open: (req) => {
    get().req?.resolve(null);
    set({ req });
  },
  close: (id) => {
    const req = get().req;
    set({ req: null });
    // Next frame: whatever the choice opens (a sheet, a picker) should not
    // mount in the same commit that removes the menu.
    if (req) requestAnimationFrame(() => req.resolve(id));
  },
}));

export async function showMenu(anchorRef: RefObject<View | null>, sections: Sections): Promise<string | null> {
  const node = anchorRef.current;
  if (!node) return null;
  const rect = await new Promise<Rect>((res) => node.measureInWindow((x, y, w, h) => res({ x, y, w, h })));
  void Haptics.selectionAsync();
  return new Promise((resolve) => useMenu.getState().open({ rect, sections, resolve }));
}

const WIDTH = 252;
const GAP = 4;
const EDGE = 8;

export function MenuHost() {
  const req = useMenu((s) => s.req);
  const close = useMenu((s) => s.close);
  const c = useThemeColors();
  const reduceMotion = useReducedMotion();
  const { width: W, height: H } = useWindowDimensions();
  const pathname = usePathname();
  const [cardH, setCardH] = useState(0);
  // Where this host sits in window coordinates. measureInWindow's origin is
  // not the host's (on Android edge-to-edge it is under the status bar while
  // the host starts above it), so the anchor is placed by the difference.
  const hostRef = useRef<View>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  // Opening: 120 ms fade + 0.96 → 1 scale from the button's corner, driven by
  // hand. Reanimated's `entering` lost this absolutely placed card's top/left
  // on Android (it drew at 0,0).
  const shown = useSharedValue(0);
  const cardStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: reduceMotion ? 1 : 0.96 + 0.04 * shown.value }],
  }));
  const [, setTick] = useState(0);
  // Picked radio / segment values, shown at once instead of waiting for the
  // caller to re-render and the sections to be rebuilt.
  const [radio, setRadio] = useState<Record<string, string>>({});
  const [segment, setSegment] = useState<Record<string, string>>({});
  const firstItem = useRef<View>(null);

  useEffect(() => {
    setCardH(0);
    setOrigin(null);
    setRadio({});
    setSegment({});
    shown.value = 0;
    if (req) requestAnimationFrame(() => hostRef.current?.measureInWindow((x, y) => setOrigin({ x, y })));
  }, [req, shown]);
  useEffect(() => {
    if (cardH && origin) shown.value = withTiming(1, { duration: 120 });
  }, [cardH, origin, shown]);

  // Leaving the screen, the keyboard or a rotation all close it. The path is
  // compared with the one the menu opened on rather than trusting the effect
  // to run only on navigation: it re-ran with the path unchanged (a radio
  // item re-rendering the screen behind) and closed a menu meant to stay open.
  const openedOn = useRef<string | null>(null);
  useEffect(() => {
    openedOn.current = req ? pathname : null;
    // Only when a menu opens or closes, not on every path change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  useEffect(() => {
    if (openedOn.current !== null && pathname !== openedOn.current) useMenu.getState().close(null);
  }, [pathname]);
  useEffect(() => {
    if (!req) return undefined;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      close(null);
      return true;
    });
    const kb = Keyboard.addListener('keyboardDidShow', () => close(null));
    const dim = Dimensions.addEventListener('change', () => close(null));
    return () => {
      back.remove();
      kb.remove();
      dim.remove();
    };
  }, [req, close]);

  if (!req) return null;
  const sections = typeof req.sections === 'function' ? req.sections() : req.sections;
  const rect = origin
    ? { ...req.rect, x: req.rect.x - origin.x, y: req.rect.y - origin.y }
    : req.rect;
  const width = Math.min(WIDTH, W - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(rect.x + rect.w - width, W - width - EDGE));
  const below = rect.y + rect.h + GAP;
  // Opens upwards when there is no room below.
  const top = cardH && below + cardH > H - EDGE ? Math.max(EDGE, rect.y - GAP - cardH) : below;
  const refresh = () => {
    setTick((n) => n + 1);
    // Again once the caller has re-rendered with the new value.
    setTimeout(() => setTick((n) => n + 1), 150);
  };
  let first = true;
  const takeFirst = () => {
    if (!first) return undefined;
    first = false;
    return firstItem;
  };

  return (
    <View ref={hostRef} collapsable={false} style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Any tap outside closes it — and only closes it: this layer takes the
          touch, so the button underneath does not fire too. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => close(null)}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      />
      <View
        style={{ position: 'absolute', top, left, width, opacity: cardH && origin ? 1 : 0 }}
        onLayout={(e) => {
          if (cardH) return;
          setCardH(e.nativeEvent.layout.height);
          const node = findNodeHandle(firstItem.current);
          if (node) AccessibilityInfo.setAccessibilityFocus(node);
        }}
      >
        <Animated.View
          accessibilityRole="menu"
          accessibilityViewIsModal
          className="rounded-[14px] border border-line bg-card dark:border-line-dark dark:bg-card-dark"
          style={[
            styles.card,
            cardStyle,
            { maxHeight: H * 0.7, transformOrigin: top < rect.y ? 'bottom right' : 'top right' },
          ]}
        >
          <ScrollView bounces={false} contentContainerStyle={{ padding: 6 }}>
            {sections.map((sec, si) => (
              <View key={si}>
                {si > 0 ? <View className="my-1.5 h-px bg-gray-100 dark:bg-gray-800" /> : null}
                {sec.title ? (
                  <Text className="px-2.5 pb-1 pt-1 text-xs font-bold tracking-widest text-gray-500 dark:text-gray-400">
                    {sec.title}
                  </Text>
                ) : null}
                {sec.items.map((item) => {
                  if (item.kind === 'action') {
                    const tint = item.destructive ? c.alert : c.ink2;
                    return (
                      <Pressable
                        key={item.id}
                        ref={takeFirst()}
                        onPress={() => close(item.id)}
                        accessibilityRole="menuitem"
                        accessibilityLabel={item.detail ? `${item.label}, ${item.detail}` : item.label}
                        className="flex-row items-center rounded-[10px] px-2.5 active:bg-gray-100 dark:active:bg-gray-800"
                        style={{ minHeight: 44 }}
                      >
                        {item.icon ? <Ionicons name={item.icon} size={20} color={tint} /> : null}
                        <Text
                          className={`${item.detail ? 'shrink-0' : 'flex-1'} text-base ${item.icon ? 'ml-3' : ''} ${
                            item.destructive ? 'text-alert dark:text-alert-dark' : 'text-ink dark:text-gray-100'
                          }`}
                          numberOfLines={1}
                        >
                          {item.label}
                        </Text>
                        {item.detail ? (
                          // The value gives way, not the label: a long project name or surveyor list is cut.
                          <Text
                            numberOfLines={1}
                            className={`ml-3 flex-1 text-right text-sm ${
                              item.attention ? 'text-alert dark:text-alert-dark' : 'text-gray-500 dark:text-gray-400'
                            }`}
                          >
                            {item.detail}
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  }
                  if (item.kind === 'radio') {
                    const checked = radio[item.group] !== undefined ? radio[item.group] === item.id : item.checked;
                    return (
                      <Pressable
                        key={item.id}
                        ref={takeFirst()}
                        onPress={() => {
                          setRadio((r) => ({ ...r, [item.group]: item.id }));
                          item.onSelect();
                          refresh();
                        }}
                        accessibilityRole="menuitem"
                        accessibilityState={{ checked }}
                        className="flex-row items-center rounded-[10px] px-2.5 active:bg-gray-100 dark:active:bg-gray-800"
                        style={{ minHeight: 44 }}
                      >
                        {item.icon ? <Ionicons name={item.icon} size={20} color={c.ink2} /> : null}
                        <Text
                          className={`flex-1 text-base text-ink dark:text-gray-100 ${item.icon ? 'ml-3' : ''}`}
                          numberOfLines={1}
                        >
                          {item.label}
                        </Text>
                        {checked ? <Ionicons name="checkmark" size={20} color={c.accent} /> : null}
                      </Pressable>
                    );
                  }
                  if (item.kind === 'segmented') {
                    const value = segment[item.id] ?? item.value;
                    return (
                      <View key={item.id} className="flex-row items-center px-2.5" style={{ minHeight: 44 }}>
                        <Text className="flex-1 text-base text-ink dark:text-gray-100" numberOfLines={1}>
                          {item.label}
                        </Text>
                        <View className="flex-row rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
                          {item.options.map((o) => {
                            const on = o.value === value;
                            return (
                              <Pressable
                                key={o.value}
                                ref={takeFirst()}
                                onPress={() => {
                                  setSegment((s) => ({ ...s, [item.id]: o.value }));
                                  item.onChange(o.value);
                                  refresh();
                                }}
                                accessibilityRole="menuitem"
                                accessibilityLabel={o.label}
                                accessibilityState={{ checked: on }}
                                hitSlop={{ top: 7, bottom: 7 }}
                                className={`h-[30px] w-9 items-center justify-center rounded-md ${
                                  on ? 'bg-card dark:bg-card-dark' : ''
                                }`}
                              >
                                <Ionicons name={o.icon} size={18} color={on ? c.ink : c.ink3} />
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    );
                  }
                  return (
                    <View key={item.id} className="flex-row gap-1.5">
                      {[item.undo, item.redo].map((k, ki) => {
                        const off = k.count === 0;
                        return (
                          <Pressable
                            key={ki}
                            ref={takeFirst()}
                            disabled={off}
                            onPress={() => {
                              k.onPress();
                              refresh();
                            }}
                            accessibilityRole="menuitem"
                            accessibilityLabel={`${k.label} ${k.count}`}
                            accessibilityState={{ disabled: off }}
                            className={`flex-1 flex-row items-center justify-center rounded-[10px] border border-line active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800 ${
                              off ? 'opacity-40' : ''
                            }`}
                            style={{ minHeight: 44 }}
                          >
                            <Ionicons name={k.icon} size={18} color={c.ink2} />
                            <Text className="ml-1.5 text-sm text-ink dark:text-gray-100">{k.label}</Text>
                            <Text
                              className="ml-1 text-sm text-gray-500 dark:text-gray-400"
                              style={{ fontVariant: ['tabular-nums'] }}
                            >
                              · {k.count}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * The button that opens a menu: 36 disc in a 44 target (like HeaderIconButton),
 * inked while its menu is open so it is clear where the card came from.
 * `pill` matches PillButton for toolbars that use those; `plain` is a bare
 * glyph for icon rows.
 */
export function MenuButton({
  onOpen,
  variant = 'disc',
  badge = false,
}: {
  /** Open the menu against the given anchor; resolve when it has closed. */
  onOpen: (anchor: RefObject<View | null>) => Promise<unknown>;
  variant?: 'disc' | 'pill' | 'plain';
  /** A dot on the button: something inside the menu still needs filling in. */
  badge?: boolean;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const anchor = useRef<View>(null);
  const [expanded, setExpanded] = useState(false);
  const press = async () => {
    setExpanded(true);
    try {
      await onOpen(anchor);
    } finally {
      setExpanded(false);
    }
  };
  const box =
    variant === 'pill'
      ? `h-11 w-11 rounded-full border ${
          expanded
            ? 'border-ink bg-ink dark:border-gray-100 dark:bg-gray-100'
            : 'border-line bg-card dark:border-line-dark dark:bg-card-dark'
        }`
      : variant === 'plain'
        ? `h-11 w-11 rounded-full ${expanded ? 'bg-gray-100 dark:bg-gray-800' : ''}`
        : `h-9 w-9 rounded-full ${expanded ? 'bg-ink dark:bg-gray-100' : 'bg-gray-100 dark:bg-gray-800'}`;
  const glyph = variant === 'plain' ? c.ink : expanded ? c.card : c.ink2;
  return (
    <Pressable
      onPress={() => void press()}
      accessibilityRole="button"
      accessibilityLabel={t('record.moreActions')}
      accessibilityHint={badge ? t('menu.hasMissing') : undefined}
      accessibilityState={{ expanded }}
      className="h-11 w-11 items-center justify-center"
    >
      <View ref={anchor} collapsable={false} className={`items-center justify-center ${box}`}>
        <Ionicons name="ellipsis-horizontal" size={variant === 'plain' ? 20 : 22} color={glyph} />
        {badge ? (
          <View className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-card bg-alert dark:border-gray-900 dark:bg-alert-dark" />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 0 10 28 rgba(31,24,20,0.18) + 0 2 6 rgba(31,24,20,0.08): RN takes one
  // shadow, so the larger; Android draws elevation.
  card: {
    shadowColor: 'rgb(31,24,20)',
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
});
