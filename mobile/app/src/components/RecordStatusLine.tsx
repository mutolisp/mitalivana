import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { isoDate } from '~/lib/datetime';
import { useElapsed } from '~/lib/useElapsed';

/**
 * Under a checklist's title (快速名錄, and a checklist-style survey drawn
 * with its screen): a moss dot and 記錄中 · elapsed · species while
 * recording; a grey dot and 已結束 · date once ended. Elapsed ticks once a
 * minute (useElapsed).
 */
export function RecordStatusLine({
  active,
  startedAt,
  endedAt,
  species,
}: {
  active: boolean;
  startedAt: number;
  endedAt: number | null;
  species: number;
}) {
  const { t } = useTranslation();
  const elapsed = useElapsed(startedAt);
  return (
    <View className="flex-row items-center">
      <View className={`mr-1.5 h-2 w-2 rounded-full ${active ? 'bg-accent-600 dark:bg-accent-400' : 'bg-gray-400'}`} />
      <Text
        numberOfLines={1}
        className={`text-xs font-medium ${active ? 'text-accent-600 dark:text-accent-400' : 'text-gray-500 dark:text-gray-400'}`}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {active
          ? `${t('records.recording')} · ${elapsed} · ${t('plotStats.sppCount', { count: species })}`
          : `${t('session.ended')} · ${endedAt ? isoDate(endedAt) : ''}`}
      </Text>
    </View>
  );
}
