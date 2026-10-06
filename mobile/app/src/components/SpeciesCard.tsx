import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { parsePhotoPaths, type RecordWithTaxon } from '~/db';
import { alienBadge } from '~/lib/conservationColors';
import { formatQuantityBadge } from '~/lib/dwcAbundance';
import { ScientificName } from './ScientificName';
import { SynonymStatusBadge } from './CollapsibleSection';
import { Tag } from './ui/Tag';
import { rebaseAppFileUri } from '~/lib/appFiles';
import { familyChineseFirst } from '~/lib/familyLabel';
import { useThemeColors } from '~/theme/colors';
import { CountStepper } from './ui/CountStepper';
import { SelectMark } from '~/components/ui/SelectMark';
import { KINGDOM_ICON } from '~/components/casual/kingdomIcon';
import type { PendingKingdom } from '~/db';

/** A row's photo: the full row height, this wide. */
const ROW_PHOTO_WIDTH = 84;

type Props = {
  record: RecordWithTaxon;
  onPress: () => void;
  onLongPress?: () => void;
  /** Select mode shows a checkbox in front of the row. */
  selectMode?: boolean;
  picked?: boolean;
  /** Just added: the row lights up and fades back, so a species added from
   *  the search box can be found in the list. */
  flash?: boolean;
  /** Given (and the record counts individuals, or nothing yet): the row ends
   *  in − n ＋. Omit on a locked record. Other abundance types stay a
   *  read-only figure; the detail sheet edits them. */
  onCountChange?: (next: number | null) => void;
  /** A survey's own marks after the family (recheck phase, made only as an interaction's other side). */
  meta?: string;
  /** A blind occurrence sealed once its survey's blind phase closed: a lock at the end. */
  sealed?: boolean;
  /** Something to fix, in the alert colour after the name (a survey occurrence's 必填未填, 2G-e). */
  alert?: string;
};

