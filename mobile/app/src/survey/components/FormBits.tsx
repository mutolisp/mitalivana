/**
 * Small pieces the survey forms share: a card section with a title, a
 * labelled field, a plain text box, and an inline problem line. Kept here, not
 * in GLORIA's ui.tsx, so the framework does not import a module.
 */
import type { ReactNode } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

export function FormCard({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View className="gap-2.5 rounded-card border border-line bg-card px-3.5 py-3 dark:border-line-dark dark:bg-card-dark">
      {title || right ? (
        <View className="flex-row items-center justify-between">
          {title ? <Text className="text-sm font-bold text-ink dark:text-gray-100">{title}</Text> : <View />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <Text className="mb-1 text-xs font-bold text-ink-2 dark:text-gray-400">{children}</Text>;
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <View className={className}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </View>
  );
}

export function TextBox({
  value,
  onChange,
  accessibilityLabel,
  placeholder,
  editable = true,
  multiline,
  autoCapitalize,
  invalid,
  onBlur,
  mono,
  keyboardType,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The field is left (a pending typed value is saved then). */
  onBlur?: () => void;
  accessibilityLabel: string;
  placeholder?: string;
  editable?: boolean;
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'characters';
  invalid?: boolean;
  /** Monospaced (a DNA sequence). */
  mono?: boolean;
  /** 'visible-password': no word composing, for text the app rewrites as it is saved (upper case). 'numbers-and-punctuation': a number that may be negative. */
  keyboardType?: 'default' | 'visible-password' | 'numbers-and-punctuation';
}) {
  const c = useThemeColors();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      onBlur={onBlur}
      accessibilityLabel={accessibilityLabel}
      placeholder={placeholder}
      placeholderTextColor={c.ink3}
      editable={editable}
      multiline={multiline}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      keyboardType={keyboardType}
      className={`rounded-lg border px-3 py-2 text-base text-gray-900 dark:text-gray-100 ${mono ? 'font-mono ' : ''}${
        invalid ? 'border-alert bg-alert-tint dark:border-alert-dark dark:bg-alert-dark-tint' : 'border-gray-300 bg-card dark:border-gray-700 dark:bg-gray-900'
      } ${editable ? '' : 'opacity-60'}`}
      style={multiline ? { minHeight: 72, textAlignVertical: 'top' } : undefined}
    />
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return <Text className="text-sm text-alert dark:text-alert-dark">{children}</Text>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{children}</Text>;
}
