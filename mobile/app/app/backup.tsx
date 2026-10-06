import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { shareThenDelete } from '~/lib/shareFile';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Switch } from '~/components/ui/Switch';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import {
  createBackup,
  createPhotoBackup,
  deleteSafetyBackup,
  hasRegionPacks,
  restoreBackup,
  restoreSafetyBackup,
} from '~/lib/backup';
import { listSafetyBackups } from '~/db';
import type { ExportFile } from '~/lib/bundleExport';

import {
  backupTooNew,
  driveErrorMessage,
  driveProgressLabel,
  listDriveBackups,
  restoreFromDrive,
  runDriveBackup,
  useDriveBackup,
  type DriveFile,
} from '~/lib/driveBackup';
import { formatBytes } from '~/lib/exportSize';
import { useDriveState } from '~/lib/driveState';
import { GoogleAuthCancelled, GoogleCodeExpired } from '~/lib/googleAuth';
import { runTask } from '~/stores/taskProgress';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';
import { AdvancedFold } from '~/components/AdvancedFold';
import { vis } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';

type Busy = null | 'backup' | 'photos' | 'restore' | 'drive' | 'cloudList' | 'cloudRestore';

/** Title of a cloud-backup row: falls back to the filename only when the
 *  creation time cannot be read. */
function cloudLabel(f: DriveFile): string {
  const ms = f.meta.createdAtMs ?? f.createdAtMs;
  return ms ? new Date(ms).toLocaleString() : f.name;
}

