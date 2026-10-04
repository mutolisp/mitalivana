/**
 * Cross-platform KeyboardAvoidingView with auto-measured offset.
 *
 * Both RN's built-in KAV and `react-native-keyboard-controller`'s KAV compute
 * padding as `frame.y + frame.height - keyboardY` where `frame` comes from
 * `onLayout` (parent-relative coords). When the KAV is mounted under any
 * chrome (status bar / ActiveSessionBar / Stack header / tab bar) the frame's
 * y is 0 in layout but non-zero in screen, so padding under-shoots by exactly
 * the KAV's screen-y. Callers used to pass `headerHeight` / `tabBarHeight`,
 * which breaks down whenever there's additional chrome above (iOS 26's
 * redesigned nav bar, ActiveSessionBar above a Stack, etc.).
 *
 * Fix: wrap with a plain View whose ref exposes `measureInWindow` (RN KAV is
 * a class component so its ref points to the class instance, not a View, and
 * its internal viewRef isn't part of the public API; using an outer View
 * sidesteps that). We measure the wrapper's screen-y on layout and feed it
 * back as `keyboardVerticalOffset`. Caller-supplied offset is ignored because
 * the measured value already covers all chrome above.
 *
 * Platform split: iOS = RN's built-in KAV; Android = lib's KAV (RN's no-ops
 * under API 35 edge-to-edge).
 */
import { useCallback, useRef, useState, type ComponentProps, type PropsWithChildren } from 'react';
import {
  KeyboardAvoidingView as RNKeyboardAvoidingView,
  Platform,
  View,
  type LayoutChangeEvent,
  type ViewProps,
} from 'react-native';
import {
  KeyboardAvoidingView as KCKeyboardAvoidingView,
  KeyboardController,
  useKeyboardHandler,
} from 'react-native-keyboard-controller';
import Reanimated, { interpolate, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

type StickyProps = ViewProps & {
  /** Extra translateY with the keyboard closed / open (the library's KeyboardStickyView `offset`). */
  offset?: { closed?: number; opened?: number };
};

/**
 * An element that rides on top of the keyboard (a docked search box, an
 * accessory bar): the library's KeyboardStickyView, same props, on Reanimated.
 *
 * The library's one moves through RN Animated's native driver. On Fabric a
 * React commit can overwrite what that driver set, and the box stayed at the
 * keyboard's height after it closed (iOS, 2026-10-04, the interaction
 * screen: picking a species from its search closes the keyboard while the
 * screen above grows a row; the third time this was seen). Reanimated keeps
 * the shadow tree in step, and onMove follows the keyboard frame by frame on
 * both platforms.
 */
export function KeyboardStickyView({ offset: { closed = 0, opened = 0 } = {}, style, children, ...rest }: PropsWithChildren<StickyProps>) {
  // Mounted with the keyboard up: start where it is, not behind it.
  const height = useSharedValue(KeyboardController.isVisible() ? KeyboardController.state().height : 0);
  const progress = useSharedValue(KeyboardController.isVisible() ? 1 : 0);
  useKeyboardHandler(
    {
      onMove: (e) => {
        'worklet';
        height.value = e.height;
        progress.value = e.progress;
      },
      onInteractive: (e) => {
        'worklet';
        height.value = e.height;
        progress.value = e.progress;
      },
      onEnd: (e) => {
        'worklet';
        height.value = e.height;
        progress.value = e.progress;
      },
    },
    [],
  );
  const follow = useAnimatedStyle(() => ({
    transform: [{ translateY: -height.value + interpolate(progress.value, [0, 1], [closed, opened]) }],
  }));
  return (
    <Reanimated.View style={[follow, style]} {...rest}>
      {children}
    </Reanimated.View>
  );
}

type Props = ComponentProps<typeof RNKeyboardAvoidingView> & {
  className?: string;
};

const InnerKAV = (
  Platform.OS === 'ios'
    ? RNKeyboardAvoidingView
    : KCKeyboardAvoidingView
) as unknown as typeof RNKeyboardAvoidingView;

export function KeyboardAvoidingView({
  onLayout,
  className,
  style,
  ...rest
}: Props) {
  const ref = useRef<View>(null);
  const [offset, setOffset] = useState(0);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      ref.current?.measureInWindow((_x, y) => {
        setOffset((prev) => (Math.abs(prev - y) > 0.5 ? y : prev));
      });
      onLayout?.(e);
    },
    [onLayout],
  );

  // className / style stay on the outer View (so caller's `flex-1` etc. apply
  // here, where we measure). The inner KAV fills the outer with style flex:1
  // and does the padding/height animation against the keyboard.
  return (
    <View
      ref={ref}
      onLayout={handleLayout}
      collapsable={false}
      className={className}
      style={style}
    >
      <InnerKAV {...rest} style={{ flex: 1 }} keyboardVerticalOffset={offset} />
    </View>
  );
}
