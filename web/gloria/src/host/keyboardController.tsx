/**
 * `react-native-keyboard-controller`. Browsers move focused inputs into view
 * themselves, so the keyboard-aware containers are plain views / scrollers
 * and the keyboard state is "not shown".
 */
import { forwardRef, type ReactNode } from 'react';
import { ScrollView, View, type ScrollViewHandle, type ScrollViewProps, type ViewProps } from '../rn/core';

export const KeyboardAwareScrollView = forwardRef<ScrollViewHandle, ScrollViewProps & { bottomOffset?: number; extraKeyboardSpace?: number }>(
  function KeyboardAwareScrollView(p, ref) {
    return <ScrollView ref={ref} {...p} />;
  },
);
export function KeyboardStickyView(p: ViewProps & { offset?: unknown; enabled?: boolean }) {
  return <View {...p} />;
}
export function KeyboardAvoidingView(p: ViewProps & { behavior?: string; keyboardVerticalOffset?: number; enabled?: boolean }) {
  return <View {...p} />;
}
export function KeyboardProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
export function useKeyboardState<T = { isVisible: boolean; height: number }>(sel?: (s: { isVisible: boolean; height: number }) => T): T {
  const s = { isVisible: false, height: 0 };
  return (sel ? sel(s) : s) as T;
}
export function useReanimatedKeyboardAnimation() {
  return { height: { value: 0 }, progress: { value: 0 } };
}
export const KeyboardController = { dismiss: () => (document.activeElement as HTMLElement | null)?.blur?.() };
export function useKeyboardHandler(_handlers: Record<string, unknown>, _deps?: unknown[]): void {}
