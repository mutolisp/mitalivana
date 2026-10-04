import { Pressable, Text } from 'react-native';

/** One of a plot screen's tabs (the fixed plot, and a plot-style survey drawn with its screen, 2G-d). */
export function TabBtn({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      // py-2, not py-3: this bar sits on the screen with the least vertical room
      // in the app. Not tighter than that, though — the row directly beneath it
      // is also tappable, and a mis-tap here swaps the whole page. 8 + 20 + 8
      // keeps the target honest while giving back 8pt.
      className={`flex-1 items-center justify-center py-2 ${active ? 'border-b-2 border-emerald-500' : ''}`}
    >
      <Text
        className={`text-sm font-medium ${
          disabled
            ? 'text-gray-300'
            : active
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-gray-600 dark:text-gray-400'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
