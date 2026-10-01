/**
 * Generalized abundance entry modal (Step C, DwC organismQuantity / Type).
 *
 * The user picks a quantity TYPE first (BB / % cover / individuals / DBH /
 * custom) and then enters the matching value. Built-in types dispatch to
 * dedicated input widgets; custom types fall through to a free TEXT input.
 */
import { errText } from '~/lib/errText';
import { parseNum } from '~/lib/parseNum';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '~/stores/settings';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { PortalHost } from '@rn-primitives/portal';

import { KeyboardAvoidingView } from './KeyboardAvoidingView';
import { SelectRow } from './settings/rows';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  SwipeNavArea,
  SwipeNavPager,
  usePagerNav,
  type SwipeNavPagerState,
} from './SwipeNavigator';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { RecordMetaFooter } from './RecordMetaFooter';
import { FavoriteToggle } from './FavoriteToggle';
import { PhotoGrid, PhotoViewerModal } from './PhotoGrid';
import { AudioClipRows, AudioRecordTile } from './AudioClipList';
import { InatSyncButton, type InatSheetState } from './InatSyncButton';
import { useRouter } from 'expo-router';
import {
  getKeysForScope,
  sourceOfTaxonId,
  type Layer,
  type Rank,
  type IdentificationKey,
} from '~/db';
import { ScientificName } from './ScientificName';
import { VerbatimLabelField } from './VerbatimLabelField';
import { RecordLocationMap } from './RecordLocationMap';
import { firstPhotoFix } from '~/lib/photoMeta';
import { TaxonomyJumpChip } from './TaxonomyJumpChip';
import { SpeciesAttributesBlock, type SpeciesAttributesDraft } from './SpeciesAttributesBlock';
import { EMPTY_DRAFT, detectionOptions } from '~/lib/dwcAttributes';
import { ToastHost } from './ToastHost';
import {
  quantityTypes,
  defaultQuantityTypeFor,
  findQuantityType,
  kindForType,
  parseDbhArray,
  serializeDbhArray,
} from '~/lib/dwcAbundance';
import { ElevationField } from './ElevationField';
import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';
import {
  BBInput,
  CountInput,
  CustomInput,
  DBHInput,
  FIELD_HEIGHT,
  PercentInput,
  PercentQuickValues,
} from './abundance/AbundanceInputs';

/** Name of the <PortalHost> this modal renders inside, for its own popovers. */
const VALUE_MODAL_PORTAL = 'plot-species-value-modal';

/** Modal-internal draft. The DB columns are organism_quantity + type. */
export type PlotValueDraft = {
  organism_quantity: string | null;
  organism_quantity_type: string | null;
  notes: string | null;
  /** Detection method (v13): 'seen' | 'heard' | 'flying'. */
  detection_type: string | null;
  /** DwC verbatimIdentification — `sp1` under the family or genus the
   *  identification reached. Null = none. */
  verbatim_identification: string | null;
} & SpeciesAttributesDraft;

const EMPTY: PlotValueDraft = {
  organism_quantity: null,
  organism_quantity_type: null,
  notes: null,
  detection_type: null,
  verbatim_identification: null,
  ...EMPTY_DRAFT,
};

/** Fields of a PlotValueDraft that are plain scalars; the two multi-value ones
 *  (reproductive_condition / leaf_phenology) are arrays and compared apart. */
const SCALAR_DRAFT_KEYS = [
  'organism_quantity',
  'organism_quantity_type',
  'notes',
  'detection_type',
  'verbatim_identification',
  'sex',
  'life_stage',
  'degree_of_establishment',
] as const;

function sameDraft(a: PlotValueDraft, b: PlotValueDraft): boolean {
  for (const k of SCALAR_DRAFT_KEYS) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return (
    JSON.stringify(a.reproductive_condition ?? []) ===
      JSON.stringify(b.reproductive_condition ?? []) &&
    JSON.stringify(a.leaf_phenology ?? []) === JSON.stringify(b.leaf_phenology ?? [])
  );
}

/** Structured taxon header so the modal can render an italic scientific name +
 *  a tappable classification path + identification-key chips (replacing the
 *  bare "layer T" line for non-stratified plots). Falls back to `title` when
 *  absent. */
