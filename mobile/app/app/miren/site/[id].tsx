/**
 * One MIREN site (road) or transect (trail): the planned point, the side of
 * the route, how it is marked, the ≥ 100 m clearance check (Road §2.3 a), the
 * trail transect fields (Trail (2) h, k, o, p), and relocation (§2.5.3: a new
 * site nearby gets the suffix `a`).
 */
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { SelectRow } from '~/components/settings/rows';
import { deleteSite, getRegion, getRoute, getSite, regionCodeFor, relocateSite, setSiteClearance, updateSite, type SitePatch } from '~/modules/miren/db';
import { formatSiteCode } from '~/modules/miren/model/codes';
import { ROAD_CLEARANCE_M, clearanceOk } from '~/modules/miren/model/planner';
import { MOUNTAIN_ZONES } from '~/modules/miren/model/vocab';
import { FieldRow, TextBlock, TextCommit } from '~/modules/miren/components/fields';
import { Banner, BannerText, Btn, Card, Label, NumAccessory, NumField } from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';
import { isoDate } from '~/lib/datetime';

export default function MirenSiteScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [site, setSite] = useState(() => getSite(id));
  const reload = useCallback(() => setSite(getSite(id)), [id]);
  useFocusEffect(reload);
  const route = site ? getRoute(site.route_id) : null;
  const region = route ? getRegion(route.region_id) : null;
  const regionCode = route && region ? regionCodeFor(region, route.kind) : null;
  if (!site || !route || !regionCode) {
    return (
      <SettingsPage title="">
        <Text className="p-4 text-gray-500">{t('miren.notFound')}</Text>
      </SettingsPage>
    );
  }
  const patch = (p: SitePatch) => {
    updateSite(site.id, p);
    reload();
  };
  const isRoad = route.kind === 'road';
  const clear = clearanceOk(site.road_clearance_m);
  const relocate = () =>
    Alert.alert(t('miren.site.relocateTitle'), t('miren.site.relocateMsg', { code: formatSiteCode(regionCode, route.code, site.site_no, 'a') }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('miren.site.relocate'),
        onPress: () => {
          const nid = relocateSite(site.id);
          if (nid != null) router.replace(`/miren/site/${nid}` as Href);
          else Alert.alert(t('miren.site.relocateTitle'), t('miren.site.relocateExists'));
        },
      },
    ]);
  // Asked first, as a route or region is: MIREN keeps no versions to undo it (code review L18).
  const remove = () =>
    Alert.alert(t('miren.site.deleteTitle'), t('miren.site.deleteMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (deleteSite(site.id)) router.back();
          else Alert.alert(t('miren.site.deleteTitle'), t('miren.site.deleteUsed'));
        },
      },
    ]);

  return (
    <SettingsPage title={formatSiteCode(regionCode, route.code, site.site_no, site.suffix)}>
      <KeyboardAwareScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <Label>{t('miren.site.planned')}</Label>
        <Card className="gap-0.5 p-3">
          <FieldRow label={t('miren.site.lat')}>
            <NumField value={site.planned_lat} onCommit={(v) => patch({ planned_lat: v })} range={RANGES.latitude} signed width={140} accessibilityLabel={t('miren.site.lat')} />
          </FieldRow>
          <FieldRow label={t('miren.site.lon')}>
            <NumField value={site.planned_lon} onCommit={(v) => patch({ planned_lon: v })} range={RANGES.longitude} signed width={140} accessibilityLabel={t('miren.site.lon')} />
          </FieldRow>
          <FieldRow label={t('miren.site.elev')}>
            <NumField value={site.planned_elev} onCommit={(v) => patch({ planned_elev: v })} range={RANGES.elevation} width={100} accessibilityLabel={t('miren.site.elev')} />
          </FieldRow>
          <View className="pt-1">
            <SelectRow
              variant="inline"
              label={t('miren.site.side')}
              value={site.side ?? ''}
              options={[
                { value: '', label: t('miren.unset') },
                { value: 'left', label: t('miren.site.side_left') },
                { value: 'right', label: t('miren.site.side_right') },
              ]}
              onChange={(v) => patch({ side: (v || null) as SitePatch['side'] })}
            />
          </View>
        </Card>
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('miren.site.plannedHint')}</Text>

        {isRoad ? (
          <>
            <Label>{t('miren.site.clearance')}</Label>
            <Banner tone={clear == null ? 'warn' : clear ? 'ok' : 'error'}>
              <BannerText tone={clear == null ? 'warn' : clear ? 'ok' : 'error'}>
                {clear == null
                  ? t('miren.site.clearanceTodo', { m: ROAD_CLEARANCE_M })
                  : t(clear ? 'miren.site.clearanceOk' : 'miren.site.clearanceShort', {
                      d: Math.round(site.road_clearance_m ?? 0),
                      m: ROAD_CLEARANCE_M,
                      date: site.clearance_checked_at ? isoDate(site.clearance_checked_at) : '',
                    })}
              </BannerText>
            </Banner>
            <Btn primary={clear == null} label={t('miren.site.measureOnMap')} onPress={() => router.push(`/(tabs)/map?measureSite=${site.id}` as Href)} />
            <Card className="p-3">
              <FieldRow label={t('miren.site.clearanceMeasured')}>
                <NumField value={site.road_clearance_m} onCommit={(v) => (v == null ? patch({ road_clearance_m: null, clearance_checked_at: null }) : (setSiteClearance(site.id, v), reload()))} range={{ min: 0, max: 100000, unit: 'm' }} width={100} accessibilityLabel={t('miren.site.clearanceMeasured')} />
              </FieldRow>
            </Card>
          </>
        ) : (
          <>
            <Label>{t('miren.site.transect')}</Label>
            <Card className="gap-0.5 p-3">
              <View>
                <SelectRow
                  variant="inline"
                  label={t('miren.site.zone')}
                  description="Mountain zone"
                  value={site.mountain_zone ?? ''}
                  options={[{ value: '', label: t('miren.unset') }, ...MOUNTAIN_ZONES.map((z) => ({ value: z, label: t(`miren.zone.${z}`) }))]}
                  onChange={(v) => patch({ mountain_zone: (v || null) as SitePatch['mountain_zone'] })}
                />
              </View>
              <FieldRow label={t('miren.site.verge')} hint="Trail verge width">
                <NumField value={site.verge_width_m} onCommit={(v) => patch({ verge_width_m: v })} range={{ min: 0, max: 50, unit: 'm' }} width={80} accessibilityLabel={t('miren.site.verge')} />
              </FieldRow>
              <FieldRow label={t('miren.site.herbivores')} hint="Herbivores">
                <TextCommit value={site.herbivores} onCommit={(v) => patch({ herbivores: v })} width={150} accessibilityLabel={t('miren.site.herbivores')} />
              </FieldRow>
              <FieldRow label={t('miren.site.distAlong')} hint={t('miren.site.distHint')}>
                <NumField value={site.dist_trailhead_along_m} onCommit={(v) => patch({ dist_trailhead_along_m: v })} range={{ min: 0, unit: 'm' }} width={100} accessibilityLabel={t('miren.site.distAlong')} />
              </FieldRow>
              <FieldRow label={t('miren.site.distDirect')} hint={t('miren.site.distHint')}>
                <NumField value={site.dist_trailhead_direct_m} onCommit={(v) => patch({ dist_trailhead_direct_m: v })} range={{ min: 0, unit: 'm' }} width={100} accessibilityLabel={t('miren.site.distDirect')} />
              </FieldRow>
            </Card>
          </>
        )}

        <Label>{t('miren.site.marker')}</Label>
        <TextBlock value={site.marker_note} onCommit={(v) => patch({ marker_note: v })} placeholder={t('miren.site.markerHint')} accessibilityLabel={t('miren.site.marker')} />
        <Label>{t('miren.site.notes')}</Label>
        <TextBlock value={site.notes} onCommit={(v) => patch({ notes: v })} accessibilityLabel={t('miren.site.notes')} />

        {site.suffix === '' ? <Btn label={t('miren.site.relocate')} onPress={relocate} /> : null}
        <Btn label={t('miren.site.deleteTitle')} onPress={remove} />
      </KeyboardAwareScrollView>
      <NumAccessory />
    </SettingsPage>
  );
}
