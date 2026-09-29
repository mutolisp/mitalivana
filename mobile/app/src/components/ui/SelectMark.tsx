/**
 * The multi-select mark (05-controls.md §2.1): one round mark for every
 * long-press selection in the app. Round = "this row is picked"; a square
 * `Checkbox` is a data value, a `Radio` a single choice.
 *
 * Fixed 24 pt: the row around it is the touch target. Pass `onPress` only
 * where the mark is its own control (the select-all in SelectionToolbar).
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

export type SelectMarkState = 'off' | 'on' | 'mixed';

export function SelectMark({
  state,
  disabled = false,
  variant = 'inline',
  onPress,
  accessibilityLabel,
}: {
  state: SelectMarkState;
  disabled?: boolean;
  /** `overlay`: on a photo — dark ground when off, a white ring when on. */
  variant?: 'inline' | 'overlay';
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const c = useThemeColors();
  const filled = state !== 'off';
  const overlay = variant === 'overlay';
  const mark = (
    <View
      className={`h-6 w-6 items-center justify-center rounded-full ${
        filled ? 'bg-accent-600 dark:bg-accent-400' : overlay ? 'border-2 border-white bg-black/30' : 'border-2 border-mark dark:border-mark-dark'
      } ${disabled ? 'opacity-40' : ''}`}
      style={filled && overlay ? { borderWidth: 2, borderColor: 'white' } : undefined}
    >
      {state === 'on' ? <Ionicons name="checkmark" size={15} color={c.onAccent} /> : null}
      {state === 'mixed' ? <View className="h-0.5 w-2.5 rounded-full bg-white dark:bg-gray-950" /> : null}
    </View>
  );
  const a11y = {
    accessibilityRole: 'checkbox' as const,
    accessibilityState: { checked: state === 'mixed' ? ('mixed' as const) : state === 'on', disabled },
    accessibilityLabel,
  };
  if (!onPress) return <View {...a11y}>{mark}</View>;
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={10} {...a11y}>
      {mark}
    </Pressable>
  );
}
