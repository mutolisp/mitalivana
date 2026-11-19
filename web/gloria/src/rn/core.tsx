/**
 * DOM implementations of the React Native components the shared mobile UI
 * uses (View, Text, Pressable, ScrollView, TextInput, …). They take the same
 * props, including NativeWind `className` strings — NativeWind classes are
 * Tailwind classes, so they apply to these elements as they are.
 *
 * Layout defaults follow React Native (flex column, no shrink, relative,
 * border-box) through the `rn-view` / `rn-text` classes in index.css, so a
 * className written for a phone lays out the same here.
 *
 * Only the props the shared components pass are implemented; anything else
 * is ignored rather than forwarded to the DOM.
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { toCss, type StyleProp, type StyleValue } from './style';

export type LayoutChangeEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };
export type GestureResponderEvent = {
  nativeEvent: { locationX: number; locationY: number; pageX: number; pageY: number };
  stopPropagation(): void;
  preventDefault(): void;
};
export type AccessibilityRole = string;
export type AccessibilityState = { disabled?: boolean; selected?: boolean; checked?: boolean | 'mixed'; busy?: boolean; expanded?: boolean };
export type ViewStyle = StyleValue;
export type TextStyle = StyleValue;
export type ImageStyle = StyleValue;

type A11y = {
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  accessibilityHint?: string;
  accessible?: boolean;
  testID?: string;
  nativeID?: string;
};

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

function a11yProps(p: A11y): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.accessibilityLabel) out['aria-label'] = p.accessibilityLabel;
  if (p.accessibilityHint) out['aria-description'] = p.accessibilityHint;
  if (p.testID) out['data-testid'] = p.testID;
  if (p.nativeID) out.id = p.nativeID;
  const s = p.accessibilityState;
  if (s?.disabled) out['aria-disabled'] = true;
  if (s?.selected != null) out['aria-selected'] = s.selected;
  if (s?.checked != null) out['aria-checked'] = s.checked;
  if (s?.expanded != null) out['aria-expanded'] = s.expanded;
  if (s?.busy) out['aria-busy'] = true;
  const r = p.accessibilityRole;
  if (r && r !== 'none') out.role = r === 'header' ? 'heading' : r === 'image' ? 'img' : r === 'adjustable' ? 'slider' : r;
  return out;
}

function useLayout(onLayout?: (e: LayoutChangeEvent) => void) {
  const ref = useRef<HTMLElement | null>(null);
  const cb = useRef(onLayout);
  cb.current = onLayout;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !cb.current) return;
    const fire = () => {
      const r = el.getBoundingClientRect();
      const parent = el.offsetParent?.getBoundingClientRect();
      cb.current?.({
        nativeEvent: { layout: { x: r.left - (parent?.left ?? 0), y: r.top - (parent?.top ?? 0), width: r.width, height: r.height } },
      });
    };
    fire();
    const ro = new ResizeObserver(fire);
    ro.observe(el);
    return () => ro.disconnect();
    // Re-subscribe only when a listener appears or goes away.
  }, [!!onLayout]);
  return ref;
}

type MeasureCb = (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void;

/**
 * React Native view refs carry measure / measureInWindow / measureLayout /
 * setNativeProps; shared components call them (keyboard spacing, dropdown
 * placement). Put them on the DOM node so those calls work unchanged.
 */
