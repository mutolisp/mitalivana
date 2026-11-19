/**
 * `react-native-gesture-handler` on pointer events: Gesture.Pan / Pinch /
 * Tap / LongPress / Native builders, Simultaneous / Exclusive / Race, and
 * <GestureDetector>. Covers what the shared components do with them — brush
 * painting a frequency grid, swiping between species, two-finger pan and
 * pinch zoom on the summit and point diagrams, the sheet's drag-to-close.
 *
 * Desktop: a trackpad pinch arrives as ctrl+wheel and is fed to Pinch
 * gestures, so the diagrams zoom there too.
 *
 * Event fields provided: x/y (relative to the detector), absoluteX/Y,
 * translationX/Y, changeX/Y, velocityX/Y, numberOfPointers; pinch adds
 * scale, focalX/Y, velocity.
 */
import { Children, cloneElement, isValidElement, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { FlatList as RNFlatList, Pressable, ScrollView as RNScrollView, View, type ViewProps } from '../rn/core';

type Cb = (e: Record<string, number>) => void;

const NOT_BUILDER = new Set(['then', 'catch', 'toJSON', 'toString', 'valueOf', 'constructor', '$$typeof', 'asymmetricMatch', 'nodeType', 'tagName', 'inspect', 'prototype']);
type Kind = 'pan' | 'pinch' | 'tap' | 'longPress' | 'native';

export class GestureBuilder {
  kind: Kind;
  cbs: Record<string, Cb | undefined> = {};
  cfg: Record<string, unknown> = { enabled: true, minPointers: 1, maxPointers: 10, minDistance: 2 };
  /** The Proxy wrapping this builder: every chained call must return it, not `this`. */
  self!: GestureBuilder;
  constructor(kind: Kind) {
    this.kind = kind;
    // Every builder method returns the proxy; unknown ones are accepted and ignored.
    const proxy = new Proxy(this, {
      get(target, prop: string | symbol) {
        // Symbols and well-known names (then, toJSON…) must read as absent, or
        // React and dev tooling would treat a gesture as a promise / string.
        if (typeof prop !== 'string' || NOT_BUILDER.has(prop) || prop in target) {
          return Reflect.get(target, prop);
        }
        if (/^on[A-Z]/.test(prop)) {
          return (fn: Cb) => {
            target.cbs[prop] = fn;
            return target.self;
          };
        }
        return (...args: unknown[]) => {
          target.cfg[prop] = args.length <= 1 ? args[0] : args;
          return target.self;
        };
      },
    });
    this.self = proxy;
    return proxy;
  }
}

type Composite = { kind: 'composite'; gestures: GestureLike[] };
type GestureLike = GestureBuilder | Composite;

/** Any builder method returns the builder again, as in react-native-gesture-handler. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- builder arguments are free-form, as in RNGH
type Chain = GestureBuilder & { [method: string]: (...a: any[]) => Chain };
const build = (k: Kind) => new GestureBuilder(k) as Chain;

export const Gesture = {
  Pan: () => build('pan'),
  Pinch: () => build('pinch'),
  Tap: () => build('tap'),
  LongPress: () => build('longPress'),
  Native: () => build('native'),
  Manual: () => build('native'),
  Fling: () => build('native'),
  Rotation: () => build('native'),
  Hover: () => build('native'),
  Simultaneous: (...gestures: GestureLike[]): Composite => ({ kind: 'composite', gestures }),
  Exclusive: (...gestures: GestureLike[]): Composite => ({ kind: 'composite', gestures }),
  Race: (...gestures: GestureLike[]): Composite => ({ kind: 'composite', gestures }),
};

function flat(g: GestureLike): GestureBuilder[] {
  return 'gestures' in g && g.kind === 'composite' ? g.gestures.flatMap(flat) : [g as GestureBuilder];
}

const asRange = (v: unknown): [number, number] | null => {
  if (v == null) return null;
  if (Array.isArray(v)) return [Number(v[0]), Number(v[1])];
  const n = Number(v);
  return n >= 0 ? [-Infinity, n] : [n, Infinity];
};
const outside = (d: number, r: [number, number] | null) => !!r && (d <= r[0] || d >= r[1]);

type Pt = { x: number; y: number };

export function GestureDetector({ gesture, children }: { gesture: GestureLike; children: ReactNode }) {
  const gs = flat(gesture).filter((g) => g.cfg.enabled !== false);
  const ref = useRef<HTMLDivElement | null>(null);
  const pts = useRef(new Map<number, Pt>());
  const st = useRef({
    start: { x: 0, y: 0 } as Pt,
    last: { x: 0, y: 0, t: 0 },
    vel: { x: 0, y: 0 },
    active: new Set<GestureBuilder>(),
    failed: new Set<GestureBuilder>(),
    pinch0: 0,
    lastScale: 1,
    longTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    down: false,
  });

  const rel = (p: Pt) => {
    const r = ref.current?.getBoundingClientRect();
    return { x: p.x - (r?.left ?? 0), y: p.y - (r?.top ?? 0) };
  };
  const centroid = (): Pt => {
    const a = [...pts.current.values()];
    return a.length ? { x: a.reduce((s, p) => s + p.x, 0) / a.length, y: a.reduce((s, p) => s + p.y, 0) / a.length } : { x: 0, y: 0 };
  };
  const spread = () => {
    const a = [...pts.current.values()];
    return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  };
  const event = (extra: Record<string, number> = {}) => {
    const c = centroid();
    const r = rel(c);
    const s = st.current;
    return {
      x: r.x,
      y: r.y,
      absoluteX: c.x,
      absoluteY: c.y,
      translationX: c.x - s.start.x,
      translationY: c.y - s.start.y,
      velocityX: s.vel.x,
      velocityY: s.vel.y,
      numberOfPointers: pts.current.size,
      ...extra,
    };
  };
  const fire = (g: GestureBuilder, name: string, e: Record<string, number>) => g.cbs[name]?.(e);

  const finish = (success: boolean) => {
    const s = st.current;
    clearTimeout(s.longTimer);
    const e = event({ scale: s.lastScale, focalX: rel(centroid()).x, focalY: rel(centroid()).y });
    for (const g of gs) {
      if (s.active.has(g)) fire(g, 'onEnd', { ...e, success: success ? 1 : 0 });
      fire(g, success ? 'onTouchesUp' : 'onTouchesCancelled', e);
      fire(g, 'onFinalize', e);
    }
    s.active.clear();
    s.failed.clear();
    s.down = false;
  };

  const onDown = (ev: React.PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    pts.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    const s = st.current;
    // Restart the reference point whenever the finger count changes.
    s.start = centroid();
    s.last = { ...s.start, t: performance.now() };
    if (pts.current.size === 2) {
      s.pinch0 = spread();
      s.lastScale = 1;
    }
    const e = event();
    if (!s.down) {
      s.down = true;
      for (const g of gs) {
        fire(g, 'onTouchesDown', e);
        fire(g, 'onBegin', e);
        if (g.kind === 'pan' && Number(g.cfg.minDistance) === 0 && pts.current.size >= Number(g.cfg.minPointers)) {
          s.active.add(g);
          fire(g, 'onStart', e);
        }
        if (g.kind === 'longPress') {
          s.longTimer = setTimeout(() => {
            s.active.add(g);
            fire(g, 'onStart', event());
          }, Number(g.cfg.minDuration ?? 500));
        }
      }
    }
  };

  const onMove = (ev: React.PointerEvent) => {
    if (!pts.current.has(ev.pointerId)) return;
    pts.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const s = st.current;
    const c = centroid();
    const now = performance.now();
    const dt = Math.max(1, now - s.last.t);
    const changeX = c.x - s.last.x;
    const changeY = c.y - s.last.y;
    s.vel = { x: (changeX / dt) * 1000, y: (changeY / dt) * 1000 };
    s.last = { x: c.x, y: c.y, t: now };
    const dx = c.x - s.start.x;
    const dy = c.y - s.start.y;
    if (Math.hypot(dx, dy) > 10) clearTimeout(s.longTimer);
    const n = pts.current.size;
    const base = event({ changeX, changeY });
    for (const g of gs) {
      if (s.failed.has(g)) continue;
      if (g.kind === 'pan') {
        if (n < Number(g.cfg.minPointers) || n > Number(g.cfg.maxPointers)) continue;
        if (!s.active.has(g)) {
          if (outside(dx, asRange(g.cfg.failOffsetX)) || outside(dy, asRange(g.cfg.failOffsetY))) {
            s.failed.add(g);
            continue;
          }
          const ax = asRange(g.cfg.activeOffsetX);
          const ay = asRange(g.cfg.activeOffsetY);
          const go = ax || ay ? outside(dx, ax) || outside(dy, ay) : Math.hypot(dx, dy) >= Number(g.cfg.minDistance);
          if (!go) continue;
          s.active.add(g);
          fire(g, 'onStart', base);
        }
        fire(g, 'onUpdate', base);
        fire(g, 'onChange', base);
      } else if (g.kind === 'pinch' && n >= 2 && s.pinch0 > 0) {
        const scale = spread() / s.pinch0;
        const r = rel(c);
        const e = { ...base, scale, focalX: r.x, focalY: r.y, velocity: 0, scaleChange: scale / (s.lastScale || 1) };
        s.lastScale = scale;
        if (!s.active.has(g)) {
          s.active.add(g);
          fire(g, 'onStart', e);
        }
        fire(g, 'onUpdate', e);
        fire(g, 'onChange', e);
      }
    }
  };

  const onUp = (ev: React.PointerEvent, cancelled = false) => {
    if (!pts.current.has(ev.pointerId)) return;
    const s = st.current;
    const c = centroid();
    const moved = Math.hypot(c.x - s.start.x, c.y - s.start.y);
    if (!cancelled && pts.current.size === 1 && moved < 10) {
      for (const g of gs) if (g.kind === 'tap' && !s.active.has(g)) fire(g, 'onEnd', { ...event(), success: 1 });
    }
    pts.current.delete(ev.pointerId);
    if (pts.current.size === 0) finish(!cancelled);
    else {
      s.start = centroid();
      s.pinch0 = spread();
    }
  };

  // Trackpad pinch (ctrl+wheel) → Pinch gestures. A native listener: React's
  // wheel handler is passive and could not stop the page from zooming.
  const wheelScale = useRef({ scale: 1, timer: 0 as unknown as ReturnType<typeof setTimeout> });
  const pinchesRef = useRef<GestureBuilder[]>([]);
  pinchesRef.current = gs.filter((g) => g.kind === 'pinch');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      const pinches = pinchesRef.current;
      if (!ev.ctrlKey || pinches.length === 0) return;
      ev.preventDefault();
      const w = wheelScale.current;
      const r = rel({ x: ev.clientX, y: ev.clientY });
      const starting = w.scale === 1;
      w.scale *= Math.exp(-ev.deltaY / 100);
      const e = { x: r.x, y: r.y, focalX: r.x, focalY: r.y, scale: w.scale, velocity: 0, numberOfPointers: 2 } as Record<string, number>;
      for (const g of pinches) {
        if (starting) {
          fire(g, 'onBegin', e);
          fire(g, 'onStart', e);
        }
        fire(g, 'onUpdate', e);
      }
      clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        for (const g of pinches) {
          fire(g, 'onEnd', e);
          fire(g, 'onFinalize', e);
        }
        w.scale = 1;
      }, 150);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // A pan that must win over page scrolling claims the touch; a horizontal
  // swipe (activeOffsetX) leaves vertical scrolling to the page.
  const pans = gs.filter((g) => g.kind === 'pan');
  const touchAction = pans.length === 0 && !gs.some((g) => g.kind === 'pinch')
    ? undefined
    : pans.some((g) => g.cfg.activeOffsetX != null && g.cfg.activeOffsetY == null)
      ? 'pan-y'
      : pans.some((g) => g.cfg.activeOffsetY != null && g.cfg.activeOffsetX == null)
        ? 'pan-x'
        : pans.every((g) => Number(g.cfg.minPointers) >= 2)
          ? 'pan-x pan-y'
          : 'none';

  const child = Children.only(children);
  return (
    <div
      ref={ref}
      className="rn-view"
      style={{ touchAction }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={(e) => onUp(e)}
      onPointerCancel={(e) => onUp(e, true)}
    >
      {isValidElement(child) ? cloneElement(child as ReactElement) : child}
    </div>
  );
}

export function GestureHandlerRootView(p: ViewProps) {
  return <View {...p} />;
}

export const ScrollView = RNScrollView;
export const FlatList = RNFlatList;
export const TouchableOpacity = Pressable;
export const RectButton = Pressable;
export const BaseButton = Pressable;
export const BorderlessButton = Pressable;
export const State = { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 } as const;
export const Directions = { RIGHT: 1, LEFT: 2, UP: 4, DOWN: 8 } as const;
export type GestureType = GestureBuilder;
export type PanGesture = GestureBuilder;
