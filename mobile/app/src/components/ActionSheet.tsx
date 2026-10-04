/**
 * The app's action sheet: the 15A bottom list sheet (07-action-sheet.md §2),
 * the same on iOS and Android. ActionSheetIOS is no longer used: new iOS draws
 * it as a centred glass menu with no icons, descriptions, groups or search.
 *
 *   const i = await showActionSheet({
 *     title: '建立記錄',
 *     options: [
 *       { label: '快速名錄', icon: 'list' },
 *       { label: '樣區調查', description: '分層、覆蓋度、小區' },
 *       { label: '刪除', destructive: true },
 *     ],
 *   });
 *   if (i >= 0) doSomething(i);
 *
 * Resolves with the index into `options` of the one picked, or -1 (✕, a tap
 * on the dim, a swipe down, Android back). It resolves only once the sheet
 * has finished sliding away, so a caller may open a Modal straight after.
 *
 * Layers. The sheet is not an RN Modal: it draws in an <ActionSheetLayer />,
 * a plain overlay like MenuHost. One sits in app/_layout.tsx; every component
 * that renders an RN <Modal> puts one last inside it (check:sheet-layer), as
 * a Modal covers the root one. A sheet opens in the layer mounted last — the
 * topmost — and is cancelled (-1) if that layer goes away under it.
 *
 * Android back inside a Modal goes to the Modal's onRequestClose, never to
 * BackHandler: wrap it in `sheetBack(…)` so it closes an open sheet first.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { Button } from '~/components/ui/Button';
import { Chip } from '~/components/ui/Chip';
import { IconDisc } from '~/components/ui/IconDisc';
import { ListRow } from '~/components/ui/ListRow';
import { NameParts } from '~/components/NameParts';
import { partsText, type NamePart } from '~/lib/nameParts';
import {
  isConfirmation,
  layoutSheet,
  markMatch,
  optionKey,
  pushRecent,
  searchShown,
  type SheetSection,
} from '~/lib/actionSheetCore';
import { useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

export type ActionSheetOption = {
  label: string;
  /** In the alert colour, moved to the end in a group of its own. */
  destructive?: boolean;
  /** One line under the label. */
  description?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Group heading; consecutive options with the same section are grouped. */
  section?: string;
  disabled?: boolean;
  /** Shown instead of the description while disabled. */
  disabledReason?: string;
  /** The current value: a check at the end (pick a layer, a subplot). */
  selected?: boolean;
  /** Extra text the search matches (a scientific name, a code). */
  keywords?: string;
  /** What `recentKey` remembers this option by; the label when not given. */
  key?: string;
  /**
   * The label / description with scientific names, each in italics by rank
   * (src/lib/nameParts.ts), shown instead of the plain text; the plain text
   * stays what the search matches. `nameOption()` fills both.
   */
  labelParts?: readonly NamePart[];
  descriptionParts?: readonly NamePart[];
};

/** An option whose label has scientific names: shown in italics, searched as plain text. */
export function nameOption(parts: readonly NamePart[], extra: Omit<ActionSheetOption, 'label' | 'labelParts'> = {}): ActionSheetOption {
  return { label: partsText(parts), labelParts: parts, ...extra };
}

export type ActionSheetRequest = {
  title?: string;
  message?: string;
  /** Title / message with scientific names (italic by rank), instead of `title` / `message`. */
  titleParts?: readonly NamePart[];
  messageParts?: readonly NamePart[];
  options: ActionSheetOption[];
  /** Kept for the callers that pass it: the ✕ button's accessibility label. */
  cancelLabel?: string;
  /** 'auto' (the default): a search box above 8 options. */
  search?: boolean | 'auto';
  /** A row of chips under the search box; one is chosen at a time, besides 全部. */
  filters?: { label: string; match: (o: ActionSheetOption) => boolean }[];
  /** Remember the last picks under this key: a 最近用過 group on top (at most 3). */
  recentKey?: string;
};

/** Slide in / out; the promise resolves once the slide out is over. */
const ANIM_MS = 200;
/** Share of the window the sheet may take. */
const MAX_SHARE = 0.88;
/** A wide screen keeps the sheet this wide, centred. */
const MAX_WIDTH = 640;

type OpenSheet = {
  seq: number;
  req: ActionSheetRequest;
  /** The layer it draws in. */
  layer: number;
  resolve: (index: number) => void;
  /** Set when it starts to close: the index it will resolve with. */
  closing: number | null;
};

type SheetStore = { layers: number[]; open: OpenSheet | null };

const useSheets = create<SheetStore>(() => ({ layers: [], open: null }));

let nextLayer = 1;
let nextSeq = 1;

