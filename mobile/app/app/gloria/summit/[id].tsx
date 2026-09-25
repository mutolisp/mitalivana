/** Edit one summit's base data from the summit list. */
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { getSummit } from '~/modules/gloria/db';
import { SummitFields } from '~/modules/gloria/components/SummitForm';
import { NumAccessory } from '~/modules/gloria/components/ui';

export default function GloriaSummitScreen() {
  const { t } = useTranslation();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [summit, setSummit] = useState(() => getSummit(id));
  const reload = useCallback(() => setSummit(getSummit(id)), [id]);
  useFocusEffect(reload);
  return (
    <SettingsPage title={summit?.full_code ?? ''}>
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {summit ? <SummitFields summit={summit} onChanged={reload} /> : <Text className="text-gray-500">{t('gloria.notFound')}</Text>}
      </ScrollView>
      <NumAccessory />
    </SettingsPage>
  );
}
