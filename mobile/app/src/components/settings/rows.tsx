/**
 * The row vocabulary shared by the preferences screen and its detail pages.
 *
 * `Section` and `RowInput` moved here verbatim from app/settings.tsx; keeping
 * them private to that file is why the specimen-collecting block ended up
 * inlined there in the first place.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';

const ROW = 'bg-white dark:bg-gray-900 px-4 py-3';
const DIVIDER = 'border-b border-gray-100 dark:border-gray-800';
const PRESSED = 'active:bg-gray-50 dark:active:bg-gray-800';

/** `title` is optional so a trailing block can carry no caption — a caption
 *  promises a group, and the About row at the foot of the menu is one item. */
export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View className="mt-6">
      {title ? (
        <Text className="px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</Text>
      ) : null}
      {children}
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
        placeholderTextColor="#9ca3af"
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
  onPress,
}: {
  label: string;
  description?: string;
  value?: string;
  destructive?: boolean;
  chevron?: boolean;
  /** Red dot before the chevron: something behind this row wants attention. */
  badge?: boolean;
  onPress: () => void;
}) {
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
        {chevron ? <Ionicons name="chevron-forward" size={value ? 16 : 18} color="#9ca3af" /> : null}
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
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
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
}: {
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

  const select = (
    <Select value={selected} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger
        className={`${variant === 'inline' ? 'w-full' : 'min-w-[140px]'} ${triggerClassName}`}
        accessibilityLabel={label}
      >
        <SelectValue placeholder={String(value)} />
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