function withNativeMethods<T>(el: T): T {
  const node = el as unknown as (HTMLElement & Record<string, unknown>) | null;
  if (!node || node.measureInWindow) return el;
  const rect = () => node.getBoundingClientRect();
  node.measureInWindow = (cb: (x: number, y: number, w: number, h: number) => void) => {
    const r = rect();
    cb(r.left, r.top, r.width, r.height);
  };
  node.measure = (cb: MeasureCb) => {
    const r = rect();
    const p = node.offsetParent?.getBoundingClientRect();
    cb(r.left - (p?.left ?? 0), r.top - (p?.top ?? 0), r.width, r.height, r.left + window.scrollX, r.top + window.scrollY);
  };
  node.measureLayout = (rel: unknown, ok: (x: number, y: number, w: number, h: number) => void) => {
    const r = rect();
    const o = rel instanceof HTMLElement ? rel.getBoundingClientRect() : { left: 0, top: 0 };
    ok(r.left - o.left, r.top - o.top, r.width, r.height);
  };
  node.setNativeProps = (props: { style?: StyleProp<StyleValue> }) => {
    if (props?.style) Object.assign(node.style, toCss(props.style));
  };
  return el;
}

function setRefs<T>(el: T, ...refs: Array<unknown>) {
  withNativeMethods(el);
  for (const r of refs) {
    if (typeof r === 'function') r(el);
    else if (r && typeof r === 'object') (r as { current: T }).current = el;
  }
}

// ── View ──────────────────────────────────────────────────────────────────

export type ViewProps = A11y & {
  className?: string;
  style?: StyleProp<StyleValue>;
  children?: ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  hitSlop?: unknown;
  collapsable?: boolean;
  onStartShouldSetResponder?: unknown;
  onTouchStart?: unknown;
  onTouchEnd?: unknown;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
};

export const View = forwardRef<HTMLDivElement, ViewProps>(function View(p, ref) {
  const lref = useLayout(p.onLayout);
  const pe = p.pointerEvents;
  return (
    <div
      ref={(el) => setRefs(el, ref, lref)}
      className={cx('rn-view', p.className, pe === 'none' && 'pointer-events-none', pe === 'box-none' && 'rn-box-none')}
      style={toCss(p.style)}
      onPointerDown={p.onPointerDown}
      onPointerMove={p.onPointerMove}
      onPointerUp={p.onPointerUp}
      {...a11yProps(p)}
    >
      {p.children}
    </div>
  );
});

// ── Text ──────────────────────────────────────────────────────────────────

const InText = createContext(false);

export type TextProps = A11y & {
  className?: string;
  style?: StyleProp<StyleValue>;
  children?: ReactNode;
  numberOfLines?: number;
  selectable?: boolean;
  onPress?: (e: GestureResponderEvent) => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  onLayout?: (e: LayoutChangeEvent) => void;
  ellipsizeMode?: string;
  adjustsFontSizeToFit?: boolean;
  allowFontScaling?: boolean;
  maxFontSizeMultiplier?: number;
};

export const Text = forwardRef<HTMLSpanElement, TextProps>(function Text(p, ref) {
  const nested = useContext(InText);
  const lref = useLayout(p.onLayout);
  const clamp: CSSProperties | undefined =
    p.numberOfLines && p.numberOfLines > 0
      ? p.numberOfLines === 1
        ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        : { overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: p.numberOfLines, WebkitBoxOrient: 'vertical' }
      : undefined;
  const css = toCss(p.style);
  return (
    <InText.Provider value>
      <span
        ref={(el) => setRefs(el, ref, lref)}
        className={cx(nested ? 'rn-text-nested' : 'rn-text', p.className, p.selectable && 'select-text', p.onPress && 'cursor-pointer')}
        style={clamp || css ? { ...css, ...clamp } : undefined}
        onClick={
          p.onPress
            ? (e) => {
                e.stopPropagation();
                p.onPress?.(toGesture(e));
              }
            : undefined
        }
        {...a11yProps(p)}
      >
        {p.children}
      </span>
    </InText.Provider>
  );
});

// ── Pressable ─────────────────────────────────────────────────────────────

type PressState = { pressed: boolean; hovered?: boolean };

