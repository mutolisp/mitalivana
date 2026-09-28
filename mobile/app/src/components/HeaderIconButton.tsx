/**
 * Navigation-bar icon button — the one shape every header action uses.
 *
 * Replaces the bare glyph that used to be copy-pasted into each screen
 * (`h-9 w-9 items-center justify-center active:opacity-60` + a hard-coded
 * `#2563eb`). A floating icon gives no hint that it is pressable and no hint
 * where its edge is, which matters more than usual here: this is a field app,
 * used one-handed, often with wet or gloved fingers.
 *
 * The disc is what changes on press — fading the whole button out (the old
 * `active:opacity-60`) makes the target look like it is disappearing rather
 * than being pushed.
 *
 * The disc reads as 36pt but sits centred in a transparent 44pt pressable, so
 * the touch target is really 44 on both platforms rather than a 36pt button
 * stretched with `hitSlop`.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import { useThemeColors } from '~/theme/colors';

/**
 * Optical-centring nudges, in points.
 *
 * A chevron is not symmetric about its own glyph box: the apex sits at one
 * edge and the two arms open away from it, so geometric centring leaves it
 * looking shoved toward the point. Invisible while the glyph floats on its
 * own; obvious the moment it sits inside a disc, which is what the circular
 * buttons made visible.
 *
 * Positive = move right. Applied as a transform, NOT a margin: the button
 * centres its child, so a margin would widen that child and move it by only
 * half the value — a nudge that silently means something other than it says.
 *
 * Only glyphs that actually need it are listed.
 */
const OPTICAL_NUDGE_X: Partial<Record<string, number>> = {
  'chevron-back': 2,
  'chevron-forward': -2,
};

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
  const c = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      className={`h-11 w-11 items-center justify-center ${edge === 'left' ? '-ml-2' : ''}`}
    >
      {({ pressed }) => (
        // `active:` on the Pressable would not reach this child, so the
        // pressed state is passed down explicitly.
        <View
          className={`h-9 w-9 items-center justify-center rounded-full ${
            pressed && !disabled ? 'bg-gray-200 dark:bg-gray-700' : 'bg-gray-100 dark:bg-gray-800'
          }`}
        >
          <Ionicons
            name={icon}
            size={22}
            color={disabled ? c.disabled : tone === 'danger' ? c.alert : c.accent}
            style={{ transform: [{ translateX: OPTICAL_NUDGE_X[icon] ?? 0 }] }}
          />
        </View>
      )}
    </Pressable>
  );
}
