/**
 * `react-native-draggable-flatlist` on the web: rows reorder by dragging.
 *
 * As on mobile, a row starts moving when its own handle calls `drag()`
 * (the shared rows do that on a long press). It then follows the pointer;
 * rows it passes slide out of its way, and on release `onDragEnd` gets the
 * new order. Page scrolling is held off while a row is carried (touch).
 *
 * Keyboard (desktop): with focus inside a row, Alt+↑ / Alt+↓ moves it one
 * place — the same onDragEnd, so the screen saves it as a drag.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, type FlatListProps } from '../rn/core';

export type RenderItemParams<T> = { item: T; getIndex: () => number | undefined; drag: () => void; isActive: boolean };

type Props<T> = Omit<FlatListProps<T>, 'renderItem'> & {
  renderItem: (p: RenderItemParams<T>) => ReactNode;
  onDragEnd?: (p: { data: T[]; from: number; to: number }) => void;
  onDragBegin?: (index: number) => void;
  onRelease?: (index: number) => void;
  activationDistance?: number;
  containerStyle?: unknown;
};

// Where the pointer is now: drag() is called from a long press, after the
// press began, so the start position has to come from here.
const last = { x: 0, y: 0 };
if (typeof window !== 'undefined') {
  const track = (e: PointerEvent) => {
    last.x = e.clientX;
    last.y = e.clientY;
  };
  window.addEventListener('pointerdown', track, true);
  window.addEventListener('pointermove', track, true);
}

type DragState = { from: number; to: number; dy: number; height: number };

function moved<T>(data: readonly T[], from: number, to: number): T[] {
  const out = data.slice();
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

function useDragRows<T>(data: readonly T[], p: Props<T>) {
  const rows = useRef<Array<HTMLDivElement | null>>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const finish = (from: number, to: number) => {
    p.onRelease?.(from);
    if (to !== from) p.onDragEnd?.({ data: moved(data, from, to), from, to });
  };

  const start = (from: number) => {
    const rects = rows.current.slice(0, data.length).map((r) => r?.getBoundingClientRect() ?? null);
    const own = rects[from];
    if (!own) return;
    const startY = last.y || own.top + own.height / 2;
    const mids = rects.map((r) => (r ? r.top + r.height / 2 : 0));
    let state: DragState = { from, to: from, dy: 0, height: own.height };
    setDrag(state);
    p.onDragBegin?.(from);
    const onMove = (e: PointerEvent) => {
      const dy = e.clientY - startY;
      const centre = own.top + own.height / 2 + dy;
      let to = from;
      for (let i = 0; i < mids.length; i++) {
        if (i < from && centre < mids[i]) {
          to = i;
          break;
        }
        if (i > from && centre > mids[i]) to = i;
      }
      state = { ...state, dy, to };
      setDrag(state);
    };
    const holdScroll = (e: TouchEvent) => e.preventDefault();
    const onUp = () => {
      stop();
      setDrag(null);
      finish(from, state.to);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('touchmove', holdScroll);
      document.body.style.userSelect = '';
      cleanup.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchmove', holdScroll, { passive: false });
    document.body.style.userSelect = 'none';
    cleanup.current = stop;
  };

  const shift = (i: number): number => {
    if (!drag || i === drag.from) return drag && i === drag.from ? drag.dy : 0;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -drag.height;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return drag.height;
    return 0;
  };

  const row = (item: T, index: number, key: string, separator: ReactNode) => {
    const active = drag?.from === index;
    return (
      <div
        key={key}
        ref={(el) => {
          rows.current[index] = el;
        }}
        className="rn-view"
        style={{
          transform: drag ? `translateY(${shift(index)}px)` : undefined,
          transition: drag && !active ? 'transform 120ms ease-out' : undefined,
          position: 'relative',
          zIndex: active ? 10 : undefined,
          boxShadow: active ? '0 6px 16px rgb(0 0 0 / 0.18)' : undefined,
        }}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          const to = e.key === 'ArrowUp' ? index - 1 : index + 1;
          if (to < 0 || to >= data.length) return;
          e.preventDefault();
          p.onDragEnd?.({ data: moved(data, index, to), from: index, to });
        }}
      >
        {separator}
        {p.renderItem({ item, getIndex: () => index, drag: () => start(index), isActive: active })}
      </div>
    );
  };
  return row;
}

const show = (c: ReactNode | (() => ReactNode)) => (typeof c === 'function' ? c() : c);

function Rows<T>(p: Props<T>) {
  const data = p.data ?? [];
  const row = useDragRows(data, p);
  return (
    <>
      {show(p.ListHeaderComponent)}
      {data.length === 0
        ? show(p.ListEmptyComponent)
        : data.map((item, index) =>
            row(item, index, p.keyExtractor ? p.keyExtractor(item, index) : String(index), index > 0 && p.ItemSeparatorComponent ? p.ItemSeparatorComponent() : null),
          )}
      {show(p.ListFooterComponent)}
    </>
  );
}

/** A list with its own scroller. */
export default function DraggableFlatList<T>(p: Props<T>) {
  const { renderItem: _r, onDragEnd: _a, onDragBegin: _b, onRelease: _c, activationDistance: _d, containerStyle: _e, data: _f, ...scroll } = p;
  return (
    <ScrollView {...(scroll as object)}>
      <Rows {...p} />
    </ScrollView>
  );
}

/** The nested variant: rows in the page's own scroller (NestableScrollContainer). */
export function NestableDraggableFlatList<T>(p: Props<T>) {
  return (
    <div className="rn-view">
      <Rows {...p} />
    </div>
  );
}

export { ScrollView as NestableScrollContainer } from '../rn/core';

export function ScaleDecorator({ children }: { children?: ReactNode; activeScale?: number }) {
  return <>{children}</>;
}
export const ShadowDecorator = ScaleDecorator;
export const OpacityDecorator = ScaleDecorator;
