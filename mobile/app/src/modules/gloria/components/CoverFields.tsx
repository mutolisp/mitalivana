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
import { Pressable, Text, View } from 'react-native';
import { SelectRow } from '~/components/settings/rows';
import { SwipeNavArea, useSwipeNav } from '~/components/SwipeNavigator';
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
 * moves to another item.
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
      className="h-9 w-8 items-center justify-center rounded-lg border border-gray-300 dark:border-gray-700"
    >
      <Ionicons name={d < 0 ? 'chevron-back' : 'chevron-forward'} size={16} color="#6b7280" />
    </Pressable>
  );
  return (
    <View className="gap-1">
      <SwipeNavArea nav={nav} style={{ flex: 0 }}>
        <View className="flex-row items-center gap-1.5">
          {arrow(-1)}
          <View className="flex-1">
            <SelectRow
              variant="inline"
              label={t(labelKey(k))}
              value={k as string}
              options={keys.map((x) => ({ value: x as string, label: t(labelKey(x)) }))}
              onChange={(x) => go(keys.indexOf(x as (typeof keys)[number]))}
            />
          </View>
          {arrow(1)}
          <NumField
            value={v}
            onCommit={(n) => onCommit({ [k]: n })}
            onSubmitEditing={() => go(iRef.current + 1)}
            commitRef={commitRef}
            accessibilityLabel={t(labelKey(k))}
            width={56}
            range={RANGES.percent}
            editable={editable}
          />
          <Pressable
            onPress={() => onCommit({ [k]: none ? null : 0 })}
            disabled={!editable}
            hitSlop={6}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: none, disabled: !editable }}
            accessibilityLabel={`${t(labelKey(k))} ${t('gloria.cover.none')}`}
            className="flex-row items-center"
          >
            <Ionicons name={none ? 'checkbox' : 'square-outline'} size={18} color={none ? '#00A2A5' : '#9ca3af'} />
            <Text className="text-[10px] text-gray-500 dark:text-gray-400">{t('gloria.cover.none')}</Text>
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
                className={`text-[11px] ${n === i ? 'font-bold text-[#00797b] dark:text-cyan-300' : 'text-gray-500 dark:text-gray-400'}`}
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
  return (
    <View className="gap-1">
      <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.cover.title')}</Text>
      <CoverStepper unit={unit} keys={TOP_KEYS} labelKey={(k) => `gloria.cover.${k}`} onCommit={commitTop} editable={editable} />
      {sum != null ? (
        <Text className={`text-right text-xs font-semibold ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {ok ? t('gloria.cover.sumOk', { sum }) : t('gloria.cover.sumBad', { sum })}
        </Text>
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