export default function BackupScreen() {
  const safetyVis = vis(useUsageMode(), 'backupSafety');
  const c = useThemeColors();
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState('');
  // Country checklist packs are re-downloadable GBIF data and stay out of the
  // backup by default; the switch only appears when a pack exists.
  const [includePacks, setIncludePacks] = useState(false);
  const [packsExist, setPacksExist] = useState(false);
  useEffect(() => setPacksExist(hasRegionPacks()), []);

  // Cloud backup state. lastUploadAtMs lives in an app-private file rather than
  // the settings table, so a device restored from another one correctly shows
  // "not backed up yet" instead of inheriting the other device's timestamp.
  const driveProgress = useDriveBackup((s) => s.progress);
  const lastUploadAtMs = useDriveState((s) => s.lastUploadAtMs);
  const loadDriveState = useDriveState((s) => s.load);
  // null = never listed (as opposed to "listed and empty", which is []).
  const [cloud, setCloud] = useState<DriveFile[] | null>(null);
  useEffect(() => {
    void loadDriveState();
  }, [loadDriveState]);

  // Automatic safety backups: snapshots cleanup.ts leaves before a repair that
  // would rewrite existing rows.
  // They are written to an app-private directory that DocumentPicker cannot see,
  // so this page has to offer the entry point — otherwise the backup exists but
  // cannot be restored, which is only half a feature.
  const [safety, setSafety] = useState<{ name: string; uri: string; size: number }[]>([]);
  const refreshSafety = useCallback(() => setSafety(listSafetyBackups()), []);
  useEffect(refreshSafety, [refreshSafety]);

  const handleRestoreSafety = (name: string) => {
    Alert.alert(
      t('backup.safetyRestoreConfirmTitle'),
      t('backup.safetyRestoreConfirmMsg', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('backup.restore'),
          style: 'destructive',
          onPress: async () => {
            try {
              setBusy('restore');
              await restoreSafetyBackup(name);
            } catch (e) {
              setBusy(null);
              Alert.alert(t('backup.restoreFailed'), errText(e));
            }
          },
        },
      ],
    );
  };

  const handleDeleteSafety = (name: string) => {
    Alert.alert(
      t('backup.safetyDeleteConfirmTitle'),
      t('backup.safetyDeleteConfirmMsg', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteSafetyBackup(name);
            refreshSafety();
          },
        },
      ],
    );
  };

  const share = async (file: ExportFile) => {
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert(t('backup.shareUnavailable'), t('backup.fileGenerated', { uri: file.uri }));
      return;
    }
    await shareThenDelete(file.uri, { mimeType: file.mimeType, dialogTitle: file.filename });
  };

  const handleBackup = async () => {
    if (busy) return;
    try {
      setBusy('backup');
      // The panel is a plain overlay: once it is gone the share sheet can open.
      const file = await runTask((report) => createBackup({ includePacks: packsExist && includePacks, report }));
      await share(file);
    } catch (e) {
      Alert.alert(t('backup.backupFailed'), errText(e));
    } finally {
      setBusy(null);
    }
  };

  const handlePhotoBackup = async () => {
    if (busy) return;
    try {
      setBusy('photos');
      setProgress('');
      const file = await createPhotoBackup((done, total) =>
        setProgress(t('backup.photoProgress', { done, total })),
      );
      if (!file) {
        Alert.alert(t('backup.noPhotos'), t('backup.noPhotosMsg'));
        return;
      }
      await share(file);
    } catch (e) {
      Alert.alert(t('backup.photoBackupFailed'), errText(e));
    } finally {
      setBusy(null);
      setProgress('');
    }
  };

  const handleDriveUpload = async () => {
    if (busy) return;
    try {
      setBusy('drive');
      // interactive: the user pressed a button and is watching, so an
      // unlinked account should open the code sheet rather than fail.
      const ran = await runDriveBackup({
        interactive: true,
        includePacks: packsExist && includePacks,
      });
      if (ran) toast(t('gdrive.uploadDone'));
    } catch (e) {
      // Backing out of the authorization sheet is a decision, not a failure.
      if (e instanceof GoogleAuthCancelled) return;
      const msg =
        e instanceof GoogleCodeExpired ? t('gdrive.codeExpired') : await driveErrorMessage(e);
      Alert.alert(t('gdrive.uploadFailed', { msg }));
    } finally {
      setBusy(null);
    }
  };

  const handleListCloud = async () => {
    if (busy) return;
    try {
      setBusy('cloudList');
      const files = await listDriveBackups({ interactive: true });
      setCloud(files);
    } catch (e) {
      if (e instanceof GoogleAuthCancelled) return;
      Alert.alert(t('gdrive.listFailed', { msg: await driveErrorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  const handleCloudRestore = async (f: DriveFile) => {
    if (busy) return;
    const confirm = await showActionSheet({
      title: t('backup.restoreTitle'),
      message: t('backup.restoreMsg'),
      options: [{ label: t('backup.restoreConfirm'), destructive: true }],
    });
    if (confirm !== 0) return;
    try {
      setBusy('cloudRestore');
      setProgress('');
      // On success this reloads the app, so control won't return here.
      await restoreFromDrive(f, (received, total) =>
        setProgress(
          t('gdrive.downloading', { pct: total ? Math.round((received / total) * 100) : 0 }),
        ),
      );
    } catch (e) {
      setBusy(null);
      setProgress('');
      Alert.alert(t('backup.restoreFailed'), await driveErrorMessage(e));
    }
  };

  const handleRestore = async () => {
    if (busy) return;
    try {
      const r = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'application/x-zip-compressed', '*/*'],
        copyToCacheDirectory: true,
      });
      if (r.canceled) return;
      const uri = r.assets[0]?.uri;
      if (!uri) return;

      const confirm = await showActionSheet({
        title: t('backup.restoreTitle'),
        message: t('backup.restoreMsg'),
        options: [{ label: t('backup.restoreConfirm'), destructive: true }],
      });
      if (confirm !== 0) return;

      setBusy('restore');
      // On success this reloads the app, so control won't return here.
      await runTask((report) => restoreBackup(uri, report));
    } catch (e) {
      setBusy(null);
      Alert.alert(t('backup.restoreFailed'), errText(e));
    }
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <ScrollView className="flex-1">
        <Section
          icon="archive-outline"
          title={t('backup.dataBackupTitle')}
          desc={t('backup.dataBackupDesc')}
        >
          {packsExist ? (
            <View className="mt-1 flex-row items-center justify-between py-1">
              <Text className="flex-1 pr-2 text-sm text-gray-700 dark:text-gray-300">
                {t('backup.includePacks')}
              </Text>
              <Switch value={includePacks} onValueChange={setIncludePacks} />
            </View>
          ) : null}
          <ActionButton
            label={t('backup.createExport')}
            onPress={handleBackup}
            busy={busy === 'backup'}
            disabled={busy !== null}
          />
        </Section>

        <Section
          icon="cloud-outline"
          title={t('gdrive.cloudBackupTitle')}
          desc={t('gdrive.cloudBackupDesc')}
        >
          <ActionButton
            label={t('gdrive.uploadNow')}
            onPress={handleDriveUpload}
            busy={busy === 'drive'}
            disabled={busy !== null}
          />
          <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {busy === 'drive' && driveProgress
              ? driveProgressLabel(driveProgress)
              : lastUploadAtMs
                ? t('gdrive.lastUpload', { date: new Date(lastUploadAtMs).toLocaleString() })
                : t('gdrive.neverUploaded')}
          </Text>
        </Section>

        <Section
          icon="images-outline"
          title={t('backup.photoBackupTitle')}
          desc={t('backup.photoBackupDesc')}
        >
          <ActionButton
            label={t('backup.exportPhotos')}
            onPress={handlePhotoBackup}
            busy={busy === 'photos'}
            disabled={busy !== null}
          />
          {busy === 'photos' && progress ? (
            <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t('backup.processing', { progress })}
            </Text>
          ) : null}
        </Section>

        <Section
          icon="cloud-upload-outline"
          title={t('backup.dataRestoreTitle')}
          desc={t('backup.dataRestoreDesc')}
        >
          <ActionButton
            label={t('backup.restoreFromFile')}
            onPress={handleRestore}
            busy={busy === 'restore'}
            disabled={busy !== null}
            destructive
          />
        </Section>

        <Section
          icon="cloud-download-outline"
          title={t('gdrive.cloudRestoreTitle')}
          desc={t('gdrive.cloudRestoreDesc')}
        >
          <ActionButton
            label={t('gdrive.listBackups')}
            onPress={handleListCloud}
            busy={busy === 'cloudList'}
            disabled={busy !== null}
          />
          {busy === 'cloudRestore' && progress ? (
            <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">{progress}</Text>
          ) : null}
          {cloud?.length === 0 ? (
            <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t('gdrive.listEmpty')}
            </Text>
          ) : null}
          {cloud?.map((f) => {
            const tooNew = backupTooNew(f);
            return (
              <View
                key={f.id}
                className="mt-2 flex-row items-center justify-between rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
              >
                <View className="flex-1 pr-2">
                  <Text className="text-sm text-gray-900 dark:text-gray-100" numberOfLines={1}>
                    {cloudLabel(f)}
                  </Text>
                  <Text className="text-xs text-gray-500 dark:text-gray-400">
                    {t('gdrive.backupMeta', {
                      size: f.sizeBytes != null ? formatBytes(f.sizeBytes) : '—',
                      appVersion: f.meta.appVersion ?? '—',
                    })}
                  </Text>
                </View>
                {/* A version newer than this build is blocked at the list level, so nobody
                   downloads tens of MB before finding out it cannot be read. */}
                {tooNew ? (
                  // A short label, not the whole backup.tooNew sentence — that one wraps to five
            // lines in a column 45% wide.
                  // The version is already in the row on the left, and restoreBackup blocks it
            // again if it is actually tapped.
                  <Text className="text-xs font-medium text-amber-600 dark:text-amber-500">
                    {t('gdrive.tooNewShort')}
                  </Text>
                ) : (
                  <Pressable
                    onPress={() => handleCloudRestore(f)}
                    disabled={busy !== null}
                    hitSlop={8}
                    className="active:opacity-60"
                  >
                    <Text className="text-sm font-medium text-accent-600 dark:text-accent-400">
                      {t('backup.restore')}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </Section>

        {safety.length > 0 && safetyVis !== 'hide' ? (
          <SafetyFold folded={safetyVis === 'adv'}>
          <Section
            icon="shield-checkmark-outline"
            title={t('backup.safetyTitle')}
            desc={t('backup.safetyDesc')}
          >
            {safety.map((f) => (
              <View
                key={f.name}
                className="mt-2 flex-row items-center justify-between rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
              >
                <View className="flex-1 pr-2">
                  <Text className="text-sm text-gray-900 dark:text-gray-100" numberOfLines={1}>
                    {f.name.replace(/^safety-backup-|\.db$/g, '')}
                  </Text>
                  <Text className="text-xs text-gray-500 dark:text-gray-400">
                    {(f.size / 1024).toFixed(0)} KB
                  </Text>
                </View>
                <Pressable
                  onPress={() => handleRestoreSafety(f.name)}
                  disabled={busy !== null}
                  hitSlop={8}
                  className="mr-3 active:opacity-60"
                >
                  <Text className="text-sm font-medium text-accent-600 dark:text-accent-400">
                    {t('backup.restore')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => handleDeleteSafety(f.name)}
                  disabled={busy !== null}
                  hitSlop={8}
                  className="active:opacity-60"
                >
                  <Ionicons name="trash-outline" size={18} color={c.alert} />
                </Pressable>
              </View>
            ))}
          </Section>
          </SafetyFold>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** 自動安全備份: in place in pro mode, under 進階 in the simpler ones. */
function SafetyFold({ folded, children }: { folded: boolean; children: React.ReactNode }) {
  return folded ? <AdvancedFold className="mx-4 mt-4">{children}</AdvancedFold> : <>{children}</>;
}

function Section({
  icon,
  title,
  desc,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <View className="mt-3 border-y border-gray-200 bg-card px-4 py-4 dark:border-gray-700 dark:bg-gray-900">
      <View className="flex-row items-center">
        <Ionicons name={icon} size={20} color="#4b5563" />
        <Text className="ml-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </Text>
      </View>
      <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">{desc}</Text>
      <View className="mt-3">{children}</View>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  busy,
  disabled,
  destructive,
}: {
  label: string;
  onPress: () => void;
  busy: boolean;
  disabled: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      label={label}
      onPress={onPress}
      variant={destructive ? 'danger' : 'primary'}
      disabled={disabled && !busy}
      loading={busy}
      size="lg"
      fullWidth
    />
  );
}
