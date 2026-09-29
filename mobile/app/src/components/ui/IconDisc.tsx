/**
 * Header icon button (05-controls.md §2.4): a 36 pt disc centred in a 44 pt
 * target. `back` is always chevron-back (never arrow-back), `more` the
 * horizontal ellipsis that opens an OverflowMenu.
 *
 * `glyph` is the escape hatch HeaderIconButton uses for its other actions
 * (reopen, delete…); new code should stay within the named icons.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

export type IconDiscIcon = 'back' | 'close' | 'more' | 'search' | 'add';

const GLYPH: Record<IconDiscIcon, keyof typeof Ionicons.glyphMap> = {
  back: 'chevron-back',
  close: 'close',
  more: 'ellipsis-horizontal',
  search: 'search',
  add: 'add',
};

/**
 * Optical-centring nudges, in points. A chevron is not symmetric about its
 * own glyph box, so geometric centring leaves it shoved toward its apex —
 * invisible on its own, obvious inside a disc. Applied as a transform: the
 * button centres its child, so a margin would move it by half the value.
 */
const OPTICAL_NUDGE_X: Partial<Record<string, number>> = {
  'chevron-back': 2,
  'chevron-forward': -2,
};

export function IconDisc({
  icon,
  glyph,
  onPress,
  tone = 'default',
  accessibilityLabel,
  disabled = false,
  edge,
}: {
  icon?: IconDiscIcon;
  glyph?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  /** `onPhoto`: dark translucent disc, white glyph (map and photo overlays).
   *  `danger`: red glyph on the same neutral disc. */
  tone?: 'default' | 'onPhoto' | 'danger';
  accessibilityLabel: string;
  disabled?: boolean;
  /** `left` pulls the disc toward the header edge, where a back button sits. */
  edge?: 'left';
}) {
  const c = useThemeColors();
  const name = glyph ?? GLYPH[icon ?? 'back'];
  const color = disabled ? c.disabled : tone === 'onPhoto' ? 'white' : tone === 'danger' ? c.alert : c.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      className={`h-11 w-11 items-center justify-center ${edge === 'left' ? '-ml-2' : ''}`}
    >
      {({ pressed }) => (
        // `active:` on the Pressable would not reach this child.
        <View
          className={`h-9 w-9 items-center justify-center rounded-full ${
            tone === 'onPhoto'
              ? pressed
                ? 'bg-black/50'
                : 'bg-black/35'
              : pressed && !disabled
                ? 'bg-disc-pressed dark:bg-disc-dark-pressed'
                : 'bg-disc dark:bg-disc-dark'
          }`}
        >
          <Ionicons name={name} size={20} color={color} style={{ transform: [{ translateX: OPTICAL_NUDGE_X[name] ?? 0 }] }} />
        </View>
      )}
    </Pressable>
  );
}
