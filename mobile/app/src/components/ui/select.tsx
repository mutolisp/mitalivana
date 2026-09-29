/**
 * Select — react-native-reusables' Select, adapted to this app.
 *
 * Adapted rather than pasted: RNR's registry copy styles itself with shadcn
 * tokens (`bg-popover`, `text-foreground`, `border-input`, …) and draws lucide
 * icons. This project has neither — `tailwind.config.js` defines the app's
 * own tokens (`paper`, `card`, `ink`, `accent`, …), not shadcn's, and icons
 * are Ionicons everywhere. Standing up a parallel shadcn colour system next to
 * the existing gray / accent convention would leave the app with two.
 *
 * Also dropped from upstream, all native-only concerns:
 *   - every `Platform.OS === 'web'` branch (`@rn-primitives/select` already
 *     resolves its own web build by file extension)
 *   - `FullWindowOverlay` — its job is "paint above the screen container", and
 *     <PortalHost>'s placement in app/_layout.tsx already guarantees that
 *   - the exiting animation: a portalled subtree unmounts synchronously, which
 *     is the flaky half of Reanimated's layout animations
 *   - SelectGroup / SelectLabel / the scroll buttons — nothing here groups
 *     options, and the buttons are web-only no-ops
 *
 * The popover paints above the native stack header because <PortalHost /> is a
 * later sibling of the <View> holding <Stack>. Android's hardware back closes
 * it (the primitive's Content registers its own BackHandler).
 */
import { Ionicons } from '@expo/vector-icons';
import * as SelectPrimitive from '@rn-primitives/select';
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '~/theme/colors';

const Select = SelectPrimitive.Root;

/**
 * The backdrop has to be a Pressable, not a View.
 *
 * `SelectPrimitive.Overlay` closes the popover from its own `onPress`
 * (`closeOnPress` defaults to true), and `asChild` hands that prop to whatever
 * child is given. An `Animated.View` accepts `onPress` and silently ignores it,
 * so tapping outside did nothing and the only way to dismiss was to re-tap the
 * open option. Animating a Pressable instead keeps the fade and makes the tap
 * land on something that listens.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function SelectTrigger({
  className = '',
  bare = false,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  className?: string;
  /** No box: just the value and the chevron, for a settings row whose right
   *  side is its current value (03-screens-flow.md §4c). */
  bare?: boolean;
}) {
  const c = useThemeColors();
  const box = bare
    ? 'gap-1 py-1'
    : 'gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-card dark:bg-gray-900 px-3 py-2';
  return (
    <SelectPrimitive.Trigger
      className={`flex-row items-center justify-between ${box} ${props.disabled ? 'opacity-50' : ''} ${className}`}
      {...props}
    >
      <>{children}</>
      <Ionicons name="chevron-down" size={16} color={c.ink3} />
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({
  className = '',
  numberOfLines = 1,
  bare = false,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value> & { className?: string; bare?: boolean }) {
  const { value } = SelectPrimitive.useRootContext();
  // shrink + one line: a long label ("個體數 (individuals)") used to wrap to
  // two lines, grow the trigger, and push the chevron outside its border. It
  // now truncates, and the chevron keeps its place inside the box. `shrink`,
  // not `flex-1`: an auto-width trigger (the settings rows) must still size
  // to its label instead of collapsing to its min width.
  return (
    <SelectPrimitive.Value
      numberOfLines={numberOfLines}
      className={`shrink ${
        bare
          ? 'text-sm text-gray-600 dark:text-gray-300'
          : `text-base ${value ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`
      } ${className}`}
      {...props}
    />
  );
}

/** Caps the popover so a long list can never span the whole screen — and so
 *  `avoidCollisions` never has to fight the ActiveSessionBar, which is not a
 *  safe-area inset and which the portal knows nothing about. */
const MAX_POPOVER_HEIGHT = 288;

function SelectContent({
  className = '',
  children,
  position = 'popper',
  portalHost,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  className?: string;
  portalHost?: string;
}) {
  // Safe here: <PortalHost /> sits under <SafeAreaProvider>.
  const insets = useSafeAreaInsets();
  return (
    <SelectPrimitive.Portal hostName={portalHost}>
      <SelectPrimitive.Overlay style={StyleSheet.absoluteFill} asChild>
        {/* Styled inline rather than with NativeWind: this is a component built
            by createAnimatedComponent, and the backdrop silently losing its
            colour would be a confusing way to find out className did not reach
            it. Nothing here needs a Tailwind token anyway. */}
        <AnimatedPressable
          style={[StyleSheet.absoluteFill, { zIndex: 50, backgroundColor: 'rgba(0,0,0,0.4)' }]}
          entering={FadeIn.duration(120)}
        >
          <SelectPrimitive.Content
            insets={{ top: insets.top + 8, bottom: insets.bottom + 8, left: 12, right: 12 }}
            position={position}
            sideOffset={4}
            className={`z-50 min-w-[8rem] rounded-xl border border-gray-200 dark:border-gray-700 bg-card dark:bg-gray-900 shadow-lg ${className}`}
            {...props}
          >
            <ScrollView style={{ maxHeight: MAX_POPOVER_HEIGHT }} bounces={false}>
              <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
            </ScrollView>
          </SelectPrimitive.Content>
        </AnimatedPressable>
      </SelectPrimitive.Overlay>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className = '',
  label,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & { className?: string }) {
  const c = useThemeColors();
  return (
    <SelectPrimitive.Item
      label={label}
      className={`flex-row items-center justify-between gap-2 rounded-lg px-3 py-2.5 active:bg-accent-50 dark:active:bg-accent-900/40 ${props.disabled ? 'opacity-50' : ''} ${className}`}
      {...props}
    >
      <SelectPrimitive.ItemText className="text-base text-gray-900 dark:text-gray-100" />
      <SelectPrimitive.ItemIndicator asChild>
        <View>
          <Ionicons name="checkmark" size={18} color={c.accent} />
        </View>
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
