/**
 * Census codes as toggle chips (design 13c): the code in monospace, filled
 * when on. `single` makes them a radio group (the four whole-tree death codes
 * are alternatives); `named` adds each code's name (a template's own codes).
 */
import { Pressable, Text, View } from 'react-native';

export function CodeChips({
  codes,
  selected,
  onChange,
  single,
  disabled,
  labelOf,
  named,
}: {
  codes: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  single?: boolean;
  disabled?: boolean;
  /** Spoken label of a code. */
  labelOf: (code: string) => string;
  /** Show the label after the code (a template's own codes, which the user named). */
  named?: boolean;
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {codes.map((code) => {
        const on = selected.includes(code);
        const toggle = () => {
          if (single) onChange(on ? [] : [code]);
          else onChange(on ? selected.filter((x) => x !== code) : [...selected, code]);
        };
        return (
          <Pressable
            key={code}
            onPress={toggle}
            disabled={disabled}
            accessibilityRole={single ? 'radio' : 'togglebutton'}
            accessibilityState={{ checked: on, disabled }}
            accessibilityLabel={`${code} ${labelOf(code)}`}
            className={`min-w-[44px] items-center justify-center rounded-lg px-2 ${
              on
                ? 'border-[1.5px] border-accent-600 bg-accent-600 dark:border-accent-400 dark:bg-accent-400'
                : 'border border-line bg-card dark:border-line-dark dark:bg-gray-900'
            } ${disabled ? 'opacity-40' : ''}`}
            style={{ height: 36 }}
          >
            <View className="flex-row items-center gap-1">
              <Text className={`font-mono text-sm font-bold ${on ? 'text-white dark:text-gray-950' : 'text-ink dark:text-gray-100'}`}>{code}</Text>
              {named ? <Text className={`text-sm ${on ? 'text-white dark:text-gray-950' : 'text-ink-2 dark:text-gray-300'}`}>{labelOf(code)}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
