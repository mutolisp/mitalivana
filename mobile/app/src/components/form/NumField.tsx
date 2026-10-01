/**
 * Numeric field committed on blur / submit, with the keyboard bar (Next /
 * Previous / Done) iOS's number pad lacks. Moved from the GLORIA screens'
 * ui.tsx (which re-exports it; MIREN uses it too) so the survey framework can
 * use it without importing a module (docs/planned/Modular_survey.md §9,
 * Phase 0). Behaviour, ids and i18n keys are unchanged.
 */
import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, InputAccessoryView, Keyboard, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { checkRange, type Range } from '~/lib/numberRange';
import { parseNum } from '~/lib/parseNum';
import { useThemeColors } from '~/theme/colors';

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

/** 上一格 / 下一格 (05-controls.md §2.7): a chevron and the word, on a 36 pt
 *  pill; a step that cannot go anywhere fades like a StepPager's. */
function KbStep({ dir, onPress, disabled = false }: { dir: -1 | 1; onPress: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      className={`flex-row items-center rounded-full bg-disc px-3 active:bg-disc-pressed dark:bg-disc-dark dark:active:bg-disc-dark-pressed ${disabled ? 'opacity-35' : ''}`}
      style={{ height: 36 }}
    >
      {dir < 0 ? <Ionicons name="chevron-back" size={16} color={c.ink} /> : null}
      <Text className="mx-1 text-base font-semibold text-ink dark:text-gray-100">{t(dir < 0 ? 'gloria.kb.prev' : 'gloria.kb.next')}</Text>
      {dir > 0 ? <Ionicons name="chevron-forward" size={16} color={c.ink} /> : null}
    </Pressable>
  );
}

function AccessoryBar() {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 border-t border-line bg-card px-3 py-1.5 dark:border-line-dark dark:bg-card-dark">
      {focusedPrev || stepping ? <KbStep dir={-1} onPress={() => focusedPrev?.()} disabled={!focusedPrev} /> : null}
      <View className="flex-1" />
      <KbStep dir={1} onPress={() => (focusedNext ? focusedNext() : Keyboard.dismiss())} />
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
