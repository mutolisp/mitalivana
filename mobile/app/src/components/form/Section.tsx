/**
 * Titled form sections: a plain one and one that folds. Moved unchanged from
 * the plot screen (app/plot/[id]/index.tsx, Phase 0 —
 * docs/planned/Modular_survey.md §9) for the survey framework's forms.
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

export function Section({
  title,
  required,
  children,
}: {
  title: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View className="px-4 py-3">
      {title ? (
        <View className="mb-2 flex-row items-center">
          <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {title}
          </Text>
          {required ? <Text className="ml-1 text-xs text-red-500">*</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function CollapsibleSection({
  title,
  defaultExpanded = false,
  children,
}: {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}) {
  const c = useThemeColors();
  const [open, setOpen] = useState(defaultExpanded);
  return (
    <View className="px-4 py-3">
      <Pressable
        onPress={() => setOpen((o) => !o)}
        className={`flex-row items-center ${open ? 'mb-2' : ''}`}
        hitSlop={6}
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={c.ink2} />
        <Text className="ml-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}