function finish(seq: number) {
  const open = useSheets.getState().open;
  if (!open || open.seq !== seq) return;
  useSheets.setState({ open: null });
  const index = open.closing ?? -1;
  const picked = index >= 0 ? open.req.options[index] : undefined;
  if (picked && !picked.destructive && open.req.recentKey) rememberPick(open.req.recentKey, optionKey(picked));
  open.resolve(index);
}

function rememberPick(recentKey: string, key: string) {
  const settings = useSettings.getState();
  if (!settings.loaded) return;
  const all = settings.action_sheet_recent;
  settings.set('action_sheet_recent', { ...all, [recentKey]: pushRecent(all[recentKey] ?? [], key) });
}

/** Starts the slide out; resolves with `index` once it is over. */
function closeSheet(index: number) {
  const open = useSheets.getState().open;
  if (!open || open.closing !== null) return;
  useSheets.setState({ open: { ...open, closing: index } });
  setTimeout(() => finish(open.seq), ANIM_MS);
}

/** Imperative API. Resolves with the chosen option's index, or -1 if cancelled. */
export function showActionSheet(req: ActionSheetRequest): Promise<number> {
  return new Promise<number>((resolve) => {
    const { layers, open } = useSheets.getState();
    // One sheet at a time: a new one replaces whatever is still up.
    if (open) {
      useSheets.setState({ open: null });
      open.resolve(open.closing ?? -1);
    }
    const layer = layers[layers.length - 1];
    if (layer === undefined) {
      if (__DEV__) console.warn('showActionSheet: no <ActionSheetLayer /> mounted');
      resolve(-1);
      return;
    }
    useSheets.setState({ open: { seq: nextSeq++, req, layer, resolve, closing: null } });
  });
}

/** Closes an open sheet as cancelled. True when there was one (the back press is spent). */
export function dismissActionSheet(): boolean {
  const open = useSheets.getState().open;
  if (!open) return false;
  closeSheet(-1);
  return true;
}

/**
 * A Modal's onRequestClose (Android back; iOS page-sheet swipe): an action
 * sheet open over the Modal closes first, the Modal on the next press.
 */
export function sheetBack(close?: () => void): () => void {
  return () => {
    if (!dismissActionSheet()) close?.();
  };
}

/**
 * Where action sheets draw. One in app/_layout.tsx, and one last inside every
 * RN <Modal>, given that Modal's `visible`: iOS keeps a closed Modal's
 * children mounted until its slide-out is over, so without it a sheet asked
 * for in that time (close, wait, then ask: how the next step usually opens)
 * would land in the Modal going away and be cancelled with it, unseen.
 */
export function ActionSheetLayer({ visible = true }: { visible?: boolean }) {
  const [id] = useState(() => nextLayer++);
  // Before paint: a sheet asked for as a Modal opens lands in the Modal's layer.
  useLayoutEffect(() => {
    if (!visible) return;
    useSheets.setState((s) => ({ layers: [...s.layers, id] }));
    return () => {
      const { layers, open } = useSheets.getState();
      useSheets.setState({ layers: layers.filter((x) => x !== id) });
      // The layer went away under its sheet (its Modal closed): cancelled,
      // unless an option had already been picked.
      if (open?.layer === id) {
        useSheets.setState({ open: null });
        open.resolve(open.closing ?? -1);
      }
    };
  }, [id, visible]);
  const open = useSheets((s) => (s.open?.layer === id ? s.open : null));
  if (!open) return null;
  return <SheetView key={open.seq} open={open} />;
}

/** Grabber, title and ✕; dragging it down closes the sheet. */
function SheetTop({
  title,
  message,
  closeLabel,
  onClose,
  titleRef,
}: {
  title?: string | readonly NamePart[];
  message?: string | readonly NamePart[];
  closeLabel: string;
  onClose: () => void;
  titleRef?: RefObject<Text | null>;
}) {
  return (
    <>
      <View className="items-center pb-1 pt-2">
        <View className="h-[5px] w-9 rounded-full bg-gray-300 dark:bg-gray-600" />
      </View>
      <View className="flex-row items-start pl-4 pr-2">
        <View className="flex-1 pb-2 pt-1.5">
          {title ? (
            <Text ref={titleRef} accessibilityRole="header" className="text-xl font-bold text-ink dark:text-gray-100">
              {typeof title === 'string' ? title : <NameParts parts={title} bold />}
            </Text>
          ) : null}
          {message ? (
            <Text className="mt-0.5 text-[13px] leading-[18px] text-ink-3 dark:text-gray-400">
              {typeof message === 'string' ? message : <NameParts parts={message} />}
            </Text>
          ) : null}
        </View>
        <IconDisc icon="close" onPress={onClose} accessibilityLabel={closeLabel} />
      </View>
    </>
  );
}

