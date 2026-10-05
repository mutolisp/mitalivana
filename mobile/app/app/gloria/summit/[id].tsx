/** Edit one summit's base data from the summit list. */
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { getSummit } from '~/modules/gloria/db';
import { SummitFields } from '~/modules/gloria/components/SummitForm';
import { Btn, Label, NumAccessory } from '~/modules/gloria/components/ui';
import { ExportProgressOverlay } from '~/components/ExportProgressOverlay';
import { bundleLoggers } from '~/lib/bundleExport';
import { useExportShare } from '~/lib/useExportShare';
import { useSettings } from '~/stores/settings';
import { LoggerVisitList } from '~/modules/gloria/components/LoggerVisitList';

export default function GloriaSummitScreen() {
  const { t } = useTranslation();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [summit, setSummit] = useState(() => getSummit(id));
  const reload = useCallback(() => setSummit(getSummit(id)), [id]);
  useFocusEffect(reload);
  const includePhotos = useSettings((s) => s.export_include_photos);
  const { shareBundle, progress, onProgress } = useExportShare();
  return (
    <SettingsPage title={summit?.full_code ?? ''}>
      <KeyboardAwareScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {summit ? <SummitFields summit={summit} onChanged={reload} /> : <Text className="text-gray-500">{t('gloria.notFound')}</Text>}
        {/* Loggers are read and changed between monitoring cycles too: no survey needed here. */}
        {summit ? (
          <>
            <Label>{t('gloria.tab.loggers')}</Label>
            <LoggerVisitList summitId={summit.id} />
            {/* Only the loggers: for visits between two surveys, without exporting a survey. */}
            <Btn label={t('gloria.logger.export')} onPress={() => void shareBundle(() => bundleLoggers(summit.id, { includePhotos, onProgress }))} />
          </>
        ) : null}
      </KeyboardAwareScrollView>
      <NumAccessory />
      <ExportProgressOverlay progress={progress} />
    </SettingsPage>
  );
}
