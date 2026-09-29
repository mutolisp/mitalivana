/**
 * The species pickers every grid screen shares — the fixed plot's frequency
 * tab, a quadrat's frequency, GLORIA's 1×1 m frequency and its point
 * recording — so they look and behave the same (06-plot-quadrats design 10d,
 * user decision 2026-09-29):
 *
 *   - SpeciesPager: ‹ [card] › with a row of dots. The card shows the
 *     species' name, layer, scientific name, cover and position, and its
 *     cells; a sideways swipe or the arrows step through the species, a tap
 *     drops the list down (the same menu as GLORIA's dropdowns: name · cells,
 *     ✓ on the current one). Used where the grid is painted (筆刷).
 *   - SpeciesToggleCard: a dropdown over a big card — name and count on one
 *     line, the scientific name under it — filled while the species is in the
 *     current cell / point; a tap toggles it, a long press puts it in and
 *     moves on. Used cell by cell (逐格) and point by point. The how-to line
 *     is the caller's, at the foot of the page, so the card stays compact.
 *
 * Species share one colour (user decision 2026-09-29): no swatch; only
 * GLORIA's Hi1–Hi3 keep theirs. A species without a vernacular name shows its
 * scientific name, italic by the usual rule, on up to two lines.
 */
import { Ionicons } from '@expo/vector-icons';
import * as SelectPrimitive from '@rn-primitives/select';
import * as Haptics from 'expo-haptics';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { ScientificName } from '~/components/ScientificName';
import { useSwipeBlock } from '~/components/SwipeNavigator';
import { Select, SelectContent, SelectItem, SelectTrigger } from '~/components/ui/select';
import { Tag } from '~/components/ui/Tag';
import { useThemeColors } from '~/theme/colors';

export type PagerSpecies = {
  key: string;
  /** Full display name, for the menu and screen readers. */
  name: string;
  cname: string | null;
  sci: string | null;
  /** A morphospecies label or field determination, after the name. */
  qualifier?: string | null;
  /** The species' layer in the plot list ("灌木層"), when it has one. */
  layer: string | null;
  /** Only for what is not a species (GLORIA's Hi1–Hi3): species share one colour. */
  color?: string;
  cover: number | null;
  cells: number;
  /** Cover but no cells yet. */
  missing: boolean;
};

/** The dropdown both pickers open: every species with its count, ✓ on `value`. */
function SpeciesMenu({
  items,
  value,
  onPick,
  children,
}: {
  items: readonly PagerSpecies[];
  value: string | null;
  onPick: (i: number) => void;
  /** The trigger. */
  children: React.ReactNode;
}) {
  // The layer tells two records of one taxon apart (a plot list may hold it in two layers).
  const label = (s: PagerSpecies) => `${s.name}${s.layer ? `（${s.layer}）` : ''} · ${s.cells}`;
  const cur = items.find((s) => s.key === value);
  return (
    <Select
      value={cur ? { value: cur.key, label: label(cur) } : undefined}
      onValueChange={(o) => {
        const i = o ? items.findIndex((s) => s.key === o.value) : -1;
        if (i >= 0) onPick(i);
      }}
    >
      {children}
      <SelectContent>
        {items.map((s) => (
          <SelectItem key={s.key} value={s.key} label={label(s)} />
        ))}
      </SelectContent>
    </Select>
  );
}

/** Horizontal swipe to step, so a vertical scroll of the page still passes through. */
function useSideSwipe(step: (dir: -1 | 1) => void, deps: unknown[]) {
  // The screen's own sideways swipe (a plot's tabs) waits for this one.
  const block = useSwipeBlock();
  return useMemo(
    () => {
      const pan = Gesture.Pan()
        .runOnJS(true)
        .activeOffsetX([-16, 16])
        .failOffsetY([-12, 12])
        .onEnd((e) => {
          if (e.translationX < -40) step(1);
          else if (e.translationX > 40) step(-1);
        });
      return block ? pan.blocksExternalGesture(block) : pan;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps, block],
  );
}

