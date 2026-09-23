/**
 * Import field photos as records — one record per photo.
 *
 * Deliberately NOT a third mode of BatchImportModal. That one exists to resolve
 * NAMES: it has exact / ambiguous / unmatched buckets, per-row radio pickers and
 * a GBIF fallback. Here there is no name to resolve. A photo either says what it
 * is (this app wrote a taxon_id into its EXIF) or it does not, and everything in
 * the second group takes one species the user picks once. Two states, one
 * answer — folding that into a 580-line modal built for a different question
 * would cost more than it saved.
 *
 * Reading EXIF is I/O per photo, so it runs while the sheet is open with a
 * progress bar, and yields to the UI thread between photos.
 */
import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SearchResult } from '~/db';
import { readPhotoMeta } from '~/lib/photoMeta';
import {
  buildPlannedRecords,
  planPhotoImport,
  type MissingCoordPolicy,
  type PhotoPlan,
  type PlannedRecord,
} from '~/lib/photoImport';
import type { PickedPhoto } from '~/lib/photoCapture';
import { runOverModal } from './GbifLookupHost';
import { SearchBox } from './SearchBox';
import { showActionSheet } from './ActionSheet';

type Props = {
  /** The photos the user picked, with whatever EXIF the picker gave us. */
  picked: PickedPhoto[];
  onCancel: () => void;
  /** Rows to write. Already oldest-first. */
  onConfirm: (rows: PlannedRecord[]) => void;
};

