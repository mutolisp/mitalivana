/**
 * A header title that may be cut short by the buttons beside it: one line,
 * and a tap shows the whole name.
 */
import { Pressable, Text } from 'react-native';
import { useToast } from '~/stores/toast';

export function HeaderTitleText({ text }: { text: string }) {
  const toast = useToast((s) => s.show);
  return (
    <Pressable onPress={() => toast(text)} accessibilityRole="header" accessibilityLabel={text} hitSlop={6} style={{ flexShrink: 1 }}>
      <Text numberOfLines={1} ellipsizeMode="tail" className="text-[17px] font-semibold text-gray-900 dark:text-gray-100">
        {text}
      </Text>
    </Pressable>
  );
}
