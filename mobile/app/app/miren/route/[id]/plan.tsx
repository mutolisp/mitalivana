/**
 * Plan a route's sites from a track with elevations (GPX / KML / GeoJSON).
 *
 * Road (Road §2.3, p. 2): 20 sites, the elevation range from the bottom to
 * the highest point divided into 19 equal bands. Trail (Trail protocol,
 * Placing transects, p. 3): every N metres of elevation (where the trail
 * first crosses each contour) or every N metres along the trail; transects
 * must be ≥ 50 m apart in elevation or ≥ 100 m apart in distance, ≥ 10 per
 * trail — warnings only.
 *
 * Planned points are targets: sites are chosen before going into the field
 * (§2.3) and then found with GPS. Writing keeps each site's other data.
 */
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { detectFormat, parseGeoFile } from '~/lib/geoConverters';
import { errText } from '~/lib/errText';
import { applyPlannedSites, getRoute, listSites, updateRoute } from '~/modules/miren/db';
import {
  checkTrailSpacing,
  cumulativeMeters,
  orientUphill,
  planRoadSites,
  planTrailByDistance,
  planTrailByElevation,
  profileFromGeoJson,
  profileFromGeometries,
  profileToGeoJson,
  topElevation,
  type Stop,
} from '~/modules/miren/model/planner';
import { MAX_SITE, pad2 } from '~/modules/miren/model/codes';
import { ProfileChart } from '~/modules/miren/components/ProfileChart';
import { FieldRow } from '~/modules/miren/components/fields';
import { Banner, BannerText, Btn, Card, Label, NumAccessory, NumField, Seg } from '~/modules/gloria/components/ui';

type TrailMethod = 'elevation' | 'distance';