export type PressableProps = A11y & {
  className?: string;
  style?: StyleProp<StyleValue> | ((s: PressState) => StyleProp<StyleValue>);
  children?: ReactNode | ((s: PressState) => ReactNode);
  onPress?: (e: GestureResponderEvent) => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  onPressIn?: (e: GestureResponderEvent) => void;
  onPressOut?: (e: GestureResponderEvent) => void;
  delayLongPress?: number;
  disabled?: boolean | null;
  onLayout?: (e: LayoutChangeEvent) => void;
  hitSlop?: unknown;
  android_ripple?: unknown;
  unstable_pressDelay?: number;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
};

function toGesture(e: { clientX?: number; clientY?: number; pageX?: number; pageY?: number; currentTarget?: EventTarget | null; stopPropagation(): void; preventDefault(): void }): GestureResponderEvent {
  const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect?.();
  return {
    nativeEvent: {
      locationX: (e.clientX ?? 0) - (r?.left ?? 0),
      locationY: (e.clientY ?? 0) - (r?.top ?? 0),
      pageX: e.pageX ?? 0,
      pageY: e.pageY ?? 0,
    },
    stopPropagation: () => e.stopPropagation(),
    preventDefault: () => e.preventDefault(),
  };
}

export const Pressable = forwardRef<HTMLDivElement, PressableProps>(function Pressable(p, ref) {
  const [pressed, setPressed] = useState(false);
  const lref = useLayout(p.onLayout);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const disabled = !!p.disabled;

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const state = { pressed };
  const style = typeof p.style === 'function' ? p.style(state) : p.style;
  const children = typeof p.children === 'function' ? p.children(state) : p.children;
  const interactive = !disabled && !!(p.onPress || p.onLongPress || p.onPressIn);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || e.button > 0) return;
      longFired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      setPressed(true);
      p.onPressIn?.(toGesture(e));
      if (p.onLongPress) {
        const ev = toGesture(e);
        timer.current = setTimeout(() => {
          longFired.current = true;
          setPressed(false);
          p.onLongPress?.(ev);
        }, p.delayLongPress ?? 500);
      }
    },
    [disabled, p.onLongPress, p.onPressIn, p.delayLongPress],
  );
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    clear();
    if (pressed) {
      setPressed(false);
      p.onPressOut?.(toGesture(e));
    }
  };

  return (
    <div
      ref={(el) => setRefs(el, ref, lref)}
      className={cx('rn-view', p.className, interactive && 'rn-pressable', disabled && 'rn-disabled', p.pointerEvents === 'none' && 'pointer-events-none')}
      style={toCss(style)}
      role={p.accessibilityRole ? undefined : interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-disabled={disabled || undefined}
      {...a11yProps(p)}
      onPointerDown={onPointerDown}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
      onPointerMove={(e) => {
        const s = start.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
          clear();
          setPressed(false);
        }
      }}
      onContextMenu={p.onLongPress ? (e) => e.preventDefault() : undefined}
      onClick={(e) => {
        if (disabled) return;
        if (longFired.current) {
          longFired.current = false;
          e.stopPropagation();
          return;
        }
        if (p.onPress) {
          e.stopPropagation();
          p.onPress(toGesture(e));
        }
      }}
      onKeyDown={(e) => {
        if (!interactive || (e.key !== 'Enter' && e.key !== ' ')) return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        p.onPress?.(toGesture(e as unknown as React.PointerEvent<HTMLDivElement>));
      }}
    >
      {children}
    </div>
  );
});

export const TouchableOpacity = Pressable;

// ── ScrollView ────────────────────────────────────────────────────────────

export type ScrollViewHandle = {
  scrollTo(o: { x?: number; y?: number; animated?: boolean } | number): void;
  scrollToEnd(o?: { animated?: boolean }): void;
};

export type ScrollViewProps = ViewProps & {
  horizontal?: boolean;
  contentContainerClassName?: string;
  contentContainerStyle?: StyleProp<StyleValue>;
  showsVerticalScrollIndicator?: boolean;
  showsHorizontalScrollIndicator?: boolean;
  keyboardShouldPersistTaps?: string;
  keyboardDismissMode?: string;
  onScroll?: (e: { nativeEvent: { contentOffset: { x: number; y: number } } }) => void;
  scrollEventThrottle?: number;
  scrollEnabled?: boolean;
  bounces?: boolean;
  automaticallyAdjustKeyboardInsets?: boolean;
  nestedScrollEnabled?: boolean;
  refreshControl?: ReactNode;
};

