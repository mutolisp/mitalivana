/**
 * A number typed into a form that is saved as a whole (the tree form, the
 * permanent-plot form). The text is the state — parsed with parseNum when the
 * form is saved — so nothing depends on a blur firing before Save is pressed.
 * Uses NumField's keyboard bar for Done on the iOS number pad.
 */
import { TextInput } from 'react-native';
import { NUM_ACCESSORY_ID, NUMERIC_KEYBOARD, bindNumAccessory } from '~/components/form/NumField';
import { useThemeColors } from '~/theme/colors';

export function DraftNum({
  value,
  onChange,
  accessibilityLabel,
  placeholder,
  width = 76,
  signed,
  editable = true,
  invalid,
  strong,
}: {
  value: string;
  onChange: (text: string) => void;
  accessibilityLabel: string;
  placeholder?: string;
  width?: number | '100%';
  /** Needs a minus sign — the iOS decimal pad has none. */
  signed?: boolean;
  editable?: boolean;
  invalid?: boolean;
  /** The field the screen is about (DBH): heavier border and text. */
  strong?: boolean;
}) {
  const c = useThemeColors();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      onFocus={() => bindNumAccessory(null)}
      inputAccessoryViewID={NUM_ACCESSORY_ID}
      keyboardType={signed ? 'numbers-and-punctuation' : NUMERIC_KEYBOARD}
      editable={editable}
      placeholder={placeholder}
      placeholderTextColor={c.ink3}
      accessibilityLabel={accessibilityLabel}
      selectTextOnFocus
      style={{ width, fontVariant: ['tabular-nums'] }}
      className={`rounded-lg border px-2 py-2 text-right ${strong ? 'text-base font-bold' : 'text-sm'} ${
        invalid
          ? 'border-alert bg-alert-tint text-gray-900 dark:border-alert-dark dark:bg-alert-dark-tint dark:text-gray-100'
          : strong
            ? 'border-[1.5px] border-accent-600 bg-card text-gray-900 dark:border-accent-400 dark:bg-gray-900 dark:text-gray-100'
            : 'border-gray-300 bg-card text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
      } ${editable ? '' : 'opacity-60'}`}
    />
  );
}
