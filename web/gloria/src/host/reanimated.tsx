/**
 * `react-native-reanimated`, the part the shared components use:
 * useSharedValue / useAnimatedStyle / withTiming / runOnJS / useReducedMotion,
 * Animated.View, and the FadeIn-style entering builders.
 *
 * Shared values are plain observable boxes. useAnimatedStyle records which
 * shared values its function reads and re-renders the component when any of
 * them changes; withTiming tweens numbers on requestAnimationFrame. Nothing
 * runs on a UI thread — worklets are ordinary functions here.
 */
import { forwardRef, useEffect, useMemo, useReducer, useRef, useSyncExternalStore, type ComponentType } from 'react';
import { Image as RNImage, Pressable, ScrollView, Text, View } from '../rn/core';

// ── Shared values ─────────────────────────────────────────────────────────

type Timing = { __timing: true; to: number; duration: number; cb?: (finished: boolean) => void };
let tracking: Set<SharedValue<unknown>> | null = null;

export class SharedValue<T> {
  private v: T;
  private subs = new Set<() => void>();
  private raf = 0;
  constructor(v: T) {
    this.v = v;
  }
  get value(): T {
    tracking?.add(this as SharedValue<unknown>);
    return this.v;
  }
  set value(next: T) {
    const t = next as unknown as Timing;
    if (t && typeof t === 'object' && t.__timing) {
      this.animate(t);
      return;
    }
    this.stop();
    this.set(next);
  }
  get(): T {
    return this.value;
  }
  private set(next: T) {
    if (Object.is(next, this.v)) return;
    this.v = next;
    for (const s of this.subs) s();
  }
  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  private animate(t: Timing) {
    this.stop();
    // withDecay: no fling on the web; the value stays where the drag left it.
    if (!Number.isFinite(t.to)) {
      t.cb?.(true);
      return;
    }
    const from = Number(this.v);
    const start = performance.now();
    if (!Number.isFinite(from) || t.duration <= 0 || reducedMotion()) {
      this.set(t.to as unknown as T);
      t.cb?.(true);
      return;
    }
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / t.duration);
      const eased = 1 - Math.pow(1 - k, 3);
      this.set((from + (t.to - from) * eased) as unknown as T);
      if (k < 1) this.raf = requestAnimationFrame(step);
      else {
        this.raf = 0;
        t.cb?.(true);
      }
    };
    this.raf = requestAnimationFrame(step);
  }
}

export function makeMutable<T>(v: T): SharedValue<T> {
  return new SharedValue(v);
}

export function useSharedValue<T>(init: T): SharedValue<T> {
  const ref = useRef<SharedValue<T>>(null);
  if (!ref.current) ref.current = new SharedValue(init);
  useEffect(() => () => ref.current?.stop(), []);
  return ref.current;
}

export function withTiming(to: number, cfg?: { duration?: number; easing?: unknown }, cb?: (finished?: boolean) => void): number {
  return { __timing: true, to, duration: cfg?.duration ?? 300, cb } as unknown as number;
}
export const withSpring = (to: number, _cfg?: unknown, cb?: (finished?: boolean) => void) => withTiming(to, { duration: 250 }, cb);
export const withDelay = (_ms: number, v: number) => v;
export const withDecay = (_cfg?: unknown, cb?: (finished?: boolean) => void) => withTiming(Number.NaN, { duration: 0 }, cb);
export const withSequence = (...vs: number[]) => vs[vs.length - 1];
export const withRepeat = (v: number) => v;
export function cancelAnimation(sv: SharedValue<unknown>) {
  sv.stop();
}
export const runOnJS = <A extends unknown[], R>(fn: (...a: A) => R) => fn;
export const runOnUI = runOnJS;

