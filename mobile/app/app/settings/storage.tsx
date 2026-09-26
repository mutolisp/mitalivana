/**
 * Storage — what the app keeps on the device and what can go (src/lib/storage).
 *
 * Only two things are deleted from here, each after a confirmation: the cache
 * (always disposable) and photos / recordings that no record points to.
 * Downloadable data (checklists, offline map, POI), safety and pre-merge backups link to
 * the screens that already manage them; the user's own database is shown for
 * information only.
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, Text, View } from 'react-native';
import { LinkRow, Section } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { formatBytes } from '~/lib/exportSize';
import {
  cacheBusy,
  clearCache,
  deleteFiles,
  dirSize,
  findMediaOrphans,
  legacyLeftovers,
  mergeBackups,
  removeLegacyLeftovers,
  safetyBackups,
  sizeOf,
  type Orphans,
} from '~/lib/storage';
import { useToast } from '~/stores/toast';

type Sizes = {
  cache: number;
  orphans: Orphans;
  safety: { n: number; bytes: number };
  merge: { n: number; bytes: number };
  datasets: number;
  packs: number;
  vectormap: number;
  poi: number;
  legacy: number;
  userDb: number;
  photos: number;
  audio: number;
};

function measure(): Sizes {
  const doc = (name: string) => dirSize(new Directory(Paths.document, name));
  const file = (name: string) => {
    const f = new File(Paths.document, name);
    return f.exists ? (f.size ?? 0) : 0;
  };
  const safety = safetyBackups();
  const merge = mergeBackups();
  return {
    cache: dirSize(new Directory(Paths.cache)),
    orphans: findMediaOrphans(),
    safety: { n: safety.length, bytes: safety.reduce((a, f) => a + (f.size ?? 0), 0) },
    merge: { n: merge.length, bytes: merge.reduce((a, f) => a + (f.size ?? 0), 0) },
    datasets: doc('datasets'),
    packs: file('regionpacks.db'),
    vectormap: doc('vectormap'),
    poi: doc('poi'),
    legacy: legacyLeftovers().reduce((a, e) => a + sizeOf(e), 0),
    userDb: ['user.db', 'user.db-wal', 'user.db-shm'].reduce((a, n) => a + file(n), 0),
    photos: doc('photos'),
    audio: doc('audio'),
  };
}

export default function StorageScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const [s, setS] = useState<Sizes | null>(null);
  const refresh = useCallback(() => setS(measure()), []);
  useFocusEffect(refresh);
  if (!s) return <SettingsPage>{null}</SettingsPage>;

  const total =
    s.cache + s.safety.bytes + s.merge.bytes + s.datasets + s.packs + s.vectormap + s.poi + s.legacy + s.userDb + s.photos + s.audio;
  const confirm = (title: string, msg: string, run: () => void | Promise<void>) =>
    Alert.alert(title, msg, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('storage.delete'), style: 'destructive', onPress: () => void run() },
    ]);

  const clearCacheNow = () => {
    if (cacheBusy()) {
      Alert.alert(t('storage.busyTitle'), t('storage.busy'));
      return;
    }
    confirm(t('storage.cacheTitle'), t('storage.cacheConfirm', { size: formatBytes(s.cache) }), async () => {
      const freed = await clearCache();
      toast(t('storage.freed', { size: formatBytes(freed) }));
      refresh();
    });
  };
  const clearOrphans = () => {
    // Re-scan at the moment of deleting: a record may have been added since the screen opened.
    const now = findMediaOrphans();
    if (!now.files.length) return refresh();
    confirm(t('storage.orphansTitle'), t('storage.orphansConfirm', { n: now.files.length, size: formatBytes(now.bytes) }), () => {
      deleteFiles(now.files);
      toast(t('storage.freed', { size: formatBytes(now.bytes) }));
      refresh();
    });
  };
  const clearLegacy = () =>
    confirm(t('storage.legacyTitle'), t('storage.legacyConfirm', { size: formatBytes(s.legacy) }), () => {
      removeLegacyLeftovers();
      toast(t('storage.freed', { size: formatBytes(s.legacy) }));
      refresh();
    });

  return (
    <SettingsPage>
      <ScrollView contentContainerClassName="pb-8">
        <View className="px-4 pt-4">
          <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
            {formatBytes(total)}
          </Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">{t('storage.totalHint')}</Text>
        </View>

        <Section title={t('storage.canFree')}>
          <LinkRow
            label={t('storage.cache')}
            description={t('storage.cacheDesc')}
            value={formatBytes(s.cache)}
            chevron={false}
            onPress={clearCacheNow}
          />
          <LinkRow
            label={t('storage.orphans')}
            description={t('storage.orphansDesc', { n: s.orphans.files.length })}
            value={formatBytes(s.orphans.bytes)}
            chevron={false}
            onPress={clearOrphans}
          />
          {s.legacy > 0 ? (
            <LinkRow label={t('storage.legacy')} description={t('storage.legacyDesc')} value={formatBytes(s.legacy)} chevron={false} onPress={clearLegacy} />
          ) : null}
          <LinkRow
            label={t('storage.safety')}
            description={t('storage.safetyDesc', { n: s.safety.n })}
            value={formatBytes(s.safety.bytes)}
            onPress={() => router.push('/backup' as Href)}
          />
          <LinkRow
            label={t('storage.mergeBackups')}
            description={t('storage.mergeBackupsDesc', { n: s.merge.n })}
            value={formatBytes(s.merge.bytes)}
            onPress={() => router.push('/settings/merge-backups' as Href)}
          />
        </Section>

        <Section title={t('storage.downloads')}>
          <LinkRow label={t('storage.datasets')} value={formatBytes(s.datasets + s.packs)} onPress={() => router.push('/regionpacks' as Href)} />
          <LinkRow label={t('storage.offlineMap')} value={formatBytes(s.vectormap + s.poi)} onPress={() => router.push('/settings/offlinemap' as Href)} />
        </Section>

        <Section title={t('storage.yours')}>
          <LinkRow label={t('storage.photos')} value={formatBytes(s.photos)} chevron={false} onPress={() => undefined} />
          <LinkRow label={t('storage.audio')} value={formatBytes(s.audio)} chevron={false} onPress={() => undefined} />
          <LinkRow label={t('storage.database')} value={formatBytes(s.userDb)} chevron={false} onPress={() => undefined} />
        </Section>
        <Text className="px-4 pt-3 text-xs text-gray-500 dark:text-gray-400">{t('storage.yoursHint')}</Text>
      </ScrollView>
    </SettingsPage>
  );
}
