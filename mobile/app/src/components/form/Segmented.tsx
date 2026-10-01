/**
 * Segmented choices and underlined tabs. Moved from the GLORIA screens'
 * ui.tsx (which re-exports them) so the survey framework can use them without
 * importing a module (docs/planned/Modular_survey.md §9, Phase 0).
 */
import { Pressable, ScrollView, Text, View } from 'react-native';

/**
 * Underlined tabs that scroll sideways (03-screens-flow.md §4e): five GLORIA
 * tabs no longer squeeze into one 390-pt segmented control.
 */
export function LineTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="grow-0 border-b border-line bg-card dark:border-line-dark dark:bg-card-dark"
      contentContainerClassName="px-2"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            className="justify-center px-3"
            style={{ minHeight: 44 }}
          >
            <Text
              className={`text-sm ${on ? 'font-bold text-accent-600 dark:text-accent-400' : 'font-medium text-gray-600 dark:text-gray-400'}`}
            >
              {o.label}
            </Text>
            <View className={`absolute bottom-0 left-3 right-3 h-[2.5px] rounded-full ${on ? 'bg-accent-600 dark:bg-accent-400' : ''}`} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <View className="flex-row rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-800 dark:bg-gray-900">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            className={`flex-1 items-center rounded-md py-1.5 ${on ? 'bg-card dark:bg-gray-700' : ''}`}
          >
            <Text className={`text-xs ${on ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