export const ScrollView = forwardRef<ScrollViewHandle, ScrollViewProps>(function ScrollView(p, ref) {
  const el = useRef<HTMLDivElement | null>(null);
  const lref = useLayout(p.onLayout);
  useImperativeHandle(ref, () => ({
    scrollTo(o) {
      const opt = typeof o === 'number' ? { y: o } : o;
      el.current?.scrollTo({ left: opt.x, top: opt.y, behavior: opt.animated === false ? 'auto' : 'smooth' });
    },
    scrollToEnd(o) {
      const d = el.current;
      if (d) d.scrollTo({ top: d.scrollHeight, left: d.scrollWidth, behavior: o?.animated === false ? 'auto' : 'smooth' });
    },
  }));
  return (
    <div
      ref={(d) => setRefs(d, el, lref)}
      className={cx('rn-view rn-scroll', p.horizontal ? 'overflow-x-auto overflow-y-hidden' : 'overflow-y-auto', p.scrollEnabled === false && 'overflow-hidden', p.className)}
      style={toCss(p.style)}
      onScroll={p.onScroll ? (e) => p.onScroll?.({ nativeEvent: { contentOffset: { x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop } } }) : undefined}
      {...a11yProps(p)}
    >
      <div
        className={cx('rn-view', p.horizontal && 'flex-row', p.contentContainerClassName)}
        style={toCss(p.contentContainerStyle)}
      >
        {p.children}
      </div>
    </div>
  );
});

// ── TextInput ─────────────────────────────────────────────────────────────

export type TextInputHandle = { focus(): void; blur(): void; clear(): void; isFocused(): boolean };

