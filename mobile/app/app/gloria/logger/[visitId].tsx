/**
 * One temperature-logger visit (Form 4): date, researchers, which cycle it
 * falls in, the Form 4 scans (photos or PDF), and the loggers per direction.
 * 完成 locks the visit on its own — a visit years after the survey ended is
 * normal, so the survey's lock does not apply here.
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DateTimeField } from '~/components/DateTimeField';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { resolveAssetUri } from '~/lib/bundleExport';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { pickFiles, photoRef } from '~/lib/fileAttach';
import { BackHeaderLeft } from '~/lib/goBack';
import { captureEnvPhoto } from '~/lib/photoCapture';
import { useToast } from '~/stores/toast';
import { getSummit } from '~/modules/gloria/db';
import { deleteVisit, getVisit, listLoggers, refillReadouts, summitCycles, updateVisit } from '~/modules/gloria/loggerDb';
import { cycleOf, loggerCode, parseFiles } from '~/modules/gloria/model/loggers';
import { FileList, LoggerForm, ResearcherPick } from '~/modules/gloria/components/LoggerForm';
import { Banner, BannerText, Btn, Card, Label, NumAccessory } from '~/modules/gloria/components/ui';

const INPUT =
  'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export default function LoggerVisitScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const visitId = Number(useLocalSearchParams<{ visitId: string }>().visitId);
  const load = useCallback(() => {
    const visit = getVisit(visitId);
    return visit ? { visit, loggers: listLoggers(visitId), summit: getSummit(visit.summit_id), cycles: summitCycles(visit.summit_id) } : null;
  }, [visitId]);
  const [s, setS] = useState(load);
  const reload = useCallback(() => setS(load()), [load]);
  useFocusEffect(reload);

  // Deleted elsewhere (another screen, a merge): say so rather than show a blank page.
  if (!s || !s.summit)
    return (
      <SafeAreaView className="flex-1 bg-gray-50 p-4 dark:bg-gray-950">
        <Stack.Screen options={{ headerLeft: BackHeaderLeft }} />
        <Text className="text-sm text-gray-500 dark:text-gray-400">{t('gloria.logger.notFound')}</Text>
      </SafeAreaView>
    );
  const { visit, loggers, summit } = s;
  const locked = visit.locked === 1;
  const mocy = cycleOf(visit.visit_ts, s.cycles);
  const year = new Date(visit.visit_ts).getFullYear();
  const form4 = parseFiles(visit.form4_files);
  const setForm4 = (next: ReturnType<typeof parseFiles>) => {
    updateVisit(visitId, { form4_files: next.length ? JSON.stringify(next) : null });
    reload();
  };
  const carried = loggers.some((l) => l.prev_uuid);

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: t('gloria.logger.visitTitle', { date: isoStamp(visit.visit_ts).slice(0, 10) }),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <HeaderIconButton
              icon={locked ? 'lock-closed' : 'checkmark-done-outline'}
              label={t(locked ? 'gloria.logger.unlock' : 'gloria.logger.done')}
              onPress={() => {
                updateVisit(visitId, { locked: locked ? null : 1 });
                reload();
                toast(t(locked ? 'gloria.logger.unlocked' : 'gloria.logger.lockedDone'));
              }}
            />
          ),
        }}
      />
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {locked ? (
          <Banner tone="info">
            <BannerText tone="info">{t('gloria.logger.lockedBanner')}</BannerText>
          </Banner>
        ) : null}
        <Card className="gap-2 p-3">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{summit.full_code}</Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {mocy != null ? t('gloria.logger.belongs', { mocy }) : t('gloria.logger.cycleNone')}
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('gloria.logger.date')}</Text>
            <View className="flex-1">
              <DateTimeField
                value={visit.visit_ts}
                mode="date"
                onChange={(ts) => {
                  if (locked) return;
                  updateVisit(visitId, { visit_ts: ts });
                  reload();
                }}
              />
            </View>
          </View>
          <ResearcherPick
            label={t('gloria.logger.researchers')}
            value={visit.researchers}
            editable={!locked}
            onChange={(v) => {
              updateVisit(visitId, { researchers: v });
              reload();
            }}
          />
          <Text className="text-[11px] text-gray-400">
            {t('gloria.logger.codeExample', { code: loggerCode(summit, `E22`, 'a', year) })}
          </Text>
        </Card>

        <Label>{t('gloria.logger.form4')}</Label>
        <Card className="gap-2 p-3">
          <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.logger.form4Hint')}</Text>
          <FileList files={form4} editable={!locked} resolve={resolveAssetUri} onChange={setForm4} />
          {!locked ? (
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Btn
                  small
                  label={t('gloria.logger.takePhoto')}
                  onPress={() =>
                    void captureEnvPhoto().then((u) => u && setForm4([...form4, photoRef(u, `Form4-${isoStamp(visit.visit_ts).slice(0, 10)}-${form4.length + 1}.jpg`)]))
                  }
                />
              </View>
              <View className="flex-1">
                <Btn
                  small
                  label={t('gloria.logger.pickFile')}
                  onPress={() =>
                    void pickFiles()
                      .then((picked) => picked.length && setForm4([...form4, ...picked]))
                      .catch((e) => Alert.alert(t('gloria.logger.fileFail'), errText(e)))
                  }
                />
              </View>
            </View>
          ) : null}
        </Card>

        {carried ? (
          <Banner tone="info">
            <BannerText tone="info">{t('gloria.logger.fromPrev')}</BannerText>
          </Banner>
        ) : null}
        {!locked ? (
          <Btn
            small
            label={t('gloria.logger.refill')}
            onPress={() => {
              const n = refillReadouts(visitId);
              reload();
              toast(n == null ? t('gloria.logger.refillNoPrev') : n === 0 ? t('gloria.logger.refillNone') : t('gloria.logger.refillDone', { count: n }));
            }}
          />
        ) : null}
        <LoggerForm visitId={visitId} visitTs={visit.visit_ts} loggers={loggers} researchers={visit.researchers} editable={!locked} reload={reload} resolve={resolveAssetUri} />

        <Label>{t('gloria.logger.comments')}</Label>
        <TextInput
          key={`c-${visit.comments ?? ''}`}
          defaultValue={visit.comments ?? ''}
          editable={!locked}
          multiline
          onEndEditing={(e) => {
            const v = e.nativeEvent.text.trim() || null;
            if (v !== visit.comments) {
              updateVisit(visitId, { comments: v });
              reload();
            }
          }}
          accessibilityLabel={t('gloria.logger.comments')}
          className={`min-h-[64px] ${INPUT}`}
          style={{ textAlignVertical: 'top' }}
        />
        {!locked ? (
          <Btn
            label={t('gloria.logger.removeVisit')}
            onPress={() =>
              Alert.alert(t('gloria.logger.removeVisit'), t('gloria.logger.removeVisitMsg'), [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('gloria.logger.removeGo'),
                  style: 'destructive',
                  onPress: () => {
                    deleteVisit(visitId);
                    router.back();
                  },
                },
              ])
            }
          />
        ) : null}
      </ScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}
