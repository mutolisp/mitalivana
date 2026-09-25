/**
 * Small building blocks shared by the GLORIA screens. Colours follow the app:
 * gray surfaces, the teal ACCENT for anything the user acts on
 * (src/lib/colors.ts), emerald for done, amber / red for warnings.
 */
import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, InputAccessoryView, Keyboard, Pressable, Text, TextInput, View } from 'react-native';
import { checkRange, type Range } from '../model/ranges';
import { ACTION_FILL } from '~/lib/colors';
import { useSettings } from '~/stores/settings';

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <View className={`rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 ${className}`}>
      {children}
    </View>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{children}</Text>
  );
}

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
  const size = small ? 'px-3 py-1.5' : 'px-4 py-2.5';
  const look = primary
    ? `${ACTION_FILL}`
    : 'border border-gray-300 bg-gray-50 active:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:active:bg-gray-700';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      className={`items-center justify-center rounded-lg ${size} ${look} ${disabled ? 'opacity-40' : ''}`}
    >
      <Text
        className={`${small ? 'text-xs' : 'text-sm'} font-semibold ${primary ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}
      >
        {label}
      </Text>
    </Pressable>
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
            className={`flex-1 items-center rounded-md py-1.5 ${on ? 'bg-white dark:bg-gray-700' : ''}`}
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
  const border = tone ? { borderColor: tone, borderStyle: 'dashed' as const } : undefined;
  const fill = on ? { backgroundColor: tone ?? '#00A2A5', borderColor: tone ?? '#00A2A5' } : undefined;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[border, fill]}
      className="mr-1.5 mb-1.5 flex-row items-center rounded-full border border-gray-300 bg-white px-3 py-1.5 dark:border-gray-700 dark:bg-gray-900"
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
    warn: 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40',
    error: 'border-red-400 bg-red-50 dark:border-red-800 dark:bg-red-950/40',
    info: 'border-transparent bg-cyan-50 dark:bg-cyan-950/40',
    ok: 'border-emerald-400 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40',
  }[tone];
  return <View className={`rounded-lg border px-3 py-2 ${cls}`}>{children}</View>;
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ink = tone === 'error' ? '#dc2626' : '#d97706';
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
    warn: 'text-amber-800 dark:text-amber-300',
    error: 'text-red-700 dark:text-red-300',
    info: 'text-cyan-800 dark:text-cyan-300',
    ok: 'text-emerald-700 dark:text-emerald-300',
  }[tone];
  return <Text className={`text-xs ${bold ? 'font-semibold' : ''} ${cls}`}>{children}</Text>;
}

/** Digits and a decimal point only. */
export const NUMERIC_KEYBOARD = 'decimal-pad' as const;

/**
 * iOS's number pad has no return key, so numeric fields get a bar above the
 * keyboard with Next / Done. Android's number pad carries its own Next key
 * (returnKeyType), and InputAccessoryView renders nothing there. Render one
 * <NumAccessory /> per screen that uses NumField.
 */
export const NUM_ACCESSORY_ID = 'gloria-num';
let focusedNext: (() => void) | null = null;

export function NumAccessory() {
  const { t } = useTranslation();
  return (
    <InputAccessoryView nativeID={NUM_ACCESSORY_ID}>
      <View className="flex-row items-center justify-end gap-5 border-t border-gray-300 bg-gray-100 px-4 py-2 dark:border-gray-700 dark:bg-gray-800">
        <Pressable onPress={() => (focusedNext ? focusedNext() : Keyboard.dismiss())} hitSlop={8} accessibilityRole="button">
          <Text className="text-base font-semibold text-[#00797b] dark:text-cyan-300">{t('gloria.kb.next')}</Text>
        </Pressable>
        <Pressable onPress={() => Keyboard.dismiss()} hitSlop={8} accessibilityRole="button">
          <Text className="text-base text-gray-700 dark:text-gray-200">{t('gloria.kb.done')}</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
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
    accessibilityLabel: string;
    /** Refuse values outside min/max; warn (but keep) outside warnMin/warnMax. */
    range?: Range;
    /** Needs a minus sign (coordinates) — the iOS decimal pad has none. */
    signed?: boolean;
  }
>(function NumField({ value, onCommit, placeholder, changed, width = 76, onSubmitEditing, accessibilityLabel, range, signed }, ref) {
  const { t } = useTranslation();
  const [text, setText] = useState(fmt(value));
  // Last value handed to onCommit: Next commits and the blur that follows
  // would otherwise write the same value a second time.
  const sent = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    setText(fmt(value));
    sent.current = undefined;
  }, [value]);
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
        focusedNext = onSubmitEditing
          ? () => {
              if (commit()) onSubmitEditing();
            }
          : null;
      }}
      inputAccessoryViewID={NUM_ACCESSORY_ID}
      blurOnSubmit={!onSubmitEditing}
      returnKeyType={onSubmitEditing ? 'next' : 'done'}
      keyboardType={signed ? 'numbers-and-punctuation' : NUMERIC_KEYBOARD}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      selectTextOnFocus
      style={{ width, fontVariant: ['tabular-nums'] }}
      className={`rounded-md border px-2 py-1.5 text-right text-sm ${
        changed
          ? 'border-[#00A2A5] bg-cyan-50 text-gray-900 dark:bg-cyan-950/40 dark:text-gray-100'
          : 'border-gray-300 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
      }`}
      placeholderTextColor="#9ca3af"
    />
  );
});
