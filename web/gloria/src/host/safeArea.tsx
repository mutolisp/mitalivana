/**
 * `react-native-safe-area-context`. The page itself pads for notches with
 * `env(safe-area-inset-*)` (index.css), so components see zero insets and
 * SafeAreaView is a plain View.
 */
import type { ReactNode } from 'react';
import { View, type ViewProps } from '../rn/core';

export type EdgeInsets = { top: number; right: number; bottom: number; left: number };
const ZERO: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function useSafeAreaInsets(): EdgeInsets {
  return ZERO;
}
export function useSafeAreaFrame() {
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}
export function SafeAreaView(p: ViewProps & { edges?: string[]; mode?: string }) {
  return <View {...p} />;
}
export function SafeAreaProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
export const SafeAreaInsetsContext = { Consumer: ({ children }: { children: (i: EdgeInsets) => ReactNode }) => children(ZERO) };
export const initialWindowMetrics = { insets: ZERO, frame: { x: 0, y: 0, width: 0, height: 0 } };
