/**
 * A fixed plot's species list, row by row (moved out of PlotSpeciesTab for
 * 2G, so a plot-style survey built from a template draws the same rows): the
 * species row with its value badge (count ± in place), and the layer chip.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import type { PlotSpeciesRecordWithTaxon } from '~/db';
import { alienBadge } from '~/lib/conservationColors';
import { formatQuantityBadge, kindForType, parseDbhArray } from '~/lib/dwcAbundance';
import { ScientificName } from '~/components/ScientificName';
import { TaxonomyJumpChip } from '~/components/TaxonomyJumpChip';
import { SelectMark } from '~/components/ui/SelectMark';

/** What a row reads of a record: a plot species row, or a survey occurrence shaped like one. */
export type PlotRowRecord = Pick<
  PlotSpeciesRecordWithTaxon,
  | 'alien_type'
  | 'kingdom'
  | 'phylum'
  | 'class'
  | 'order'
  | 'family'
  | 'family_c'
  | 'inat_uploaded_at'
  | 'common_name_c'
  | 'verbatim_identification'
  | 'is_endemic'
  | 'is_hybrid'
  | 'simple_name'
  | 'rank'
  | 'name_author'
  | 'notes'
  | 'organism_quantity'
  | 'organism_quantity_type'
>;

export function PlotSpeciesRow({
  record,
  onPress,
  onLongPress,
  onAdjust,
  selectMode,
  picked,
  alert,
}: {
  record: PlotRowRecord;
  onPress: () => void;
  onLongPress: () => void;
  onAdjust?: (delta: number) => void;
  selectMode: boolean;
  picked: boolean;
  /** Something to fix, in the alert colour after the name (a survey occurrence's 必填未填, 2G-e). */
  alert?: string;
}) {
  const { t: tr } = useTranslation();
  const ab = alienBadge(record.alien_type, record.kingdom);
  // Already on iNaturalist → tinted row (see migrations.ts v30).
  const uploaded = record.inat_uploaded_at != null;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      className={`flex-row items-start border-b border-gray-100 px-4 py-3 dark:border-gray-800 ${uploaded ? 'bg-lime-50 active:bg-lime-100 dark:bg-lime-900/30 dark:active:bg-lime-900/50' : 'bg-card active:bg-gray-50 dark:bg-gray-900 dark:active:bg-gray-800'}`}
    >
      {selectMode ? (
        <View style={{ marginRight: 10, alignSelf: 'center' }}><SelectMark state={picked ? 'on' : 'off'} /></View>
      ) : null}
      <View className="flex-1">
        <View className="flex-row items-center" style={{ flexWrap: 'wrap' }}>
          <Text className="text-sm font-medium text-gray-900 dark:text-gray-100" numberOfLines={1}>
            {record.common_name_c || tr('species.noChineseName')}
            {/* The field determination, when it is finer than the taxon can be
                (v39). Two rows sharing a family's taxon_id are two morphospecies
                and this is the only thing that tells them apart — so it belongs
                on the name line. Mirrors SpeciesCard. */}
            {record.verbatim_identification ? (
              <Text className="font-normal text-gray-500 dark:text-gray-400">
                {` · ${record.verbatim_identification}`}
              </Text>
            ) : null}
          </Text>
          {record.is_endemic === 'true' ? (
            <Text className="ml-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {tr('species.endemicShort')}
            </Text>
          ) : null}
          {ab ? (
            <Text className={`ml-1.5 text-[11px] font-medium ${ab.textClass}`}>
              {ab.shortLabel}
            </Text>
          ) : null}
          {record.is_hybrid === 'true' ? (
            <Text className="ml-1.5 text-[11px] font-medium text-purple-700 dark:text-purple-300">
              {tr('plotSpecies.hybridShort')}
            </Text>
          ) : null}
          {alert ? <Text className="ml-1.5 text-[11px] font-semibold text-alert dark:text-alert-dark">{alert}</Text> : null}
        </View>
        <ScientificName
          name={record.simple_name}
          rank={record.rank}
          author={record.name_author}
          kingdom={record.kingdom}
          className="mt-0.5 text-xs text-gray-700 dark:text-gray-300"
          numberOfLines={1}
        />
        {record.family ? (
          <View className="mt-1 self-start">
            <TaxonomyJumpChip
              rank="family"
              lineage={{
                kingdom: record.kingdom,
                phylum: record.phylum,
                class: record.class,
                order: record.order,
                family: record.family,
              }}
              name={record.family}
              nameC={record.family_c}
              compact
            />
          </View>
        ) : null}
        {record.notes ? (
          <Text
            className="mt-0.5 text-[11px] italic text-gray-500 dark:text-gray-400"
            numberOfLines={1}
          >
            {record.notes}
          </Text>
        ) : null}
      </View>
      <View className="ml-3 items-end">
        <ValueBadge record={record} onAdjust={onAdjust} />
      </View>
    </Pressable>
  );
}

