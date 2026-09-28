/**
 * Altitude in metres for one record: filled from the GNSS fix, editable by
 * hand, committed on blur. Empty = not recorded.
 *
 * Follows `value` whenever the user is not typing in it — the fix taken when
 * the species was entered can arrive after the detail view is already open,
 * and a different record can be stepped to without remounting.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, TextInput, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

const show = (v: number | null | undefined) => (v != null ? String(v) : '');

export function ElevationField({
  value,
  onCommit,
  inputClassName,
}: {
  value: number | null | undefined;
  onCommit: (metres: number | null) => void;
  inputClassName: string;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const [text, setText] = useState(show(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(show(value));
  }, [value]);

  const commit = () => {
    editing.current = false;
    const s = text.trim();
    if (!s) {
      if (value != null) onCommit(null);
      return;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) {
      // Not a number — put the stored value back rather than save garbage.
      setText(show(value));
      return;
    }
    if (n !== value) onCommit(n);
  };

  return (
    <View className="flex-row items-center">
      <TextInput
        value={text}
        onFocus={() => {
          editing.current = true;
        }}
        onChangeText={setText}
        onBlur={commit}
        placeholder={t('collection.elevationPlaceholder')}
        placeholderTextColor={c.ink3}
        keyboardType="numbers-and-punctuation"
        accessibilityLabel={t('collection.elevation')}
        className={`${inputClassName} flex-1`}
      />
      <Text className="ml-2 text-sm text-gray-500 dark:text-gray-400">m</Text>
    </View>
  );
}
