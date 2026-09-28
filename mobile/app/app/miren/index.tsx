/**
 * MIREN region list (偏好設定 → MIREN, or 新增記錄 → MIREN). A region holds
 * the road and / or trail routes; surveys are started from a route.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { listRegions, type RegionWithCounts } from '~/modules/miren/db';
import { promptNewRegion } from '~/modules/miren/prompts';
import { useActiveMiren } from '~/modules/miren/store';
import { Btn, Card, Label } from '~/modules/gloria/components/ui';

export default function MirenRegionsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [regions, setRegions] = useState<RegionWithCounts[]>(() => listRegions());
  const active = useActiveMiren((s) => s.survey);
  useFocusEffect(
    useCallback(() => {
      setRegions(listRegions());
      useActiveMiren.getState().refresh();
    }, []),
  );
  const add = async () => {
    const id = await promptNewRegion();
    if (id != null) router.push(`/miren/region/${id}` as Href);
  };
  return (
    <SettingsPage headerRight={() => <HeaderIconButton icon="add" label={t('miren.regions.newTitle')} onPress={() => void add()} />}>
      <ScrollView contentContainerClassName="gap-3 p-4">
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('miren.regions.intro')}</Text>
        {active ? <Btn primary label={t('miren.regions.continueActive', { year: active.year })} onPress={() => router.push(`/miren/survey/${active.id}` as Href)} /> : null}
        {regions.length === 0 ? <Btn primary label={t('miren.regions.newTitle')} onPress={() => void add()} /> : null}
        {regions.length > 0 ? <Label>{t('miren.regions.title')}</Label> : null}
        {regions.length > 0 ? (
          <Card>
            {regions.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => router.push(`/miren/region/${r.id}` as Href)}
                accessibilityRole="button"
                className="flex-row items-center border-b border-gray-100 px-3 py-2.5 dark:border-gray-800"
              >
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {[r.code_road, r.code_trail].filter(Boolean).join(' / ')}
                    {r.name ? `  ${r.name}` : ''}
                  </Text>
                  <Text className="text-xs text-gray-500 dark:text-gray-400">
                    {[r.country, t('miren.regions.counts', { routes: r.routes, surveys: r.surveys })].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
              </Pressable>
            ))}
          </Card>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
