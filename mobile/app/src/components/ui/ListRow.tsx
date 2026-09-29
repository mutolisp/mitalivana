/**
 * One list row with slots (04-collection-listrow.md §1). The screens each had
 * their own row; this is the shape they converge on, one screen at a time
 * (specimens first).
 *
 * Long-press is select mode everywhere in the app; the row only reports it.
 * The divider runs from the text start to the right edge, so rows with a
 * leading thumbnail still read as one block per record.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { safeAppFileUri } from '~/lib/appFiles';
import { useThemeColors } from '~/theme/colors';

export type ListRowTone = 'default' | 'fresh' | 'uploaded';

const TONE: Record<ListRowTone, string> = {
  default: 'bg-card dark:bg-card-dark',
  // Just added: the pale acorn of the pinned group, so it catches the eye.
  fresh: 'bg-acorn-wash dark:bg-gray-800',
  // Already on iNaturalist (migrations.ts v30), as the specimen row had it.
  uploaded: 'bg-lime-50 dark:bg-lime-900/30',
};

export function ListRow({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  onPress,
  onLongPress,
  selected = false,
  tone = 'default',
  divider = true,
  accessibilityLabel,
}: {
  /** Checkbox, Thumb, CodeBadge or an icon tile. */
  leading?: ReactNode;
  /** Text plus inline tags. */
  title: ReactNode;
  /** A ScientificName or secondary text. */
  subtitle?: ReactNode;
  /** One short line, text-xs. */
  meta?: string;
  /** A stepper, a value, a star or a chevron. A 44 pt control needs only the 8 pt right padding. */
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  tone?: ListRowTone;
  divider?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityLabel={accessibilityLabel}
      className={`flex-row items-center pl-4 active:bg-gray-100 dark:active:bg-gray-800 ${
        selected ? 'bg-accent-50 dark:bg-accent-950' : TONE[tone]
      }`}
      style={{ minHeight: 56 }}
    >
      {leading ? <View className="mr-3">{leading}</View> : null}
      <View
        className={`flex-1 flex-row items-center self-stretch py-2.5 pr-2 ${
          divider ? 'border-b border-line dark:border-line-dark' : ''
        }`}
      >
        <View className="flex-1 pr-2">
          {typeof title === 'string' ? (
            <Text className="text-base font-medium text-ink dark:text-gray-100" numberOfLines={1}>
              {title}
            </Text>
          ) : (
            title
          )}
          {subtitle ? <View className="mt-0.5">{subtitle}</View> : null}
          {meta ? (
            <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        {trailing}
      </View>
    </Pressable>
  );
}

/**
 * 48 pt photo thumbnail with a count badge; without a photo, a dashed camera
 * frame. `onPress` on the empty frame takes a photo on the spot.
 */
export function Thumb({
  uri,
  count = 0,
  onPress,
  accessibilityLabel,
}: {
  uri?: string | null;
  count?: number;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const c = useThemeColors();
  // Only files inside the app's own media folders are shown (security audit S1).
  const src = uri ? safeAppFileUri(uri) : null;
  const body = src ? (
    <View>
      <Image source={{ uri: src }} style={{ width: 48, height: 48, borderRadius: 10 }} contentFit="cover" />
      {count > 1 ? (
        <View className="absolute -right-1 -top-1 rounded-full bg-ink/80 px-1.5 dark:bg-gray-950/80">
          <Text className="text-[10px] font-bold text-white">{count}</Text>
        </View>
      ) : null}
    </View>
  ) : (
    <View
      className="items-center justify-center rounded-[10px] border-[1.5px] border-dashed border-gray-400 dark:border-gray-500"
      style={{ width: 48, height: 48 }}
    >
      <Ionicons name="camera-outline" size={20} color={c.ink3} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      {body}
    </Pressable>
  );
}

/** A code in monospace on a pale ground (collection number, unit code). */
export function CodeBadge({ code }: { code: string }) {
  return (
    <View className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">
      <Text className="font-mono text-xs font-bold text-cupule dark:text-gray-300">{code}</Text>
    </View>
  );
}
