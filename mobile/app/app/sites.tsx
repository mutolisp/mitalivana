import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isoDateTime } from '~/lib/datetime';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { SafeAreaView } from 'react-native-safe-area-context';
import { countSiteReferences, deleteSite, listSites, type SiteWithProject } from '~/db';
import { SITE_TYPE_ICON, SITE_TYPE_LABEL } from '~/lib/siteLabels';
import { sitesToGeoJSON, sitesToGPX, sitesToKML, sitesToWKT } from '~/lib/geoExporters';
import { useToast } from '~/stores/toast';
import { SwipeRow } from '~/components/SwipeRow';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { BackHeaderLeft } from '~/lib/goBack';
import { ACTION_FILL } from '~/lib/colors';

type ExportFormat = 'geojson' | 'kml' | 'gpx' | 'wkt';

const EXPORT_LABELS: Record<
  ExportFormat,
  { label: string; ext: string; mime: string; uti: string }
> = {
  geojson: { label: 'GeoJSON', ext: 'geojson', mime: 'application/geo+json', uti: 'public.json' },
  kml: {
    label: 'KML',
    ext: 'kml',
    mime: 'application/vnd.google-earth.kml+xml',
    uti: 'com.google.earth.kml',
  },
  gpx: { label: 'GPX', ext: 'gpx', mime: 'application/gpx+xml', uti: 'public.xml' },
  wkt: { label: 'WKT', ext: 'wkt', mime: 'text/plain', uti: 'public.plain-text' },
};

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.-]/g, '_').slice(0, 80) || 'sites';
}


function formatTime(ts: number): string {
  return isoDateTime(ts);
}

export default function SitesScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const [sites, setSites] = useState<SiteWithProject[]>([]);

  const reload = useCallback(() => setSites(listSites()), []);
  useFocusEffect(useCallback(() => reload(), [reload]));

  const handleDelete = (s: SiteWithProject) => {
    // A site bound to a checklist or plot survey is that record's geometry;
      // deleting it here
    // silently strips the boundary off the record, so say so first.
    const bound = countSiteReferences(s.id) > 0;
    const msg = bound
      ? t('sites.deleteBoundMsg', { name: s.name })
      : t('sites.deleteMsg', { name: s.name });
    Alert.alert(t('sites.deleteTitle'), msg, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteSite(s.id);
          reload();
          toast(t('sites.deleted'));
        },
      },
    ]);
  };

  // Hand the id over and let the map centre itself. Writing `map_view` and
  // navigating used to look right and do nothing: the map is a tab screen, so
  // once it has been visited it stays mounted and only ever reads that setting
  // through `initialRegion` — and its own pan handler overwrites the value
  // 600 ms later anyway.
  const handleJumpTo = (s: SiteWithProject) => {
    router.push(`/(tabs)/map?site=${s.id}` as Href);
  };

  const exportSites = async (subset: SiteWithProject[], format: ExportFormat, baseName: string) => {
    if (subset.length === 0) {
      toast(t('sites.noExport'));
      return;
    }
    try {
      let text = '';
      if (format === 'geojson') text = sitesToGeoJSON(subset);
      else if (format === 'kml') text = sitesToKML(subset);
      else if (format === 'gpx') text = sitesToGPX(subset);
      else text = sitesToWKT(subset);

      const meta = EXPORT_LABELS[format];
      const filename = `${sanitizeFilename(baseName)}.${meta.ext}`;
      const file = new File(Paths.cache, filename);
      if (file.exists) file.delete();
      file.create();
      file.write(text);

      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert(t('sites.shareUnavailable'), t('backup.fileGenerated', { uri: file.uri }));
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: meta.mime,
        dialogTitle: filename,
        UTI: meta.uti,
      });
    } catch (e) {
      Alert.alert(t('export.failed'), e instanceof Error ? e.message : String(e));
    }
  };

  const askExportFormat = async (subset: SiteWithProject[], baseName: string) => {
    const formats: ExportFormat[] = ['geojson', 'kml', 'gpx', 'wkt'];
    const idx = await showActionSheet({
      title: t('sites.exportTitle', { count: subset.length }),
      options: formats.map((f) => ({ label: EXPORT_LABELS[f].label })),
    });
    if (idx >= 0 && idx < formats.length) exportSites(subset, formats[idx], baseName);
  };

  // Group by project
  const byProject = sites.reduce<Map<string, SiteWithProject[]>>((acc, s) => {
    const list = acc.get(s.project_name) ?? [];
    list.push(s);
    acc.set(s.project_name, list);
    return acc;
  }, new Map());
  const projectGroups = [...byProject.entries()];

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: t('sites.title'),
          headerLeft: BackHeaderLeft,
          headerRight: () =>
            sites.length > 0 ? (
              <HeaderIconButton
                icon="share-outline"
                onPress={() => askExportFormat(sites, 'sites')}
                label={t('common.export')}
              />
            ) : null,
        }}
      />

      {sites.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="map-outline" size={64} color="#9ca3af" />
          <Text className="mt-4 text-lg font-medium text-gray-700 dark:text-gray-300">
            {t('sites.empty')}
          </Text>
          <Text className="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('sites.emptyHint')}
          </Text>
          <Pressable
            onPress={() => router.push('/(tabs)/map')}
            className={`mt-4 rounded-full px-4 py-2 ${ACTION_FILL}`}
          >
            <Text className="text-sm font-medium text-white">{t('sites.goToMap')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={projectGroups}
          keyExtractor={([projectName]) => projectName}
          renderItem={({ item: [projectName, list] }) => (
            <View>
              <View className="flex-row items-center justify-between bg-gray-100 px-4 py-2 dark:bg-gray-800">
                <Text className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                  {projectName} · {t('sites.projectStats', { count: list.length })}
                </Text>
                <Pressable onPress={() => askExportFormat(list, projectName)} hitSlop={6}>
                  <Ionicons name="share-outline" size={16} color="#2563eb" />
                </Pressable>
              </View>
              {list.map((s) => (
                <SwipeRow key={s.id} onDelete={() => handleDelete(s)}>
                  <Pressable
                    onPress={() => handleJumpTo(s)}
                    className="flex-row items-center border-b border-gray-100 bg-white px-4 py-3 active:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:active:bg-gray-800"
                  >
                    <Ionicons
                      name={SITE_TYPE_ICON[s.geometry_type]}
                      size={20}
                      color="#2563eb"
                      style={{ marginRight: 12 }}
                    />
                    <View className="flex-1">
                      <Text className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {s.name}
                      </Text>
                      <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {t(SITE_TYPE_LABEL[s.geometry_type])}{' '}
                        · {formatTime(s.updated_at)}
                      </Text>
                      {s.notes ? (
                        <Text
                          className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
                          numberOfLines={1}
                        >
                          {s.notes}
                        </Text>
                      ) : null}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                  </Pressable>
                </SwipeRow>
              ))}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}
