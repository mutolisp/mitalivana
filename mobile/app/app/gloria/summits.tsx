/**
 * GLORIA summit list (偏好設定): every summit with its base data and last
 * cycle; import a CSV / .xlsx of sheet 00_ columns, or open one to edit.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { errText } from '~/lib/errText';
import { listSummits, type SummitWithLast } from '~/modules/gloria/db';
import { startSummitImport } from '~/modules/gloria/summitImportFile';
import { exportPointsCsv, exportSummitsCsv } from '~/modules/gloria/summitExport';
import { showActionSheet } from '~/components/ActionSheet';
import { useExportShare } from '~/lib/useExportShare';
import { ExportProgressOverlay } from '~/components/ExportProgressOverlay';
import { Btn, Card, Label } from '~/modules/gloria/components/ui';
import { useThemeColors } from '~/theme/colors';

export default function GloriaSummitsScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const [summits, setSummits] = useState<SummitWithLast[]>(() => listSummits());
  useFocusEffect(useCallback(() => setSummits(listSummits()), []));
  const groups = useMemo(() => {
    const m = new Map<string, SummitWithLast[]>();
    for (const s of summits) m.set(s.target_region, [...(m.get(s.target_region) ?? []), s]);
    return [...m.entries()];
  }, [summits]);
  const { shareBundle, progress } = useExportShare();
  const runExport = async () => {
    const idx = await showActionSheet({
      title: t('gloria.summitExport.title'),
      options: [{ label: t('gloria.summitExport.summits') }, { label: t('gloria.summitExport.points') }],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) void shareBundle(exportSummitsCsv);
    if (idx === 1) void shareBundle(exportPointsCsv);
  };
  const runImport = () =>
    void startSummitImport(
      () => router.push('/gloria/summit-import' as Href),
      (e) => Alert.alert(t('gloria.summitImport.readFail'), errText(e)),
    );

  return (
    <SettingsPage
      headerRight={() => (
        <View className="flex-row items-center gap-3">
          <HeaderIconButton icon="download-outline" label={t('gloria.summitImport.button')} onPress={runImport} />
          <HeaderIconButton icon="share-outline" label={t('gloria.summitExport.title')} disabled={summits.length === 0} onPress={() => void runExport()} />
        </View>
      )}
    >
      <ScrollView contentContainerClassName="gap-3 p-4">
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.summitImport.format')}</Text>
        {summits.length === 0 ? <Btn primary label={t('gloria.summitImport.button')} onPress={runImport} /> : null}
        {groups.map(([region, list]) => (
          <View key={region} className="gap-1.5">
            <Label>{t('gloria.new.region', { region })}</Label>
            <Card>
              {list.map((s) => (
                <Pressable
                  key={s.id}
                  onPress={() => router.push(`/gloria/summit/${s.id}` as Href)}
                  className="flex-row items-center border-b border-gray-100 px-3 py-2.5 dark:border-gray-800"
                >
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{s.full_code}</Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400">
                      {[s.name, s.elevation_m != null ? `${s.elevation_m} m` : null, s.veg_zone,
                        s.last_mocy != null ? t('gloria.new.lastMocy', { mocy: s.last_mocy }) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={c.ink3} />
                </Pressable>
              ))}
            </Card>
          </View>
        ))}
      </ScrollView>
      <ExportProgressOverlay progress={progress} />
    </SettingsPage>
  );
}
