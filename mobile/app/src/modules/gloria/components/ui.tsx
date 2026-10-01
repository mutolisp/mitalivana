/**
 * Small building blocks shared by the GLORIA screens. `Btn` wraps the app's
 * `Button`, and `Card` / `Banner` draw from the redesign tokens (card, line,
 * accent, acorn, alert), so every GLORIA screen takes the new palette before
 * its layout is redone (03-screens-flow.md §4d).
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { Button } from '~/components/ui/Button';
import { useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

// Moved to ~/components/form (Phase 0) and re-exported for the GLORIA and
// MIREN screens that import them from here.
export { LineTabs, Seg } from '~/components/form/Segmented';
export { NUMERIC_KEYBOARD, NUM_ACCESSORY_ID, NumAccessory, NumField } from '~/components/form/NumField';
export { parseNum } from '~/lib/parseNum';

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

/** Red asterisk after a required field's label (nest inside its <Text>). */
export function Req({ on = true }: { on?: boolean }) {
  return on ? <Text className="text-red-600 dark:text-red-400"> *</Text> : null;
}