export type PlotModalHeader = {
  /** Needed to tell a TaiCOL taxon from a region-pack / external one, which
   *  decides whether identification keys apply. Required, not optional, so a
   *  new construction site fails to compile rather than silently showing keys
   *  for a species they were never written for. */
  taxonId: string;
  cname: string;
  name: string;
  author: string;
  kingdom: string;
  phylum: string;
  class_name: string;
  order: string;
  family: string;
  family_c: string;
  genus: string;
  /** Decides whether the morphospecies label is offered — see
   *  `VerbatimLabelField`. English (TaiCOL) or Chinese (YList) both work. */
  rank: string;
};

type Props = {
  visible: boolean;
  layer: Layer;
  title: string;
  header?: PlotModalHeader | null;
  initial?: PlotValueDraft | null;
  kingdom?: string | null;
  className?: string | null;
  /** Plot/layer-suggested default type when starting from blank. */
  defaultType?: string | null;
  /** Show the detection-method (seen/heard/flying) chips — point count / animal
   *  records. */
  showDetection?: boolean;
  /** Current per-record GNSS (edit mode); displayed by the GNSS button. */
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  /** Persist the record's own coordinate. In create mode the parent buffers
   *  it and inserts it with the row. Omit to hide the GNSS button. */
  onSaveLocation?: (lat: number | null, lng: number | null, accuracy: number | null) => void;
  /** Live-commit a coordinate edited on the inline map (no toast). A manual
   *  edit carries no GNSS accuracy (null); an undo hands the previous measured
   *  value back. Pass alongside onSaveLocation to show the map. */
  onChangeLocation?: (lat: number, lng: number, accuracy: number | null) => void;
  /** The record's altitude (metres) and how to save it; in create mode the
   *  parent buffers it like the coordinate. Omit `onSaveElevation` to hide. */
  elevation?: number | null;
  onSaveElevation?: (metres: number | null, source: 'gnss' | 'manual') => void;
  /** Plot geographic context for the coordinate map preview (centre / track /
   *  point-count radius). Omit to hide the preview button. */
  plotGeo?: {
    lat: number | null;
    lng: number | null;
    trackGeojson: string | null;
    radiusM: number | null;
  } | null;
  /** Photo URIs: the record's in edit mode, the parent's pending buffer in
   *  create mode. */
  photoUris?: string[];
  /** Capture / library handlers for the photo section. Parent owns the
   *  capture flow and the write (a DB update in edit mode, a buffer in create
   *  mode); omit to hide the section. */
  onAddPhoto?: (mode: 'camera' | 'library') => void;
  onRemovePhoto?: (uri: string) => void;
  /** iNaturalist state of the record (edit mode only): shows the uploaded
   *  badge. */
  /** Identity footer, edit mode only — absent when adding a new record. */
  occurrenceId?: string | null;
  updatedAt?: number | null;
  inatObservationId?: number | null;
  inatUploadedAt?: number | null;
  /** Upload / sync to iNat row (edit mode only). */
  inat?: InatSheetState;
  /** Audio clips: the record's in edit mode, the parent's pending buffer in
   *  create mode (attached when the row is inserted). */
  audioUris?: string[];
  onAddAudio?: (uri: string) => void;
  onRemoveAudio?: (uri: string) => void;
  onCancel: () => void;
  onSave: (v: PlotValueDraft) => void;
  /** Position in the layer list ON SCREEN, so the modal can step to the
   *  neighbouring species by swipe or chevron. Edit mode only. */
  pager?: SwipeNavPagerState;
  /** Edit mode only: actions on the saved row itself, which the species list
   *  used to offer on long-press. They act immediately, not through Save. */
  recordActions?: {
    onReplaceTaxon: () => void;
    /** Stratified plots only — a transect / point count has one layer. */
    onChangeLayer?: () => void;
    onDelete: () => void;
  };
};

