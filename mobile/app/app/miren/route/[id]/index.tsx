/**
 * One MIREN road or trail: its protocol fields, its sites and its surveys.
 *
 * Road fields follow the submission template (DATA_22_example.xlsx: Traffic
 * intensity 1 < 10 / 2 10–100 / 3 > 100 cars per day, Road open = months per
 * year, Road type). Trail fields follow Trail protocol (1), pp. 4–5.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { SelectRow } from '~/components/settings/rows';
import {
  addSite,
  deleteRoute,
  getRegion,
  getRoute,
  listSites,
  listSurveysOfRoute,
  regionCodeFor,
  updateRoute,
  type RoutePatch,
} from '~/modules/miren/db';
import { promptStartSurvey } from '~/modules/miren/prompts';
import { formatSiteCode, MAX_SITE } from '~/modules/miren/model/codes';
import { clearanceOk } from '~/modules/miren/model/planner';
import { TRAIL_ACTIVITIES, TRAIL_SUBSTRATES } from '~/modules/miren/model/vocab';
import { parseMultiAttribute, serializeMultiAttribute } from '~/lib/dwcMultiValue';
import { FieldRow, TextBlock, TextCommit } from '~/modules/miren/components/fields';
import { Btn, Card, Chip, Label, NumAccessory, NumField } from '~/modules/gloria/components/ui';
import { promptText } from '~/components/TextPromptModal';

export default function MirenRouteScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [route, setRoute] = useState(() => getRoute(id));
  const [sites, setSites] = useState(() => listSites(id));
  const [surveys, setSurveys] = useState(() => listSurveysOfRoute(id));
  const reload = useCallback(() => {
    setRoute(getRoute(id));
    setSites(listSites(id));
    setSurveys(listSurveysOfRoute(id));
  }, [id]);
  useFocusEffect(reload);

  const region = route ? getRegion(route.region_id) : null;
  const regionCode = route && region ? regionCodeFor(region, route.kind) : null;
  if (!route || !regionCode) {
    return (
      <SettingsPage title="">
        <Text className="p-4 text-gray-500">{t('miren.notFound')}</Text>
      </SettingsPage>
    );
  }
  const patch = (p: RoutePatch) => {
    updateRoute(route.id, p);
    reload();
  };
  const activities = parseMultiAttribute(route.activities);
  const toggleActivity = (a: string) =>
    patch({ activities: serializeMultiAttribute(activities.includes(a) ? activities.filter((x) => x !== a) : [...activities, a]) });
  const addOneSite = async () => {
    const used = new Set(sites.map((s) => s.site_no));
    let next = 1;
    while (used.has(next)) next += 1;
    const raw = await promptText({
      title: t('miren.route.addSite'),
      message: t('miren.route.addSiteMsg', { max: MAX_SITE[route.kind] }),
      defaultValue: String(next),
      keyboardType: 'numeric',
    });
    const n = Number(raw?.trim());
    if (!raw || !Number.isInteger(n) || n < 1 || n > MAX_SITE[route.kind]) return;
    if (addSite(route.id, n) == null) Alert.alert(t('miren.route.addSite'), t('miren.route.siteTaken', { n }));
    reload();
  };
  const remove = () =>
    Alert.alert(t('miren.route.deleteTitle'), t('miren.route.deleteMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (deleteRoute(route.id)) router.back();
          else Alert.alert(t('miren.route.deleteTitle'), t('miren.route.deleteUsed'));
        },
      },
    ]);
  const isRoad = route.kind === 'road';

  return (
    <SettingsPage title={`${regionCode}.${route.code}`}>
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Label>{t(isRoad ? 'miren.kind.road' : 'miren.kind.trail')}</Label>
        <Card className="gap-0.5 p-3">
          <FieldRow label={t('miren.route.name')}>
            <TextCommit value={route.name} onCommit={(v) => patch({ name: v })} accessibilityLabel={t('miren.route.name')} />
          </FieldRow>
          {isRoad ? (
            <>
              <View className="pt-1">
                <SelectRow
                  variant="inline"
                  label={t('miren.route.traffic')}
                  description="Traffic intensity"
                  value={route.traffic_intensity ?? 0}
                  options={[
                    { value: 0, label: t('miren.unset') },
                    { value: 1, label: t('miren.route.traffic1') },
                    { value: 2, label: t('miren.route.traffic2') },
                    { value: 3, label: t('miren.route.traffic3') },
                  ]}
                  onChange={(v) => patch({ traffic_intensity: v || null })}
                />
              </View>
              <FieldRow label={t('miren.route.roadOpen')} hint="Road open">
                <NumField value={route.road_open_months} onCommit={(v) => patch({ road_open_months: v })} range={{ min: 0, max: 12, integer: true, unit: '' }} width={70} accessibilityLabel={t('miren.route.roadOpen')} />
              </FieldRow>
              <FieldRow label={t('miren.route.roadType')} hint="Road type">
                <TextCommit value={route.road_type} onCommit={(v) => patch({ road_type: v })} placeholder="Asphalt" width={140} accessibilityLabel={t('miren.route.roadType')} />
              </FieldRow>
            </>
          ) : (
            <>
              <FieldRow label={t('miren.route.length')}>
                <NumField value={route.length_m} onCommit={(v) => patch({ length_m: v })} range={{ min: 0, unit: 'm' }} width={100} accessibilityLabel={t('miren.route.length')} />
              </FieldRow>
              <FieldRow label={t('miren.route.width')} hint="Average width">
                <NumField value={route.width_m} onCommit={(v) => patch({ width_m: v })} range={{ min: 0, max: 50, unit: 'm' }} width={80} accessibilityLabel={t('miren.route.width')} />
              </FieldRow>
              <View className="pt-1">
                <SelectRow
                  variant="inline"
                  label={t('miren.route.category')}
                  description="formal / informal"
                  value={route.category ?? ''}
                  options={[
                    { value: '', label: t('miren.unset') },
                    { value: 'formal', label: t('miren.route.formal') },
                    { value: 'informal', label: t('miren.route.informal') },
                  ]}
                  onChange={(v) => patch({ category: (v || null) as RoutePatch['category'] })}
                />
              </View>
              <View className="pt-1">
                <SelectRow
                  variant="inline"
                  label={t('miren.route.substrate')}
                  value={route.substrate ?? ''}
                  options={[{ value: '', label: t('miren.unset') }, ...TRAIL_SUBSTRATES.map((s) => ({ value: s, label: t(`miren.substrate.${s}`) }))]}
                  onChange={(v) => patch({ substrate: v || null })}
                />
              </View>
              <Text className="pt-2 text-sm text-gray-700 dark:text-gray-300">{t('miren.route.activities')}</Text>
              <View className="flex-row flex-wrap pt-1">
                {TRAIL_ACTIVITIES.map((a) => (
                  <Chip key={a} label={t(`miren.activity.${a}`)} on={activities.includes(a)} onPress={() => toggleActivity(a)} />
                ))}
              </View>
            </>
          )}
        </Card>
        {!isRoad ? (
          <>
            <Label>{t('miren.route.history')}</Label>
            <TextBlock value={route.history} onCommit={(v) => patch({ history: v })} placeholder={t('miren.route.historyHint')} accessibilityLabel={t('miren.route.history')} />
          </>
        ) : null}

        <Label>{t(isRoad ? 'miren.route.sites' : 'miren.route.transects')}</Label>
        <Btn primary={sites.length === 0} label={t('miren.route.plan')} onPress={() => router.push(`/miren/route/${route.id}/plan` as Href)} />
        {sites.length ? (
          <Card>
            {sites.map((s) => {
              const clear = clearanceOk(s.road_clearance_m);
              return (
                <Pressable
                  key={s.id}
                  onPress={() => router.push(`/miren/site/${s.id}` as Href)}
                  accessibilityRole="button"
                  className="flex-row items-center border-b border-gray-100 px-3 py-2 dark:border-gray-800"
                >
                  <Text className="w-28 font-mono text-sm text-gray-900 dark:text-gray-100">{formatSiteCode(regionCode, route.code, s.site_no, s.suffix)}</Text>
                  <Text className="flex-1 text-xs text-gray-500 dark:text-gray-400">
                    {[s.planned_elev != null ? `${Math.round(s.planned_elev)} m` : null, s.side ? t(`miren.site.side_${s.side}`) : null].filter(Boolean).join(' · ')}
                  </Text>
                  {isRoad ? (
                    <Text className={`mr-2 text-[11px] ${clear == null ? 'text-amber-600' : clear ? 'text-emerald-600' : 'text-red-600'}`}>
                      {clear == null ? t('miren.site.clearanceUnchecked') : `${Math.round(s.road_clearance_m ?? 0)} m`}
                    </Text>
                  ) : null}
                  <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                </Pressable>
              );
            })}
          </Card>
        ) : null}
        <Btn label={t('miren.route.addSite')} onPress={() => void addOneSite()} />

        <Label>{t('miren.route.surveys')}</Label>
        {surveys.length ? (
          <Card>
            {surveys.map((v) => (
              <Pressable
                key={v.id}
                onPress={() => router.push(`/miren/survey/${v.id}` as Href)}
                accessibilityRole="button"
                className="flex-row items-center border-b border-gray-100 px-3 py-2.5 dark:border-gray-800"
              >
                <Text className="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{v.year}</Text>
                <Text className={`mr-2 text-xs ${v.status === 'active' ? 'text-emerald-600' : 'text-gray-500'}`}>
                  {t(v.status === 'active' ? 'miren.survey.active' : 'miren.survey.done')}
                </Text>
                <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
              </Pressable>
            ))}
          </Card>
        ) : null}
        <Btn primary={sites.length > 0} disabled={sites.length === 0} label={t('miren.route.newSurvey')} onPress={() => void promptStartSurvey(route.id)} />
        {sites.length === 0 ? <Text className="text-xs text-gray-500 dark:text-gray-400">{t('miren.route.noSites')}</Text> : null}
        <Btn label={t('miren.route.deleteTitle')} onPress={remove} />
      </ScrollView>
      <NumAccessory />
    </SettingsPage>
  );
}