/** `text` with the search match on an acorn-tint ground; with `names`, those parts instead (names in italics, no mark). */
function Marked({ text, names, query, className, lines }: { text: string; names?: readonly NamePart[]; query: string; className: string; lines?: number }) {
  if (names) {
    return (
      <Text className={className} numberOfLines={lines}>
        <NameParts parts={names} />
      </Text>
    );
  }
  const parts = query ? markMatch(text, query) : null;
  return (
    <Text className={className} numberOfLines={lines}>
      {parts ? (
        <>
          {parts[0]}
          <Text className="bg-acorn-tint dark:bg-acorn-deep">{parts[1]}</Text>
          {parts[2]}
        </>
      ) : (
        text
      )}
    </Text>
  );
}

function OptionRow({ o, query, divider, onPress }: { o: ActionSheetOption; query: string; divider: boolean; onPress: () => void }) {
  const c = useThemeColors();
  const reason = o.disabled && o.disabledReason ? o.disabledReason : null;
  const detail = reason ?? o.description;
  const detailNames = reason ? undefined : o.descriptionParts;
  return (
    <ListRow
      onPress={onPress}
      disabled={o.disabled}
      divider={divider}
      accessibilityRole="button"
      accessibilityState={{ selected: !!o.selected }}
      leading={
        o.icon ? (
          <View
            className={`h-10 w-10 items-center justify-center rounded-xl ${
              o.destructive ? 'bg-alert-tint dark:bg-alert-dark-tint' : 'bg-acorn-wash dark:bg-gray-800'
            }`}
          >
            <Ionicons name={o.icon} size={20} color={o.destructive ? c.alert : c.cupule} />
          </View>
        ) : undefined
      }
      title={
        <Marked
          text={o.label}
          names={o.labelParts}
          query={query}
          className={`text-base font-medium ${o.destructive ? 'text-alert dark:text-alert-dark' : 'text-ink dark:text-gray-100'}`}
        />
      }
      subtitle={
        detail || detailNames ? (
          <Marked text={detail ?? ''} names={detailNames} query={query} className="text-[13px] leading-[18px] text-ink-3 dark:text-gray-400" />
        ) : undefined
      }
      trailing={o.selected ? <Ionicons name="checkmark" size={22} color={c.accent} style={{ marginRight: 8 }} /> : undefined}
    />
  );
}

