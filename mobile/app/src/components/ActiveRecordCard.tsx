/**
 * The record in progress, at the top of the records tab (03-screens-flow.md
 * §1). While it is showing, ActiveSessionBar shrinks to its hairline on this
 * screen, so the two never say the same thing twice.
 *
 * Two figures, not three: the spec's GNSS accuracy was dropped (2026-09-29) —
 * this tab does not run a location watch, and starting one just to fill the
 * card would drain the battery all day in the field.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import type { ActiveRecordKind } from '~/lib/useActiveRecordSummary';
import { useElapsed } from '~/lib/useElapsed';
import { useThemeColors } from '~/theme/colors';

const KIND_LABEL: Record<ActiveRecordKind, string> = {
  session: 'record.kindSession',
  plot: 'record.kindPlot',
  gloria: 'record.kindGloria',
  miren: 'record.kindMiren',
  modular: 'record.kindModular',
};

export function ActiveRecordCard({
  kind,
  title,
  subtitle,
  speciesCount,
  startedAt,
  onResume,
}: {
  kind: ActiveRecordKind;
  title: string;
  /** Project · start time. */
  subtitle: string;
  /** Null when the kind has no single species count (GLORIA, MIREN). */
  speciesCount: number | null;
  startedAt: number;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const elapsed = useElapsed(startedAt);
  return (
    <View className="mx-4 mb-3 gap-3 rounded-[18px] bg-accent-600 p-4 dark:bg-accent-800">
      <View className="flex-row items-center">
        <View className="mr-2 h-2 w-2 rounded-full bg-acorn" />
        <Text className="text-xs font-bold tracking-wider text-white" numberOfLines={1}>
          {`${t('records.recording')} · ${t(KIND_LABEL[kind])}`}
        </Text>
      </View>
      <View>
        <Text className="text-2xl font-bold text-white" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-sm text-accent-100" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View className="flex-row gap-6">
        {speciesCount != null ? (
          <View>
            <Text className="text-2xl font-bold text-white" style={{ fontVariant: ['tabular-nums'] }}>
              {speciesCount}
            </Text>
            <Text className="text-xs text-accent-100">{t('records.activeSpecies')}</Text>
          </View>
        ) : null}
        <View>
          <Text className="text-2xl font-bold text-white" style={{ fontVariant: ['tabular-nums'] }}>
            {elapsed}
          </Text>
          <Text className="text-xs text-accent-100">{t('records.activeElapsed')}</Text>
        </View>
      </View>
      <Pressable
        onPress={onResume}
        accessibilityRole="button"
        className="flex-row items-center justify-center rounded-full bg-card active:bg-gray-100 dark:bg-card-dark dark:active:bg-gray-800"
        style={{ minHeight: 48 }}
      >
        <Text className="text-base font-bold text-accent-600 dark:text-accent-400">
          {t('records.activeResume')}
        </Text>
        <Ionicons name="chevron-forward" size={18} color={c.accent} style={{ marginLeft: 4 }} />
      </Pressable>
    </View>
  );
}
