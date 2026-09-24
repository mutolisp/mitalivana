import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useToast } from '~/stores/toast';

/** Distance (px) the banner must be dragged up before it dismisses. */
const DISMISS_THRESHOLD = 28;

/**
 * The toast banner. Mounted once at the navigation root, and again — with
 * `inModal` — inside every Modal that fires toasts while it is open: the root
 * one is an absolutely-positioned View, and iOS gives each Modal its own
 * window, so a toast fired from inside a Modal rendered behind it and was never
 * seen. Both instances read the same store, so they show and dismiss together;
 * when the Modal closes the root one finishes the remaining time.
 */
export function ToastHost({ inModal = false }: { inModal?: boolean }) {
  const insets = useSafeAreaInsets();
  const current = useToast((s) => s.current);
  const dismiss = useToast((s) => s.dismiss);
  const translateY = useSharedValue(0);

  // Reset position whenever a new toast appears (id changes).
  useEffect(() => {
    translateY.value = 0;
  }, [current?.id, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    // Fade as it slides up so the dismiss feels responsive.
    opacity: Math.max(0, 1 + translateY.value / 80),
  }));

  if (!current) return null;

  // Swipe up to dismiss (only upward movement is tracked).
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateY.value = Math.min(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY < -DISMISS_THRESHOLD) {
        translateY.value = withTiming(-200, { duration: 150 });
        runOnJS(dismiss)();
      } else {
        translateY.value = withTiming(0, { duration: 120 });
      }
    });

  // useSafeAreaInsets rather than SafeAreaView: inside a Modal the latter can
  // come back with a zero inset and put the banner under the notch.
  const banner = (
    <View
      pointerEvents="box-none"
      // In a Modal the positioned wrapper below takes the absolute placement,
      // and the banner stays in flow so the wrapper gets its height — Android
      // delivers no touches outside a parent's bounds (swipe, action button).
      className={inModal ? '' : 'absolute inset-x-0 top-0'}
      style={{ paddingTop: insets.top }}
    >
      <GestureDetector gesture={pan}>
        {/* Animated.View carries transform/opacity + an explicit full width (so
            the inner flex-1 message text doesn't collapse to 0); visual styling
            stays on the plain inner View so it doesn't depend on NativeWind
            mapping Animated.View. */}
        <Animated.View style={[animatedStyle, { width: '100%' }]}>
          <View className="mx-4 mt-2 flex-row items-center rounded-lg bg-gray-900 px-4 py-3 shadow-lg">
            <Text className="flex-1 text-sm text-white">{current.message}</Text>
            {current.action ? (
              <Pressable
                onPress={() => {
                  current.action!.onPress();
                  dismiss();
                }}
                className="ml-3 active:opacity-70"
              >
                <Text className="text-sm font-bold text-blue-300">{current.action.label}</Text>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
  // A Modal's content is outside the app's GestureHandlerRootView, and
  // GestureDetector crashes without one. Absolutely positioned and box-none,
  // so it covers nothing but the banner.
  return inModal ? (
    <GestureHandlerRootView
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, top: 0 }}
    >
      {banner}
    </GestureHandlerRootView>
  ) : (
    banner
  );
}