export type TextInputProps = A11y & {
  className?: string;
  style?: StyleProp<StyleValue>;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  placeholderTextColor?: string;
  onChangeText?: (text: string) => void;
  onChange?: (e: { nativeEvent: { text: string } }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSubmitEditing?: (e: { nativeEvent: { text: string } }) => void;
  onEndEditing?: (e: { nativeEvent: { text: string } }) => void;
  onKeyPress?: (e: { nativeEvent: { key: string } }) => void;
  multiline?: boolean;
  numberOfLines?: number;
  editable?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  autoComplete?: string;
  keyboardType?: string;
  inputMode?: string;
  returnKeyType?: string;
  enterKeyHint?: string;
  secureTextEntry?: boolean;
  selectTextOnFocus?: boolean;
  blurOnSubmit?: boolean;
  submitBehavior?: string;
  textAlign?: 'left' | 'center' | 'right';
  inputAccessoryViewID?: string;
  clearButtonMode?: string;
  selectionColor?: string;
  textContentType?: string;
  spellCheck?: boolean;
  scrollEnabled?: boolean;
};

const INPUT_MODE: Record<string, React.HTMLAttributes<HTMLInputElement>['inputMode']> = {
  numeric: 'numeric',
  'number-pad': 'numeric',
  'decimal-pad': 'decimal',
  'numbers-and-punctuation': 'decimal',
  'email-address': 'email',
  'phone-pad': 'tel',
  url: 'url',
  'web-search': 'search',
};

export const TextInput = forwardRef<TextInputHandle, TextInputProps>(function TextInput(p, ref) {
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => el.current?.focus(),
    blur: () => el.current?.blur(),
    clear: () => {
      if (el.current) el.current.value = '';
      p.onChangeText?.('');
    },
    isFocused: () => document.activeElement === el.current,
  }));
  const common = {
    ref: el,
    className: cx('rn-input', p.className),
    style: { ...toCss(p.style), ...(p.textAlign ? { textAlign: p.textAlign } : null) },
    value: p.value,
    defaultValue: p.defaultValue,
    placeholder: p.placeholder,
    readOnly: p.editable === false,
    maxLength: p.maxLength,
    autoFocus: p.autoFocus,
    autoCapitalize: p.autoCapitalize === 'characters' ? 'characters' : p.autoCapitalize,
    autoCorrect: p.autoCorrect === false ? 'off' : undefined,
    autoComplete: p.autoComplete === 'off' ? 'off' : p.autoComplete,
    spellCheck: p.spellCheck ?? p.autoCorrect,
    inputMode: (p.inputMode as never) ?? (p.keyboardType ? INPUT_MODE[p.keyboardType] : undefined),
    enterKeyHint: (p.enterKeyHint ?? (p.returnKeyType === 'done' || p.returnKeyType === 'go' || p.returnKeyType === 'next' || p.returnKeyType === 'search' || p.returnKeyType === 'send' ? p.returnKeyType : undefined)) as never,
    'aria-label': p.accessibilityLabel ?? p.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      p.onChangeText?.(e.target.value);
      p.onChange?.({ nativeEvent: { text: e.target.value } });
    },
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (p.selectTextOnFocus) e.target.select();
      p.onFocus?.();
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      p.onEndEditing?.({ nativeEvent: { text: e.target.value } });
      p.onBlur?.();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      p.onKeyPress?.({ nativeEvent: { key: e.key } });
      if (e.key === 'Enter' && !p.multiline && !e.nativeEvent.isComposing) {
        p.onSubmitEditing?.({ nativeEvent: { text: (e.target as HTMLInputElement).value } });
        if (p.blurOnSubmit !== false && p.submitBehavior !== 'submit') (e.target as HTMLInputElement).blur();
      }
    },
  };
  return p.multiline ? (
    <textarea {...common} rows={p.numberOfLines ?? 3} />
  ) : (
    <input {...common} type={p.secureTextEntry ? 'password' : 'text'} />
  );
});

// ── Small pieces ──────────────────────────────────────────────────────────

export function ActivityIndicator(p: { size?: 'small' | 'large' | number; color?: string; className?: string; style?: StyleProp<StyleValue> }) {
  const d = typeof p.size === 'number' ? p.size : p.size === 'large' ? 36 : 20;
  return (
    <span
      role="progressbar"
      className={cx('rn-spinner', p.className)}
      style={{ width: d, height: d, borderColor: p.color, ...toCss(p.style) }}
    />
  );
}

export type SwitchProps = {
  value?: boolean;
  onValueChange?: (v: boolean) => void;
  disabled?: boolean;
  trackColor?: { false?: string; true?: string };
  thumbColor?: string;
  ios_backgroundColor?: string;
  accessibilityLabel?: string;
  className?: string;
  style?: StyleProp<StyleValue>;
};

export function Switch(p: SwitchProps) {
  const on = !!p.value;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={p.accessibilityLabel}
      disabled={p.disabled}
      onClick={() => p.onValueChange?.(!on)}
      className={cx('rn-switch', on && 'rn-switch-on', p.className)}
      style={{ background: on ? p.trackColor?.true : p.trackColor?.false, ...toCss(p.style) }}
    >
      <span className="rn-switch-thumb" style={{ background: p.thumbColor }} />
    </button>
  );
}

