/**
 * Surface top cover (manual p.40, Work Step H / L) and the six lichen /
 * bryophyte subtypes. In zh-TW the block is 「地表覆蓋估測(%)」.
 *
 * Each block is one row stepping through its items (CoverStepper). Each item
 * has a 「無」 box: ticking it records 0 (estimated, absent), unticking clears
 * it (not estimated yet). Blank and 0 stay distinct, so the
 * last blank of the seven can still be completed to 100 (autoFillLast).
 */
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { SwipeNavArea, useSwipeNav } from '~/components/SwipeNavigator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { FONT_SCALE_VALUE, useSettings } from '~/stores/settings';
import type { GloriaUnit, UnitPatch } from '../db';
import { NumField } from './ui';
import { RANGES } from '../model/ranges';
import { autoFillLast, exactSum } from '../model/validate';

export const TOP_KEYS = [
  'cov_vascular',
  'cov_solid_rock',
  'cov_scree',
  'cov_lichens',
  'cov_bryophytes',
  'cov_bare_ground',
  'cov_litter',
] as const;
export const SUB_KEYS = [
  'sub_lich_below_vasc',
  'sub_lich_on_rock',
  'sub_lich_on_scree',
  'sub_bry_below_vasc',
  'sub_bry_on_rock',
  'sub_bry_on_scree',
] as const;

export function topSum(u: GloriaUnit): number | null {
  const vals = TOP_KEYS.map((k) => u[k]);
  if (vals.every((v) => v == null)) return null;
  return exactSum(vals.reduce<number>((a, v) => a + (v ?? 0), 0));
}

/**
 * One row for a whole block (7 top covers or 6 subtypes), like the frequency
 * target picker: ‹ [item ▾] › [value] ☐無, stepped by the arrows, a sideways
 * swipe, the keyboard's Next, or a tap on the summary line below, which shows
 * every item's value at once. Whatever is typed is committed before the row
 * moves to another item; ticking 「無」 moves on by itself.
 */
function CoverStepper({
  unit,
  keys,
  labelKey,
  onCommit,
  editable,
}: {
  unit: GloriaUnit;
  keys: readonly (keyof UnitPatch & keyof GloriaUnit)[];
  labelKey: (k: string) => string;
  onCommit: (patch: UnitPatch) => void;
  editable: boolean;
}) {
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
  const v = unit[k] as number | null;
  const none = v === 0;
  const arrow = (d: -1 | 1) => (
    <Pressable
      onPress={() => go(i + d)}
      accessibilityRole="button"
      accessibilityLabel={t(d < 0 ? 'gloria.cover.prev' : 'gloria.cover.next')}
      style={{ width: Math.round(32 * fs), minHeight: Math.round(40 * fs) }}
      className="items-center justify-center rounded-lg border border-gray-300 dark:border-gray-700"
    >
      <Ionicons name={d < 0 ? 'chevron-back' : 'chevron-forward'} size={Math.round(16 * fs)} color="#6b7280" />
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
              onValueChange={(o) => o && go(keys.indexOf(o.value as (typeof keys)[number]))}
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
            onCommit={(n) => onCommit({ [k]: n })}
            onSubmitEditing={() => go(iRef.current + 1)}
            commitRef={commitRef}
            target={k as string}
            accessibilityLabel={t(labelKey(k))}
            width={Math.round(56 * fs)}
            range={RANGES.percent}
            editable={editable}
          />
          <Pressable
            onPress={() => {
              onCommit({ [k]: none ? null : 0 });
              // Ticked: on to the next item (not past the last). Anything
              // half-typed is dropped, not committed: 「無」 is the answer.
              if (!none && i < keys.length - 1) setI(i + 1);
            }}
            disabled={!editable}
            hitSlop={6}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: none, disabled: !editable }}
            accessibilityLabel={`${t(labelKey(k))} ${t('gloria.cover.none')}`}
            className="flex-row items-center"
          >
            <Ionicons name={none ? 'checkbox' : 'square-outline'} size={Math.round(18 * fs)} color={none ? '#00A2A5' : '#9ca3af'} />
            <Text className="text-xxs text-gray-500 dark:text-gray-400">{t('gloria.cover.none')}</Text>
          </Pressable>
        </View>
      </SwipeNavArea>
      {/* Every item at a glance; tap one to jump to it. */}
      <View className="flex-row flex-wrap">
        {keys.map((x, n) => {
          const val = unit[x] as number | null;
          return (
            <Pressable key={x} onPress={() => go(n)} hitSlop={4} className="mr-2 py-0.5">
              <Text
                className={`text-xs ${n === i ? 'font-bold text-[#00797b] dark:text-cyan-300' : 'text-gray-500 dark:text-gray-400'}`}
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {t(`gloria.cover.short.${x}`)} {val ?? '–'}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function TopCoverFields({ unit, onCommit, editable = true }: { unit: GloriaUnit; onCommit: (p: UnitPatch) => void; editable?: boolean }) {
  const { t } = useTranslation();
  // Filling the sixth of seven completes the seventh (model/validate autoFillLast).
  const commitTop = (p: UnitPatch) => {
    const edited = Object.keys(p)[0] as (typeof TOP_KEYS)[number];
    const next = Object.fromEntries(TOP_KEYS.map((k) => [k, k in p ? (p as Record<string, number | null>)[k] : unit[k]])) as Record<
      (typeof TOP_KEYS)[number],
      number | null
    >;
    const fill = autoFillLast(next, TOP_KEYS, edited);
    onCommit(fill ? { ...p, [fill.key]: fill.value } : p);
  };
  const sum = topSum(unit);
  const ok = sum != null && Math.abs(sum - 100) < 1e-9;
  // Foldable like the subtypes; folded, the header still shows the total.
  const [open, setOpen] = useState(true);
  const total =
    sum != null ? (
      <Text className={`text-xs font-semibold ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
        {ok ? t('gloria.cover.sumOk', { sum }) : t('gloria.cover.sumBad', { sum })}
      </Text>
    ) : null;
  return (
    <View className="gap-1">
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center"
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color="#9ca3af" />
        <Text className="ml-1 flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{t('gloria.cover.title')}</Text>
        {open ? null : total}
      </Pressable>
      {open ? (
        <>
          <CoverStepper unit={unit} keys={TOP_KEYS} labelKey={(k) => `gloria.cover.${k}`} onCommit={commitTop} editable={editable} />
          {total ? <View className="items-end">{total}</View> : null}
        </>
      ) : null}
    </View>
  );
}

export function SubtypeFields({ unit, onCommit, editable = true }: { unit: GloriaUnit; onCommit: (p: UnitPatch) => void; editable?: boolean }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1">
      <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.cover.subtypeHint')}</Text>
      <CoverStepper unit={unit} keys={SUB_KEYS} labelKey={(k) => `gloria.cover.${k}`} onCommit={onCommit} editable={editable} />
    </View>
  );
}
