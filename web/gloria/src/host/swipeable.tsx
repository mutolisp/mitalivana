/**
 * `react-native-gesture-handler/Swipeable`: a row that slides to reveal its
 * actions. On the web the row drags with the pointer (touch or mouse) past
 * 40 px to open; the actions are the same elements the mobile row renders.
 */
import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react';

type Props = {
  children?: ReactNode;
  renderRightActions?: (...a: unknown[]) => ReactNode;
  renderLeftActions?: (...a: unknown[]) => ReactNode;
  onSwipeableOpen?: (direction: 'left' | 'right') => void;
  onSwipeableClose?: () => void;
  onSwipeableWillOpen?: (direction: 'left' | 'right') => void;
  friction?: number;
  rightThreshold?: number;
  leftThreshold?: number;
  overshootRight?: boolean;
  overshootLeft?: boolean;
  containerStyle?: unknown;
  childrenContainerStyle?: unknown;
  enabled?: boolean;
};

export type SwipeableMethods = { close(): void; openLeft(): void; openRight(): void; reset(): void };

const Swipeable = forwardRef<SwipeableMethods, Props>(function Swipeable(p, ref) {
  const [open, setOpen] = useState<'left' | 'right' | null>(null);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const set = (o: 'left' | 'right' | null) => {
    setOpen(o);
    setDx(0);
    if (o) {
      p.onSwipeableWillOpen?.(o);
      p.onSwipeableOpen?.(o);
    } else p.onSwipeableClose?.();
  };
  useImperativeHandle(ref, () => ({
    close: () => set(null),
    openLeft: () => set('left'),
    openRight: () => set('right'),
    reset: () => set(null),
  }));
  const enabled = p.enabled !== false;
  return (
    <div className="rn-view" style={{ overflow: 'hidden' }}>
      {open === 'left' && p.renderLeftActions ? <div className="rn-view flex-row">{p.renderLeftActions()}</div> : null}
      <div
        className="rn-view"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, touchAction: 'pan-y' }}
        onPointerDown={(e) => {
          if (!enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
          start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s || s.id !== e.pointerId) return;
          const x = e.clientX - s.x;
          if (Math.abs(e.clientY - s.y) > 24 && Math.abs(x) < 24) {
            start.current = null;
            setDx(0);
            return;
          }
          if ((x < 0 && p.renderRightActions) || (x > 0 && p.renderLeftActions)) setDx(x);
        }}
        onPointerUp={() => {
          if (!start.current) return;
          start.current = null;
          if (dx < -40) set('right');
          else if (dx > 40) set('left');
          else setDx(0);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDx(0);
        }}
      >
        {p.children}
      </div>
      {open === 'right' && p.renderRightActions ? <div className="rn-view flex-row justify-end">{p.renderRightActions()}</div> : null}
    </div>
  );
});

export default Swipeable;
export { Swipeable };