export type FlatListProps<T> = Omit<ScrollViewProps, 'children'> & {
  data: ReadonlyArray<T> | null | undefined;
  renderItem: (info: { item: T; index: number }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  ListHeaderComponent?: ReactNode | (() => ReactNode);
  ListFooterComponent?: ReactNode | (() => ReactNode);
  ListEmptyComponent?: ReactNode | (() => ReactNode);
  ItemSeparatorComponent?: () => ReactNode;
  extraData?: unknown;
  initialNumToRender?: number;
  getItemLayout?: unknown;
};

const render = (c: ReactNode | (() => ReactNode)) => (typeof c === 'function' ? c() : c);

/** No virtualization: GLORIA lists are tens of rows, not thousands. */
export function FlatList<T>(p: FlatListProps<T>) {
  const data = p.data ?? [];
  return (
    <ScrollView {...p}>
      {render(p.ListHeaderComponent)}
      {data.length === 0
        ? render(p.ListEmptyComponent)
        : data.map((item, index) => (
            <div key={p.keyExtractor ? p.keyExtractor(item, index) : String(index)} className="rn-view">
              {index > 0 && p.ItemSeparatorComponent ? p.ItemSeparatorComponent() : null}
              {p.renderItem({ item, index })}
            </div>
          ))}
      {render(p.ListFooterComponent)}
    </ScrollView>
  );
}

/** iOS keyboard accessory bar: nothing to show on the web. */
export function InputAccessoryView(_p: { nativeID?: string; children?: ReactNode }) {
  return null;
}

export function Image(p: { source?: { uri?: string } | number; className?: string; style?: StyleProp<StyleValue>; accessibilityLabel?: string; resizeMode?: string }) {
  const uri = typeof p.source === 'object' ? p.source?.uri : undefined;
  if (!uri) return null;
  const fit = p.resizeMode === 'contain' ? 'contain' : 'cover';
  return <img src={uri} alt={p.accessibilityLabel ?? ''} className={cx('rn-image', p.className)} style={{ objectFit: fit, ...toCss(p.style) }} />;
}

// ── SectionList ───────────────────────────────────────────────────────────

export type SectionBase<T> = { data: ReadonlyArray<T>; key?: string } & Record<string, unknown>;

export type SectionListProps<T, S extends SectionBase<T>> = Omit<ScrollViewProps, 'children'> & {
  sections: ReadonlyArray<S>;
  renderItem: (info: { item: T; index: number; section: S }) => ReactNode;
  renderSectionHeader?: (info: { section: S }) => ReactNode;
  renderSectionFooter?: (info: { section: S }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  stickySectionHeadersEnabled?: boolean;
  ListHeaderComponent?: ReactNode | (() => ReactNode);
  ListFooterComponent?: ReactNode | (() => ReactNode);
  ListEmptyComponent?: ReactNode | (() => ReactNode);
  ItemSeparatorComponent?: () => ReactNode;
  initialNumToRender?: number;
  extraData?: unknown;
};

/** No virtualization (sheets and lists here are short); sticky headers by CSS. */
export function SectionList<T, S extends SectionBase<T>>(p: SectionListProps<T, S>) {
  const empty = p.sections.every((s) => s.data.length === 0);
  return (
    <ScrollView {...p}>
      {render(p.ListHeaderComponent)}
      {empty
        ? render(p.ListEmptyComponent)
        : p.sections.map((section, si) => (
            <div key={section.key ?? si} className="rn-view">
              {p.renderSectionHeader ? (
                <div className={['rn-view', p.stickySectionHeadersEnabled ? 'sticky top-0 z-10' : ''].join(' ')}>
                  {p.renderSectionHeader({ section })}
                </div>
              ) : null}
              {section.data.map((item, index) => (
                <div key={p.keyExtractor ? p.keyExtractor(item, index) : String(index)} className="rn-view">
                  {index > 0 && p.ItemSeparatorComponent ? p.ItemSeparatorComponent() : null}
                  {p.renderItem({ item, index, section })}
                </div>
              ))}
              {p.renderSectionFooter ? p.renderSectionFooter({ section }) : null}
            </div>
          ))}
      {render(p.ListFooterComponent)}
    </ScrollView>
  );
}

export function KeyboardAvoidingView(p: ViewProps & { behavior?: string; keyboardVerticalOffset?: number; enabled?: boolean; contentContainerStyle?: unknown }) {
  return <View {...p} />;
}
