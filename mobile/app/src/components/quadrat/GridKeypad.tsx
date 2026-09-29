/**
 * The R / C number keypad under the species card (brush input; user spec
 * 2026-09-29). Rows of n buttons each, labelled 1–9 and 0 for the tenth.
 * What a press does is lib/gridKeypad's; this only draws it: a button waiting
 * for the other axis is ringed, a locked one is inverted.
 */
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { keypadLabel, keypadMark, type KeypadAxis, type KeypadState } from '~/lib/gridKeypad';

export function GridKeypad({
  n,
  state,
  disabled,
  onPress,
  onLongPress,
}: {
  n: number;
  state: KeypadState;
  disabled?: boolean;
  onPress: (axis: KeypadAxis, k: number) => void;
  onLongPress: (axis: KeypadAxis, k: number) => void;
}) {
  const { t } = useTranslation();
  const row = (axis: KeypadAxis) => (
    <View className="flex-row items-center gap-1">
      <Text className="w-5 text-center text-base font-bold text-ink dark:text-gray-100">{axis === 'r' ? 'R' : 'C'}</Text>
      {Array.from({ length: n }, (_, k) => {
        const mark = keypadMark(state, { axis, k });
        const ground =
          mark === 'locked'
            ? 'bg-ink dark:bg-gray-100'
            : axis === 'r'
              ? 'bg-acorn-deep'
              : 'bg-acorn';
        const ink = mark === 'locked' ? 'text-white dark:text-ink' : axis === 'r' ? 'text-white' : 'text-ink';
        return (
          <Pressable
            key={k}
            disabled={disabled}
            onPress={() => {
              void Haptics.selectionAsync();
              onPress(axis, k);
            }}
            onLongPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onLongPress(axis, k);
            }}
            delayLongPress={350}
            accessibilityRole="button"
            accessibilityLabel={t(axis === 'r' ? 'plot.quadrats.keypadRow' : 'plot.quadrats.keypadCol', { n: k + 1 })}
            accessibilityHint={t('plot.quadrats.keypadHint')}
            accessibilityState={{ selected: mark != null, disabled: !!disabled }}
            className={`h-9 flex-1 items-center justify-center rounded-full active:opacity-70 ${ground} ${
              mark === 'pending' ? 'border-[3px] border-ink dark:border-gray-100' : ''
            } ${disabled ? 'opacity-40' : ''}`}
          >
            <Text className={`text-base font-bold ${ink}`} style={{ fontVariant: ['tabular-nums'] }}>
              {keypadLabel(k)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  return (
    <View className="gap-1.5" accessibilityLabel={t('plot.quadrats.keypad')}>
      {row('r')}
      {row('c')}
    </View>
  );
}
