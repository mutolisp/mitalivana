/**
 * Phase 0 of docs/planned/Media_sync.md: send picked files up to the team's
 * relay and back, and show whether the bytes match and what each step cost.
 * Development builds only (the team page shows the entry under __DEV__); the
 * screen goes when phase 2 replaces it with real file sync.
 */
import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickFiles } from '~/lib/fileAttach';
import { downloadMedia, mediaEnabled, uploadMedia, type Progress } from '~/lib/mediaSync';
import { pickPhotos } from '~/lib/photoCapture';
import { teamSyncErrorText } from '~/lib/teamSyncText';

type Row = { name: string; lines: string[]; ok: boolean | null };
type Picked = { uri: string; name: string };

const MB = 1024 * 1024;
const mb = (n: number) => (n / MB).toFixed(2);
const rate = (bytes: number, ms: number) => (ms > 0 ? `${(bytes / MB / (ms / 1000)).toFixed(2)} MB/s` : '—');

export default function TeamMediaTestScreen() {
  const { t } = useTranslation();
  const teamId = String(useLocalSearchParams<{ id: string }>().id ?? '');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [last, setLast] = useState<Picked[]>([]);

  useEffect(() => {
    mediaEnabled(teamId)
      .then(setEnabled)
      .catch((e) => {
        setEnabled(false);
        setStatus(teamSyncErrorText(e));
      });
  }, [teamId]);

  const progress: Progress = (stage, done, total) => setStatus(t(`teamSync.mediaTest.stage.${stage}`, { done, total }));

  const runOne = async (f: Picked): Promise<Row> => {
    const lines: string[] = [];
    try {
      const up = await uploadMedia(teamId, f.uri, progress);
      lines.push(
        t('teamSync.mediaTest.sizeLine', { mb: mb(up.size), n: up.count }) +
          (up.skipped ? ` ${t('teamSync.mediaTest.skipped', { n: up.skipped })}` : ''),
        t('teamSync.mediaTest.timesUp', { hash: up.ms.hash, seal: up.ms.seal, upload: up.ms.upload, rate: rate(up.size, up.ms.upload) }),
      );
      const dest = new File(Paths.cache, `media-test-${up.mid}`);
      const down = await downloadMedia(teamId, up.mid, up.count, dest, progress);
      const heap = [up.heapPeak, down.heapPeak].every((x) => x == null) ? '—' : `${mb(Math.max(up.heapPeak ?? 0, down.heapPeak ?? 0))} MB`;
      lines.push(
        t('teamSync.mediaTest.timesDown', { download: down.ms.download, rate: rate(down.size, down.ms.download), open: down.ms.open }),
        t('teamSync.mediaTest.heap', { value: heap }),
        `sha256 ${up.sha256.slice(0, 16)}…`,
      );
      const same = down.sha256 === up.sha256 && down.size === up.size;
      lines.push(same ? t('teamSync.mediaTest.match') : t('teamSync.mediaTest.mismatch', { bytes: down.size, sha: `${down.sha256.slice(0, 16)}…` }));
      if (dest.exists) dest.delete();
      return { name: f.name, lines, ok: same };
    } catch (e) {
      lines.push(t('teamSync.mediaTest.failed', { message: teamSyncErrorText(e) }));
      return { name: f.name, lines, ok: false };
    }
  };

  const run = async (files: Picked[]) => {
    if (!files.length) return;
    setBusy(true);
    setLast(files);
    try {
      for (const f of files) {
        const r = await runOne(f);
        setRows((prev) => [r, ...prev]);
      }
      setStatus(t('teamSync.mediaTest.done'));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (kind: 'file' | 'photo') => {
    try {
      const files =
        kind === 'file'
          ? (await pickFiles()).map((f) => ({ uri: f.uri, name: f.name }))
          : (await pickPhotos()).map((uri) => ({ uri, name: uri.split('/').pop() ?? uri }));
      await run(files);
    } catch (e) {
      setStatus(teamSyncErrorText(e));
    }
  };

  const btn = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      className={`flex-1 items-center rounded-lg px-3 py-2.5 ${disabled || busy ? 'bg-gray-300 dark:bg-gray-700' : 'bg-accent-700 active:opacity-80'}`}
    >
      <Text className="text-center text-sm font-semibold text-white">{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: t('teamSync.mediaTest.title') }} />
      <ScrollView contentContainerClassName="gap-3 p-4">
        <Text className="text-xs text-gray-600 dark:text-gray-400">{t('teamSync.mediaTest.intro', { platform: Platform.OS })}</Text>
        <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {enabled == null ? t('teamSync.mediaTest.checking') : enabled ? t('teamSync.mediaTest.accepted') : t('teamSync.mediaTest.refused')}
        </Text>
        <View className="flex-row gap-2">
          {btn(t('teamSync.mediaTest.pickFile'), () => void pick('file'), !enabled)}
          {btn(t('teamSync.mediaTest.pickPhoto'), () => void pick('photo'), !enabled)}
        </View>
        {btn(t('teamSync.mediaTest.rerun'), () => void run(last), !enabled || !last.length)}
        {status ? <Text className="text-xs text-gray-500 dark:text-gray-400">{status}</Text> : null}
        {rows.map((r, i) => (
          <View key={i} className="gap-0.5 rounded-lg border border-gray-200 bg-card p-3 dark:border-gray-800 dark:bg-gray-900">
            <Text selectable className={`text-sm font-semibold ${r.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
              {r.name}
            </Text>
            {r.lines.map((l, k) => (
              <Text key={k} selectable className="text-xs text-gray-700 dark:text-gray-300">
                {l}
              </Text>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
