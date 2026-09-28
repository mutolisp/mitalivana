/**
 * Hex values for props that cannot take a class name (Ionicons `color`,
 * `placeholderTextColor`, ActivityIndicator, RefreshControl, map overlays).
 *
 * Keep in sync with tailwind.config.js. `check:palette` forbids new hex
 * literals outside src/theme/, conservationColors.ts and rankColors.ts.
 */
import { useColorScheme } from '@/hooks/use-color-scheme';

export const LIGHT = {
  paper: '#F6EFE2',
  card: '#FFFBF3',
  line: '#E4D7C1',
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
} as const;

export const DARK: Record<keyof typeof LIGHT, string> = {
  paper: '#1F1814',
  card: '#2B2119',
  line: '#4A3D31',
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
};

export type ThemeColors = typeof DARK;

export function useThemeColors(): ThemeColors {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}
