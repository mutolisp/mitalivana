/**
 * The row vocabulary shared by the preferences screen and its detail pages.
 *
 * `Section` and `RowInput` moved here verbatim from app/settings.tsx; keeping
 * them private to that file is why the specimen-collecting block ended up
 * inlined there in the first place.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Switch } from '~/components/ui/Switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { splitMatch, type SettingsTone } from '~/lib/settingsIndex';
import { useThemeColors, type ThemeColors } from '~/theme/colors';

const ROW = 'bg-card dark:bg-gray-900 px-4 py-3';
/** With an icon tile: text starts at 12 + 30 + 12 = 54, where the divider starts. */
const ICON_ROW = 'bg-card dark:bg-card-dark py-3 pl-3 pr-4';
const DIVIDER = 'border-b border-gray-100 dark:border-gray-800';
const PRESSED = 'active:bg-gray-50 dark:active:bg-gray-800';

/**
 * A group of rows on one card (03-screens-flow.md §4c).
 *
 * `title` is optional so a trailing block can carry no caption — a caption
 * promises a group, and the About row at the foot of the menu is one item.
 * `plain` keeps the old full-bleed look for a page whose section holds free
 * content rather than rows (provenance).
 */
export function Section({
  title,
  plain = false,
  children,
}: {
  title?: string;
  plain?: boolean;
  children: React.ReactNode;
}) {
  if (plain) {
    return (
      <View className="mt-6">
        {title ? (
          <Text className="px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</Text>
        ) : null}
        {children}
      </View>
    );
  }
  return (
    <View className="mt-6 px-4">
      {title ? (
        <Text
          className="px-1 pb-2 text-xs font-bold uppercase text-gray-500 dark:text-gray-400"
          style={{ letterSpacing: 0.96 }}
        >
          {title}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-card bg-card dark:bg-card-dark">
        {/* Every row draws its own bottom divider; pulling the last one 1 px
            under the card's clip hides it without the rows knowing their
            position. */}
        <View style={{ marginBottom: -1 }}>{children}</View>
      </View>
    </View>
  );
}

type IconName = ComponentProps<typeof Ionicons>['name'];

const TILE: Record<SettingsTone, string> = {
  accent: 'bg-accent-100 dark:bg-accent-900',
  acorn: 'bg-acorn-tint dark:bg-gray-800',
  neutral: 'bg-gray-100 dark:bg-gray-800',
  alert: 'bg-alert-tint dark:bg-alert-dark-tint',
};

function tileInk(c: ThemeColors, tone: SettingsTone): string {
  return tone === 'accent' ? c.accent : tone === 'acorn' ? c.acornDeep : tone === 'alert' ? c.alert : c.ink2;
}

/** Shared by the three row kinds when they carry an icon. */
interface RowDecor {
  icon?: IconName;
  tone?: SettingsTone;
  /** Location line above the label in search results (「調查 › 標本採集」). */
  crumb?: string;
  /** Search query to mark in the label and description. */
  highlight?: string;
}

function IconTile({ icon, tone }: { icon: IconName; tone: SettingsTone }) {
  const c = useThemeColors();
  return (
    <View className={`mr-3 h-[30px] w-[30px] items-center justify-center rounded-lg ${TILE[tone]}`}>
      <Ionicons name={icon} size={17} color={tileInk(c, tone)} />
    </View>
  );
}

/** Inset divider for icon rows: from the text start (54) to the right edge. */
function InsetDivider() {
  return <View className="absolute bottom-0 right-0 h-px bg-gray-100 dark:bg-gray-800" style={{ left: 54 }} />;
}

/** `text` with the first match of `query` on an acorn-tint ground. */
function Marked({ text, query, className }: { text: string; query?: string; className: string }) {
  const parts = query ? splitMatch(text, query) : null;
  if (!parts) return <Text className={className}>{text}</Text>;
  return (
    <Text className={className}>
      {parts[0]}
      <Text className="bg-acorn-tint dark:bg-acorn-deep">{parts[1]}</Text>
      {parts[2]}
    </Text>
  );
}

function RowText({
  label,
  description,
  crumb,
  highlight,
  labelClass = 'text-gray-900 dark:text-gray-100',
}: {
  label: string;
  description?: string;
  crumb?: string;
  highlight?: string;
  labelClass?: string;
}) {
  return (
    <View className="flex-1 pr-3">
      {crumb ? (
        <Text className="mb-0.5 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {crumb}
        </Text>
      ) : null}
      <Marked text={label} query={highlight} className={`text-base ${labelClass}`} />
      {description ? (
        <Marked text={description} query={highlight} className="text-xs text-gray-500 dark:text-gray-400" />
      ) : null}
    </View>
  );
}

/** Uncontrolled text row committed on blur — same interaction as the plot
 *  env-tab fields, so a half-typed value never lands in settings. */
export function RowInput({
  label,
  value,
  placeholder,
  keyboardType,
  autoCapitalize,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
  autoCapitalize?: 'none' | 'characters';
  onCommit: (v: string) => void;
}) {
  const c = useThemeColors();
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <View className={`flex-row items-center justify-between ${DIVIDER} ${ROW}`}>
      <Text className="text-base text-gray-900 dark:text-gray-100">{label}</Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => onCommit(draft)}
        placeholder={placeholder}
        placeholderTextColor={c.ink3}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoCorrect={false}
        className="min-w-[120px] rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-right text-base text-gray-900 dark:text-gray-100"
      />
    </View>
  );
}

