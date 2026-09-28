import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSite, listProjects, type Project } from '~/db';

import {
  detectFormat,
  parseGeoFile,
  type GeoFormat,
  type ImportedGeometry,
} from '~/lib/geoConverters';
import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';

type Props = {
  visible: boolean;
  defaultProjectId?: number;
  onClose: () => void;
  onCommitted: (count: number) => void;
};

const FORMAT_LABEL: Record<GeoFormat, string> = {
  geojson: 'GeoJSON',
  kml: 'KML',
  gpx: 'GPX',
  wkt: 'WKT',
};

/** Geometries listed per file in the preview; the rest are summarised. */
const PREVIEW_PER_FILE = 20;

/** One picked file that yielded at least one geometry. */
type PickedFile = {
  /** Original filename including extension — the preview group header. */
  filename: string;
  /** Filename without its extension; the per-file default name prefix. */
  base: string;
  format: GeoFormat;
  geoms: ImportedGeometry[];
};

/** A picked file that yielded nothing, kept so the user is told which. */
type SkippedFile = { filename: string; reason: string };

/** A single geometry to create, carrying where it came from. */
type Entry = {
  geom: ImportedGeometry;
  /** Name prefix in force for this geometry's file. */
  base: string;
  indexInFile: number;
  countInFile: number;
};

/**
 * The name for a geometry whose source file supplied none.
 *
 * Numbering restarts per file, so two files each holding one shape keep their
 * own names instead of colliding on a shared "#1".
 */
function fallbackName(base: string, indexInFile: number, countInFile: number): string {
  if (!base) return '';
  return countInFile === 1 ? base : `${base} #${indexInFile + 1}`;
}

