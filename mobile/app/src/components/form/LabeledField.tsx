/**
 * A labelled text field saved on blur, and its numeric form (decimal comma
 * accepted; out-of-range or unreadable input reverts). Moved from the plot
 * screen (app/plot/[id]/index.tsx, where they were `Field` / `NumField`;
 * Phase 0 — docs/planned/Modular_survey.md §9). Renamed so they do not clash
 * with the keyboard-bar NumField in ./NumField.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, TextInput, View } from 'react-native';
import { parseNum } from '~/lib/parseNum';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';

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
  onSave: (v: string) => void;
}) {
  const c = useThemeColors();
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const dirty = draft !== value;

  return (
    <View className="mb-3">
      <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
        {label}
        {required ? <Text className="text-red-500"> *</Text> : null}
      </Text>
      <View className="flex-row items-center rounded-lg border border-gray-200 bg-card px-3 dark:border-gray-700 dark:bg-gray-900">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={() => {
            if (dirty) onSave(draft);
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
  onSave: (n: number | null) => void;
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
      onSave={(v) => {
        if (v.trim() === '') {
          onSave(null);
          return;
        }
        // An unreadable entry reverts instead of saving null: clearing the
        // stored value because of a typo is data loss.
        const n = parseNum(v);
        const ok = n !== null && (min === undefined || n >= min) && (max === undefined || n <= max);
        if (!ok) {
          if (ranged) toast(t('plot.numRange', { min: min ?? 0, max: max ?? 100 }));
          setResetKey((k) => k + 1);
          return;
        }
        onSave(n);
      }}
    />
  );
}
