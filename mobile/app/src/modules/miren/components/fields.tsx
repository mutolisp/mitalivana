/**
 * Form rows for the MIREN screens. Numeric fields, cards, labels, buttons and
 * segmented controls are the GLORIA module's (modules/gloria/components/ui),
 * so both modules look and behave the same; this file adds the text rows.
 *
 * Every field commits on end of editing and writes at once, as elsewhere.
 */
import { Text, TextInput, View } from 'react-native';

export const INPUT =
  'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

/** A label on the left, the control on the right. `hint` is the protocol's own term. */
export function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <View className="flex-1">
        <Text className="text-sm text-gray-700 dark:text-gray-300">{label}</Text>
        {hint ? <Text className="text-[11px] text-gray-400 dark:text-gray-500">{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** Single-line text committed on end of editing; blank → null. */
export function TextCommit({
  value,
  onCommit,
  placeholder,
  width = 176,
  accessibilityLabel,
  autoCapitalize = 'sentences',
  maxLength,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  placeholder?: string;
  width?: number;
  accessibilityLabel: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  maxLength?: number;
}) {
  return (
    <TextInput
      key={value ?? ''}
      defaultValue={value ?? ''}
      onEndEditing={(e) => {
        const v = e.nativeEvent.text.trim() || null;
        if (v !== value) onCommit(v);
      }}
      placeholder={placeholder}
      placeholderTextColor="#9ca3af"
      accessibilityLabel={accessibilityLabel}
      autoCapitalize={autoCapitalize}
      maxLength={maxLength}
      style={{ width }}
      className={INPUT}
    />
  );
}

/** Multi-line text (notes, literature, regional description), full width. */
export function TextBlock({
  value,
  onCommit,
  placeholder,
  accessibilityLabel,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  placeholder?: string;
  accessibilityLabel: string;
}) {
  return (
    <TextInput
      key={value ?? ''}
      defaultValue={value ?? ''}
      multiline
      onEndEditing={(e) => {
        const v = e.nativeEvent.text.trim() || null;
        if (v !== value) onCommit(v);
      }}
      placeholder={placeholder}
      placeholderTextColor="#9ca3af"
      accessibilityLabel={accessibilityLabel}
      className={`${INPUT} min-h-[64px]`}
      textAlignVertical="top"
    />
  );
}
