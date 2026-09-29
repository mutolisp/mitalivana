/**
 * A header title that may be cut short by the buttons beside it: one line,
 * and a tap shows the whole name.
 */
import type { ReactNode } from 'react';
import { Pressable, Text } from 'react-native';
import { useToast } from '~/stores/toast';

export function HeaderTitleText({
  text,
  subtitle,
  mono = false,
}: {
  text: string;
  subtitle?: ReactNode;
  /** Codes (GLORIA's TW-DAS-SUN): the same letters line up across screens. */
  mono?: boolean;
}) {
  const toast = useToast((s) => s.show);
  return (
    <Pressable onPress={() => toast(text)} accessibilityRole="header" accessibilityLabel={text} hitSlop={6} style={{ flexShrink: 1 }}>
      <Text numberOfLines={1} ellipsizeMode="tail" className={`text-[17px] font-semibold text-gray-900 dark:text-gray-100 ${mono ? 'font-mono' : ''}`}>
        {text}
      </Text>
      {/* A status line under the title (the checklist's 記錄中 · elapsed). */}
      {subtitle ?? null}
    </Pressable>
  );
}
