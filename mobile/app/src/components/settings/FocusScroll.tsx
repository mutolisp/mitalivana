/**
 * Settings search lands on a subpage row (03-screens-flow.md §4c): the menu
 * pushes `route?focus=<id>`, this scroller reads the param, and the
 * <FocusAnchor> with that id scrolls itself into view and flashes acorn-tint
 * for 1.2 s. Ids are listed in src/lib/settingsIndex.ts; check:settings-index
 * fails when one has no anchor.
 *
 * An anchor outside a FocusScrollView is a plain View, so a component shared
 * with a screen that has no search entry point needs no second version.
 */
import { useLocalSearchParams } from 'expo-router';
import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewProps } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

interface FocusCtx {
  focus: string | undefined;
  content: RefObject<View | null>;
  scrollTo: (y: number) => void;
  /** Two anchors may share an id (both 採集號 rows); only the first acts. */
  done: { current: boolean };
}

const Ctx = createContext<FocusCtx | null>(null);

export function FocusScrollView({ children, ...props }: ScrollViewProps & { children: ReactNode }) {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const done = useRef(false);
  const ctx: FocusCtx = {
    focus,
    content,
    scrollTo: (y) => scroll.current?.scrollTo({ y, animated: true }),
    done,
  };
  return (
    <ScrollView ref={scroll} {...props}>
      <Ctx.Provider value={ctx}>
        {/* Measuring against this wrapper gives the anchor's y in scroll
            content coordinates, however deeply it is nested. */}
        <View ref={content} collapsable={false}>
          {children}
        </View>
      </Ctx.Provider>
    </ScrollView>
  );
}

export function FocusAnchor({ id, children }: { id: string; children: ReactNode }) {
  const ctx = useContext(Ctx);
  const self = useRef<View>(null);
  const flash = useSharedValue(0);
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.value }));

  const onLayout = () => {
    if (!ctx || ctx.focus !== id || ctx.done.current) return;
    ctx.done.current = true;
    // One frame later, so the rows above have their final heights.
    requestAnimationFrame(() => {
      const target = ctx.content.current;
      if (!self.current || !target) return;
      self.current.measureLayout(
        target,
        (_x, y) => {
          ctx.scrollTo(Math.max(0, y - 24));
          flash.value = 0.6;
          flash.value = withTiming(0, { duration: 1200 });
        },
        () => undefined,
      );
    });
  };

  return (
    <View ref={self} collapsable={false} onLayout={onLayout}>
      {children}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, flashStyle]}>
        <View className="flex-1 bg-acorn-tint dark:bg-acorn-deep" />
      </Animated.View>
    </View>
  );
}
