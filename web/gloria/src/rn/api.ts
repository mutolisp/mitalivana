/**
 * Non-component React Native APIs the shared code calls: Alert (rendered by
 * <AlertHost/>), Keyboard, Platform, AppState, Dimensions /
 * useWindowDimensions, Linking.
 */
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

// ── Alert ─────────────────────────────────────────────────────────────────

export type AlertButton = { text?: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };
export type AlertRequest = { id: number; title: string; message?: string; buttons: AlertButton[]; cancelable: boolean };

type AlertStore = { queue: AlertRequest[]; push(r: AlertRequest): void; shift(): void };
export const useAlertStore = create<AlertStore>((set) => ({
  queue: [],
  push: (r) => set((s) => ({ queue: [...s.queue, r] })),
  shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

let alertSeq = 0;

export const Alert = {
  /** Same signature as RN; with no buttons there is a single OK. Tapping outside counts as cancel only when `cancelable`. */
  alert(title: string, message?: string, buttons?: AlertButton[], options?: { cancelable?: boolean }) {
    useAlertStore.getState().push({
      id: ++alertSeq,
      title,
      message,
      buttons: buttons?.length ? buttons : [{ text: 'OK' }],
      cancelable: options?.cancelable ?? false,
    });
  },
};

// ── Keyboard ──────────────────────────────────────────────────────────────

export const Keyboard = {
  dismiss() {
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur();
  },
  addListener(_event: string, _fn: (...a: unknown[]) => void) {
    return { remove() {} };
  },
  isVisible: () => false,
};

// ── Platform ──────────────────────────────────────────────────────────────

export const Platform = {
  OS: 'web' as const,
  Version: 0,
  select<T>(o: { web?: T; default?: T; ios?: T; android?: T; native?: T }): T | undefined {
    return 'web' in o ? o.web : o.default;
  },
};

// ── AppState ──────────────────────────────────────────────────────────────

const appStateNow = () => (document.visibilityState === 'visible' ? 'active' : 'background');

export const AppState = {
  get currentState() {
    return appStateNow();
  },
  addEventListener(_type: 'change', fn: (s: 'active' | 'background') => void) {
    const h = () => fn(appStateNow());
    document.addEventListener('visibilitychange', h);
    return { remove: () => document.removeEventListener('visibilitychange', h) };
  },
};

// ── Dimensions ────────────────────────────────────────────────────────────

type Dim = { width: number; height: number; scale: number; fontScale: number };
let dim: Dim = { width: 0, height: 0, scale: 1, fontScale: 1 };
const readDim = (): Dim => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w !== dim.width || h !== dim.height) dim = { width: w, height: h, scale: window.devicePixelRatio || 1, fontScale: 1 };
  return dim;
};

export const Dimensions = {
  get(_which: 'window' | 'screen' = 'window'): Dim {
    return readDim();
  },
  addEventListener(_t: 'change', fn: (e: { window: Dim }) => void) {
    const h = () => fn({ window: readDim() });
    window.addEventListener('resize', h);
    return { remove: () => window.removeEventListener('resize', h) };
  },
};

export function useWindowDimensions(): Dim {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('resize', cb);
      return () => window.removeEventListener('resize', cb);
    },
    readDim,
    readDim,
  );
}

// ── Linking ───────────────────────────────────────────────────────────────

export const Linking = {
  async openURL(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  async canOpenURL(url: string) {
    return /^https?:/.test(url);
  },
};

// ── BackHandler (Escape) ──────────────────────────────────────────────────

const backHandlers: Array<() => boolean | null | undefined> = [];
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || backHandlers.length === 0) return;
    // Last registered first, as on Android.
    for (let i = backHandlers.length - 1; i >= 0; i--) {
      if (backHandlers[i]()) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
    }
  });
}

/** Android's back button; on the web the Escape key. */
export const BackHandler = {
  addEventListener(_event: 'hardwareBackPress', fn: () => boolean | null | undefined) {
    backHandlers.push(fn);
    return {
      remove() {
        const i = backHandlers.lastIndexOf(fn);
        if (i >= 0) backHandlers.splice(i, 1);
      },
    };
  },
  exitApp() {},
};

// ── Accessibility ─────────────────────────────────────────────────────────

/** The DOM element itself stands in for a native node handle. */
export function findNodeHandle(ref: unknown): HTMLElement | null {
  return ref instanceof HTMLElement ? ref : null;
}

let liveRegion: HTMLElement | null = null;

export const AccessibilityInfo = {
  setAccessibilityFocus(node: unknown) {
    if (!(node instanceof HTMLElement)) return;
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    node.focus({ preventScroll: true });
  },
  announceForAccessibility(message: string) {
    if (!liveRegion) {
      liveRegion = document.createElement('div');
      liveRegion.setAttribute('aria-live', 'polite');
      liveRegion.className = 'sr-only';
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = '';
    setTimeout(() => liveRegion && (liveRegion.textContent = message), 50);
  },
  isScreenReaderEnabled: async () => false,
  isReduceMotionEnabled: async () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  addEventListener: (_e: string, _fn: unknown) => ({ remove() {} }),
};