export default function MirenPlanScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [route, setRoute] = useState(() => getRoute(id));
  const [method, setMethod] = useState<TrailMethod>('elevation');
  const [band, setBand] = useState<number | null>(50);
  const [stepM, setStepM] = useState<number | null>(100);

  const points = useMemo(() => orientUphill(profileFromGeoJson(route?.track_geojson ?? null)), [route?.track_geojson]);
  const along = useMemo(() => cumulativeMeters(points), [points]);
  const isRoad = route?.kind === 'road';
  const planned: Array<Stop | null> = useMemo(() => {
    if (points.length < 2) return [];
    if (isRoad) return planRoadSites(points);
    return method === 'elevation' ? planTrailByElevation(points, band ?? 0) : planTrailByDistance(points, stepM ?? 0);
  }, [points, isRoad, method, band, stepM]);
  const stops = planned.filter((s): s is Stop => s != null);
  const issues = !isRoad ? checkTrailSpacing(stops) : [];
  const tooMany = route ? planned.length > MAX_SITE[route.kind] : false;

  if (!route) {
    return (
      <SettingsPage>
        <Text className="p-4 text-gray-500">{t('miren.notFound')}</Text>
      </SettingsPage>
    );
  }

  const importTrack = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: ['*/*'], copyToCacheDirectory: true });
      const asset = r.canceled ? null : r.assets?.[0];
      if (!asset?.uri) return;
      const text = await new File(asset.uri).text();
      const format = detectFormat(text, asset.name);
      if (!format) {
        Alert.alert(t('miren.plan.import'), t('geoImport.badFormat'));
        return;
      }
      const prof = profileFromGeometries(parseGeoFile(text, format).map((g) => g.geometry));
      if (!prof.ok) {
        Alert.alert(t('miren.plan.import'), t(prof.error === 'no-line' ? 'miren.plan.noLine' : 'miren.plan.noElevation'));
        return;
      }
      const up = orientUphill(prof.points);
      const length = cumulativeMeters(up);
      updateRoute(route.id, {
        track_geojson: profileToGeoJson(up),
        ...(route.kind === 'trail' && route.length_m == null ? { length_m: Math.round(length[length.length - 1]) } : {}),
      });
      setRoute(getRoute(route.id));
    } catch (e) {
      Alert.alert(t('miren.plan.import'), errText(e));
    }
  };

  const write = () => {
    const doWrite = () => {
      applyPlannedSites(route.id, planned.slice(0, MAX_SITE[route.kind]));
      router.back();
    };
    if (listSites(route.id).length === 0) doWrite();
    else
      Alert.alert(t('miren.plan.writeTitle'), t('miren.plan.writeMsg'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('miren.plan.write'), onPress: doWrite },
      ]);
  };

  const bottom = points[0]?.ele;
  const top = points.length ? topElevation(points) : undefined;
  const totalKm = along.length ? along[along.length - 1] / 1000 : 0;

  return (
    <SettingsPage>
      <KeyboardAwareScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t(isRoad ? 'miren.plan.introRoad' : 'miren.plan.introTrail')}</Text>
        <Btn primary={points.length === 0} label={t(points.length ? 'miren.plan.reimport' : 'miren.plan.import')} onPress={() => void importTrack()} />
        {points.length >= 2 ? (
          <>
            <Card className="p-3">
              <Text className="text-xs text-gray-500 dark:text-gray-400">
                {t('miren.plan.summary', { bottom: Math.round(bottom ?? 0), top: Math.round(top ?? 0), km: totalKm.toFixed(1), n: points.length })}
              </Text>
              <ProfileChart points={points} along={along} stops={stops} />
            </Card>
            {!isRoad ? (
              <Card className="gap-2 p-3">
                <Seg
                  value={method}
                  onChange={setMethod}
                  options={[
                    { value: 'elevation', label: t('miren.plan.byElevation') },
                    { value: 'distance', label: t('miren.plan.byDistance') },
                  ]}
                />
                {method === 'elevation' ? (
                  <FieldRow label={t('miren.plan.band')}>
                    <NumField value={band} onCommit={setBand} range={{ min: 10, max: 500, unit: 'm' }} width={80} accessibilityLabel={t('miren.plan.band')} />
                  </FieldRow>
                ) : (
                  <FieldRow label={t('miren.plan.interval')}>
                    <NumField value={stepM} onCommit={setStepM} range={{ min: 10, max: 5000, unit: 'm' }} width={80} accessibilityLabel={t('miren.plan.interval')} />
                  </FieldRow>
                )}
              </Card>
            ) : null}
            {issues.map((i, k) => (
              <Banner key={k} tone="warn">
                <BannerText tone="warn">
                  {i.kind === 'too-few'
                    ? t('miren.plan.tooFew', { n: i.count })
                    : t('miren.plan.tooClose', { a: pad2(i.index), b: pad2(i.index + 1), de: Math.round(i.elevationGap), dd: Math.round(i.distanceGap) })}
                </BannerText>
              </Banner>
            ))}
            {tooMany ? (
              <Banner tone="warn">
                <BannerText tone="warn">{t('miren.plan.tooMany', { n: planned.length, max: MAX_SITE[route.kind] })}</BannerText>
              </Banner>
            ) : null}
            <Label>{t('miren.plan.preview')}</Label>
            <Card>
              {planned.slice(0, MAX_SITE[route.kind]).map((s, i) => (
                <View key={i} className="flex-row border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
                  <Text className="w-10 font-mono text-sm text-gray-900 dark:text-gray-100">{pad2(i + 1)}</Text>
                  {s ? (
                    <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300" style={{ fontVariant: ['tabular-nums'] }}>
                      {`${Math.round(s.ele)} m · ${(s.along / 1000).toFixed(2)} km`}
                    </Text>
                  ) : (
                    <Text className="flex-1 text-sm text-amber-600">{t('miren.plan.unreached')}</Text>
                  )}
                </View>
              ))}
            </Card>
            <Btn primary disabled={stops.length === 0} label={t('miren.plan.write')} onPress={write} />
          </>
        ) : null}
      </KeyboardAwareScrollView>
      <NumAccessory />
    </SettingsPage>
  );
}
