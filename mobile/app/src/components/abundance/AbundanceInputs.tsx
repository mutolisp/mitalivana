/**
 * Abundance inputs — Braun-Blanquet, % cover, counts, multi-stem DBH, custom
 * units. Moved unchanged from PlotSpeciesValueModal.tsx (Phase 0,
 * docs/planned/Modular_survey.md §9) so the survey framework's Abundance and
 * DBH components can use them; the modal imports them back.
 *
 * DBH stems and % cover read numbers with parseNum (a decimal comma counts).
 * `DbhStemChip` and `DBHInput` confirm with `Alert` because they are used
 * inside a Modal.
 */
import { Ionicons } from '@expo/vector-icons';
import { useColorScheme as useNwColorScheme } from 'nativewind';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { basalArea } from '~/lib/dwcAbundance';
import { ACTION_FILL } from '~/lib/colors';
import { parseNum } from '~/lib/parseNum';
import { useThemeColors } from '~/theme/colors';

const BB_OPTIONS = ['+', 'r', '1', '2', '3', '4', '5'] as const;

/** Height shared by the unit dropdown and the value field that sit side by
 *  side, so the two boxes line up on both platforms (a TextInput's natural
 *  height differs between iOS and Android). */
export const FIELD_HEIGHT = 'h-12';