/** A tappable row. `value` is the current setting shown inline (採集號),
 *  `description` the subtitle. Set `chevron={false}` for a row that acts in
 *  place (資料檢查, 清除…) rather than navigating — the glyph is what tells the
 *  user which of the two this is. */
export function LinkRow({
  label,
  description,
  value,
  destructive = false,
  chevron = true,
  badge = false,
  badgeLabel,
  onPress,
  icon,
  tone = 'neutral',
  crumb,
  highlight,
}: {
  label: string;
  description?: string;
  value?: string;
  destructive?: boolean;
  chevron?: boolean;
  /** Red dot before the chevron: something behind this row wants attention. */
  badge?: boolean;
  /** With `icon`: a red word tag instead of the dot (「更新」). */
  badgeLabel?: string;
  onPress: () => void;
} & RowDecor) {
  const c = useThemeColors();
  if (icon) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        className={`flex-row items-center ${ICON_ROW} ${PRESSED}`}
      >
        <IconTile icon={icon} tone={destructive ? 'alert' : tone} />
        <RowText
          label={label}
          description={description}
          crumb={crumb}
          highlight={highlight}
          labelClass={destructive ? 'text-alert dark:text-alert-dark' : undefined}
        />
        <View className="flex-row items-center">
          {badge && badgeLabel ? (
            <View className="mr-1.5 rounded bg-alert px-1.5 dark:bg-alert-dark">
              <Text className="text-xs font-bold text-white dark:text-gray-950">{badgeLabel}</Text>
            </View>
          ) : badge ? (
            <View className="mr-1.5 h-2 w-2 rounded-full bg-alert dark:bg-alert-dark" />
          ) : null}
          {value ? (
            <Text className="mr-1 shrink text-sm text-gray-600 dark:text-gray-300" numberOfLines={1}>
              {value}
            </Text>
          ) : null}
          {chevron ? <Ionicons name="chevron-forward" size={16} color={c.ink3} /> : null}
        </View>
        <InsetDivider />
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`flex-row items-center justify-between ${DIVIDER} ${ROW} ${PRESSED}`}
    >
      <View className="flex-1 pr-3">
        <Text className={`text-base ${destructive ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>
          {label}
        </Text>
        {description ? (
          <Text className="text-xs text-gray-500 dark:text-gray-400">{description}</Text>
        ) : null}
      </View>
      <View className="flex-row items-center">
        {value ? (
          <Text className="mr-1 text-base text-gray-500 dark:text-gray-400">{value}</Text>
        ) : null}
        {badge ? <View className="mr-1.5 h-2 w-2 rounded-full bg-red-500" /> : null}
        {chevron ? <Ionicons name="chevron-forward" size={value ? 16 : 18} color={c.ink3} /> : null}
      </View>
    </Pressable>
  );
}

/** An on/off setting: label and description on the left, a Switch on the
 *  right. Tapping the row flips it too, not just the thumb. */
export function SwitchRow({
  label,
  description,
  value,
  onChange,
  icon,
  tone = 'neutral',
  crumb,
  highlight,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
} & RowDecor) {
  if (icon) {
    return (
      <Pressable
        onPress={() => onChange(!value)}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
        className={`flex-row items-center ${ICON_ROW} ${PRESSED}`}
      >
        <IconTile icon={icon} tone={tone} />
        <RowText label={label} description={description} crumb={crumb} highlight={highlight} />
        <Switch value={value} onValueChange={onChange} />
        <InsetDivider />
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      className={`flex-row items-center justify-between ${DIVIDER} ${ROW} ${PRESSED}`}
    >
      <View className="flex-1 pr-3">
        <Text className="text-base text-gray-900 dark:text-gray-100">{label}</Text>
        {description ? (
          <Text className="text-xs text-gray-500 dark:text-gray-400">{description}</Text>
        ) : null}
      </View>
      <Switch value={value} onValueChange={onChange} />
    </Pressable>
  );
}

/**
 * A settings row whose value is picked from a short list.
 *
 * `variant='row'` is the full-bleed settings row; `variant='inline'` puts the
 * label above a full-width trigger, for the card layouts (iNaturalist, the
 * upload screen) where a bordered box next to a TextInput reads better.
 *
 * The option values stay `T` at the call site — `settings.set('undo_duration')`
 * wants a number — and are converted at the primitive boundary, which only
 * speaks strings.
 *
 * `portalHost` names a <PortalHost> to render the popover into. Needed inside
 * an RN <Modal>: the default host lives in app/_layout.tsx, which a Modal
 * covers, so the popover would open behind it. Callers there put a named
 * <PortalHost> inside the Modal and pass its name here.
 */
export function SelectRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
  variant = 'row',
  disabled = false,
  divider = true,
  description,
  portalHost,
  triggerClassName = '',
  icon,
  tone = 'neutral',
  crumb,
  highlight,
}: RowDecor & {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  variant?: 'row' | 'inline';
  disabled?: boolean;
  divider?: boolean;
  description?: string;
  portalHost?: string;
  /** Extra classes for the trigger box — e.g. a fixed height so it lines up
   *  with a text field beside it. */
  triggerClassName?: string;
}) {
  const current = options.find((o) => o.value === value);
  const selected = current ? { value: String(current.value), label: current.label } : undefined;

  const handleChange = (opt: { value: string; label: string } | undefined) => {
    if (!opt) return;
    const match = options.find((o) => String(o.value) === opt.value);
    if (match) onChange(match.value);
  };

  // An icon row shows its value the way a link row does: plain text on the
  // right, no box (03-screens-flow.md §4c).
  const bare = !!icon && variant === 'row';
  const select = (
    <Select value={selected} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger
        bare={bare}
        className={`${variant === 'inline' ? 'w-full' : bare ? 'max-w-[160px]' : 'min-w-[140px]'} ${triggerClassName}`}
        accessibilityLabel={label}
      >
        <SelectValue bare={bare} placeholder={String(value)} />
      </SelectTrigger>
      <SelectContent portalHost={portalHost}>
        {options.map((o) => (
          <SelectItem key={String(o.value)} value={String(o.value)} label={o.label} />
        ))}
      </SelectContent>
    </Select>
  );

  if (variant === 'inline') {
    return (
      <View>
        <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">{label}</Text>
        {select}
        {description ? (
          <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">{description}</Text>
        ) : null}
      </View>
    );
  }

  if (icon) {
    return (
      <View className={`flex-row items-center ${ICON_ROW}`}>
        <IconTile icon={icon} tone={tone} />
        <RowText label={label} description={description} crumb={crumb} highlight={highlight} />
        {select}
        {divider ? <InsetDivider /> : null}
      </View>
    );
  }

  return (
    <View className={`flex-row items-center justify-between ${divider ? DIVIDER : ''} ${ROW}`}>
      <View className="flex-1 pr-3">
        <Text className="text-base text-gray-900 dark:text-gray-100">{label}</Text>
        {description ? (
          <Text className="text-xs text-gray-500 dark:text-gray-400">{description}</Text>
        ) : null}
      </View>
      {select}
    </View>
  );
}
