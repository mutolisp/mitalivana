/**
 * A record's start and end time, typed by hand — for digitising old field
 * sheets as much as for correcting a stamp. Date and time are separate fields
 * (the date wheel reaches an old year in a few flicks, where one datetime
 * wheel steps through every day), stacked so the iOS spinner has full width.
 * An empty time shows 「設為現在」; the end can be cleared again.
 *
 * `SurveyTimesModal` is the same fields on a full-screen page, for screens
 * with no room for them inline (快速名錄, 採集記錄).
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DateTimeField } from '~/components/DateTimeField';
import { isoStamp } from '~/lib/datetime';

type Props = {
  start: number | null;
  end: number | null;
  /** `null` only for the end, from its clear button. */
  onChange: (which: 'start' | 'end', ts: number | null) => void;
  /** The start column is NOT NULL (sessions, trips): no 「設為現在」 state. */
  startRequired?: boolean;
  /** A locked record: show the times, change nothing. */
  readOnly?: boolean;
};

export function SurveyTimeFields({
  start,
  end,
  onChange,
  startRequired = false,
  readOnly = false,
}: Props) {
  const { t } = useTranslation();
  const save = (which: 'start' | 'end', ts: number) => {
    const s = which === 'start' ? ts : start;
    const e = which === 'end' ? ts : end;
    if (s != null && e != null && e < s) {
      Alert.alert(t('surveyTime.orderTitle'), t('surveyTime.order'));
      return;
    }
    onChange(which, ts);
  };
  const row = (which: 'start' | 'end', value: number | null, label: string) =>
    readOnly ? (
      <View className="flex-row items-center gap-2">
        <Text className="w-10 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
        <Text className="flex-1 text-sm text-gray-900 dark:text-gray-100">
          {value != null ? isoStamp(value) : '—'}
        </Text>
      </View>
    ) : (
      <View className="flex-row items-start gap-2">
        <Text className="w-10 pt-2.5 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
        {value != null ? (
          <View className="flex-1 gap-1.5">
            <DateTimeField value={value} mode="date" onChange={(ts) => save(which, ts)} />
            <DateTimeField
              value={value}
              mode="time"
              format={(ts) => isoStamp(ts).slice(11)}
              onChange={(ts) => save(which, ts)}
            />
          </View>
        ) : (
          <Pressable
            onPress={() => save(which, Date.now())}
            accessibilityRole="button"
            accessibilityLabel={`${label} ${t('surveyTime.setNow')}`}
            className="flex-1 rounded-lg border border-dashed border-gray-300 px-3 py-2 dark:border-gray-600"
          >
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              {t('surveyTime.setNow')}
            </Text>
          </Pressable>
        )}
        {which === 'end' && value != null ? (
          <Pressable
            onPress={() => onChange('end', null)}
            hitSlop={8}
            accessibilityLabel={t('surveyTime.clearEnd')}
            className="pt-2.5 active:opacity-60"
          >
            <Ionicons name="close-circle" size={18} color="#9ca3af" />
          </Pressable>
        ) : null}
      </View>
    );
  return (
    <View className="gap-2">
      {startRequired && start == null ? null : row('start', start, t('surveyTime.start'))}
      {row('end', end, t('surveyTime.end'))}
      <Text className="text-[11px] text-gray-400">
        {t(readOnly ? 'recordLock.banner' : 'surveyTime.hint')}
      </Text>
    </View>
  );
}

export function SurveyTimesModal({
  visible,
  onClose,
  ...fields
}: Props & { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-gray-50 dark:bg-gray-950" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <Text className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('surveyTime.title')}
          </Text>
          <Pressable onPress={onClose} hitSlop={8} className="active:opacity-60">
            <Text className="text-base font-medium text-[#00A2A5]">{t('common.done')}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}>
          <SurveyTimeFields {...fields} />
        </ScrollView>
      </View>
    </Modal>
  );
}
