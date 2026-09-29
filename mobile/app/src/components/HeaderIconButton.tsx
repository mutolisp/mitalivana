/**
 * Navigation-bar icon button — the one shape every header action uses.
 *
 * A thin wrapper over `IconDisc` (05-controls.md §2.4) that keeps the old
 * API: any Ionicons glyph, a `danger` tone for finish-recording and friends,
 * and `edge="left"` for a headerLeft. The disc reads as 36 pt inside a 44 pt
 * pressable, so the touch target really is 44 on both platforms — this is a
 * field app, used one-handed, often with wet or gloved fingers.
 */
import type { Ionicons } from '@expo/vector-icons';
import { IconDisc } from '~/components/ui/IconDisc';

export function HeaderIconButton({
  icon,
  onPress,
  label,
  disabled = false,
  tone = 'default',
  edge,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  /** Screen-reader name. The glyph carries no text, so this is the only label. */
  label: string;
  disabled?: boolean;
  /** Finish-recording and friends keep a red glyph on the same neutral disc — a
   *  red disc would shout louder than the action deserves in a header. */
  tone?: 'default' | 'danger';
  /** `left` pulls the disc back toward the header edge, where the native back
   *  button would sit. Use on `headerLeft`. */
  edge?: 'left';
}) {
  return (
    <IconDisc
      glyph={icon}
      onPress={onPress}
      accessibilityLabel={label}
      disabled={disabled}
      tone={tone}
      edge={edge}
    />
  );
}