function Arrow({ dir, off, onPress }: { dir: -1 | 1; off: boolean; onPress: () => void }) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={t(dir < 0 ? 'common.previous' : 'common.next')}
      className={`w-12 items-center justify-center self-stretch rounded-2xl border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800 ${
        off ? 'opacity-35' : ''
      }`}
    >
      <Ionicons name={dir < 0 ? 'chevron-back' : 'chevron-forward'} size={20} color={c.ink} />
    </Pressable>
  );
}

/** Vernacular name, else the scientific name (up to two lines); the qualifier after it. */
function SpeciesTitle({ s, className, lines = 2 }: { s: PagerSpecies; className: string; lines?: number }) {
  const q = s.qualifier ? <Text className="font-normal">{` ${s.qualifier}`}</Text> : null;
  if (s.cname || !s.sci) {
    return (
      <Text className={className} numberOfLines={lines}>
        {s.cname || s.name}
        {q}
      </Text>
    );
  }
  return (
    <Text className={className} numberOfLines={lines}>
      <ScientificName name={s.sci} className={className} />
      {q}
    </Text>
  );
}

function useStepper(count: number, index: number, onIndex: (i: number) => void, wrap: boolean) {
  const step = (dir: -1 | 1) => {
    if (count < 2) return;
    let next = index + dir;
    if (wrap) next = (next + count) % count;
    else if (next < 0 || next >= count) return;
    void Haptics.selectionAsync();
    onIndex(next);
  };
  const swipe = useSideSwipe(step, [index, count]);
  const off = (dir: -1 | 1) => count < 2 || (!wrap && (dir < 0 ? index <= 0 : index >= count - 1));
  return { step, swipe, off };
}