export function ValueBadge({
  record,
  onAdjust,
}: {
  record: Pick<PlotRowRecord, 'organism_quantity' | 'organism_quantity_type'>;
  onAdjust?: (delta: number) => void;
}) {
  const kind = kindForType(record.organism_quantity_type);
  const badge = formatQuantityBadge(record.organism_quantity, record.organism_quantity_type);

  // Individuals (count): inline +/- stepper for quick field tallying without
  // opening the value modal. Other kinds keep the static badge.
  if (kind === 'count' && onAdjust) {
    return (
      <View className="flex-row items-center">
        <Pressable
          onPress={() => onAdjust(-1)}
          hitSlop={10}
          className="px-1.5 py-1 active:opacity-50"
        >
          <Ionicons name="remove-circle-outline" size={22} color="#ea580c" />
        </Pressable>
        <View className="min-w-[40px] items-center rounded-md bg-slate-100 px-2 py-1.5 dark:bg-slate-800">
          <Text className="text-sm font-semibold text-slate-700 dark:text-slate-200">{badge}</Text>
        </View>
        <Pressable
          onPress={() => onAdjust(1)}
          hitSlop={10}
          className="px-1.5 py-1 active:opacity-50"
        >
          <Ionicons name="add-circle-outline" size={22} color="#ea580c" />
        </Pressable>
      </View>
    );
  }

  // Tone by kind
  const tone =
    kind === 'BB'
      ? {
          bg: 'bg-emerald-100 dark:bg-emerald-900/60',
          text: 'text-emerald-700 dark:text-emerald-300',
        }
      : kind === 'percent'
        ? { bg: 'bg-accent-100 dark:bg-accent-900/60', text: 'text-accent-700 dark:text-accent-300' }
        : kind === 'DBH'
          ? { bg: 'bg-amber-100 dark:bg-amber-900/60', text: 'text-amber-800 dark:text-amber-300' }
          : { bg: 'bg-slate-100', text: 'text-slate-700' };

  if (kind === 'DBH') {
    const stems = parseDbhArray(record.organism_quantity);
    const ba = stems.reduce((s, d) => s + Math.PI * (d / 2) ** 2, 0);
    return (
      <View className={`items-end rounded-md px-2.5 py-1.5 ${tone.bg}`}>
        <Text className={`text-sm font-semibold ${tone.text}`}>{badge}</Text>
        {stems.length > 0 ? (
          <Text className={`text-[10px] ${tone.text}`}>{ba.toFixed(1)} cm²</Text>
        ) : null}
        {stems.length > 0 ? (
          <Text className={`text-[10px] ${tone.text}`} numberOfLines={1}>
            {stems.map((d) => d.toFixed(1)).join(', ')}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className={`rounded-md px-2.5 py-1.5 ${tone.bg}`}>
      <Text className={`text-sm font-semibold ${tone.text}`}>{badge}</Text>
    </View>
  );
}

/**
 * Layer chip — which layer the next species is recorded into.
 *
 * Same shape as the checklist screen's filter Chip, emerald rather than blue:
 * emerald is this screen's accent, and the colour difference is the cheapest
 * way to say these are not filters.
 *
 * A layer with no records still gets a chip. That is the opposite of the
 * checklist screen, which hides empty groups because filtering to an empty one
 * is pointless — here the empty layer is precisely the one you are about to
 * record into, so hiding it would make the layer unreachable.
 */
export function LayerChip({
  label,
  a11yLabel,
  active,
  onPress,
  onLongPress,
}: {
  label: string;
  a11yLabel: string;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected: active }}
      className={`mr-2 rounded-full border px-3 py-1.5 ${
        active
          ? 'border-emerald-500 bg-emerald-500'
          : 'border-gray-300 bg-card dark:border-gray-600 dark:bg-gray-900'
      }`}
    >
      <Text
        className={`text-xs font-medium ${active ? 'text-white' : 'text-gray-700 dark:text-gray-300'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
