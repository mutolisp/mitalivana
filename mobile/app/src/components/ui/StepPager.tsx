/**
 * Previous / next with a position (05-controls.md §2.5): two 32 pt discs and
 * "3 / 47" between them. A disabled step fades to 0.35 and keeps its colour
 * (the old grey `#d1d5db` read as a different button, not a paused one).
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

export function StepButton({ dir, disabled, onPress }: { dir: -1 | 1; disabled: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t(dir < 0 ? 'common.previous' : 'common.next')}
      accessibilityState={{ disabled }}
      className={`h-8 w-8 items-center justify-center rounded-full bg-disc active:bg-disc-pressed dark:bg-disc-dark dark:active:bg-disc-dark-pressed ${
        disabled ? 'opacity-35' : ''
      }`}
    >
      <Ionicons name={dir < 0 ? 'chevron-back' : 'chevron-forward'} size={18} color={c.ink} />
    </Pressable>
  );
}

export function StepPager({ index, total, onStep }: { index: number; total: number; onStep: (dir: -1 | 1) => void }) {
  return (
    <View className="flex-row items-center">
      <StepButton dir={-1} disabled={index <= 0} onPress={() => onStep(-1)} />
      <Text className="text-center text-sm text-ink-2 dark:text-gray-300" style={{ minWidth: 64, fontVariant: ['tabular-nums'] }}>
        {`${index + 1} / ${total}`}
      </Text>
      <StepButton dir={1} disabled={index >= total - 1} onPress={() => onStep(1)} />
    </View>
  );
}
