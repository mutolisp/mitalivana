/**
 * A status tick — "this is done / present" — as opposed to a control the
 * user taps (05-controls.md: selection is SelectMark, a value is Checkbox).
 * Kept here so check:controls can keep the check-circle glyph out of screens.
 */
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors } from '~/theme/colors';

export function DoneMark({ size = 20 }: { size?: 20 | 24 }) {
  const c = useThemeColors();
  return <Ionicons name="checkmark-circle" size={size} color={c.accent} />;
}
