/**
 * One MIREN region: its codes (road 3 letters, trail 2 — Road protocol
 * §2.5.2, Trail (2) a), name, country, the literature used for native /
 * non-native status, the trail protocol's regional description, and its
 * routes.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { deleteRegion, getRegion, listRoutes, setRegionCode, updateRegion, type RegionPatch } from '~/modules/miren/db';
import { promptNewRoute } from '~/modules/miren/prompts';
import { REGION_CODE_LENGTH, type RouteKind } from '~/modules/miren/model/codes';
import { FieldRow, TextBlock, TextCommit } from '~/modules/miren/components/fields';
import { Btn, Card, Label } from '~/modules/gloria/components/ui';

export default function MirenRegionScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [region, setRegion] = useState(() => getRegion(id));
  const [routes, setRoutes] = useState(() => listRoutes(id));
  const reload = useCallback(() => {
    setRegion(getRegion(id));
    setRoutes(listRoutes(id));
  }, [id]);
  useFocusEffect(reload);

  if (!region) {
    return (
      <SettingsPage title="">
        <Text className="p-4 text-gray-500">{t('miren.notFound')}</Text>
      </SettingsPage>
    );
  }
  const patch = (p: RegionPatch) => {
    updateRegion(region.id, p);
    reload();
  };
  const setCode = (kind: RouteKind, v: string | null) => {
    const r = setRegionCode(region.id, kind, v);
    const n = REGION_CODE_LENGTH[kind];
    if (r === 'invalid') Alert.alert(t('miren.code.refused'), t('miren.code.invalid', { n }));
    if (r === 'taken') Alert.alert(t('miren.code.refused'), t('miren.code.taken'));
    if (r === 'in-use') Alert.alert(t('miren.code.refused'), t('miren.code.inUse'));
    reload();
  };
  const addRoute = async () => {
    const rid = await promptNewRoute(region);
    if (rid != null) router.push(`/miren/route/${rid}` as Href);
  };
  const remove = () =>
    Alert.alert(t('miren.region.deleteTitle'), t('miren.region.deleteMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (deleteRegion(region.id)) router.back();
          else Alert.alert(t('miren.region.deleteTitle'), t('miren.region.deleteUsed'));
        },
      },
    ]);
  const title = [region.code_road, region.code_trail].filter(Boolean).join(' / ');
  const groups = (['road', 'trail'] as const).map((k) => [k, routes.filter((r) => r.kind === k)] as const);

  return (
    <SettingsPage title={title}>
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Label>{t('miren.region.base')}</Label>
        <Card className="gap-0.5 p-3">
          <FieldRow label={t('miren.region.codeRoad')} hint={t('miren.region.codeRoadHint')}>
            <TextCommit value={region.code_road} onCommit={(v) => setCode('road', v)} width={90} autoCapitalize="characters" maxLength={3} placeholder="MTN" accessibilityLabel={t('miren.region.codeRoad')} />
          </FieldRow>
          <FieldRow label={t('miren.region.codeTrail')} hint={t('miren.region.codeTrailHint')}>
            <TextCommit value={region.code_trail} onCommit={(v) => setCode('trail', v)} width={90} autoCapitalize="characters" maxLength={2} placeholder="AU" accessibilityLabel={t('miren.region.codeTrail')} />
          </FieldRow>
          <FieldRow label={t('miren.region.name')}>
            <TextCommit value={region.name} onCommit={(v) => patch({ name: v })} accessibilityLabel={t('miren.region.name')} />
          </FieldRow>
          <FieldRow label={t('miren.region.country')} hint={t('miren.region.countryHint')}>
            <TextCommit value={region.country} onCommit={(v) => patch({ country: v?.toUpperCase() ?? null })} width={90} autoCapitalize="characters" maxLength={2} placeholder="TW" accessibilityLabel={t('miren.region.country')} />
          </FieldRow>
        </Card>

        <Label>{t('miren.region.literature')}</Label>
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('miren.region.literatureHint')}</Text>
        <TextBlock value={region.default_literature} onCommit={(v) => patch({ default_literature: v })} accessibilityLabel={t('miren.region.literature')} />

        {region.code_trail ? (
          <>
            <Label>{t('miren.region.description')}</Label>
            <Text className="text-xs text-gray-500 dark:text-gray-400">{t('miren.region.descriptionHint')}</Text>
            <TextBlock value={region.regional_description} onCommit={(v) => patch({ regional_description: v })} accessibilityLabel={t('miren.region.description')} />
          </>
        ) : null}

        {groups.map(([kind, list]) =>
          list.length ? (
            <View key={kind} className="gap-1.5">
              <Label>{t(kind === 'road' ? 'miren.region.roads' : 'miren.region.trails')}</Label>
              <Card>
                {list.map((r) => (
                  <Pressable
                    key={r.id}
                    onPress={() => router.push(`/miren/route/${r.id}` as Href)}
                    accessibilityRole="button"
                    className="flex-row items-center border-b border-gray-100 px-3 py-2.5 dark:border-gray-800"
                  >
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {r.code}
                        {r.name ? `  ${r.name}` : ''}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400">
                        {[t('miren.region.siteCount', { n: r.sites }), r.last_year != null ? t('miren.region.lastYear', { year: r.last_year }) : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                  </Pressable>
                ))}
              </Card>
            </View>
          ) : null,
        )}
        <Btn primary label={t('miren.region.newRoute')} onPress={() => void addRoute()} />
        <Btn label={t('miren.region.deleteTitle')} onPress={remove} />
      </ScrollView>
    </SettingsPage>
  );
}