export function PhotoImportModal({ picked, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [plan, setPlan] = useState<PhotoPlan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [taxon, setTaxon] = useState<SearchResult | null>(null);
  const [policy, setPolicy] = useState<MissingCoordPolicy>({ kind: 'leave-empty' });
  // True while a root-hosted lookup is up — see runOverModal.
  const [steppedAside, setSteppedAside] = useState(false);

  // Read every photo's EXIF once, when the sheet opens. In an effect, not
  // during render: the read is I/O and setting state mid-render is what makes
  // React Compiler bail out of the component (and loops in dev).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setProgress({ done: 0, total: picked.length });
      const read: { uri: string; meta: Awaited<ReturnType<typeof readPhotoMeta>> }[] = [];
      for (let i = 0; i < picked.length; i++) {
        const p = picked[i];
        const meta = await readPhotoMeta(p.uri, p.exif);
        if (cancelled) return;
        read.push({ uri: p.uri, meta });
        setProgress({ done: i + 1, total: picked.length });
      }
      setPlan(planPhotoImport(read));
      setProgress(null);
    })();
    // Closing mid-read must not land state on an unmounted sheet.
    return () => {
      cancelled = true;
    };
  }, [picked]);

  const needsTaxon = plan?.needsTaxonCount ?? 0;
  const rows =
    plan === null ? [] : buildPlannedRecords(plan, taxon?.taxon_id ?? null, policy, Date.now());
  const canConfirm = rows.length > 0 && progress === null;

  const pickPolicy = async () => {
    const idx = await showActionSheet({
      title: t('photoImport.noCoordTitle'),
      message: t('photoImport.noCoordHint'),
      cancelLabel: t('common.cancel'),
      options: [{ label: t('photoImport.leaveEmpty') }, { label: t('photoImport.useCurrent') }],
    });
    if (idx === 0) {
      setPolicy({ kind: 'leave-empty' });
      return;
    }
    if (idx !== 1) return;
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
      return;
    }
    // Nothing conditional inside the try/catch: React Compiler cannot lower a
    // value block there and bails out of the whole component (`??` and a
    // ternary in here is what did it the first time).
    let pos: Location.LocationObject;
    try {
      pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
      return;
    }
    // The measured accuracy rides along: this position is honest about being a
    // fix taken now, not the one the photo was taken at.
    setPolicy({
      kind: 'fixed',
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracyM: pos.coords.accuracy ?? null,
    });
  };

  const policyLabel =
    policy.kind === 'leave-empty'
      ? t('photoImport.leaveEmpty')
      : `${policy.lat.toFixed(4)}, ${policy.lng.toFixed(4)}`;

  return (
    <Modal visible={!steppedAside} animationType="slide" onRequestClose={onCancel}>
      <View
        className="flex-1 bg-white dark:bg-gray-900"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <Pressable onPress={onCancel} hitSlop={8} disabled={progress !== null}>
            <Text className="text-base text-gray-700 dark:text-gray-300">{t('common.cancel')}</Text>
          </Pressable>
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('photoImport.title')}
          </Text>
          <Pressable onPress={() => onConfirm(rows)} hitSlop={8} disabled={!canConfirm}>
            <Text
              className={`text-base font-semibold ${
                canConfirm ? 'text-blue-600 dark:text-blue-400' : 'text-gray-300 dark:text-gray-600'
              }`}
            >
              {t('photoImport.add', { count: rows.length })}
            </Text>
          </Pressable>
        </View>

        {plan ? (
          <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
            <View className="border-b border-gray-100 px-4 py-2 dark:border-gray-800">
              <Text className="text-xs text-gray-500 dark:text-gray-400">
                {t('photoImport.summary', {
                  resolved: plan.resolvedCount,
                  pending: plan.needsTaxonCount,
                })}
              </Text>
            </View>

            {/* One species for the whole batch. Photos this app exported ignore
                it — they already know what they are. */}
            {needsTaxon > 0 ? (
              <View className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
                <Text className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t('photoImport.speciesFor', { count: needsTaxon })}
                </Text>
                {taxon ? (
                  <Pressable
                    onPress={() => setTaxon(null)}
                    className="flex-row items-center rounded-lg border border-gray-200 px-3 py-2 active:opacity-70 dark:border-gray-700"
                  >
                    <Ionicons name="leaf-outline" size={16} color="#059669" />
                    <Text className="ml-2 flex-1 text-sm text-gray-900 dark:text-gray-100">
                      {taxon.cname || taxon.name}
                    </Text>
                    <Ionicons name="close-circle" size={18} color="#9ca3af" />
                  </Pressable>
                ) : (
                  <SearchBox
                    layout="dropdown"
                    afterSelect="dismiss"
                    onSelect={(result) => setTaxon(result)}
                    runLookup={(run) => runOverModal(setSteppedAside, run)}
                  />
                )}
              </View>
            ) : null}

            {plan.withoutCoords > 0 ? (
              <Pressable
                onPress={pickPolicy}
                className="flex-row items-center border-b border-gray-100 px-4 py-3 active:opacity-70 dark:border-gray-800"
              >
                <Ionicons name="location-outline" size={16} color="#6b7280" />
                <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">
                  {t('photoImport.noCoordCount', { count: plan.withoutCoords })}
                </Text>
                <Text className="text-sm text-gray-500 dark:text-gray-400">{policyLabel}</Text>
                <Ionicons name="chevron-forward" size={14} color="#9ca3af" />
              </Pressable>
            ) : null}

            <View className="flex-row flex-wrap gap-2 p-4">
              {plan.items.map((item) => (
                <View key={item.uri} className="relative">
                  <Image
                    source={{ uri: item.uri }}
                    style={{ width: 96, height: 96, borderRadius: 8 }}
                    contentFit="cover"
                  />
                  <View className="absolute bottom-1 left-1 flex-row gap-1">
                    {item.embeddedTaxonId ? (
                      <Badge icon="pricetag" tone="emerald" />
                    ) : null}
                    {item.hasCoords ? <Badge icon="location" tone="blue" /> : null}
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <View className="flex-1 items-center justify-center px-10">
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
              {t('photoImport.reading')}
            </Text>
            {progress ? (
              <>
                <View className="mt-4 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                  <View
                    className="h-2 rounded-full bg-blue-500"
                    style={{
                      width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                    }}
                  />
                </View>
                <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {progress.done} / {progress.total}
                </Text>
              </>
            ) : null}
          </View>
        )}
      </View>
    </Modal>
  );
}

/** A thumbnail corner marker. Icon only — there is no room for a word, and the
 *  legend is the summary line above the grid. */
function Badge({ icon, tone }: { icon: 'pricetag' | 'location'; tone: 'emerald' | 'blue' }) {
  return (
    <View
      className={`h-5 w-5 items-center justify-center rounded-full ${
        tone === 'emerald' ? 'bg-emerald-600' : 'bg-blue-600'
      }`}
    >
      <Ionicons name={icon} size={11} color="white" />
    </View>
  );
}
