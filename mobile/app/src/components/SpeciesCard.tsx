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
import { useThemeColors } from '~/theme/colors';

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
};

export function SpeciesCard({ record, onPress, onLongPress, selectMode, picked, flash }: Props) {
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
      {selectMode ? (
        <Ionicons
          name={picked ? 'checkbox' : 'square-outline'}
          size={20}
          color={picked ? c.accent : c.ink3}
          style={{ marginRight: 10, alignSelf: 'center' }}
        />
      ) : null}
      {/* No photo, no placeholder: an empty square cost every row 56 pt of
          width for nothing. */}
      {photos.length > 0 ? (
        <View className="mr-3 h-12 w-12 overflow-hidden rounded-[10px] bg-gray-100 dark:bg-gray-800">
          <Image
            source={{ uri: rebaseAppFileUri(photos[0]) }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
          />
          {photos.length > 1 ? (
            <View
              className="absolute bottom-0 right-0 flex-row items-center rounded-tl-md bg-black/60 px-1 py-0.5"
            >
              <Text className="text-[10px] font-semibold text-white">×{photos.length}</Text>
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
          {record.family_c} {record.family}
        </Text>
      </View>
      {/* The count is why it was recorded, so it belongs where the list is
          scanned rather than only inside the detail sheet. (Phase 4 turns this
          into a stepper for plain individual counts.) */}
      {record.organism_quantity ? (
        <View className="ml-2 justify-center">
          <Text className="text-base font-bold tabular-nums text-gray-800 dark:text-gray-200">
            {formatQuantityBadge(record.organism_quantity, record.organism_quantity_type)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