function SheetView({ open }: { open: OpenSheet }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const { req } = open;
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const keyboard = useReanimatedKeyboardAnimation();
  const recent = useSettings((s) => (req.recentKey ? s.action_sheet_recent[req.recentKey] : undefined));

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  // The recent group as the sheet opened: a pick does not reshuffle it under the finger.
  const [recentAtOpen] = useState(() => recent ?? []);
  const sections = useMemo<SheetSection[]>(
    () =>
      layoutSheet(req.options, {
        query,
        match: filter === null ? undefined : (o) => req.filters![filter].match(o as ActionSheetOption),
        recent: recentAtOpen,
      }),
    [req, query, filter, recentAtOpen],
  );

  // Slide in on mount, out when `closing` is set; a drag on the top follows the finger.
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);
  const sheetH = useSharedValue(H);
  useEffect(() => {
    shown.value = withTiming(open.closing === null ? 1 : 0, { duration: ANIM_MS });
  }, [open.closing, shown]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? shown.value : 1,
    paddingBottom: Math.max(insets.bottom, -keyboard.height.value),
    transform: [{ translateY: (reduceMotion ? 0 : (1 - shown.value) * sheetH.value) + drag.value }],
  }));

  const cancel = () => closeSheet(-1);
  // A gesture-handler pan, not a PanResponder: inside a Modal whose content
  // has its own GestureHandlerRootView (the species sheet), a PanResponder
  // here was never granted the drag (Android, 2026-10-03).
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(6)
        .failOffsetX([-24, 24])
        .onUpdate((e) => {
          drag.value = Math.max(0, e.translationY);
        })
        .onEnd((e) => {
          if (e.translationY > sheetH.value * 0.3 || e.velocityY > 1000) runOnJS(closeSheet)(-1);
          else drag.value = withTiming(0, { duration: 150 });
        }),
    [drag, sheetH],
  );

  // Android back, for a sheet in the root layer (inside a Modal: sheetBack).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSheet(-1);
      return true;
    });
    return () => sub.remove();
  }, []);

  // Screen readers start at the title.
  const titleRef = useRef<Text>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const node = findNodeHandle(titleRef.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, ANIM_MS);
    return () => clearTimeout(timer);
  }, []);

  const pick = (i: number) => closeSheet(i);
  const confirm = isConfirmation(req.options);
  const withSearch = !confirm && searchShown(req.search, req.options.length);
  const total = req.options.length;
  const closeLabel = req.cancelLabel ?? t('actionSheet.close');

  let body: ReactNode;
  if (confirm) {
    const o = req.options[0];
    body = (
      <View className="px-4 pb-3 pt-2">
        {o.description || o.descriptionParts ? (
          <Text className="mb-3 text-sm text-ink-3 dark:text-gray-400">{o.descriptionParts ? <NameParts parts={o.descriptionParts} /> : o.description}</Text>
        ) : null}
        <Button label={o.label} variant="danger" size="lg" fullWidth icon={o.icon} onPress={() => pick(0)} />
      </View>
    );
  } else {
    const empty = query.trim() !== '' && sections.length === 0;
    body = (
      <>
        {withSearch ? (
          <View className="px-4 pb-2">
            <View
              className="flex-row items-center rounded-full border-[1.5px] border-gray-300 bg-paper px-3 dark:border-gray-600 dark:bg-paper-dark"
              style={{ minHeight: 44 }}
            >
              <Ionicons name="search" size={18} color={c.ink3} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                onFocus={() => setSearching(true)}
                placeholder={t('actionSheet.searchPlaceholder', { count: total })}
                placeholderTextColor={c.ink3}
                accessibilityLabel={t('actionSheet.search')}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                className="ml-2 flex-1 py-2 text-base text-ink dark:text-gray-100"
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.clear')}>
                  <Ionicons name="close-circle" size={18} color={c.ink3} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
        {req.filters?.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }} accessibilityRole="tablist">
            <Chip label={t('actionSheet.all', { count: total })} selected={filter === null} onPress={() => setFilter(null)} />
            {req.filters.map((f, i) => (
              <Chip key={f.label} label={f.label} count={req.options.filter((o) => f.match(o)).length} selected={filter === i} onPress={() => setFilter(i)} />
            ))}
          </ScrollView>
        ) : null}
        {empty ? (
          <Text className="px-4 py-6 text-center text-sm text-ink-3 dark:text-gray-400">{t('actionSheet.noMatch', { q: query.trim() })}</Text>
        ) : (
          <SectionList
            sections={sections.map((s) => ({ ...s, data: s.rows }))}
            keyExtractor={(i, n) => `${i}:${n}`}
            stickySectionHeadersEnabled
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            initialNumToRender={24}
            style={{ flexGrow: 0, flexShrink: 1 }}
            renderSectionHeader={({ section }) =>
              section.kind === 'destructive' ? (
                sections.length > 1 ? <View className="h-2 bg-card dark:bg-card-dark" /> : null
              ) : section.kind === 'recent' || section.title ? (
                <View className="flex-row items-center bg-card px-4 pb-1 pt-3 dark:bg-card-dark">
                  <Text className="flex-1 text-xs font-bold tracking-[0.04em] text-cupule dark:text-gray-300">
                    {section.kind === 'recent' ? t('actionSheet.recent') : section.title}
                  </Text>
                  <Text className="text-xs text-ink-3 dark:text-gray-400" style={{ fontVariant: ['tabular-nums'] }}>
                    {section.rows.length}
                  </Text>
                </View>
              ) : null
            }
            renderItem={({ item, index, section }) => (
              <OptionRow o={req.options[item]} query={query} divider={index < section.rows.length - 1} onPress={() => pick(item)} />
            )}
          />
        )}
      </>
    );
  }

  return (
    // Its own gesture root: a Modal is a window of its own, which the app's root does not reach.
    <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, dimStyle]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          className="bg-black/40"
          onPress={cancel}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        onLayout={(e) => {
          sheetH.value = e.nativeEvent.layout.height;
        }}
        className="overflow-hidden rounded-t-sheet bg-card dark:bg-card-dark"
        style={[
          {
            position: 'absolute',
            bottom: 0,
            width: Math.min(W, MAX_WIDTH),
            left: (W - Math.min(W, MAX_WIDTH)) / 2,
            maxHeight: H * MAX_SHARE,
            // Typing into the search: the full height, so the results do not jump about.
            ...(searching ? { height: H * MAX_SHARE } : null),
          },
          sheetStyle,
        ]}
      >
        <GestureDetector gesture={pan}>
          <View>
            <SheetTop title={req.titleParts ?? req.title} message={req.messageParts ?? req.message} closeLabel={closeLabel} onClose={cancel} titleRef={titleRef} />
          </View>
        </GestureDetector>
        {body}
      </Animated.View>
    </GestureHandlerRootView>
  );
}
