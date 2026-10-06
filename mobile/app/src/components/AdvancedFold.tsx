/**
 * 進階 — where the simpler usage modes keep what pro mode shows in place
 * (src/lib/usageMode.ts, `adv`). A dashed button at the end of a screen or
 * sheet (design 18j / 18l); tapping it shows its contents below it.
 *
 *   {vis(mode, 'recordMeta') === 'adv' ? (
 *     <AdvancedFold summary={t('…')}>…</AdvancedFold>
 *   ) : null}
 *
 * Callers decide what goes in: in pro mode the same pieces render where they
 * always were and no fold is drawn. Closed on every visit: a volunteer who
 * opened it once should not find the screen longer the next time.
 */
import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { useThemeColors } from '~/theme/colors';

export function AdvancedFold({
  summary,
  children,
  className = '',
}: {
  /** What is inside, for the closed label: 「進階：{{summary}}」. */
  summary?: string;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const [open, setOpen] = useState(false);
  const label = open ? t('mode.advancedHide') : summary ? t('mode.advancedWith', { summary }) : t('mode.advanced');
  return (
    <View className={className}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center justify-center rounded-xl border border-dashed border-gray-300 px-4 active:bg-gray-100 dark:border-gray-600 dark:active:bg-gray-800"
        style={{ minHeight: 48 }}
      >
        <Text className="flex-shrink text-[15px] text-gray-700 dark:text-gray-300" numberOfLines={1}>
          {label}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={c.ink2} style={{ marginLeft: 6 }} />
      </Pressable>
      {open ? <View className="mt-2">{children}</View> : null}
    </View>
  );
}
