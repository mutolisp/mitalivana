/**
 * Surface top cover (manual p.40, Work Step H / L) and the six lichen /
 * bryophyte subtypes. In zh-TW the block is 「地表覆蓋估測(%)」.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View, type TextInput } from 'react-native';
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

function Grid({
  unit,
  keys,
  labelKey,
  onCommit,
}: {
  unit: GloriaUnit;
  keys: readonly (keyof UnitPatch & keyof GloriaUnit)[];
  labelKey: (k: string) => string;
  onCommit: (patch: UnitPatch) => void;
}) {
  const { t } = useTranslation();
  const refs = useRef<Array<TextInput | null>>([]);
  return (
    <View className="flex-row flex-wrap">
      {keys.map((k, i) => (
        <View key={k} className="mb-1.5 w-1/2 flex-row items-center pr-2">
          <Text className="flex-1 text-xs text-gray-700 dark:text-gray-300" numberOfLines={1}>{t(labelKey(k))}</Text>
          <NumField
            ref={(r) => { refs.current[i] = r; }}
            value={unit[k] as number | null}
            onCommit={(v) => onCommit({ [k]: v })}
            onSubmitEditing={i < keys.length - 1 ? () => refs.current[i + 1]?.focus() : undefined}
            accessibilityLabel={t(labelKey(k))}
            width={76}
            range={RANGES.percent}
          />
        </View>
      ))}
    </View>
  );
}

export function TopCoverFields({ unit, onCommit }: { unit: GloriaUnit; onCommit: (p: UnitPatch) => void }) {
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
      <Grid unit={unit} keys={TOP_KEYS} labelKey={(k) => `gloria.cover.${k}`} onCommit={commitTop} />
      {sum != null ? (
        <Text className={`text-right text-xs font-semibold ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {ok ? t('gloria.cover.sumOk', { sum }) : t('gloria.cover.sumBad', { sum })}
        </Text>
      ) : null}
    </View>
  );
}

export function SubtypeFields({ unit, onCommit }: { unit: GloriaUnit; onCommit: (p: UnitPatch) => void }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1">
      <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.cover.subtypeHint')}</Text>
      <Grid unit={unit} keys={SUB_KEYS} labelKey={(k) => `gloria.cover.${k}`} onCommit={onCommit} />
    </View>
  );
}
