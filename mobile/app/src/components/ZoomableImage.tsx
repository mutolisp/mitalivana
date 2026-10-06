/**
 * One page of the photo viewer that can be zoomed to look at detail
 * (PhotoViewerModal).
 *
 * - Pinch: 1×–5×, about the fingers (moving them while pinching pans too).
 * - Double tap: 2.5× at the tapped point, or back to 1× when zoomed.
 * - One finger while zoomed: pan, held to the picture's edges, with a fling.
 * - Single tap at 1×: `onTap` (the viewer closes); ignored while zoomed, so
 *   looking at detail never closes it by accident.
 *
 * `onZoomChange` tells the viewer whether this page is zoomed: its pager stops
 * paging while it is, so a sideways drag pans the picture instead. `active`
 * false (another page in view) puts the picture back to 1×.
 *
 * Bounds come from the picture as drawn (contain), not the frame, so a wide
 * photo cannot be dragged off into its letterbox.
 */
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from 'react-native-reanimated';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

export function ZoomableImage({
  uri,
  width,
  height,
  active,
  onZoomChange,
  onTap,
}: {
  uri: string;
  /** The frame the picture is drawn in. */
  width: number;
  height: number;
  active: boolean;
  onZoomChange: (zoomed: boolean) => void;
  onTap: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  // The picture's size inside the frame (contain); the frame until it loads.
  const fitW = useSharedValue(width);
  const fitH = useSharedValue(height);

  const report = (z: boolean) => {
    setZoomed(z);
    onZoomChange(z);
  };

  // Another page in view: back to 1×.
  useEffect(() => {
    if (active) return;
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
    setZoomed(false);
  }, [active, scale, tx, ty]);

  const clampX = (x: number, s: number) => {
    'worklet';
    const max = Math.max(0, (fitW.value * s - width) / 2);
    return Math.min(max, Math.max(-max, x));
  };
  const clampY = (y: number, s: number) => {
    'worklet';
    const max = Math.max(0, (fitH.value * s - height) / 2);
    return Math.min(max, Math.max(-max, y));
  };

  const pinch = Gesture.Pinch()
    .onStart((e) => {
      startScale.value = scale.value;
      startX.value = tx.value;
      startY.value = ty.value;
      // The fingers' midpoint, from the frame's centre.
      originX.value = e.focalX - width / 2;
      originY.value = e.focalY - height / 2;
    })
    .onUpdate((e) => {
      const s = Math.min(MAX_SCALE * 1.2, Math.max(0.8, startScale.value * e.scale));
      const ratio = s / startScale.value;
      // Keep the point under the fingers under them; where they have moved to
      // carries the picture along.
      const fx = e.focalX - width / 2;
      const fy = e.focalY - height / 2;
      scale.value = s;
      tx.value = fx - (originX.value - startX.value) * ratio;
      ty.value = fy - (originY.value - startY.value) * ratio;
    })
    .onEnd(() => {
      const s = Math.min(MAX_SCALE, Math.max(1, scale.value));
      scale.value = withTiming(s, { duration: 180 });
      tx.value = withTiming(s === 1 ? 0 : clampX(tx.value, s), { duration: 180 });
      ty.value = withTiming(s === 1 ? 0 : clampY(ty.value, s), { duration: 180 });
      runOnJS(report)(s > 1);
    });

  const pan = Gesture.Pan()
    .enabled(zoomed)
    .maxPointers(1)
    .onStart(() => {
      startX.value = tx.value;
      startY.value = ty.value;
    })
    .onUpdate((e) => {
      tx.value = clampX(startX.value + e.translationX, scale.value);
      ty.value = clampY(startY.value + e.translationY, scale.value);
    })
    .onEnd((e) => {
      const maxX = Math.max(0, (fitW.value * scale.value - width) / 2);
      const maxY = Math.max(0, (fitH.value * scale.value - height) / 2);
      tx.value = withDecay({ velocity: e.velocityX, clamp: [-maxX, maxX] });
      ty.value = withDecay({ velocity: e.velocityY, clamp: [-maxY, maxY] });
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      if (scale.value > 1) {
        scale.value = withTiming(1, { duration: 200 });
        tx.value = withTiming(0, { duration: 200 });
        ty.value = withTiming(0, { duration: 200 });
        runOnJS(report)(false);
        return;
      }
      const s = DOUBLE_TAP_SCALE;
      const fx = e.x - width / 2;
      const fy = e.y - height / 2;
      scale.value = withTiming(s, { duration: 200 });
      tx.value = withTiming(clampX(fx - fx * s, s), { duration: 200 });
      ty.value = withTiming(clampY(fy - fy * s, s), { duration: 200 });
      runOnJS(report)(true);
    });

  const singleTap = Gesture.Tap().onEnd(() => {
    if (scale.value <= 1) runOnJS(onTap)();
  });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height, overflow: 'hidden' }} collapsable={false}>
        <Animated.View style={[{ width, height }, style]}>
          <Image
            source={{ uri }}
            style={{ width, height }}
            contentFit="contain"
            onLoad={(e) => {
              const iw = e.source.width;
              const ih = e.source.height;
              if (!iw || !ih) return;
              const k = Math.min(width / iw, height / ih);
              fitW.value = iw * k;
              fitH.value = ih * k;
            }}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
