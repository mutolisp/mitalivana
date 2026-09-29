/**
 * Hex values for props that cannot take a class name (Ionicons `color`,
 * `placeholderTextColor`, ActivityIndicator, RefreshControl, map overlays).
 *
 * Keep in sync with tailwind.config.js. `check:palette` forbids new hex
 * literals outside src/theme/, conservationColors.ts and rankColors.ts.
 */
import { useColorScheme } from 'nativewind';

export const LIGHT = {
  paper: '#F6EFE2',
  card: '#FFFBF3',
  line: '#E4D7C1',
  /** Stronger than `line`: the outline that marks an unfilled status box (GLORIA 未開始). */
  outline: '#CDBDA3',
  ink: '#2B2119',
  ink2: '#5A4B3D',
  ink3: '#6F5F52',
  disabled: '#A8977F',
  cupule: '#6B5433',
  acorn: '#E0A04A',
  acornDeep: '#97561A',
  accent: '#2F6B3E',
  accentPressed: '#265833',
  accentTint: '#E6EEDF',
  alert: '#A8321F',
  alertTint: '#F7E3DC',
  onAccent: '#FFFFFF',
  onAcorn: '#2B2119',
  /**
   * Icon on a floating control over the map, and the tab bar's inactive tint.
   * Darker than `ink2`: those controls are translucent, so whatever the tiles
   * underneath are shows through and eats contrast.
   */
  overlayIcon: '#4A3D31',
} as const;

export const DARK: Record<keyof typeof LIGHT, string> = {
  paper: '#1F1814',
  card: '#2B2119',
  line: '#4A3D31',
  outline: '#6F5F52',
  ink: '#EDE3D2',
  ink2: '#CDBDA3',
  ink3: '#A8977F',
  disabled: '#6F5F52',
  cupule: '#CDBDA3',
  acorn: '#E0A04A',
  acornDeep: '#E0A04A',
  accent: '#7FB38A',
  accentPressed: '#A9CBA9',
  accentTint: '#26402D',
  alert: '#E8876F',
  alertTint: '#4A2A22',
  onAccent: '#1F1814',
  onAcorn: '#2B2119',
  overlayIcon: '#CDBDA3',
};

export type ThemeColors = typeof DARK & { scheme: 'light' | 'dark' };

const LIGHT_THEME: ThemeColors = { ...LIGHT, scheme: 'light' };
const DARK_THEME: ThemeColors = { ...DARK, scheme: 'dark' };

/**
 * Reads NativeWind's scheme, the same one that drives `dark:` classes, so a
 * hex from here never disagrees with the classes next to it when the user
 * overrides the system theme.
 */
export function useThemeColors(): ThemeColors {
  return useColorScheme().colorScheme === 'dark' ? DARK_THEME : LIGHT_THEME;
}
