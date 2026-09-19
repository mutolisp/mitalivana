import { useColorScheme as useNwColorScheme } from 'nativewind';

/**
 * Theme-aware color tokens for places where NativeWind classes can't reach:
 *   - TextInput `placeholderTextColor` (RN prop, not a class)
 *   - SVG / Ionicons `color` (string color, not a class)
 *   - inline RN `style={{ backgroundColor: ... }}`
 *
 * Returns concrete hex values picked from the current effective scheme. Synced
 * with the user's theme preference via `useThemeSync` at the app root.
 */
export function useThemeColors(): {
  scheme: 'light' | 'dark';
  /** TextInput placeholder text */
  placeholder: string;
  /** Generic neutral icon */
  icon: string;
  /** Subtle text on muted backgrounds */
  muted: string;
  /**
   * Icon sitting on a floating control over the map.
   *
   * Higher contrast than `icon`: those chips are `bg-gray-900/95` in dark mode,
   * and gray-400 on that is barely visible against a busy map. Matches the tab
   * bar's inactive tint so both sets of controls read as the same UI layer.
   */
  overlayIcon: string;
  /** Accent (selected / active) icon on those same floating controls. */
  overlayAccent: string;
} {
  const { colorScheme } = useNwColorScheme();
  const dark = colorScheme === 'dark';
  return {
    scheme: dark ? 'dark' : 'light',
    placeholder: dark ? '#6b7280' : '#9ca3af', // gray-500 / gray-400
    icon: dark ? '#9ca3af' : '#6b7280', // gray-400 / gray-500
    muted: dark ? '#9ca3af' : '#6b7280',
    overlayIcon: dark ? '#d1d5db' : '#374151', // gray-300 / gray-700
    overlayAccent: dark ? '#93c5fd' : '#2563eb', // blue-300 / blue-600
  };
}
