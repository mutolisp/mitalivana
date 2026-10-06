/**
 * The usage-mode card at the top of the settings page (design 18b), and the
 * sheet that switches mode. Switching only changes what is shown; records of
 * every kind stay and still open.
 */
import { Ionicons } from '@expo/vector-icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { showActionSheet } from '~/components/ActionSheet';
import { modeTexts } from '~/components/ModeSetupGate';
import type { UsageMode } from '~/lib/usageMode';
import { applyUsageMode, currentUsageMode, useUsageMode } from '~/lib/useUsageMode';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';

const ORDER: UsageMode[] = ['casual', 'vol', 'pro'];

/** The 15A sheet of the three modes; picking one switches at once. */
export async function chooseUsageMode(t: TFunction): Promise<void> {
  const current = currentUsageMode();
  const texts = modeTexts(t);
  const idx = await showActionSheet({
    title: t('mode.title'),
    message: t('mode.switchNote'),
    options: ORDER.map((m) => ({
      label: texts[m].name,
      description: texts[m].desc,
      icon: texts[m].icon,
      selected: m === current,
    })),
  });
  const next = ORDER[idx];
  if (!next || next === current) return;
  applyUsageMode(next);
  useToast.getState().show(t('mode.switched', { mode: texts[next].name }));
}

export function ModeCard() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const mode = useUsageMode();
  const x = modeTexts(t)[mode];
  return (
    <Pressable
      onPress={() => void chooseUsageMode(t)}
      accessibilityRole="button"
      accessibilityHint={t('mode.change')}
      className="mx-4 mt-4 flex-row items-center rounded-card border-[1.5px] border-accent-600 bg-accent-50 p-3.5 active:bg-accent-100 dark:border-accent-400 dark:bg-accent-950 dark:active:bg-accent-900"
    >
      <View className="mr-3 h-12 w-12 items-center justify-center rounded-xl bg-accent-600 dark:bg-accent-400">
        <Ionicons name={x.icon} size={24} color={c.onAccent} />
      </View>
      <View className="mr-2 flex-1">
        <Text className="text-xs font-bold text-accent-700 dark:text-accent-300" style={{ letterSpacing: 0.96 }}>
          {t('mode.title')}
        </Text>
        <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">{x.name}</Text>
        <Text className="text-sm text-gray-600 dark:text-gray-400">{x.desc}</Text>
      </View>
      <Text className="text-base font-bold text-accent-700 dark:text-accent-300">{t('mode.change')}</Text>
    </Pressable>
  );
}
