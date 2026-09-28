/**
 * Text button, in the four looks the redesign allows (02-components.md).
 *
 *   primary    one per screen: the action that completes what the user started
 *   secondary  outlined: change species, cancel
 *   danger     tinted, never solid red: remove, delete
 *   ghost      text only: header "cancel", minor text actions
 *
 * Height is a minimum rather than fixed so the label can grow with the font
 * scale instead of being clipped. `className` is for layout only (margins,
 * `flex-1`, `self-center`); the look belongs to `variant`.
 */
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, Text } from 'react-native';

import { useThemeColors } from '~/theme/colors';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BOX: Record<Variant, string> = {
  primary: 'bg-accent-600 active:bg-accent-700 dark:bg-accent-400 dark:active:bg-accent-300',
  secondary:
    'border-[1.5px] border-gray-300 active:bg-gray-100 dark:border-gray-600 dark:active:bg-gray-800',
  danger: 'bg-alert-tint active:bg-alert-tint/70 dark:bg-alert-dark-tint dark:active:bg-alert-dark-tint/70',
  ghost: 'active:bg-gray-100 dark:active:bg-gray-800',
};

const LABEL: Record<Variant, string> = {
  primary: 'font-bold text-white dark:text-gray-950',
  secondary: 'font-medium text-ink dark:text-gray-100',
  danger: 'font-bold text-alert dark:text-alert-dark',
  ghost: 'font-medium text-accent-600 dark:text-accent-400',
};

export function Button({
  label,
  onPress,
  onLongPress,
  delayLongPress,
  variant = 'primary',
  icon,
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  className = '',
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  variant?: Variant;
  /** Leading icon. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** md 40, lg 48. */
  size?: 'md' | 'lg';
  disabled?: boolean;
  /** A spinner replaces the icon, and presses are ignored. */
  loading?: boolean;
  fullWidth?: boolean;
  className?: string;
  accessibilityLabel?: string;
}) {
  const c = useThemeColors();
  const glyph = { primary: c.onAccent, secondary: c.ink, danger: c.alert, ghost: c.accent }[variant];
  const height = size === 'lg' ? 48 : 40;
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      className={`flex-row items-center justify-center ${size === 'lg' ? 'px-[22px]' : 'px-4'} ${BOX[variant]} ${
        fullWidth ? 'self-stretch' : ''
      } ${disabled ? 'opacity-40' : ''} ${className}`}
      style={{ minHeight: height, borderRadius: height / 2 }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={glyph} />
      ) : icon ? (
        <Ionicons name={icon} size={size === 'lg' ? 18 : 16} color={glyph} />
      ) : null}
      <Text
        className={`${size === 'lg' ? 'text-base' : 'text-sm'} ${LABEL[variant]} ${loading || icon ? 'ml-1.5' : ''} text-center`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