export function PlotSpeciesValueModal({
  visible,
  layer,
  title,
  header,
  initial,
  kingdom,
  className,
  defaultType,
  showDetection = false,
  lat,
  lng,
  accuracy,
  onSaveLocation,
  onChangeLocation,
  elevation,
  onSaveElevation,
  plotGeo,
  photoUris,
  onAddPhoto,
  onRemovePhoto,
  audioUris,
  onAddAudio,
  onRemoveAudio,
  inatObservationId,
  inatUploadedAt,
  occurrenceId,
  updatedAt,
  inat,
  onCancel,
  onSave,
  pager,
  recordActions,
}: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const resolvedDefaultType =
    initial?.organism_quantity_type ?? defaultType ?? defaultQuantityTypeFor(kingdom);

  const [qtyType, setQtyType] = useState<string>(resolvedDefaultType);
  const [bb, setBb] = useState<string | null>(null);
  const [numericValue, setNumericValue] = useState<string>('');
  const [stems, setStems] = useState<number[]>([]);
  const [stemDraft, setStemDraft] = useState('');
  const [customValue, setCustomValue] = useState<string>('');
  const [customType, setCustomType] = useState<string>('');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [detection, setDetection] = useState<string | null>(initial?.detection_type ?? null);
  const [verbatim, setVerbatim] = useState<string | null>(initial?.verbatim_identification ?? null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const router = useRouter();

  // Braun-Blanquet & DBH only apply to vascular plants. In transect /
  // point_count (layer 'T') hide them for non-vascular taxa (animals etc.).
  // Fixed plots keep them (bryophytes still get BB cover by layer method).
  const isVascular = (header?.phylum ?? '') === 'Tracheophyta';
  const hideBbDbh = layer === 'T' && !isVascular;

  // Identification keys defined for the taxon's genus / family (one rank up),
  // shown as key chips like the taxonomy tree / SpeciesDetailSheet.
  const [parentKeys, setParentKeys] = useState<IdentificationKey[]>([]);
  const twOn = useSettings((s) => s.enabled_regions.includes('TW'));
  useEffect(() => {
    // Keys only exist for Taiwan, so they only make sense for a TaiCOL taxon.
    // Region-pack and external species carry a 'g…' id (GBIF/iNat) and would
    // otherwise inherit their family's Taiwanese key — wrong for, say, a
    // Japanese congener. `sourceOfTaxonId` covers the JP 'y…' ids too, which a
    // bare external-id check would miss.
    if (!visible || !header || !twOn || sourceOfTaxonId(header.taxonId) !== 'taicol') {
      setParentKeys([]);
      return;
    }
    const found: IdentificationKey[] = [];
    if (header.genus) found.push(...getKeysForScope('genus', header.genus));
    if (header.family) found.push(...getKeysForScope('family', header.family));
    const seen = new Set<number>();
    setParentKeys(
      found.filter((k) => {
        if (seen.has(k.id)) return false;
        seen.add(k.id);
        return true;
      }),
    );
  }, [visible, header, twOn]);
  const [attrs, setAttrs] = useState<SpeciesAttributesDraft>({
    sex: initial?.sex ?? null,
    life_stage: initial?.life_stage ?? null,
    reproductive_condition: initial?.reproductive_condition ?? [],
    leaf_phenology: initial?.leaf_phenology ?? [],
    degree_of_establishment: initial?.degree_of_establishment ?? null,
  });

  // Rehydrate fields whenever the modal opens or the initial draft changes.
  useEffect(() => {
    if (!visible) return;
    const startType =
      initial?.organism_quantity_type ?? defaultType ?? defaultQuantityTypeFor(kingdom);
    setQtyType(startType);
    setNotes(initial?.notes ?? '');
    setDetection(initial?.detection_type ?? null);
    setVerbatim(initial?.verbatim_identification ?? null);
    setAttrs({
      sex: initial?.sex ?? null,
      life_stage: initial?.life_stage ?? null,
      reproductive_condition: initial?.reproductive_condition ?? [],
      leaf_phenology: initial?.leaf_phenology ?? [],
      degree_of_establishment: initial?.degree_of_establishment ?? null,
    });

    const k = kindForType(startType);
    const qty = initial?.organism_quantity ?? '';
    setBb(k === 'BB' ? qty || null : null);
    setNumericValue(k === 'count' || k === 'percent' ? qty : '');
    setStems(k === 'DBH' ? parseDbhArray(qty) : []);
    setStemDraft('');
    setCustomValue(k === 'custom' ? qty : '');
    setCustomType(k === 'custom' ? startType : '');
  }, [visible, initial, defaultType, kingdom]);

  const currentKind = useMemo(() => kindForType(qtyType), [qtyType]);
  /** Percent and count are a single field, so they sit beside the unit. */
  const inlineValue = currentKind === 'percent' || currentKind === 'count';

  const unitOptions = useMemo(
    () =>
      quantityTypes().filter(
        (opt) =>
          opt.value === qtyType || !(hideBbDbh && (opt.kind === 'BB' || opt.kind === 'DBH')),
      ),
    [qtyType, hideBbDbh],
  );

  /** `__custom__` is the sentinel `handleSwitchType` already understood; as a
   *  Select option it needs to round-trip, so a custom type in progress shows
   *  as "custom" rather than falling back to its half-typed name. */
  const typeOptions = useMemo(
    () => [
      ...unitOptions.map((o) => ({ value: o.value, label: o.label })),
      { value: '__custom__', label: t('plotValue.custom') },
    ],
    [unitOptions, t],
  );
  const selectedType = currentKind === 'custom' ? '__custom__' : qtyType;

  // Reset value fields when the user switches type mid-edit (avoid stale BB
  // carrying over to a numeric type, etc.).
  const handleSwitchType = (next: string) => {
    setQtyType(next);
    const k = kindForType(next);
    if (k !== 'BB') setBb(null);
    if (k !== 'count' && k !== 'percent') setNumericValue('');
    if (k !== 'DBH') {
      setStems([]);
      setStemDraft('');
    }
    if (k !== 'custom') {
      setCustomValue('');
      setCustomType('');
    } else {
      setCustomType('');
    }
  };

  const addStem = () => {
    const n = parseNum(stemDraft);
    if (n === null || n <= 0) return;
    setStems((prev) => [...prev, n]);
    setStemDraft('');
  };
  const removeStem = (idx: number) => setStems((prev) => prev.filter((_, i) => i !== idx));

  const canSave = (() => {
    if (currentKind === 'BB') return bb !== null;
    if (currentKind === 'count')
      return numericValue.trim() !== '' && Number.isFinite(Number(numericValue));
    if (currentKind === 'percent') {
      const n = parseNum(numericValue);
      // Cover estimate must be in (0, 100].
      return n !== null && n > 0 && n <= 100;
    }
    if (currentKind === 'DBH') return stems.length > 0;
    if (currentKind === 'custom') return customValue.trim() !== '' && customType.trim() !== '';
    return false;
  })();

  const buildDraft = (): PlotValueDraft => {
    const base = {
      ...EMPTY,
      ...attrs,
      notes: notes || null,
      detection_type: detection,
      verbatim_identification: verbatim,
    };
    let quantity: string | null = null;
    let type: string | null = qtyType;
    if (currentKind === 'BB') quantity = bb;
    else if (currentKind === 'count') quantity = numericValue.trim();
    // A decimal comma is stored as a point; text without one is kept as typed
    // so an untouched record still compares equal to what it was loaded from.
    else if (currentKind === 'percent') quantity = numericValue.trim().replace(',', '.');
    else if (currentKind === 'DBH') quantity = serializeDbhArray(stems);
    else if (currentKind === 'custom') {
      quantity = customValue.trim();
      type = customType.trim();
    }
    return { ...base, organism_quantity: quantity, organism_quantity_type: type };
  };

  const handleSave = () => onSave(buildDraft());

  /**
   * Swiping to the next species commits what is on screen first.
   *
   * This modal is where abundance gets typed species by species, so "next" has
   * to mean "save and next" — silently dropping the value the user just entered
   * would be the worst possible reading of the gesture. An untouched record is
   * left alone so merely browsing does not bump `updated_at` (which would mark
   * every row it passes as needing an iNaturalist re-sync), and an incomplete
   * value (`!canSave`) is discarded rather than half-written.
   */
  const stepPager = useMemo<SwipeNavPagerState | undefined>(() => {
    if (!pager) return undefined;
    return {
      ...pager,
      onStep: (dir) => {
        if (canSave && !sameDraft(buildDraft(), { ...EMPTY, ...(initial ?? {}) })) handleSave();
        pager.onStep(dir);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pager,
    canSave,
    initial,
    attrs,
    notes,
    detection,
    verbatim,
    qtyType,
    bb,
    numericValue,
    stems,
    customValue,
    customType,
    currentKind,
  ]);
  const nav = usePagerNav(stepPager);

  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      {/* gesture-handler needs its own root inside a Modal's view hierarchy. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end">
          <Pressable
            onPress={onCancel}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.4)',
            }}
          />
          {/* `marginTop = insets.top + 16` puts the top of the sheet below the
            Dynamic Island / notch even when the keyboard pushes content up.
            `flex-1` lets the sheet fill the remaining viewport so the inner
            ScrollView's height is properly bounded. */}
          <View
            style={{ marginTop: insets.top + 16 }}
            className="flex-1 rounded-t-2xl bg-card dark:bg-gray-900"
          >
            <SafeAreaView edges={['bottom']} className="flex-1">
              <SwipeNavPager state={stepPager} grabber />
              {/* Title region is INSIDE the scroll so when content is long, the
                user can scroll the title up out of the way. iOS bottom-sheet
                guidance + the user's spec ("make it scrollable"). */}
              <SwipeNavArea nav={nav}>
                <KeyboardAwareScrollView
                  className="flex-1"
                  contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
                  keyboardShouldPersistTaps="handled"
                  bottomOffset={24}
                >
                  <View className="mb-3 border-b border-gray-100 pb-3 dark:border-gray-800">
                    <View className="flex-row items-start">
                      <Text
                        className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100"
                        numberOfLines={2}
                      >
                        {header ? header.cname || t('species.noChineseName') : title}
                      </Text>
                    </View>
                    {header ? (
                      <ScientificName
                        name={header.name}
                        rank={header.rank}
                        author={header.author}
                        kingdom={header.kingdom}
                        className="text-sm text-gray-700 dark:text-gray-300"
                      />
                    ) : null}
                    {recordActions && header ? (
                      <View className="flex-row flex-wrap items-center" style={{ columnGap: 16 }}>
                        <Pressable
                          onPress={recordActions.onReplaceTaxon}
                          hitSlop={6}
                          className="mt-2 flex-row items-center active:opacity-70"
                        >
                          <Ionicons name="swap-horizontal" size={14} color={c.accent} />
                          <Text className="ml-1 text-xs font-medium text-accent-700 dark:text-accent-300">
                            {t('plotSpecies.changeTaxon')}
                          </Text>
                        </Pressable>
                        {recordActions.onChangeLayer ? (
                          <Pressable
                            onPress={recordActions.onChangeLayer}
                            hitSlop={6}
                            className="mt-2 flex-row items-center active:opacity-70"
                          >
                            <Ionicons name="layers-outline" size={14} color={c.accent} />
                            <Text className="ml-1 text-xs font-medium text-accent-700 dark:text-accent-300">
                              {t('plotSpecies.changeLayer')}
                            </Text>
                          </Pressable>
                        ) : null}
                        <FavoriteToggle taxonId={header.taxonId} />
                      </View>
                    ) : null}
                    {/* Folded into the draft, not written on the spot: this
                        modal persists everything through its own Save. */}
                    {header ? (
                      <VerbatimLabelField
                        key={`${occurrenceId ?? ''}|${header.taxonId}`}
                        rank={header.rank}
                        value={verbatim}
                        onCommit={setVerbatim}
                      />
                    ) : null}
                    {/* Classification path (each rank tappable → taxonomy tree) +
                    identification-key chips. Shown for ALL plot types so fixed
                    plots also get the jump links; fixed plots additionally show
                    their vegetation layer below. */}
                    {header ? (
                      <View className="mt-2 flex-row flex-wrap items-center" style={{ gap: 6 }}>
                        {/* Family and genus only. The full kingdom→genus path
                            filled two lines above the fields the user actually
                            came here for, and the upper ranks are one tap away
                            in the tree anyway. */}
                        {(
                          [
                            { rank: 'family', name: header.family, nameC: header.family_c },
                            { rank: 'genus', name: header.genus },
                          ] as Array<{ rank: Rank; name: string; nameC?: string }>
                        )
                          .filter((r) => r.name)
                          .map((r) => (
                            <TaxonomyJumpChip
                              key={r.rank}
                              rank={r.rank}
                              lineage={{
                                kingdom: header.kingdom,
                                phylum: header.phylum,
                                class: header.class_name,
                                order: header.order,
                                family: header.family,
                                genus: header.genus,
                              }}
                              name={r.name}
                              nameC={r.nameC}
                              beforeJump={onCancel}
                            />
                          ))}
                        {parentKeys.map((k) => (
                          <Pressable
                            key={k.id}
                            onPress={() => {
                              onCancel();
                              requestAnimationFrame(() => router.push(`/key/${k.id}`));
                            }}
                            className={`flex-row items-center rounded-full px-2.5 py-1 active:opacity-80 ${
                              k.mode === 'multi_access'
                                ? 'bg-accent-100 dark:bg-accent-900/60'
                                : 'bg-emerald-100 dark:bg-emerald-900/60'
                            }`}
                            hitSlop={4}
                          >
                            <Ionicons
                              name="key"
                              size={12}
                              color={k.mode === 'multi_access' ? c.accent : c.accent}
                            />
                            <Text
                              className={`ml-1 text-xs font-medium ${
                                k.mode === 'multi_access'
                                  ? 'text-accent-700 dark:text-accent-300'
                                  : 'text-emerald-700 dark:text-emerald-300'
                              }`}
                            >
                              {t('nav.key')} ({k.scope_name})
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                    {layer !== 'T' ? (
                      <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {t('plotValue.layer', { layer })}
                      </Text>
                    ) : null}
                  </View>
                  {/* Unit + value on one row. Five wrapped pills cost two lines
                      above the field they describe, on the screen a surveyor
                      uses most; a dropdown is one line whatever the label
                      length. Same SelectRow as 偏好設定, popped into the host
                      below rather than the root one the Modal covers. */}
                  <View className="flex-row items-start" style={{ gap: 8 }}>
                    <View className="flex-1">
                      <SelectRow
                        variant="inline"
                        label={t('plotValue.abundanceUnit')}
                        value={selectedType}
                        options={typeOptions}
                        onChange={handleSwitchType}
                        portalHost={VALUE_MODAL_PORTAL}
                        // Same fixed height as the value field beside it, so
                        // the two boxes line up whatever the platform's
                        // TextInput height turns out to be.
                        triggerClassName={FIELD_HEIGHT}
                      />
                    </View>
                    {inlineValue ? (
                      <View className="flex-1">
                        {/* Matches SelectRow's inline caption so the two fields
                            line up; the inputs run `compact` because the unit
                            is already named on the left. */}
                        <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                          {currentKind === 'percent'
                            ? t('plotValue.coverPct')
                            : t('plotValue.quantity')}
                        </Text>
                        {currentKind === 'percent' ? (
                          <PercentInput value={numericValue} onChange={setNumericValue} compact />
                        ) : (
                          <CountInput
                            value={numericValue}
                            onChange={setNumericValue}
                            suffix={findQuantityType(qtyType)?.suffix ?? ''}
                            compact
                          />
                        )}
                      </View>
                    ) : null}
                  </View>

                  {/* Common values, one scrollable line. */}
                  {currentKind === 'percent' ? (
                    <PercentQuickValues onPick={setNumericValue} />
                  ) : null}

                  {/* Kinds that need more than a field get the full width. */}
                  <View className={inlineValue ? '' : 'mt-3'}>
                    {currentKind === 'BB' ? <BBInput value={bb} onChange={setBb} /> : null}
                    {currentKind === 'DBH' ? (
                      <DBHInput
                        stems={stems}
                        stemDraft={stemDraft}
                        setStemDraft={setStemDraft}
                        onAdd={addStem}
                        onRemove={removeStem}
                      />
                    ) : null}
                    {currentKind === 'custom' ? (
                      <CustomInput
                        typeValue={customType}
                        setTypeValue={setCustomType}
                        quantityValue={customValue}
                        setQuantityValue={setCustomValue}
                      />
                    ) : null}
                  </View>

                  <View className="mt-4">
                    <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                      {t('endSession.notesOptional')}
                    </Text>
                    <TextInput
                      value={notes}
                      onChangeText={setNotes}
                      placeholder={t('plotValue.notesPlaceholder')}
                      placeholderTextColor={c.ink3}
                      multiline
                      className="min-h-[60px] rounded-lg border border-gray-200 bg-card px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    />
                  </View>

                  <View className="mt-4">
                    <SpeciesAttributesBlock
                      kingdom={kingdom ?? null}
                      className={className ?? null}
                      value={attrs}
                      onChange={setAttrs}
                    />
                  </View>

                  {showDetection ? (
                    <View className="mt-4">
                      <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                        {t('plotValue.detectionLabel')}
                      </Text>
                      <View className="flex-row gap-1.5">
                        {detectionOptions().map((o) => {
                          const on = detection === o.value;
                          return (
                            <Pressable
                              key={o.value}
                              onPress={() => setDetection(on ? null : o.value)}
                              className={`rounded-full border px-3 py-1.5 ${on ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 bg-card dark:border-gray-600 dark:bg-gray-900'}`}
                            >
                              <Text
                                className={`text-xs font-medium ${on ? 'text-white' : 'text-gray-700 dark:text-gray-300'}`}
                              >
                                {o.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  ) : null}

                  {onSaveLocation ? (
                    <View className="mt-4">
                      <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                        {t('plotValue.coordOptional')}
                      </Text>
                      <View className="flex-row items-center gap-2">
                        <Pressable
                          onPress={async () => {
                            const perm = await Location.requestForegroundPermissionsAsync();
                            if (perm.status !== 'granted') {
                              Alert.alert(t('gnss.permTitle'), t('plotValue.permMsg'));
                              return;
                            }
                            try {
                              const pos = await Location.getCurrentPositionAsync({
                                accuracy: Location.Accuracy.Balanced,
                              });
                              onSaveLocation(
                                pos.coords.latitude,
                                pos.coords.longitude,
                                pos.coords.accuracy ?? null,
                              );
                              if (onSaveElevation && pos.coords.altitude != null) {
                                onSaveElevation(Math.round(pos.coords.altitude), 'gnss');
                              }
                            } catch (e) {
                              Alert.alert(
                                t('plotValue.locateFailed'),
                                errText(e),
                              );
                            }
                          }}
                          onLongPress={
                            lat != null
                              ? () => {
                                  Alert.alert('GNSS', undefined, [
                                    { text: t('common.cancel'), style: 'cancel' },
                                    {
                                      text: t('species.clearCoord'),
                                      style: 'destructive',
                                      onPress: () => onSaveLocation(null, null, null),
                                    },
                                  ]);
                                }
                              : undefined
                          }
                          className="flex-1 flex-row items-center rounded-lg border border-gray-200 px-3 py-2.5 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
                        >
                          <Ionicons
                            name={lat != null ? 'location' : 'location-outline'}
                            size={18}
                            color={lat != null ? c.accent : '#4b5563'}
                          />
                          <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">
                            {lat != null && lng != null
                              ? `${lat.toFixed(5)}, ${lng.toFixed(5)}${accuracy != null ? ` (±${Math.round(accuracy)}m)` : ''}`
                              : t('species.locateSpecies')}
                          </Text>
                          <Text className="text-[11px] text-gray-400">
                            {lat != null ? t('species.longPressClear') : t('species.tapGnss')}
                          </Text>
                        </Pressable>
                      </View>
                      {/* Load the position out of an attached photo. Only when
                          there is a photo and no coordinate yet: a photo taken
                          at the plant carries the fix nobody stopped to save,
                          and in a plot large enough to need per-species
                          coordinates that is the whole point. Hidden once a
                          position exists — replacing a measured coordinate is
                          not something a button should offer. */}
                      {lat == null && (photoUris?.length ?? 0) > 0 ? (
                        <Pressable
                          onPress={async () => {
                            const out = await firstPhotoFix(photoUris ?? []);
                            // Alert, not toast: a failure the user has to read,
                            // not one that should time out.
                            if (out.kind === 'needs-photo-access') {
                              Alert.alert(t('species.usePhotoGnss'), t('species.photoNeedsAccess'));
                              return;
                            }
                            if (out.kind === 'no-gnss') {
                              Alert.alert(t('species.usePhotoGnss'), t('species.photoNoGnss'));
                              return;
                            }
                            onSaveLocation(out.fix.lat, out.fix.lng, out.fix.accuracyM);
                            if (onSaveElevation && out.fix.altitudeM != null) onSaveElevation(out.fix.altitudeM, 'gnss');
                          }}
                          className="mt-2 flex-row items-center rounded-lg border border-gray-200 px-3 py-2 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
                        >
                          <Ionicons name="image-outline" size={18} color="#4b5563" />
                          <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">
                            {t('species.usePhotoGnss')}
                          </Text>
                        </Pressable>
                      ) : null}
                      {onChangeLocation ? (
                        // The map pans on its own; block the swipe so a sideways
                        // drag moves the map instead of stepping to the next species.
                        <GestureDetector gesture={nav.blocker}>
                          <View>
                            <RecordLocationMap
                              lat={lat ?? null}
                              lng={lng ?? null}
                              accuracy={accuracy ?? null}
                              onChange={onChangeLocation}
                              taxon={
                                header
                                  ? {
                                      localTaxonId: header.taxonId,
                                      name: header.name,
                                      kingdom: header.kingdom,
                                    }
                                  : undefined
                              }
                              reference={
                                plotGeo && plotGeo.lat != null && plotGeo.lng != null
                                  ? {
                                      center: { lat: plotGeo.lat, lng: plotGeo.lng },
                                      radiusM: plotGeo.radiusM,
                                    }
                                  : undefined
                              }
                            />
                          </View>
                        </GestureDetector>
                      ) : null}
                      {onSaveElevation ? (
                        <View className="mt-2">
                          <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                            {t('collection.elevation')}
                          </Text>
                          <ElevationField
                            value={elevation}
                            onCommit={(m) => onSaveElevation(m, 'manual')}
                            inputClassName="rounded-lg border border-gray-200 bg-card px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                          />
                        </View>
                      ) : null}
                    </View>
                  ) : null}

                  {/* Photos and audio side by side (both plot types share this
                  modal); audio is edit-mode only, so create mode shows the
                  photo column alone. */}
                  {onAddPhoto || onAddAudio ? (
                    <View className="mt-4">
                      {/* Photo tiles and the square record tile sit shoulder to
                      shoulder: the photo column shrinks (and its grid wraps)
                      when there are many thumbnails, the audio column never
                      does. Recorded clips are listed full-width underneath. */}
                      <View className="flex-row items-start gap-3">
                        {onAddPhoto ? (
                          <View className="shrink">
                            <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                              {t('plotValue.photo')}
                            </Text>
                            <PhotoGrid
                              photos={photoUris ?? []}
                              onView={(idx) => setViewerIndex(idx)}
                              onAdd={() => onAddPhoto('camera')}
                              onPickLibrary={() => onAddPhoto('library')}
                              onRemove={onRemovePhoto}
                            />
                          </View>
                        ) : null}
                        {onAddAudio ? (
                          <View className="shrink-0">
                            <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                              {t('species.audioClips')}
                            </Text>
                            <AudioRecordTile onAdd={onAddAudio} />
                          </View>
                        ) : null}
                      </View>
                      {onAddAudio ? (
                        <AudioClipRows
                          clips={audioUris ?? []}
                          onRemove={onRemoveAudio ?? (() => {})}
                        />
                      ) : null}
                    </View>
                  ) : null}
                  {inat ? <InatSyncButton state={inat} /> : null}

                  <RecordMetaFooter
                    occurrenceId={occurrenceId ?? null}
                    updatedAt={updatedAt ?? null}
                    inatObservationId={inatUploadedAt != null ? inatObservationId : null}
                  />

                  {recordActions ? (
                    <Pressable
                      onPress={recordActions.onDelete}
                      className="mt-4 flex-row items-center justify-center rounded-lg border border-red-200 bg-red-50 px-4 py-3 active:bg-red-100 dark:bg-red-950/40 dark:active:bg-red-900/60"
                    >
                      <Ionicons name="trash-outline" size={18} color={c.alert} />
                      <Text className="ml-2 text-sm font-medium text-red-700 dark:text-red-400">
                        {t('plotSpecies.deleteRecord')}
                      </Text>
                    </Pressable>
                  ) : null}

                  <View className="h-4" />
                </KeyboardAwareScrollView>
              </SwipeNavArea>

              <View className="flex-row gap-3 border-t border-gray-100 px-4 py-3 dark:border-gray-800">
                <Button
                  label={t('common.cancel')}
                  onPress={onCancel}
                  variant="secondary"
                  size="lg"
                  className="flex-1"
                />
                <Button
                  label={t('common.save')}
                  onPress={handleSave}
                  disabled={!canSave}
                  size="lg"
                  className="flex-1"
                />
              </View>
            </SafeAreaView>
          </View>
        </KeyboardAvoidingView>
        {/* The unit dropdown's popover lands here. It has to be inside the
            Modal (the root host in app/_layout.tsx is behind it) and the LAST
            sibling (later siblings paint on top). Renders null while closed,
            so it costs no layout. */}
        <PortalHost name={VALUE_MODAL_PORTAL} />
      </GestureHandlerRootView>

      <PhotoViewerModal
        photos={photoUris ?? []}
        index={viewerIndex}
        onClose={() => setViewerIndex(null)}
      />
      {/* Toasts fired while this sheet is up (it has its own window). */}
      <ToastHost inModal />
    </Modal>
  );
}
