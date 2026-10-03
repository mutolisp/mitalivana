/**
 * A labelled text field saved as you type, and its numeric form (decimal comma
 * accepted; out-of-range or unreadable input reverts). Moved from the plot
 * screen (app/plot/[id]/index.tsx, where they were `Field` / `NumField`;
 * Phase 0 — docs/planned/Modular_survey.md §9). Renamed so they do not clash
 * with the keyboard-bar NumField in ./NumField.
 *
 * Saving (decided 2026-10-03): saved on blur only, a value was lost when
 * Android's Back closed the keyboard, which does not blur the field. Now it
 * saves a moment after typing stops (`done` false), and once more for good
 * (`done` true) on blur, when the keyboard closes (the field is blurred
 * then), and when the field goes away. Work that must not run on a half-typed
 * value — filling the last ground cover — waits for `done`.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Text, TextInput, View } from 'react-native';
import { parseNum } from '~/lib/parseNum';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';

/** How long typing pauses before the value is saved. */
export const TYPING_SAVE_MS = 700;

export function LabeledField({
  label,
  value,
  placeholder,
  required,
  multiline,
  keyboardType,
  suffix,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'decimal-pad' | 'numeric';
  suffix?: string;
  /** `done`: the last save of this edit (blur, keyboard closed, field gone); false while typing. */
  onSave: (v: string, done: boolean) => void;
}) {
  const c = useThemeColors();
  const [draft, setDraft] = useState(value);
  const input = useRef<TextInput>(null);
  const focused = useRef(false);
  /** What was last saved (or last came in from the record): its echo is not an outside change. */
  const sent = useRef(value);
  /** Typed since the field took the focus (its last save, `done`, is still owed), and the latest text. */
  const edited = useRef(false);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  });

  const flush = (text: string, done: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (done) edited.current = false;
    // While typing, only a new text is saved; the last save is always sent, for the work that waits for it.
    if (!done && text === sent.current) return;
    sent.current = text;
    save.current(text, done);
  };

  // A change from outside (another screen, an undo) shows, unless the user is typing here.
  useEffect(() => {
    if (value === sent.current || focused.current) return;
    sent.current = value;
    setDraft(value);
  }, [value]);

  // Android's Back closes the keyboard without blurring: blur, so the edit ends (and saves) as with a tap elsewhere.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      if (focused.current) input.current?.blur();
    });
    return () => sub.remove();
  }, []);

  // Leaving in the middle of an edit: its last save now.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (edited.current) save.current(latest.current, true);
    },
    [],
  );

  return (
    <View className="mb-3">
      <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
        {label}
        {required ? <Text className="text-red-500"> *</Text> : null}
      </Text>
      <View className="flex-row items-center rounded-lg border border-gray-200 bg-card px-3 dark:border-gray-700 dark:bg-gray-900">
        <TextInput
          ref={input}
          value={draft}
          onChangeText={(v) => {
            setDraft(v);
            edited.current = true;
            latest.current = v;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => flush(v, false), TYPING_SAVE_MS);
          }}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            if (edited.current) flush(draft, true);
          }}
          placeholder={placeholder}
          placeholderTextColor={c.ink3}
          multiline={multiline}
          keyboardType={keyboardType}
          className="flex-1 py-2 text-sm text-gray-900 dark:text-gray-100"
        />
        {suffix ? (
          <Text className="ml-1 text-xs text-gray-500 dark:text-gray-400">{suffix}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function LabeledNumField({
  label,
  suffix,
  placeholder,
  value,
  onSave,
  min,
  max,
}: {
  label: string;
  suffix?: string;
  placeholder?: string;
  value: number | null;
  /** `done` as LabeledField's: false while typing (only readable, in-range numbers are sent then). */
  onSave: (n: number | null, done: boolean) => void;
  /** Inclusive lower bound. 0 is a real value everywhere this is used —
   *  0% cover, 0° slope (flat), 0° aspect (due north) — so it must pass. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
}) {
  const { t } = useTranslation();

  const toast = useToast((s) => s.show);
  // Bumping this remounts <LabeledField>, resetting its draft to the last saved value
  // (used to discard an out-of-range or unreadable entry).
  const [resetKey, setResetKey] = useState(0);
  const ranged = min !== undefined || max !== undefined;
  return (
    <LabeledField
      key={resetKey}
      label={label}
      value={value !== null ? String(value) : ''}
      placeholder={placeholder}
      keyboardType="decimal-pad"
      suffix={suffix}
      onSave={(v, done) => {
        if (v.trim() === '') {
          onSave(null, done);
          return;
        }
        // An unreadable entry reverts instead of saving null: clearing the
        // stored value because of a typo is data loss. While typing it waits
        // ("-", "1e" are on their way to a number).
        const n = parseNum(v);
        const ok = n !== null && (min === undefined || n >= min) && (max === undefined || n <= max);
        if (!ok) {
          if (!done) return;
          if (ranged) toast(t('plot.numRange', { min: min ?? 0, max: max ?? 100 }));
          setResetKey((k) => k + 1);
          return;
        }
        onSave(n, done);
      }}
    />
  );
}