export function SpeciesPager({
  items,
  index,
  total,
  onIndex,
  compact,
  trailing,
}: {
  items: readonly PagerSpecies[];
  index: number;
  /** Cells in the grid (n²). */
  total: number;
  onIndex: (i: number) => void;
  /** Lower card (the keypad is shown under it): scientific name and cover share a line. */
  compact?: boolean;
  /** At the right end of the dots row (the keypad switch). */
  trailing?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const cur = items[index];
  const { step, swipe, off } = useStepper(items.length, index, onIndex, false);
  if (!cur) return null;
  const meta = [cur.cover != null ? `${t('plot.quadrats.cover')} ${cur.cover}%` : null, `${index + 1}/${items.length}`].filter(Boolean).join(' · ');
  return (
    <View className="gap-2">
      <View className="flex-row gap-2">
        <Arrow dir={-1} off={off(-1)} onPress={() => step(-1)} />
        <GestureDetector gesture={swipe}>
          <View className="flex-1">
            <SpeciesMenu items={items} value={cur.key} onPick={onIndex}>
              <SelectPrimitive.Trigger asChild>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${cur.name}, ${cur.cells} / ${total}`}
                  accessibilityHint={t('plot.quadrats.pagerHint')}
                  className={`flex-row items-center rounded-2xl border-2 border-accent-600 bg-card px-4 active:opacity-80 dark:border-accent-400 dark:bg-card-dark ${
                    compact ? 'min-h-[60px] py-2' : 'min-h-[76px] py-3'
                  }`}
                >
                  <View className="flex-1 pr-2">
                    <View className="flex-row flex-wrap items-center gap-x-1.5">
                      <View className="shrink">
                        <SpeciesTitle s={cur} className="text-lg font-bold text-ink dark:text-gray-100" />
                      </View>
                      {cur.layer ? <Tag kind="acorn" label={cur.layer} /> : null}
                    </View>
                    {compact ? (
                      <Text className="text-sm text-ink-2 dark:text-gray-300" numberOfLines={1}>
                        {cur.cname && cur.sci ? <ScientificName name={cur.sci} className="text-sm text-ink-2 dark:text-gray-300" /> : null}
                        {cur.cname && cur.sci ? ' · ' : ''}
                        {meta}
                      </Text>
                    ) : (
                      <>
                        {cur.cname && cur.sci ? <ScientificName name={cur.sci} numberOfLines={1} className="text-sm text-ink-2 dark:text-gray-300" /> : null}
                        <Text className="mt-0.5 text-sm text-ink-2 dark:text-gray-300" numberOfLines={1}>
                          {meta}
                        </Text>
                      </>
                    )}
                  </View>
                  <View className="items-end">
                    <Text className="text-3xl font-bold text-ink dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
                      {cur.cells}
                    </Text>
                  </View>
                </Pressable>
              </SelectPrimitive.Trigger>
            </SpeciesMenu>
          </View>
        </GestureDetector>
        <Arrow dir={1} off={off(1)} onPress={() => step(1)} />
      </View>
      {items.length > 1 || trailing ? (
        <View className="flex-row items-center">
          <View className="flex-1" />
          <View className="flex-row flex-wrap justify-center gap-1.5" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {items.length > 1
              ? items.map((it, i) =>
                  i === index ? (
                    <View key={it.key} className="h-1.5 w-5 rounded-full bg-ink dark:bg-gray-100" />
                  ) : (
                    <View key={it.key} className={`h-1.5 w-1.5 rounded-full ${it.missing ? 'bg-alert dark:bg-alert-dark' : 'bg-mark dark:bg-mark-dark'}`} />
                  ),
                )
              : null}
          </View>
          <View className="flex-1 items-end">{trailing}</View>
        </View>
      ) : null}
    </View>
  );
}

export function SpeciesToggleCard({
  items,
  index,
  onIndex,
  on,
  onToggle,
  onLongPress,
  count,
  hint,
  pickLabel,
  disabled,
}: {
  items: readonly PagerSpecies[];
  index: number;
  onIndex: (i: number) => void;
  /** The shown species is in the current cell / point. */
  on: boolean;
  onToggle: () => void;
  /** Put it in and move on. */
  onLongPress?: () => void;
  /** Cells (or hits) so far, after the name. */
  count: number;
  hint: string;
  /** The dropdown's accessibility label. */
  pickLabel: string;
  disabled?: boolean;
}) {
  const c = useThemeColors();
  const cur = items[index];
  const { step, swipe, off } = useStepper(items.length, index, onIndex, true);
  if (!cur) return null;
  return (
    <GestureDetector gesture={swipe}>
      <View className="flex-row items-stretch gap-2">
        <Arrow dir={-1} off={off(-1)} onPress={() => step(-1)} />
        <View className="flex-1 gap-1.5">
          <SpeciesMenu items={items} value={cur.key} onPick={onIndex}>
            <SelectTrigger className="w-full" accessibilityLabel={pickLabel}>
              {cur.color ? <View className="mr-2 h-3 w-3 rounded-sm" style={{ backgroundColor: cur.color }} /> : null}
              <Text className="flex-1 text-base text-gray-900 dark:text-gray-100" numberOfLines={1}>
                {cur.name}
              </Text>
            </SelectTrigger>
          </SpeciesMenu>
          <Pressable
            onPress={onToggle}
            onLongPress={onLongPress}
            disabled={disabled}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled: !!disabled }}
            accessibilityLabel={cur.name}
            accessibilityHint={hint}
            style={on ? { backgroundColor: c.accent, borderColor: c.accent } : undefined}
            className={`min-h-[76px] justify-center rounded-xl border-2 border-gray-300 bg-card px-4 py-3 dark:border-gray-700 dark:bg-gray-900 ${
              disabled ? 'opacity-50' : ''
            }`}
          >
            {/* Name and count on one line, the scientific name under it. */}
            <View className="w-full flex-row items-center gap-3">
              <View className="flex-1">
                {/* One line: the dropdown above carries the whole name. */}
                <SpeciesTitle s={cur} lines={1} className={`text-xl font-bold ${on ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`} />
              </View>
              <Text className={`text-3xl font-bold ${on ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`} style={{ fontVariant: ['tabular-nums'] }}>
                {count}
              </Text>
            </View>
            {cur.cname && cur.sci ? (
              <ScientificName
                name={cur.sci}
                numberOfLines={1}
                className={`w-full text-sm ${on ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}
              />
            ) : null}
          </Pressable>
        </View>
        <Arrow dir={1} off={off(1)} onPress={() => step(1)} />
      </View>
    </GestureDetector>
  );
}
