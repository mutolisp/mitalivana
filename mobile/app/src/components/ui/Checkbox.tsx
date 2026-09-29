/**
 * A form boolean (05-controls.md §2.2): square, for a value that belongs to
 * the data (GLORIA unit skipped, plot uniform, cover "none", a logger check).
 * Never for selecting rows — that is the round `SelectMark`. On a settings
 * page prefer a Switch.
 *
 * With `label` the whole row is the control, at least 44 pt tall.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

export function CheckboxMark({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) {
  const c = useThemeColors();
  return (
    <View
      className={`items-center justify-center rounded-md ${
        checked ? 'bg-accent-600 dark:bg-accent-400' : 'border-2 border-mark dark:border-mark-dark'
      } ${disabled ? 'opacity-40' : ''}`}
      style={{ width: 22, height: 22 }}
    >
      {checked ? <Ionicons name="checkmark" size={15} color={c.onAccent} /> : null}
    </View>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  accessibilityLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Text (or a node) beside the box; the whole row then toggles. */
  label?: ReactNode;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      hitSlop={label ? undefined : 11}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={accessibilityLabel ?? (typeof label === 'string' ? label : undefined)}
      className="flex-row items-center"
      style={label ? { minHeight: 44 } : undefined}
    >
      <CheckboxMark checked={checked} disabled={disabled} />
      {typeof label === 'string' ? (
        <Text className="ml-2.5 flex-1 text-base text-ink dark:text-gray-100">{label}</Text>
      ) : label ? (
        <View className="ml-2.5 flex-1">{label}</View>
      ) : null}
    </Pressable>
  );
}
