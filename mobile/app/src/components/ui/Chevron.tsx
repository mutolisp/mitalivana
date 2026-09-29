/**
 * Fixed indicator glyphs (05-controls.md §2.6–2.7), so size and colour stop
 * drifting file by file:
 *   Chevron          row trailing "opens something": chevron-forward 18, ink-3
 *   DropdownChevron  a field that opens a list: chevron-down 16, ink-2
 *   LinkChevron      after a text link ("查看全部"): chevron-forward 14, accent
 * No size / colour props on purpose.
 */
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors } from '~/theme/colors';

export function Chevron() {
  const c = useThemeColors();
  return <Ionicons name="chevron-forward" size={18} color={c.ink3} />;
}

export function DropdownChevron() {
  const c = useThemeColors();
  return <Ionicons name="chevron-down" size={16} color={c.ink2} />;
}

export function LinkChevron() {
  const c = useThemeColors();
  return <Ionicons name="chevron-forward" size={14} color={c.accent} />;
}
