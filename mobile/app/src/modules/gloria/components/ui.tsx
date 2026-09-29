/**
 * Small building blocks shared by the GLORIA screens. `Btn` wraps the app's
 * `Button`, and `Card` / `Banner` draw from the redesign tokens (card, line,
 * accent, acorn, alert), so every GLORIA screen takes the new palette before
 * its layout is redone (03-screens-flow.md §4d).
 */
import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, InputAccessoryView, Keyboard, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { checkRange, type Range } from '../model/ranges';
import { Button } from '~/components/ui/Button';
import { useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <View className={`rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark ${className}`}>
      {children}
    </View>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{children}</Text>
  );
}

/** Kept as a thin wrapper so the GLORIA call sites need no change: `primary`
 *  maps to the primary look, everything else to secondary. `small` is the md
 *  size (40 pt), which is as small as a field button should get. */
export function Btn({
  label,
  onPress,
  primary = false,
  disabled = false,
  small = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  small?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Button
      label={label}
      onPress={onPress}
      variant={primary ? 'primary' : 'secondary'}
      size={small ? 'md' : 'lg'}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <View className="flex-row rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-800 dark:bg-gray-900">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            className={`flex-1 items-center rounded-md py-1.5 ${on ? 'bg-card dark:bg-gray-700' : ''}`}
          >
            <Text className={`text-xs ${on ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({
  label,
  on,
  onPress,
  onLongPress,
  badge,
  tone,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  badge?: string;
  /** Distinct colour for grazing features, so they never read as species. */
  tone?: string;
}) {
  const c = useThemeColors();
  const border = tone ? { borderColor: tone, borderStyle: 'dashed' as const } : undefined;
  const fill = on ? { backgroundColor: tone ?? c.accent, borderColor: tone ?? c.accent } : undefined;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[border, fill]}
      className="mr-1.5 mb-1.5 flex-row items-center rounded-full border border-gray-300 bg-card px-3 py-1.5 dark:border-gray-700 dark:bg-gray-900"
    >
      <Text className={`text-xs ${on ? 'font-semibold text-white' : 'text-gray-900 dark:text-gray-100'}`}>{label}</Text>
      {badge ? (
        <Text className={`ml-1.5 text-[10px] ${on ? 'text-white/80' : 'font-semibold text-gray-700 dark:text-gray-300'}`} style={{ fontVariant: ['tabular-nums'] }}>
          {badge}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A passed check: shown, then gone after the undo duration (偏好設定, default
 * 5 s) — confirmation, not something to keep reading. A new `text` (the
 * numbers changed) shows it again.
 */
export function PassBanner({ text }: { text: string }) {
  const secs = useSettings((s) => s.undo_duration);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    setShown(true);
    const h = setTimeout(() => setShown(false), secs * 1000);
    return () => clearTimeout(h);
  }, [text, secs]);
  if (!shown) return null;
  return (
    <Banner tone="ok">
      <BannerText tone="ok">{text}</BannerText>
    </Banner>
  );
}

export function Banner({ tone, children }: { tone: 'warn' | 'error' | 'info' | 'ok'; children: React.ReactNode }) {
  const cls = {
    warn: 'border-acorn bg-acorn-tint dark:border-acorn-deep dark:bg-gray-800',
    error: 'border-alert bg-alert-tint dark:border-alert-dark dark:bg-alert-dark-tint',
    info: 'border-transparent bg-accent-100 dark:bg-accent-900',
    ok: 'border-accent-300 bg-accent-50 dark:border-accent-700 dark:bg-accent-950',
  }[tone];
  return <View className={`rounded-xl border px-3 py-2 ${cls}`}>{children}</View>;
}

/**
 * A warning that folds away: the title (with a count) always shows, the
 * detail opens on tap. Folded by default so warnings don't push the species
 * list off screen.
 */
export function FoldBanner({
  tone,
  title,
  count,
  children,
}: {
  tone: 'warn' | 'error';
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ink = tone === 'error' ? c.alert : c.acornDeep;
  return (
    <Banner tone={tone}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        className="flex-row items-center"
      >
        <Ionicons name="warning-outline" size={14} color={ink} />
        <View className="ml-1.5 flex-1">
          <BannerText tone={tone} bold>
            {count != null && count > 1 ? t('gloria.foldCount', { title, n: count }) : title}
          </BannerText>
        </View>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={ink} />
      </Pressable>
      {open ? <View className="mt-1 gap-0.5">{children}</View> : null}
    </Banner>
  );
}

export function BannerText({ tone, children, bold }: { tone: 'warn' | 'error' | 'info' | 'ok'; children: React.ReactNode; bold?: boolean }) {
  const cls = {
    warn: 'text-acorn-deep dark:text-acorn',
    error: 'text-alert dark:text-alert-dark',
    info: 'text-accent-800 dark:text-accent-300',
    ok: 'text-accent-700 dark:text-accent-300',
  }[tone];
  return <Text className={`text-xs ${bold ? 'font-semibold' : ''} ${cls}`}>{children}</Text>;
}

/** Digits and a decimal point only. */
export const NUMERIC_KEYBOARD = 'decimal-pad' as const;

/**
 * iOS's number pad has no return key, so numeric fields get a bar above the
 * keyboard with Next / Done. A field that steps through items (the cover
 * stepper: 7 top covers, 6 subtypes) also gets Previous. Android's number pad
 * has its own Next key and InputAccessoryView renders nothing there, so the
 * bar is drawn there only for stepping fields, which need Previous too.
 * Render one <NumAccessory /> per screen that uses NumField; on Android it
 * rides on the keyboard (KeyboardStickyView), so the screen root must be
 * <SafeAreaView edges={['bottom']}> — true where the stepper is used.
 */
export const NUM_ACCESSORY_ID = 'gloria-num';
let focusedNext: (() => void) | null = null;
let focusedPrev: (() => void) | null = null;
// Whether the focused field steps (has Previous), for the Android bar.
let stepping = false;
const listeners = new Set<() => void>();
const setStepping = (v: boolean) => {
  if (v === stepping) return;
  stepping = v;
  listeners.forEach((l) => l());
};
const subscribeStepping = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function AccessoryBar() {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-5 border-t border-gray-300 bg-gray-100 px-4 py-2 dark:border-gray-700 dark:bg-gray-800">
      {focusedPrev || stepping ? (
        <Pressable onPress={() => focusedPrev?.()} hitSlop={8} accessibilityRole="button">
          <Text className="text-base font-semibold text-accent-700 dark:text-accent-300">‹ {t('gloria.kb.prev')}</Text>
        </Pressable>
      ) : null}
      <View className="flex-1" />
      <Pressable onPress={() => (focusedNext ? focusedNext() : Keyboard.dismiss())} hitSlop={8} accessibilityRole="button">
        <Text className="text-base font-semibold text-accent-700 dark:text-accent-300">{t('gloria.kb.next')} ›</Text>
      </Pressable>
      <Pressable onPress={() => Keyboard.dismiss()} hitSlop={8} accessibilityRole="button">
        <Text className="text-base text-gray-700 dark:text-gray-200">{t('gloria.kb.done')}</Text>
      </Pressable>
    </View>
  );
}

export function NumAccessory() {
  const insets = useSafeAreaInsets();
  const keyboardUp = useKeyboardState((k) => k.isVisible);
  const step = useSyncExternalStore(subscribeStepping, () => stepping);
  if (Platform.OS !== 'android') {
    return (
      <InputAccessoryView nativeID={NUM_ACCESSORY_ID}>
        <AccessoryBar />
      </InputAccessoryView>
    );
  }
  // Android: in the flow at the screen bottom (like the search dock, which it
  // then sits under), lifted with the keyboard while a stepper is focused.
  return keyboardUp && step ? (
    <KeyboardStickyView offset={{ opened: insets.bottom }}>
      <AccessoryBar />
    </KeyboardStickyView>
  ) : null;
}

export function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const fmt = (v: number | null | undefined) => (v == null ? '' : String(v));

/**
 * Numeric field committed on blur / submit (never per keystroke, so a
 * half-typed "0." does not hit the DB). `placeholder` shows carried values.
 */
export const NumField = forwardRef<
  TextInput,
  {
    value: number | null;
    onCommit: (v: number | null) => void;
    placeholder?: string;
    changed?: boolean;
    width?: number;
    onSubmitEditing?: () => void;
    /** Step to the previous item (the keyboard bar's Previous); stepping fields only. */
    onPrev?: () => void;
    accessibilityLabel: string;
    /** Refuse values outside min/max; warn (but keep) outside warnMin/warnMax. */
    range?: Range;
    /** Needs a minus sign (coordinates) — the iOS decimal pad has none. */
    signed?: boolean;
    editable?: boolean;
    /** Filled with this field's commit, for a parent that swaps the field's
     *  target (the cover stepper) and must save what was typed first. */
    commitRef?: { current: (() => boolean) | null };
    /** What the value belongs to; a change resets the typed text even when
     *  the old and new values happen to be equal. */
    target?: string;
  }
>(function NumField({ value, onCommit, placeholder, changed, width = 76, onSubmitEditing, onPrev, accessibilityLabel, range, signed, editable = true, commitRef, target }, ref) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const [text, setText] = useState(fmt(value));
  // Last value handed to onCommit: Next commits and the blur that follows
  // would otherwise write the same value a second time.
  const sent = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    setText(fmt(value));
    sent.current = undefined;
  }, [value, target]);
  /** Returns false when the entry was refused (focus should stay here). */
  const commit = (): boolean => {
    const n = parseNum(text);
    if (n === value || n === sent.current) {
      if (n === value) setText(fmt(value));
      return true;
    }
    const verdict = range ? checkRange(n, range) : 'ok';
    const bounds = range
      ? { label: accessibilityLabel, value: n, unit: range.unit, min: range.min ?? range.warnMin, max: range.max ?? range.warnMax }
      : null;
    if (verdict === 'reject' && range && bounds) {
      setText(fmt(value));
      const whole = range.integer && n != null && !Number.isInteger(n);
      Alert.alert(
        t('gloria.num.rejectTitle'),
        whole ? t('gloria.num.rejectInt', { label: accessibilityLabel, value: n }) : t('gloria.num.reject', { ...bounds, min: range.min, max: range.max }),
      );
      return false;
    }
    sent.current = n;
    onCommit(n);
    if (verdict === 'warn' && range && bounds) {
      Alert.alert(t('gloria.num.warnTitle'), t('gloria.num.warn', { ...bounds, min: range.warnMin, max: range.warnMax }));
    }
    return true;
  };
  if (commitRef) commitRef.current = commit;
  // The accessory bar's Next is bound at focus. A field that stays focused
  // while its target changes (the cover stepper) re-binds it on each render,
  // or Next would commit to the item that had focus first.
  const focused = useRef(false);
  const bindNext = () => {
    focusedNext = onSubmitEditing
      ? () => {
          if (commit()) onSubmitEditing();
        }
      : null;
    focusedPrev = onPrev
      ? () => {
          if (commit()) onPrev();
        }
      : null;
    setStepping(!!onPrev);
  };
  if (focused.current) bindNext();
  return (
    <TextInput
      ref={ref}
      value={text}
      onChangeText={setText}
      onEndEditing={commit}
      onSubmitEditing={() => {
        if (commit()) onSubmitEditing?.();
      }}
      onFocus={() => {
        // What the iOS accessory bar's Next does for this field.
        focused.current = true;
        bindNext();
      }}
      onBlur={() => {
        focused.current = false;
        setStepping(false);
      }}
      inputAccessoryViewID={NUM_ACCESSORY_ID}
      blurOnSubmit={!onSubmitEditing}
      returnKeyType={onSubmitEditing ? 'next' : 'done'}
      keyboardType={signed ? 'numbers-and-punctuation' : NUMERIC_KEYBOARD}
      editable={editable}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      selectTextOnFocus
      style={{ width, fontVariant: ['tabular-nums'] }}
      className={`rounded-md border px-2 py-1.5 text-right text-sm ${
        changed
          ? 'border-accent-600 bg-accent-50 text-gray-900 dark:bg-accent-950/40 dark:text-gray-100'
          : 'border-gray-300 bg-card text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
      }`}
      placeholderTextColor={c.ink3}
    />
  );
});

/** Red asterisk after a required field's label (nest inside its <Text>). */
export function Req({ on = true }: { on?: boolean }) {
  return on ? <Text className="text-red-600 dark:text-red-400"> *</Text> : null;
}
