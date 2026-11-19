/**
 * `react-native-keyboard-controller`. Browsers move focused inputs into view
 * themselves, so the keyboard-aware containers are plain views / scrollers
 * and the keyboard state is "not shown".
 */
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
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
/**
 * The on-screen keyboard's height, from the visual viewport: on iOS the
 * keyboard covers the page instead of resizing it, so what the visual
 * viewport loses at the bottom is the keyboard. Elsewhere (desktop, Android
 * resizing the page) this stays 0. Under 80 px counts as no keyboard (URL bar).
 */
function keyboardHeight(): number {
  if (typeof window === 'undefined' || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  const h = window.innerHeight - vv.height - vv.offsetTop;
  return h > 80 ? Math.round(h) : 0;
}

type KbEvent = { height: number; progress: number; duration: number; target: number };
const kbListeners = new Set<(e: KbEvent) => void>();
let lastHeight = 0;
if (typeof window !== 'undefined' && window.visualViewport) {
  const fire = () => {
    const height = keyboardHeight();
    if (height === lastHeight) return;
    lastHeight = height;
    const e = { height, progress: height > 0 ? 1 : 0, duration: 0, target: -1 };
    kbListeners.forEach((l) => l(e));
  };
  window.visualViewport.addEventListener('resize', fire);
  window.visualViewport.addEventListener('scroll', fire);
}

export function useKeyboardState<T = { isVisible: boolean; height: number }>(sel?: (s: { isVisible: boolean; height: number }) => T): T {
  const [h, setH] = useState(keyboardHeight);
  useEffect(() => {
    const l = (e: KbEvent) => setH(e.height);
    kbListeners.add(l);
    return () => {
      kbListeners.delete(l);
    };
  }, []);
  const s = { isVisible: h > 0, height: h };
  return (sel ? sel(s) : s) as T;
}
export function useReanimatedKeyboardAnimation() {
  return { height: { value: 0 }, progress: { value: 0 } };
}
export const KeyboardController = {
  dismiss: async () => (document.activeElement as HTMLElement | null)?.blur?.(),
  isVisible: () => keyboardHeight() > 0,
  state: () => ({ height: keyboardHeight(), duration: 0, timestamp: Date.now(), target: -1, type: 'default', appearance: 'default' }),
  setFocusTo: (_d: string) => {},
};
export const KeyboardEvents = { addListener: (_e: string, _fn: unknown) => ({ remove() {} }) };
type Handlers = Partial<Record<'onStart' | 'onMove' | 'onInteractive' | 'onEnd', (e: KbEvent) => void>>;

/** onStart / onMove / onEnd fire once per viewport change (no frame-by-frame track on the web). */
export function useKeyboardHandler(handlers: Handlers, _deps?: unknown[]): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const l = (e: KbEvent) => {
      ref.current.onStart?.(e);
      ref.current.onMove?.(e);
      ref.current.onEnd?.(e);
    };
    kbListeners.add(l);
    return () => {
      kbListeners.delete(l);
    };
  }, []);
}