export function BBInput({ value, onChange }: { value: string | null; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <View>
      <Text className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
        {t('plotValue.bbLevel')}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {BB_OPTIONS.map((v) => {
          const on = value === v;
          return (
            <Pressable
              key={v}
              onPress={() => onChange(v)}
              className={`h-12 w-12 items-center justify-center rounded-lg ${on ? 'bg-emerald-500' : 'bg-gray-100 dark:bg-gray-800'}`}
            >
              <Text
                className={`text-lg font-semibold ${on ? 'text-white' : 'text-gray-700 dark:text-gray-300'}`}
              >
                {v}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Common cover values on one horizontally scrollable line — a wrapping row of
 *  six cost a second line for values the user may not even want. */
export function PercentQuickValues({ onPick }: { onPick: (v: string) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      className="mt-2"
      contentContainerStyle={{ gap: 8 }}
    >
      {[1, 5, 10, 25, 50, 75, 100].map((v) => (
        <Pressable
          key={v}
          onPress={() => onPick(String(v))}
          className="rounded-full bg-gray-100 px-3 py-1.5 active:bg-gray-200 dark:bg-gray-800 dark:active:bg-gray-700"
        >
          <Text className="text-xs text-gray-700 dark:text-gray-300">{v}%</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function PercentInput({
  value,
  onChange,
  compact = false,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Focused on open, as the value sheet wants; off where a whole form is shown (a template preview). */
  autoFocus?: boolean;
  /** Beside the unit dropdown: the dropdown already names the unit, and the
   *  quick values are rendered by the caller below both. */
  compact?: boolean;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <View>
      {compact ? null : (
        <Text className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
          {t('plotValue.coverPct')}
        </Text>
      )}
      <View
        className={`flex-row items-center rounded-lg border bg-card px-3 dark:bg-gray-900 ${
          compact
            ? `${FIELD_HEIGHT} border-gray-300 dark:border-gray-600`
            : 'border-gray-200 dark:border-gray-700'
        }`}
      >
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="0–100"
          placeholderTextColor={c.ink3}
          keyboardType="decimal-pad"
          autoFocus={autoFocus}
          // Compact: the box above fixes the height; the input fills it.
          className={`flex-1 text-base text-gray-900 dark:text-gray-100 ${compact ? 'h-full' : 'py-3'}`}
        />
        <Text className="ml-1 text-sm text-gray-500 dark:text-gray-400">%</Text>
      </View>
      {(() => {
        if (value.trim() === '') return null;
        const n = parseNum(value);
        if (n !== null && n > 0 && n <= 100) return null;
        return <Text className="mt-1 text-xs text-red-500">{t('plotValue.coverRange')}</Text>;
      })()}
    </View>
  );
}

export function CountInput({
  value,
  onChange,
  suffix,
  compact = false,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  autoFocus?: boolean;
  /** Beside the unit dropdown, which already names the unit. */
  compact?: boolean;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <View>
      {compact ? null : (
        <Text className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
          {t('plotValue.quantity')}
        </Text>
      )}
      <View
        className={`flex-row items-center rounded-lg border bg-card px-3 dark:bg-gray-900 ${
          compact
            ? `${FIELD_HEIGHT} border-gray-300 dark:border-gray-600`
            : 'border-gray-200 dark:border-gray-700'
        }`}
      >
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={t('plotValue.enterCount')}
          placeholderTextColor={c.ink3}
          keyboardType="numeric"
          autoFocus={autoFocus}
          // Compact: the box above fixes the height; the input fills it.
          className={`flex-1 text-base text-gray-900 dark:text-gray-100 ${compact ? 'h-full' : 'py-3'}`}
        />
        {suffix ? (
          <Text className="ml-1 text-sm text-gray-500 dark:text-gray-400">{suffix}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function DBHInput({
  stems,
  stemDraft,
  setStemDraft,
  onAdd,
  onRemove,
  autoFocus = true,
}: {
  stems: number[];
  stemDraft: string;
  setStemDraft: (s: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
  autoFocus?: boolean;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const totalBA = basalArea(stems);
  return (
    <View>
      <Text className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
        {t('abundance.dbh')}
      </Text>
      <View className="flex-row items-center rounded-lg border border-gray-200 bg-card px-3 dark:border-gray-700 dark:bg-gray-900">
        <TextInput
          value={stemDraft}
          onChangeText={setStemDraft}
          onSubmitEditing={onAdd}
          placeholder={t('plotValue.dbhPlaceholder')}
          placeholderTextColor={c.ink3}
          keyboardType="decimal-pad"
          returnKeyType="done"
          autoFocus={autoFocus}
          className="flex-1 py-3 text-base text-gray-900 dark:text-gray-100"
        />
        <Pressable onPress={onAdd} className={`rounded-md px-3 py-1.5 ${ACTION_FILL}`}>
          <Ionicons name="add" size={18} color="white" />
        </Pressable>
      </View>
      {stems.length > 0 ? (
        <>
          <View className="mt-3 flex-row flex-wrap gap-2">
            {stems.map((d, idx) => (
              <DbhStemChip key={`${idx}-${d}`} value={d} onRemove={() => onRemove(idx)} />
            ))}
          </View>
          <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t('plotValue.dbhSummary', { count: stems.length })} · BA ≈ {totalBA.toFixed(1)} cm²
          </Text>
        </>
      ) : (
        <Text className="mt-2 text-xs text-gray-400 dark:text-gray-500">
          {t('plotValue.noStems')}
        </Text>
      )}
    </View>
  );
}

export function DbhStemChip({ value, onRemove }: { value: number; onRemove: () => void }) {
  const { t } = useTranslation();
  const { colorScheme } = useNwColorScheme();
  const closeColor = colorScheme === 'dark' ? '#ffffff' : '#1e40af';
  // Both the long-press and the ✕ ask first: a stem measured in the field
  // cannot be recovered once it is gone. `Alert` because this is a Modal.
  const confirmRemove = () =>
    Alert.alert(t('plotValue.removeStemTitle'), t('plotValue.removeStemMsg', { value }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.remove'), style: 'destructive', onPress: onRemove },
    ]);
  return (
    <Pressable
      onLongPress={confirmRemove}
      delayLongPress={300}
      className="flex-row items-center rounded-full bg-accent-100 px-3 py-1.5 dark:bg-accent-900/60"
    >
      <Text className="text-sm font-medium text-accent-800 dark:text-white">{value} cm</Text>
      <Pressable onPress={confirmRemove} hitSlop={8} className="ml-1.5">
        <Ionicons name="close-circle" size={16} color={closeColor} />
      </Pressable>
    </Pressable>
  );
}

export function CustomInput({
  typeValue,
  setTypeValue,
  quantityValue,
  setQuantityValue,
}: {
  typeValue: string;
  setTypeValue: (s: string) => void;
  quantityValue: string;
  setQuantityValue: (s: string) => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <View>
        <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          {t('plotValue.customUnit')}
        </Text>
        <TextInput
          value={typeValue}
          onChangeText={setTypeValue}
          placeholder={t('plotValue.customUnitPlaceholder')}
          placeholderTextColor={c.ink3}
          autoCapitalize="none"
          className="rounded-lg border border-gray-200 bg-card px-3 py-3 text-base text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
      </View>
      <View>
        <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          {t('plotValue.quantity')}
        </Text>
        <TextInput
          value={quantityValue}
          onChangeText={setQuantityValue}
          placeholder={t('plotValue.customQtyPlaceholder')}
          placeholderTextColor={c.ink3}
          className="rounded-lg border border-gray-200 bg-card px-3 py-3 text-base text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
      </View>
    </View>
  );
}
