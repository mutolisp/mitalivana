/**
 * `@rn-primitives/select` (headless select used by components/ui/select.tsx
 * and SpeciesPager): Root / Trigger / Value / Portal / Overlay / Content /
 * Viewport / Item / ItemText / ItemIndicator / useRootContext, with the same
 * `{ value, label }` option objects and `asChild` behaviour.
 *
 * The list opens below the trigger (above when there is no room), inside a
 * full-screen overlay that closes it on a click outside or Escape.
 */
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Pressable, Text, View, type TextProps, type ViewProps } from '../rn/core';

export type Option = { value: string; label: string } | undefined;
type Rect = { x: number; y: number; width: number; height: number };

type RootCtx = {
  value: Option;
  onValueChange: (o: Option) => void;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  disabled?: boolean;
  trigger: Rect | null;
  setTrigger: (r: Rect | null) => void;
};
const Ctx = createContext<RootCtx | null>(null);

export function useRootContext(): RootCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('Select components must be inside <Select.Root>');
  return c;
}

export function Root(p: {
  value?: Option;
  defaultValue?: Option;
  onValueChange?: (o: Option) => void;
  onOpenChange?: (o: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const [inner, setInner] = useState<Option>(p.defaultValue);
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<Rect | null>(null);
  const value = p.value !== undefined ? p.value : inner;
  const ctx: RootCtx = {
    value,
    onValueChange: (o) => {
      if (p.value === undefined) setInner(o);
      p.onValueChange?.(o);
    },
    open,
    onOpenChange: (o) => {
      setOpen(o);
      p.onOpenChange?.(o);
    },
    disabled: p.disabled,
    trigger,
    setTrigger,
  };
  return <Ctx.Provider value={ctx}>{p.children}</Ctx.Provider>;
}

/** Merge props into the single child (`asChild`). */
function slot(children: ReactNode, props: Record<string, unknown>): ReactElement | null {
  const child = Children.only(children);
  if (!isValidElement(child)) return null;
  return cloneElement(child as ReactElement<Record<string, unknown>>, props);
}

export function Trigger(p: ViewProps & { asChild?: boolean; disabled?: boolean; onPress?: () => void; children?: ReactNode }) {
  const ctx = useRootContext();
  const ref = useRef<HTMLDivElement | null>(null);
  const disabled = p.disabled ?? ctx.disabled;
  const press = () => {
    if (disabled) return;
    const r = ref.current?.getBoundingClientRect();
    ctx.setTrigger(r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
    p.onPress?.();
    ctx.onOpenChange(true);
  };
  const { asChild, children, ...rest } = p;
  if (asChild) {
    // The child is a Pressable: wrap to measure it, hand it the press.
    return (
      <div ref={ref} className="rn-view">
        {slot(children, { onPress: press })}
      </div>
    );
  }
  return (
    <Pressable {...rest} ref={ref} disabled={disabled} onPress={press} accessibilityRole="combobox" accessibilityState={{ expanded: ctx.open }}>
      {children}
    </Pressable>
  );
}

export function Value(p: TextProps & { placeholder?: string }) {
  const { value } = useRootContext();
  const { placeholder, ...rest } = p;
  return <Text {...rest}>{value?.label ?? placeholder ?? ''}</Text>;
}

export function Portal({ children }: { children?: ReactNode; hostName?: string }) {
  const { open } = useRootContext();
  if (!open) return null;
  return createPortal(<div className="fixed inset-0 z-50">{children}</div>, document.body);
}

export function Overlay(p: ViewProps & { asChild?: boolean; closeOnPress?: boolean; children?: ReactNode; style?: unknown }) {
  const ctx = useRootContext();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && ctx.onOpenChange(false);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const close = () => p.closeOnPress !== false && ctx.onOpenChange(false);
  if (p.asChild) return slot(p.children, { onPress: close });
  return (
    <Pressable className={p.className} style={p.style as never} onPress={close}>
      {p.children}
    </Pressable>
  );
}

export function Content(p: ViewProps & { position?: string; sideOffset?: number; insets?: Partial<Record<'top' | 'bottom' | 'left' | 'right', number>> }) {
  const { trigger } = useRootContext();
  const off = p.sideOffset ?? 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ins = { top: 8, bottom: 8, left: 12, right: 12, ...p.insets };
  const t = trigger ?? { x: vw / 2 - 120, y: vh / 3, width: 240, height: 0 };
  const below = vh - (t.y + t.height) - ins.bottom;
  const above = t.y - ins.top;
  const up = below < 200 && above > below;
  const width = Math.max(t.width, 128);
  const left = Math.min(Math.max(ins.left, t.x), vw - ins.right - width);
  const style: React.CSSProperties = up
    ? { position: 'fixed', left, width, bottom: vh - t.y + off, maxHeight: above - off }
    : { position: 'fixed', left, width, top: t.y + t.height + off, maxHeight: below - off };
  return (
    <div className={['rn-view overflow-hidden', p.className].filter(Boolean).join(' ')} style={style} role="listbox" onClick={(e) => e.stopPropagation()}>
      {p.children}
    </div>
  );
}

export function Viewport(p: ViewProps) {
  return <View {...p} />;
}

type ItemCtx = { value: string; label: string; selected: boolean };
const ItemContext = createContext<ItemCtx | null>(null);

export function Item(p: ViewProps & { value: string; label: string; disabled?: boolean; onPress?: () => void; closeOnPress?: boolean; children?: ReactNode }) {
  const ctx = useRootContext();
  const selected = ctx.value?.value === p.value;
  const { value, label, disabled, onPress, closeOnPress, children, ...rest } = p;
  return (
    <ItemContext.Provider value={{ value, label, selected }}>
      <Pressable
        {...rest}
        disabled={disabled}
        accessibilityRole="option"
        accessibilityState={{ selected, disabled }}
        onPress={() => {
          ctx.onValueChange({ value, label });
          onPress?.();
          if (closeOnPress !== false) ctx.onOpenChange(false);
        }}
      >
        {children}
      </Pressable>
    </ItemContext.Provider>
  );
}

export function useItemContext(): ItemCtx {
  const c = useContext(ItemContext);
  if (!c) throw new Error('Select item parts must be inside <Select.Item>');
  return c;
}

export function ItemText(p: TextProps) {
  const { label } = useItemContext();
  return <Text {...p}>{label}</Text>;
}

export function ItemIndicator(p: { asChild?: boolean; children?: ReactNode }) {
  const { selected } = useItemContext();
  if (!selected) return null;
  return p.asChild ? slot(p.children, {}) : <View>{p.children}</View>;
}

export const Group = View;
export const Label = Text;
export function Separator(p: ViewProps) {
  return <View {...p} />;
}
export const ScrollUpButton = () => null;
export const ScrollDownButton = () => null;
