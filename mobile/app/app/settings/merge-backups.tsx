/**
 * Pre-merge backups (docs/Team_merge.md): the record as it was before each
 * team merge, as an ordinary export zip without photos. From here one can be
 * shared (to keep it elsewhere, or to re-import with 覆蓋 on this or another
 * device) or deleted. The newest 10 are kept automatically.
 */
import { useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import type { File } from 'expo-file-system';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { LinkRow, Section } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { formatBytes } from '~/lib/exportSize';
import { deleteFiles, mergeBackupInfo, mergeBackups } from '~/lib/storage';
import { useToast } from '~/stores/toast';

export default function MergeBackupsScreen() {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [files, setFiles] = useState<File[]>([]);
  const refresh = useCallback(() => setFiles(mergeBackups()), []);
  useFocusEffect(refresh);

  const share = async (f: File) => {
    try {
      if (!(await Sharing.isAvailableAsync())) {
        toast(t('backup.shareUnavailable'));
        return;
      }
      await Sharing.shareAsync(f.uri, { mimeType: 'application/zip', UTI: 'public.zip-archive' });
    } catch (e) {
      toast(errText(e));
    }
  };
  const remove = (targets: File[], title: string, msg: string) =>
    Alert.alert(title, msg, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('storage.delete'),
        style: 'destructive',
        onPress: () => {
          deleteFiles(targets);
          refresh();
        },
      },
    ]);
  const open = async (f: File, label: string) => {
    const idx = await showActionSheet({
      title: label,
      cancelLabel: t('common.cancel'),
      options: [{ label: t('mergeBackups.share') }, { label: t('storage.delete'), destructive: true }],
    });
    if (idx === 0) await share(f);
    else if (idx === 1) remove([f], t('mergeBackups.deleteTitle'), t('mergeBackups.deleteMsg', { name: label }));
  };

  return (
    <SettingsPage>
      <ScrollView contentContainerClassName="pb-8">
        <Text className="px-4 pt-4 text-xs text-gray-500 dark:text-gray-400">{t('mergeBackups.hint')}</Text>
        {files.length === 0 ? (
          <Text className="px-4 py-8 text-center text-sm text-gray-400">{t('mergeBackups.empty')}</Text>
        ) : (
          <>
            <Section title={t('mergeBackups.listTitle', { count: files.length })}>
              {files.map((f) => {
                const info = mergeBackupInfo(f.name);
                const when = info.at != null ? isoStamp(info.at).slice(0, 16) : '';
                return (
                  <LinkRow
                    key={f.name}
                    label={info.label}
                    description={when}
                    value={formatBytes(f.size ?? 0)}
                    onPress={() => void open(f, info.label)}
                  />
                );
              })}
            </Section>
            <View className="pt-2">
              <LinkRow
                label={t('mergeBackups.deleteAll')}
                destructive
                chevron={false}
                onPress={() =>
                  remove(files, t('mergeBackups.deleteAllTitle'), t('mergeBackups.deleteAllMsg', { count: files.length }))
                }
              />
            </View>
          </>
        )}
      </ScrollView>
    </SettingsPage>
  );
}
