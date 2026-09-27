/**
 * New GLORIA survey: pick a summit (or add one), see what will be carried
 * over, start. The survey itself is created by startGloriaAndOpen, which runs
 * the single-active guard.
 */
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { defaultSurveyorString } from '~/db/surveyors';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { startGloriaAndOpen } from '~/lib/recordCreate';
import { useToast } from '~/stores/toast';
import { errText } from '~/lib/errText';
import { startSummitImport } from '~/modules/gloria/summitImportFile';
import { listSummits, prefillSummary, upsertSummit, type SummitWithLast } from '~/modules/gloria/db';
import { Banner, BannerText, Btn, Card, Label, NUMERIC_KEYBOARD, parseNum } from '~/modules/gloria/components/ui';
import { VEG_ZONES } from '~/modules/gloria/components/SummitForm';
import { SelectRow } from '~/components/settings/rows';

const INPUT =
  'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export default function NewGloriaScreen() {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [summits, setSummits] = useState<SummitWithLast[]>(() => listSummits());
  const [picked, setPicked] = useState<number | null>(summits[0]?.id ?? null);
  const [adding, setAdding] = useState(summits.length === 0);
  const [form, setForm] = useState({ country: 'TW', region: '', summit: '', name: '', elevation: '', zone: '' });
  const router = useRouter();
  // Back from the import review: show what was added.
  useFocusEffect(
    useCallback(() => {
      const list = listSummits();
      setSummits(list);
      if (list.length) setAdding(false);
      setPicked((p) => p ?? list[0]?.id ?? null);
    }, []),
  );
  const runImport = () =>
    void startSummitImport(
      () => router.push('/gloria/summit-import' as Href),
      (e) => Alert.alert(t('gloria.summitImport.readFail'), errText(e)),
    );

  const groups = useMemo(() => {
    const m = new Map<string, SummitWithLast[]>();
    for (const s of summits) m.set(s.target_region, [...(m.get(s.target_region) ?? []), s]);
    return [...m.entries()];
  }, [summits]);
  const summary = picked != null ? prefillSummary(picked) : null;
  // Starts from the default surveyors (設定 → 調查者); the picker changes it for this survey.
  const [surveyors, setSurveyors] = useState<string | null>(() => defaultSurveyorString());
  const [pickingSurveyors, setPickingSurveyors] = useState(false);

  const saveSummit = () => {
    const country = form.country.trim().toUpperCase();
    const region = form.region.trim().toUpperCase();
    const summit = form.summit.trim().toUpperCase();
    // Box 6.1: country 2 letters (ISO 3166), target region and summit 3 characters.
    if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z0-9]{3}$/.test(region) || !/^[A-Z0-9]{3}$/.test(summit)) {
      toast(t('gloria.new.codeInvalid'));
      return;
    }
    const id = upsertSummit({
      country,
      target_region: region,
      summit,
      name: form.name.trim() || null,
      elevation_m: parseNum(form.elevation),
      veg_zone: form.zone.trim() || null,
    });
    setSummits(listSummits());
    setPicked(id);
    setAdding(false);
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {groups.map(([region, list]) => (
          <View key={region} className="gap-1.5">
            <Label>{t('gloria.new.region', { region })}</Label>
            <Card>
              {list.map((s, i) => (
                <Pressable
                  key={s.id}
                  onPress={() => setPicked(s.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: picked === s.id }}
                  className={`flex-row items-center px-3 py-2.5 active:bg-gray-50 dark:active:bg-gray-800 ${i ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}
                >
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{s.full_code}</Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400">
                      {[s.name, s.elevation_m != null ? `${s.elevation_m} m` : null, s.veg_zone,
                        s.last_mocy != null ? t('gloria.new.lastMocy', { mocy: s.last_mocy }) : t('gloria.new.firstSurvey')]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Ionicons
                    name={picked === s.id ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={picked === s.id ? '#00A2A5' : '#9ca3af'}
                  />
                </Pressable>
              ))}
            </Card>
          </View>
        ))}

        {adding ? (
          <Card className="gap-2 p-3">
            <Label>{t('gloria.new.addSummit')}</Label>
            <View className="flex-row gap-2">
              <TextInput value={form.country} onChangeText={(v) => setForm({ ...form, country: v })} placeholder="TW" autoCapitalize="characters" maxLength={2} className={`${INPUT} w-16`} accessibilityLabel={t('gloria.new.country')} />
              <TextInput value={form.region} onChangeText={(v) => setForm({ ...form, region: v })} placeholder="DAS" autoCapitalize="characters" maxLength={3} className={`${INPUT} flex-1`} accessibilityLabel={t('gloria.new.targetRegion')} />
              <TextInput value={form.summit} onChangeText={(v) => setForm({ ...form, summit: v })} placeholder="SUN" autoCapitalize="characters" maxLength={3} className={`${INPUT} flex-1`} accessibilityLabel={t('gloria.new.summitCode')} />
            </View>
            <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.new.codeHint')}</Text>
            <TextInput value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} placeholder={t('gloria.new.summitName')} className={INPUT} />
            <TextInput value={form.elevation} onChangeText={(v) => setForm({ ...form, elevation: v })} placeholder={t('gloria.new.elevation')} keyboardType={NUMERIC_KEYBOARD} className={INPUT} />
            <SelectRow
              variant="inline"
              label={t('gloria.new.vegZone')}
              value={form.zone}
              options={[{ value: '', label: t('gloria.summit.zoneNone') }, ...VEG_ZONES]}
              onChange={(v) => setForm({ ...form, zone: v })}
            />
            <View className="flex-row justify-end gap-2">
              {summits.length > 0 ? <Btn small label={t('common.cancel')} onPress={() => setAdding(false)} /> : null}
              <Btn small primary label={t('gloria.new.saveSummit')} onPress={saveSummit} />
            </View>
          </Card>
        ) : (
          <View className="flex-row gap-2">
            <View className="flex-1"><Btn label={t('gloria.new.addSummitButton')} onPress={() => setAdding(true)} /></View>
            <View className="flex-1"><Btn label={t('gloria.summitImport.button')} onPress={runImport} /></View>
          </View>
        )}

        {summary ? (
          <Banner tone="info">
            <BannerText tone="info" bold>{t('gloria.new.mocyIs', { mocy: summary.mocy })}</BannerText>
            <BannerText tone="info">
              {summary.fromMocy != null
                ? t('gloria.new.carryOver', { from: summary.fromMocy, points: summary.points })
                : t('gloria.new.noCarryOver')}
            </BannerText>
          </Banner>
        ) : null}

        <View className="gap-1.5">
          <Label>{t('gloria.new.surveyors')}</Label>
          <Pressable onPress={() => setPickingSurveyors(true)} accessibilityRole="button" accessibilityLabel={t('gloria.new.surveyors')}>
            <Card className="flex-row items-center px-3 py-2">
              <Text className={`flex-1 text-sm ${surveyors ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}>
                {surveyors || t('gloria.new.noSurveyors')}
              </Text>
              <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
            </Card>
          </Pressable>
          <SurveyorAssignSheet
            visible={pickingSurveyors}
            current={surveyors ?? ''}
            onCancel={() => setPickingSurveyors(false)}
            onAssign={(v) => {
              setPickingSurveyors(false);
              setSurveyors(v.trim() || null);
            }}
          />
        </View>
      </ScrollView>
      <View className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <Btn primary label={t('gloria.new.start')} disabled={picked == null} onPress={() => picked != null && void startGloriaAndOpen(picked, surveyors)} />
      </View>
    </SafeAreaView>
  );
}