/** Re-render when a shared value read by `fn` changes. */
function useTracked<T>(fn: () => T): T {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const prev = tracking;
  const seen = new Set<SharedValue<unknown>>();
  tracking = seen;
  let out: T;
  try {
    out = fn();
  } finally {
    tracking = prev;
  }
  const deps = [...seen];
  useEffect(() => {
    const offs = deps.map((d) => d.subscribe(bump));
    return () => offs.forEach((o) => o());
  });
  return out;
}

export function useAnimatedStyle<T>(fn: () => T, _deps?: unknown[]): T {
  return useTracked(fn);
}
export const useAnimatedProps = useAnimatedStyle;

export function useDerivedValue<T>(fn: () => T, _deps?: unknown[]): SharedValue<T> {
  const value = useTracked(fn);
  const sv = useSharedValue(value);
  sv.value = value;
  return sv;
}

export function useAnimatedReaction<T>(prepare: () => T, react: (cur: T, prev: T | null) => void) {
  const cur = useTracked(prepare);
  const prev = useRef<T | null>(null);
  useEffect(() => {
    if (!Object.is(prev.current, cur)) react(cur, prev.current);
    prev.current = cur;
  });
}

// ── Motion preference ─────────────────────────────────────────────────────

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = window.matchMedia('(prefers-reduced-motion: reduce)');
      q.addEventListener('change', cb);
      return () => q.removeEventListener('change', cb);
    },
    reducedMotion,
    () => false,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

export const Extrapolation = { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' } as const;
export function interpolate(x: number, input: number[], output: number[], extrapolate: string = 'extend'): number {
  let i = 1;
  while (i < input.length - 1 && x > input[i]) i++;
  const [a, b] = [input[i - 1], input[i]];
  const [c, d] = [output[i - 1], output[i]];
  let t = b === a ? 0 : (x - a) / (b - a);
  if (extrapolate === 'clamp') t = Math.min(1, Math.max(0, t));
  return c + (d - c) * t;
}
export const Easing = {
  linear: (t: number) => t,
  ease: (t: number) => t,
  quad: (t: number) => t * t,
  cubic: (t: number) => t * t * t,
  in: (f: (t: number) => number) => f,
  out: (f: (t: number) => number) => (t: number) => 1 - f(1 - t),
  inOut: (f: (t: number) => number) => f,
  bezier: () => (t: number) => t,
};

/** Entering / exiting builders (FadeIn.duration(150)…): a short CSS fade on mount. */
function builder(cls: string) {
  const b = { cls, duration: () => b, delay: () => b, springify: () => b, withInitialValues: () => b, easing: () => b };
  return b;
}
export const FadeIn = builder('rn-modal-fade');
export const FadeOut = builder('');
export const FadeInDown = builder('rn-modal-slide');
export const FadeOutDown = builder('');
export const SlideInDown = builder('rn-modal-slide');
export const SlideOutDown = builder('');
export const LinearTransition = builder('');
export const Layout = LinearTransition;

// ── Animated components ───────────────────────────────────────────────────

type WithAnim = { entering?: { cls?: string }; exiting?: unknown; layout?: unknown; className?: string; animatedProps?: unknown };

export function createAnimatedComponent<P extends object>(C: ComponentType<P>) {
  return forwardRef<unknown, P & WithAnim>(function Animated(props, ref) {
    const { entering, exiting: _e, layout: _l, animatedProps: _a, ...rest } = props;
    const className = useMemo(() => [rest.className, entering?.cls].filter(Boolean).join(' ') || undefined, [rest.className, entering]);
    const Comp = C as ComponentType<Record<string, unknown>>;
    return <Comp {...rest} className={className} ref={ref} />;
  });
}

const Animated = {
  View: createAnimatedComponent(View),
  Text: createAnimatedComponent(Text),
  ScrollView: createAnimatedComponent(ScrollView),
  Image: createAnimatedComponent(RNImage),
  Pressable: createAnimatedComponent(Pressable),
  createAnimatedComponent,
};
export default Animated;
export { Animated };
