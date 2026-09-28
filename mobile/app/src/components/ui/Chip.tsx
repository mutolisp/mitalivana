/**
 * Filter chip (02-components.md). Selected is ink-on-paper inverted rather
 * than accent: the accent means "you can act on this", and a chosen filter is
 * state, not an action.
 *
 * 36 tall with a 4 pt hitSlop to reach 44. Put chips in a container with
 * `accessibilityRole="tablist"` and space them with the container's `gap`.
 */
import { Pressable, Text } from 'react-native';

export function Chip({
  label,
  count,
  selected,
  onPress,
}: {
  label: string;
  /** Shown after the label, same size, tabular figures. */
  count?: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      className={`flex-row items-center rounded-chip border px-3.5 ${
        selected
          ? 'border-ink bg-ink dark:border-gray-100 dark:bg-gray-100'
          : 'border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800'
      }`}
      style={{ minHeight: 36 }}
    >
      <Text
        className={`text-sm font-medium ${selected ? 'text-card dark:text-gray-950' : 'text-ink dark:text-gray-100'}`}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {count === undefined ? label : `${label} ${count}`}
      </Text>
    </Pressable>
  );
}
