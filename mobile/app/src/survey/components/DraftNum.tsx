/**
 * A number typed into a form that is saved as a whole (the tree form, the
 * permanent-plot form). The text is the state — parsed with parseNum when the
 * form is saved — so nothing depends on a blur firing before Save is pressed.
 * Uses NumField's keyboard bar for Done on the iOS number pad.
 *
 * No `selectTextOnFocus`: on Android ReactEditText selects all at the first
 * layout after focus (ReactEditText.kt onLayout), and these forms re-lay out
 * on the first keystroke (error borders, size line) — the second key then
 * replaced the first ("15" → "5", found on the emulator 2026-10-01).
 */
import { TextInput } from 'react-native';
import { parseNum } from '~/lib/parseNum';
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
  // Text that is not a number is never silently dropped: it shows here, and the forms refuse to save it.
  const bad = invalid || (value.trim() !== '' && parseNum(value) == null);
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
      style={{ width, fontVariant: ['tabular-nums'] }}
      className={`rounded-lg border px-2 py-2 text-right ${strong ? 'text-base font-bold' : 'text-sm'} ${
        bad
          ? 'border-alert bg-alert-tint text-gray-900 dark:border-alert-dark dark:bg-alert-dark-tint dark:text-gray-100'
          : strong
            ? 'border-[1.5px] border-accent-600 bg-card text-gray-900 dark:border-accent-400 dark:bg-gray-900 dark:text-gray-100'
            : 'border-gray-300 bg-card text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
      } ${editable ? '' : 'opacity-60'}`}
    />
  );
}