export function SpeciesCard({ record, onPress, onLongPress, selectMode, picked, flash, onCountChange, meta, sealed, alert }: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const isEndemic = record.is_endemic === 'true';
  const ab = alienBadge(record.alien_type, record.kingdom);
  const photos = parsePhotoPaths(record.photo_paths);
  // Already on iNaturalist → tinted row (see migrations.ts v30).
  const uploaded = record.inat_uploaded_at != null;

  const glow = useSharedValue(0);
  useEffect(() => {
    if (!flash) return;
    glow.value = 1;
    glow.value = withTiming(0, { duration: 1000 });
  }, [flash, glow]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      className={`flex-row border-b border-gray-100 px-4 py-3 dark:border-gray-800 ${uploaded ? 'bg-accent-50 active:bg-accent-100 dark:bg-accent-950 dark:active:bg-accent-900' : 'bg-paper active:bg-gray-100 dark:bg-paper-dark dark:active:bg-gray-800'}`}
    >
      <Animated.View
        pointerEvents="none"
        className="absolute inset-0 bg-accent-50 dark:bg-accent-950"
        style={glowStyle}
      />
      {selectMode && photos.length === 0 ? (
        <View style={{ marginRight: 10, alignSelf: 'center' }}><SelectMark state={picked ? 'on' : 'off'} /></View>
      ) : null}
      {/* No photo, no placeholder: an empty square cost every row 56 pt of
          width for nothing. A photo runs the row's full height from its left
          edge (the negative margins undo the row's padding); in select mode the
          mark sits on it, in the same column as on rows without one. */}
      {photos.length > 0 ? (
        <View
          className="-my-3 -ml-4 mr-3 overflow-hidden bg-gray-100 dark:bg-gray-800"
          style={{ width: ROW_PHOTO_WIDTH, alignSelf: 'stretch' }}
        >
          <Image
            source={{ uri: rebaseAppFileUri(photos[0]) }}
            // Absolute: the text sets the row's height, not the picture's own size.
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
            contentFit="cover"
          />
          {photos.length > 1 ? (
            <View
              className="absolute bottom-0 right-0 flex-row items-center rounded-tl-md bg-black/60 px-1 py-0.5"
            >
              <Text className="text-[10px] font-semibold text-white">×{photos.length}</Text>
            </View>
          ) : null}
          {selectMode ? (
            <View className="absolute inset-0 justify-center bg-black/20 pl-4">
              <SelectMark state={picked ? 'on' : 'off'} />
            </View>
          ) : null}
        </View>
      ) : null}
      <View className="flex-1">
        <View className="flex-row flex-wrap items-center" style={{ columnGap: 6, rowGap: 2 }}>
          <Text className="flex-shrink text-base font-medium text-gray-900 dark:text-gray-100" numberOfLines={1}>
            {record.common_name_c || t('species.noChineseName')}
            {/* The field determination, when it is finer than the taxon can be
                (v39). Two rows sharing a family's taxon_id are two morphospecies
                and this is the only thing that tells them apart — so it belongs
                on the name line, not hidden in the notes. */}
            {record.verbatim_identification ? (
              <Text className="font-normal text-gray-500 dark:text-gray-400">
                {` · ${record.verbatim_identification}`}
              </Text>
            ) : null}
          </Text>
          {isEndemic ? <Tag kind="endemic" label={t('species.endemicShort')} /> : null}
          {ab ? <Tag kind={ab.kind} label={ab.shortLabel} /> : null}
          {record.protected ? <Tag kind="protected" label={record.protected} /> : null}
          {record.redlist ? <Tag kind="iucn" iucnCode={record.redlist} /> : null}
          {alert ? <Tag kind="alert" label={alert} /> : null}
        </View>
        <View className="mt-0.5 flex-row items-center">
          <ScientificName
            name={record.simple_name}
            rank={record.rank}
            author={record.name_author}
            kingdom={record.kingdom}
            className="flex-shrink text-sci text-gray-800 dark:text-gray-200"
            numberOfLines={1}
          />
          {/* This record was filed under a name the checklist does not treat as
              accepted — without the badge the name looks like a data error
              rather than the recorder's decision. */}
          {record.used_status && record.used_status !== 'accepted' ? (
            <SynonymStatusBadge status={record.used_status} />
          ) : null}
        </View>
        <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {[familyChineseFirst(record.family, record.family_c), meta].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {/* The count is why it was recorded, so it belongs where the list is
          scanned rather than only inside the detail sheet. */}
      {onCountChange &&
      !selectMode &&
      (record.organism_quantity_type == null || record.organism_quantity_type === 'individuals') ? (
        <View className="ml-2 justify-center">
          <CountStepper
            value={Number.isFinite(Number(record.organism_quantity)) && record.organism_quantity ? Number(record.organism_quantity) : null}
            onChange={onCountChange}
            accessibilityName={record.common_name_c || record.simple_name}
          />
        </View>
      ) : record.organism_quantity ? (
        <View className="ml-2 justify-center">
          <Text className="text-base font-bold tabular-nums text-gray-800 dark:text-gray-200">
            {formatQuantityBadge(record.organism_quantity, record.organism_quantity_type)}
          </Text>
        </View>
      ) : null}
      {sealed ? (
        <View className="ml-2 justify-center">
          <Ionicons name="lock-closed" size={14} color={c.ink3} accessibilityLabel={t('surveyForm.err.blindSealed')} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** The count stepper's value, or null when there is none to show. */
const countOf = (record: RecordWithTaxon) =>
  Number.isFinite(Number(record.organism_quantity)) && record.organism_quantity ? Number(record.organism_quantity) : null;
const countsIndividuals = (record: RecordWithTaxon) =>
  record.organism_quantity_type == null || record.organism_quantity_type === 'individuals';

/**
 * Card view of the same record (species_layout = card): a square photo — or
 * the kingdom's icon — then the names, family and count. Tags, select mark,
 * flash and a survey's marks (meta, sealed, alert) as on the row; the swipe
 * actions stay with the row view.
 */
export function SpeciesTile({
  record,
  onPress,
  onLongPress,
  selectMode,
  picked,
  flash,
  onCountChange,
  meta,
  sealed,
  alert,
  width,
}: Props & { width: number }) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const isEndemic = record.is_endemic === 'true';
  const ab = alienBadge(record.alien_type, record.kingdom);
  const photos = parsePhotoPaths(record.photo_paths);
  const uploaded = record.inat_uploaded_at != null;
  const stepper = onCountChange && !selectMode && countsIndividuals(record);

  const glow = useSharedValue(0);
  useEffect(() => {
    if (!flash) return;
    glow.value = 1;
    glow.value = withTiming(0, { duration: 1000 });
  }, [flash, glow]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={{ width }}
      className={`overflow-hidden rounded-card border border-line dark:border-line-dark ${uploaded ? 'bg-accent-50 active:bg-accent-100 dark:bg-accent-950 dark:active:bg-accent-900' : 'bg-card active:bg-gray-100 dark:bg-card-dark dark:active:bg-gray-800'}`}
    >
      {/* Behind the content, as on the row: lights the name area when just added. */}
      <Animated.View pointerEvents="none" className="absolute inset-0 bg-accent-50 dark:bg-accent-950" style={glowStyle} />
      <View
        className="items-center justify-center bg-accent-tint dark:bg-accent-950/40"
        style={{ width: '100%', aspectRatio: 1 }}
      >
        {photos.length > 0 ? (
          <Image source={{ uri: rebaseAppFileUri(photos[0]) }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
        ) : (
          <Ionicons name={KINGDOM_ICON[record.kingdom as PendingKingdom] ?? 'leaf-outline'} size={40} color={c.accent} />
        )}
        {photos.length > 1 ? (
          <View className="absolute bottom-0 right-0 rounded-tl-md bg-black/60 px-1.5 py-0.5">
            <Text className="text-[11px] font-semibold text-white">×{photos.length}</Text>
          </View>
        ) : null}
        {selectMode ? (
          <View className="absolute left-2 top-2">
            <SelectMark state={picked ? 'on' : 'off'} />
          </View>
        ) : null}
        {sealed ? (
          <View className="absolute bottom-2 left-2 h-7 w-7 items-center justify-center rounded-full bg-card dark:bg-card-dark">
            <Ionicons name="lock-closed" size={14} color={c.ink3} accessibilityLabel={t('surveyForm.err.blindSealed')} />
          </View>
        ) : null}
        {!stepper && record.organism_quantity ? (
          <View className="absolute right-2 top-2 rounded-full bg-card px-2 py-0.5 dark:bg-card-dark">
            <Text className="text-sm font-bold tabular-nums text-gray-900 dark:text-gray-100">
              {formatQuantityBadge(record.organism_quantity, record.organism_quantity_type)}
            </Text>
          </View>
        ) : null}
      </View>
      <View className="px-2.5 pb-2.5 pt-2">
        <Text className="text-[15px] font-medium text-gray-900 dark:text-gray-100" numberOfLines={1}>
          {record.common_name_c || t('species.noChineseName')}
        </Text>
        <ScientificName
          name={record.simple_name}
          rank={record.rank}
          kingdom={record.kingdom}
          className="text-xs text-gray-800 dark:text-gray-200"
          numberOfLines={1}
        />
        <Text className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {[familyChineseFirst(record.family, record.family_c), meta].filter(Boolean).join(' · ')}
        </Text>
        {isEndemic || ab || record.protected || record.redlist || alert ? (
          <View className="mt-1 flex-row flex-wrap" style={{ columnGap: 4, rowGap: 2 }}>
            {isEndemic ? <Tag kind="endemic" label={t('species.endemicShort')} /> : null}
            {ab ? <Tag kind={ab.kind} label={ab.shortLabel} /> : null}
            {record.protected ? <Tag kind="protected" label={record.protected} /> : null}
            {record.redlist ? <Tag kind="iucn" iucnCode={record.redlist} /> : null}
            {alert ? <Tag kind="alert" label={alert} /> : null}
          </View>
        ) : null}
        {stepper ? (
          <View className="mt-2 items-center">
            <CountStepper
              value={countOf(record)}
              onChange={onCountChange}
              accessibilityName={record.common_name_c || record.simple_name}
            />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
