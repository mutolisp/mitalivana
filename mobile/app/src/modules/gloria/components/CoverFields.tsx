/**
 * Surface top cover (manual p.40, Work Step H / L) and the six lichen /
 * bryophyte subtypes. In zh-TW the block is 「地表覆蓋估測(%)」.
 *
 * Each block is one row stepping through its items (SurfaceCover, shared). Each item
 * has a 「無」 box: ticking it records 0 (estimated, absent), unticking clears
 * it (not estimated yet). Blank and 0 stay distinct, so the
 * last blank of the seven can still be completed to 100 (autoFillLast).
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import type { GloriaUnit, UnitPatch } from '../db';
import { Req } from './ui';
import { autoFillLast, exactSum } from '../model/validate';
import { useThemeColors } from '~/theme/colors';
import { SurfaceCover } from '~/components/quadrat/SurfaceCover';

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

export function TopCoverFields({ unit, onCommit, editable = true }: { unit: GloriaUnit; onCommit: (p: UnitPatch) => void; editable?: boolean }) {
  const c = useThemeColors();
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
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={c.ink3} />
        <Text className="ml-1 flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
          {t('gloria.cover.title')}
          <Req />
        </Text>
        {open ? null : total}
      </Pressable>
      {open ? (
        <>
          <SurfaceCover values={unit} keys={TOP_KEYS} labelKey={(k) => `gloria.cover.${k}`} shortKey={(k) => `gloria.cover.short.${k}`} onCommit={commitTop} editable={editable} />
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
      <SurfaceCover values={unit} keys={SUB_KEYS} labelKey={(k) => `gloria.cover.${k}`} shortKey={(k) => `gloria.cover.short.${k}`} onCommit={onCommit} editable={editable} />
    </View>
  );
}