export function GeoImportModal({ visible, defaultProjectId = 0, onClose, onCommitted }: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number>(defaultProjectId);
  const [namePrefix, setNamePrefix] = useState('');

  // With one file the editable prefix drives every name, exactly as before the
  // picker went multi-select. With several, each file names its own shapes —
  // one shared prefix across files would just reintroduce the collision.
  const singleFile = files.length === 1;
  const entries: Entry[] = files.flatMap((f) =>
    f.geoms.map((geom, i) => ({
      geom,
      base: singleFile ? namePrefix : f.base,
      indexInFile: i,
      countInFile: f.geoms.length,
    })),
  );

  const reset = () => {
    setFiles([]);
    setSkipped([]);
    setNamePrefix('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handlePickFile = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (r.canceled) return;
      const assets = r.assets ?? [];
      if (assets.length === 0) return;

      const accepted: PickedFile[] = [];
      const rejected: SkippedFile[] = [];
      for (const asset of assets) {
        if (!asset?.uri) continue;
        try {
          const text = await new File(asset.uri).text();
          const detected = detectFormat(text, asset.name);
          if (!detected) {
            rejected.push({ filename: asset.name, reason: t('geoImport.badFormat') });
            continue;
          }
          const parsed = parseGeoFile(text, detected);
          if (parsed.length === 0) {
            rejected.push({ filename: asset.name, reason: t('geoImport.parseFail') });
            continue;
          }
          accepted.push({
            filename: asset.name,
            base: asset.name.replace(/\.[^.]+$/, ''),
            format: detected,
            geoms: parsed,
          });
        } catch {
          // One unreadable file must not abort the whole batch.
          rejected.push({ filename: asset.name, reason: t('geoImport.readFail') });
        }
      }

      // Append: a batch often has to be gathered from more than one folder,
      // and every file can be dropped again individually from the preview.
      const next = [...files, ...accepted];
      setFiles(next);
      setSkipped(rejected);
      if (next.length === 1) setNamePrefix(next[0].base);
      if (accepted.length > 0) setProjects(listProjects());
      if (accepted.length === 0 && next.length === 0) {
        Alert.alert(t('geoImport.parseFail'), t('geoImport.noneUsable'));
      }
    } catch (e) {
      Alert.alert(t('geoImport.readFail'), errText(e));
    }
  };

  const removeFile = (index: number) => {
    const next = files.filter((_, i) => i !== index);
    setFiles(next);
    if (next.length === 1) setNamePrefix(next[0].base);
  };

  const handleCommit = () => {
    if (entries.length === 0) return;
    let added = 0;
    entries.forEach((e, i) => {
      const name =
        e.geom.name?.trim() ||
        fallbackName(e.base, e.indexInFile, e.countInFile) ||
        t('geoImport.importN', { n: i + 1 });
      try {
        createSite({
          project_id: projectId,
          name,
          geometry: e.geom.geometry,
          notes: e.geom.notes ?? null,
        });
        added++;
      } catch (err) {
        // skip invalid geometries silently; surface count
        console.warn('skip', name, err);
      }
    });
    onCommitted(added);
    if (added < entries.length) {
      // Close only once the Alert is dismissed: presenting it and dismissing
      // this Modal in the same tick can take the Alert down with the Modal.
      Alert.alert(
        t('geoImport.partial'),
        t('geoImport.partialMsg', {
          total: t('geoImport.nTotal', { count: entries.length }),
          added: t('geoImport.nSucceeded', { count: added }),
        }),
        [{ text: t('common.ok'), onPress: handleClose }],
        { onDismiss: handleClose },
      );
      return;
    }
    handleClose();
  };

  const currentProject = projects.find((p) => p.id === projectId);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View
        className="flex-1 bg-card dark:bg-gray-900"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <Pressable onPress={handleClose} hitSlop={8}>
            <Text className="text-base text-gray-700 dark:text-gray-300">{t('common.cancel')}</Text>
          </Pressable>
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('geoImport.title')}
          </Text>
          <Pressable onPress={handleCommit} hitSlop={8} disabled={entries.length === 0}>
            <Text
              className={`text-base font-semibold ${entries.length === 0 ? 'text-gray-300' : 'text-accent-600 dark:text-accent-400'}`}
            >
              {t('geoImport.create', { n: entries.length || '' })}
            </Text>
          </Pressable>
        </View>

        <ScrollView className="flex-1">
          {files.length === 0 ? (
            <View className="items-center px-6 py-12">
              <Ionicons name="cloud-upload-outline" size={56} color={c.ink3} />
              <Text className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
                {t('geoImport.supportHint')}
                {'\n'}
                {t('geoImport.multiFileHint')}
                {'\n'}
                {t('geoImport.multiHint')}
              </Text>
              <Button
                label={t('geoImport.pickFile')}
                icon="folder-open-outline"
                onPress={handlePickFile}
                className="mt-6"
              />
              {skipped.length > 0 ? <SkippedBlock skipped={skipped} /> : null}
            </View>
          ) : (
            <>
              <View className="border-b border-gray-100 bg-accent-50 px-4 py-3 dark:border-gray-800 dark:bg-accent-950/40">
                <Text className="text-sm text-accent-900 dark:text-accent-100">
                  <Text className="font-bold">
                    {singleFile
                      ? files[0].filename
                      : t('geoImport.nFiles', { count: files.length })}
                  </Text>
                  {singleFile ? `（${FORMAT_LABEL[files[0].format]}）` : ''}
                </Text>
                <Text className="mt-1 text-xs text-accent-800">
                  {t('geoImport.geomSummary', { count: entries.length })}
                </Text>
              </View>

              {skipped.length > 0 ? <SkippedBlock skipped={skipped} /> : null}

              {singleFile ? (
                <Field label={t('geoImport.namePrefix')}>
                  <TextInput
                    value={namePrefix}
                    onChangeText={setNamePrefix}
                    className="rounded border border-gray-300 px-3 py-2 text-base text-gray-900 dark:border-gray-600 dark:text-gray-100"
                    placeholder={t('geoImport.namePrefixEx')}
                    placeholderTextColor={c.ink3}
                  />
                  <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('geoImport.namePrefixHint')}
                  </Text>
                </Field>
              ) : (
                <Field label={t('geoImport.namePrefix')}>
                  <Text className="text-xs text-gray-500 dark:text-gray-400">
                    {t('geoImport.perFileNameHint')}
                  </Text>
                </Field>
              )}

              <Field label={t('plot.project')}>
                <View className="flex-row flex-wrap gap-2">
                  {projects.map((p) => {
                    const active = p.id === projectId;
                    return (
                      <Pressable
                        key={p.id}
                        onPress={() => setProjectId(p.id)}
                        className={`rounded-full border px-3 py-1.5 ${active ? 'border-accent-500 bg-accent-50 dark:bg-accent-950/40' : 'border-gray-300 bg-card dark:border-gray-600 dark:bg-gray-900'}`}
                      >
                        <Text
                          className={`text-xs ${active ? 'font-semibold text-accent-700 dark:text-accent-300' : 'text-gray-700 dark:text-gray-300'} ${p.id === 0 ? 'italic' : ''}`}
                        >
                          {p.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </Field>

              <View className="px-4 py-3">
                <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('geoImport.geomPreview')}
                </Text>
                {files.map((f, fi) => {
                  const base = singleFile ? namePrefix : f.base;
                  return (
                    <View key={`${f.filename}-${fi}`} className="mb-3">
                      {singleFile ? null : (
                        <View className="mb-1 flex-row items-center justify-between">
                          <Text
                            className="flex-1 text-xs font-semibold text-gray-700 dark:text-gray-300"
                            numberOfLines={1}
                          >
                            {f.filename}（{FORMAT_LABEL[f.format]}·{f.geoms.length}）
                          </Text>
                          <Pressable onPress={() => removeFile(fi)} hitSlop={8} className="ml-2">
                            <Ionicons name="close-circle" size={18} color={c.ink3} />
                          </Pressable>
                        </View>
                      )}
                      {f.geoms.slice(0, PREVIEW_PER_FILE).map((item, i) => (
                        <View
                          key={i}
                          className="border-b border-gray-100 py-2 dark:border-gray-800"
                        >
                          <Text className="text-sm text-gray-900 dark:text-gray-100">
                            {item.name ||
                              fallbackName(base, i, f.geoms.length) ||
                              `${t('geoImport.defaultPrefix')} #${i + 1}`}
                          </Text>
                          <Text className="text-xs text-gray-500 dark:text-gray-400">
                            {item.geometry.type}
                          </Text>
                        </View>
                      ))}
                      {f.geoms.length > PREVIEW_PER_FILE ? (
                        <Text className="mt-2 text-xs italic text-gray-500 dark:text-gray-400">
                          {t('geoImport.moreNotListed', {
                            count: f.geoms.length - PREVIEW_PER_FILE,
                          })}
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>

              <View className="px-4 py-3">
                <Pressable
                  onPress={handlePickFile}
                  className="flex-row items-center self-start rounded-full bg-gray-100 px-3 py-1.5 active:bg-gray-200 dark:bg-gray-800 dark:active:bg-gray-700"
                >
                  <Ionicons name="folder-open-outline" size={14} color={c.ink} />
                  <Text className="ml-1 text-xs font-medium text-gray-700 dark:text-gray-300">
                    {t('geoImport.addMoreFiles')}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>

        {currentProject ? (
          <View className="border-t border-gray-100 px-4 py-2 dark:border-gray-800">
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              {t('geoImport.targetProject')}
              <Text className="font-medium text-gray-700 dark:text-gray-300">
                {currentProject.name}
              </Text>
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function SkippedBlock({ skipped }: { skipped: SkippedFile[] }) {
  const { t } = useTranslation();
  return (
    <View className="border-b border-amber-100 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/40">
      <Text className="text-xs font-semibold text-amber-900 dark:text-amber-200">
        {t('geoImport.skipped', { count: skipped.length })}
      </Text>
      {skipped.map((s, i) => (
        <Text key={i} className="mt-1 text-xs text-amber-800 dark:text-amber-300" numberOfLines={2}>
          {s.filename} — {s.reason}
        </Text>
      ))}
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
      <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </Text>
      {children}
    </View>
  );
}
