/**
 * Surface cover entry shared by GLORIA's quadrats and the fixed plot's
 * quadrats (06-plot-quadrats.md §5): one row stepping through the items, each
 * with a 「無」 box that records 0 (estimated, absent) — blank stays "not
 * estimated". The caller owns the values and their keys.
 *
 * NumField and the percent range come from the GLORIA module, where the
 * numeric keyboard bar they share (NumAccessory) lives.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { SwipeNavArea, useSwipeNav } from '~/components/SwipeNavigator';
import { CheckboxMark } from '~/components/ui/Checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { NumField } from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';
import { FONT_SCALE_VALUE, useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

/**
 * One row for a whole block of cover items (GLORIA: 7 top covers or 6
 * subtypes; the fixed plot's quadrats: the 7 top covers), like the frequency
 * target picker: ‹ [item ▾] › [value] ☐無, stepped by the arrows, a sideways
 * swipe, the keyboard's Next, or a tap on the summary line below, which shows
 * every item's value at once. Whatever is typed is committed before the row
 * moves to another item; ticking 「無」 moves on by itself.
 */
export function SurfaceCover<K extends string>({
  values,
  keys,
  labelKey,
  shortKey,
  onCommit,
  editable,
}: {
  /** Current value per key; null = not estimated, 0 = estimated absent. */
  values: Readonly<Record<K, number | null>>;
  keys: readonly K[];
  /** i18n key of an item's full name (the menu). */
  labelKey: (k: K) => string;
  /** i18n key of an item's short name (the summary line). */
  shortKey: (k: K) => string;
  onCommit: (patch: Partial<Record<K, number | null>>) => void;
  editable: boolean;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  // Text grows with the app's font setting and the system text size; the
  // row's boxes (arrows, value field, icons) grow with it. Heights follow by
  // stretching every box to the tallest one, the item menu.
  const fs = FONT_SCALE_VALUE[useSettings((x) => x.font_scale)] * useWindowDimensions().fontScale;
  const [i, setI] = useState(0);
  // Current item for callbacks bound earlier (Next on the keyboard bar).
  const iRef = useRef(0);
  iRef.current = i;
  const commitRef = useRef<(() => boolean) | null>(null);
  const go = (next: number) => {
    // Save a half-typed value to the item it was typed for, then move.
    if (commitRef.current && !commitRef.current()) return;
    setI(((next % keys.length) + keys.length) % keys.length);
  };
  const nav = useSwipeNav({ onStep: (d) => go(i + d), hasPrev: true, hasNext: true });
  const k = keys[i];
  const v = values[k];
  const none = v === 0;
  const arrow = (d: -1 | 1) => (
    <Pressable
      onPress={() => go(i + d)}
      accessibilityRole="button"
      accessibilityLabel={t(d < 0 ? 'quadrat.cover.prev' : 'quadrat.cover.next')}
      style={{ width: Math.round(32 * fs), minHeight: Math.round(40 * fs) }}
      className="items-center justify-center rounded-lg border border-gray-300 dark:border-gray-700"
    >
      <Ionicons name={d < 0 ? 'chevron-back' : 'chevron-forward'} size={Math.round(16 * fs)} color={c.ink2} />
    </Pressable>
  );
  return (
    <View className="gap-1">
      <SwipeNavArea nav={nav} style={{ flex: 0 }}>
        <View className="flex-row items-stretch gap-1.5">
          {arrow(-1)}
          {/* No label above: the trigger itself names the item. */}
          <View className="flex-1">
            <Select
              style={{ flex: 1 }}
              value={{ value: k as string, label: t(labelKey(k)) }}
              onValueChange={(o) => o && go(keys.indexOf(o.value as K))}
            >
              <SelectTrigger className="w-full flex-1" accessibilityLabel={t(labelKey(k))}>
                <SelectValue placeholder={t(labelKey(k))} />
              </SelectTrigger>
              <SelectContent>
                {keys.map((x) => (
                  <SelectItem key={x} value={x as string} label={t(labelKey(x))} />
                ))}
              </SelectContent>
            </Select>
          </View>
          {arrow(1)}
          <NumField
            value={v}
            onCommit={(n) => onCommit({ [k]: n } as Partial<Record<K, number | null>>)}
            onSubmitEditing={() => go(iRef.current + 1)}
            onPrev={() => go(iRef.current - 1)}
            commitRef={commitRef}
            target={k as string}
            accessibilityLabel={t(labelKey(k))}
            width={Math.round(56 * fs)}
            range={RANGES.percent}
            editable={editable}
          />
          <Pressable
            onPress={() => {
              onCommit({ [k]: none ? null : 0 } as Partial<Record<K, number | null>>);
              // Ticked: on to the next item (not past the last). Anything
              // half-typed is dropped, not committed: 「無」 is the answer.
              if (!none && i < keys.length - 1) setI(i + 1);
            }}
            disabled={!editable}
            hitSlop={6}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: none, disabled: !editable }}
            accessibilityLabel={`${t(labelKey(k))} ${t('quadrat.cover.none')}`}
            className="flex-row items-center"
          >
            <CheckboxMark checked={none} />
            <Text className="text-xxs text-gray-500 dark:text-gray-400">{t('quadrat.cover.none')}</Text>
          </Pressable>
        </View>
      </SwipeNavArea>
      {/* Every item at a glance; tap one to jump to it. */}
      <View className="flex-row flex-wrap">
        {keys.map((x, n) => {
          const val = values[x];
          return (
            <Pressable key={x} onPress={() => go(n)} hitSlop={4} className="mr-2 py-0.5">
              <Text
                className={`text-xs ${n === i ? 'font-bold text-accent-700 dark:text-accent-300' : val == null ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {t(shortKey(x))} {val ?? '–'}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
