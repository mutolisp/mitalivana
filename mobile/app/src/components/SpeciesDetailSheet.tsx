import { errText } from '~/lib/errText';
import { FavoriteToggle } from './FavoriteToggle';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  SwipeNavArea,
  SwipeNavPager,
  usePagerNav,
  type SwipeNavPagerState,
} from './SwipeNavigator';
import { PhotoGrid, PhotoViewerModal } from './PhotoGrid';
import { AudioClipRows, AudioRecordTile } from './AudioClipList';
import { InatSyncButton, type InatSheetState } from './InatSyncButton';
import { observationWebUrl } from '~/lib/inatApi';
import { ActionSheetLayer, sheetBack, showActionSheet } from './ActionSheet';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useSettings } from '~/stores/settings';
import { isoDateTime } from '~/lib/datetime';
import { useRouter } from 'expo-router';
import {
  endemicTagLabel,
  getKeysForScope,
  searchByTaxonId,
  type IdentificationKey,
  type RecordWithTaxon,
  type SearchResult,
  sourceOfTaxonId,
} from '~/db';
import { buildSpeciesCopyText, copyToClipboard, speciesCopyActions } from '~/lib/clipboard';
import { formatQuantityBadge } from '~/lib/dwcAbundance';
import { alienBadge } from '~/lib/conservationColors';
import { RecordMetaFooter } from './RecordMetaFooter';
import { ScientificName } from './ScientificName';
import { LookupResultSheet } from './LookupResultSheet';
import { Tag } from './ui/Tag';
import { Button } from './ui/Button';
import { NotesEditModal } from './NotesEditModal';
import { KeyboardAvoidingView } from './KeyboardAvoidingView';
import { RecordLocationMap } from './RecordLocationMap';
import { firstPhotoFix } from '~/lib/photoMeta';
import { VerbatimLabelField } from './VerbatimLabelField';
import { SpeciesAttributesBlock, type SpeciesAttributesDraft } from './SpeciesAttributesBlock';
import { AdvancedFold } from './AdvancedFold';
import { ObservationNotes } from './ObservationNotes';
import { shows, vis } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';
import { parseMultiAttribute } from '~/lib/dwcAttributes';
import { ToastHost } from './ToastHost';
import { ElevationField } from './ElevationField';
import { useThemeColors } from '~/theme/colors';
import { speciesParts } from '~/lib/nameParts';
import { familyChineseFirst } from '~/lib/familyLabel';

type Props = {
  record: RecordWithTaxon | null;
  onClose: () => void;
  onRemove: () => void;
  /** Called when user saves new notes for the current record. The sheet handles its own NotesEditModal.
   *  Omit to hide the notes tile (a survey whose template has no comment on its species). */
  onSaveNotes?: (newNotes: string) => void;
  /** Save / clear per-record GNSS coordinates. Pass null to clear. */
  onSaveLocation?: (lat: number | null, lng: number | null, accuracy: number | null) => void;
  /** Live-commit a coordinate edited on the inline map (no toast). Manual map
   *  edits carry no GNSS accuracy. Pass alongside onSaveLocation to show the map. */
  /** `accuracy` is null for a hand-placed point; an undo passes the previous
   *  measured value back so a restored GNSS fix keeps its uncertainty. */
  onChangeLocation?: (lat: number, lng: number, accuracy: number | null) => void;
  /** Save / clear the record's altitude (metres). Omit to hide the field. */
  onSaveElevation?: (metres: number | null, source: 'gnss' | 'manual') => void;
  /** Capture or pick a photo for the current record. Parent persists the URI. */
  onAddPhoto?: (mode: 'camera' | 'library') => void;
  /** Remove a single photo URI from the current record. */
  onRemovePhoto?: (uri: string) => void;
  /** A finished recording (file:// URI, already persisted). Parent writes the DB. */
  onAddAudio?: (uri: string) => void;
  onRemoveAudio?: (uri: string) => void;
  /** Upload / sync to iNat row for this record. */
  inat?: InatSheetState;
  /** Save species attribute changes (sex / lifeStage / reproductive / leaf). */
  onSaveAttributes?: (next: SpeciesAttributesDraft) => void;
  /** Only these attributes (a survey's phenology component asks for some); all when omitted. */
  attributeFields?: readonly (keyof SpeciesAttributesDraft)[];
  /** Re-identify: hand the docked SearchBox over to replacing this record's
   *  taxon. Optional — callers without a search box simply omit it. */
  onReplaceTaxon?: () => void;
  /** Save the individual count for this record. `null` clears it — which is a
   *  different statement from 0 ("counted, none present"), so both are
   *  reachable. Omit the prop on screens where a count makes no sense.
   *  Always written as DwC organismQuantityType `individuals`; the checklist
   *  deliberately does not offer cover / BB / DBH, which are plot methods. */
  onSaveQuantity?: (count: number | null) => void;
  /** Save the verbatim field determination (`sp1` under a family or genus).
   *  Pass null to clear. Omit to hide the control — `VerbatimLabelField` also
   *  hides itself on a record already determined to species. */
  onSaveVerbatim?: (value: string | null) => void;
  /** Position of this record in the caller's ON-SCREEN order, so the sheet can
   *  step to the neighbouring one by swipe or chevron. Omit to disable. */
  pager?: SwipeNavPagerState;
  /**
   * A survey built from a template (2G): its abundance input in place of the
   * individual count (a template may allow cover, BB …), and its other
   * components for the record after the existing fields.
   */
  quantity?: ReactNode;
  extra?: ReactNode;
};

function parsePhotoPaths(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    // ignore
  }
  return [];
}

const ALL_ATTRIBUTE_FIELDS: readonly (keyof SpeciesAttributesDraft)[] = [
  'sex',
  'life_stage',
  'reproductive_condition',
  'leaf_phenology',
  'degree_of_establishment',
];

export function SpeciesDetailSheet({
  record,
  onClose,
  onRemove,
  onSaveNotes,
  onSaveLocation,
  onChangeLocation,
  onSaveElevation,
  onAddPhoto,
  onRemovePhoto,
  onAddAudio,
  onRemoveAudio,
  inat,
  onSaveAttributes,
  attributeFields,
  onReplaceTaxon,
  onSaveQuantity,
  onSaveVerbatim,
  pager,
  quantity,
  extra,
}: Props) {
  const c = useThemeColors();
  const router = useRouter();
  const nav = usePagerNav(pager);
  const scrollRef = useRef<ScrollView>(null);
  const mode = useUsageMode();
  const { t } = useTranslation();
  const [notesModalOpen, setNotesModalOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [parentKeys, setParentKeys] = useState<IdentificationKey[]>([]);
  /** 分類資訊: the taxon page, opened over this sheet. */
  const [taxonInfo, setTaxonInfo] = useState<SearchResult | null>(null);

  // Surface identification keys defined for the record's genus / family
  // ("one rank up"). Each key is shown as a tappable chip that closes this
  // sheet and pushes the user to the key runner.
  const twOn = useSettings((s) => s.enabled_regions.includes('TW'));
  useEffect(() => {
    // Keys only exist for Taiwan → only for a TaiCOL taxon. JP ('y…') and
    // external ('g…') species would otherwise inherit their family's
    // Taiwanese key.
    if (!record || !twOn || sourceOfTaxonId(record.taxon_id) !== 'taicol') {
      setParentKeys([]);
      return;
    }
    const found: IdentificationKey[] = [];
    if (record.genus) found.push(...getKeysForScope('genus', record.genus));
    if (record.family) found.push(...getKeysForScope('family', record.family));
    // Dedupe by id (same key can index via alias on multiple scopes).
    const seen = new Set<number>();
    setParentKeys(
      found.filter((k) => {
        if (seen.has(k.id)) return false;
        seen.add(k.id);
        return true;
      }),
    );
  }, [record, twOn]);

  // Reset internal modal when the underlying record changes
  useEffect(() => {
    setNotesModalOpen(false);
    setViewerIndex(null);
    setTaxonInfo(null);
    // Stepping to a neighbour keeps the sheet mounted, so without this the new
    // record opens scrolled to wherever the previous one was left.
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [record?.id]);

  if (!record) return null;

  const isEndemic = record.is_endemic === 'true';
  const ab = alienBadge(record.alien_type, record.kingdom);
  const observedStr = isoDateTime(record.observed_at);

  // Usage modes: what pro mode shows in place, the simpler modes fold into
  // one 進階 at the end (design 18l), and the notes tile becomes 觀察筆記.
  const verbatimField = onSaveVerbatim ? (
    <VerbatimLabelField
      key={record.id}
      rank={record.rank}
      value={record.verbatim_identification}
      onCommit={onSaveVerbatim}
    />
  ) : null;
  const keyChips = parentKeys.map((k) => (
    <Pressable
      key={k.id}
      onPress={() => {
        onClose();
        requestAnimationFrame(() => router.push(`/key/${k.id}`));
      }}
      className="flex-row items-center rounded-full bg-accent-100 px-2.5 py-1 active:bg-accent-200 dark:bg-accent-900/60 dark:active:bg-accent-800"
      hitSlop={4}
    >
      <Ionicons name="key" size={12} color={c.accent} />
      <Text className="ml-1 text-xs font-medium text-accent-700 dark:text-accent-300">
        {t('nav.key')} ({k.scope_name})
      </Text>
    </Pressable>
  ));
  const attrs: SpeciesAttributesDraft = {
    sex: record.sex ?? null,
    life_stage: record.life_stage ?? null,
    reproductive_condition: parseMultiAttribute(record.reproductive_condition),
    leaf_phenology: parseMultiAttribute(record.leaf_phenology),
    degree_of_establishment: record.degree_of_establishment ?? null,
  };
  const obsNotes = Boolean(onSaveNotes) && shows(mode, 'observationNotes');
  const reproInNotes =
    obsNotes &&
    record.kingdom === 'Plantae' &&
    onSaveAttributes !== undefined &&
    (!attributeFields || attributeFields.includes('reproductive_condition'));
  const attrFields = reproInNotes
    ? (attributeFields ?? ALL_ATTRIBUTE_FIELDS).filter((f) => f !== 'reproductive_condition')
    : attributeFields;
  const elevationField = onSaveElevation ? (
    <View className="mt-2">
      <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
        {t('collection.elevation')}
      </Text>
      <ElevationField
        value={record.elevation_m}
        onCommit={(m) => onSaveElevation(m, 'manual')}
        inputClassName="rounded-lg border border-gray-200 bg-card px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      />
    </View>
  ) : null;
  const attributesBlock = (open?: boolean) =>
    onSaveAttributes ? (
      <View className="mt-3">
        <SpeciesAttributesBlock
          kingdom={record.kingdom}
          className={record.class}
          value={attrs}
          onChange={onSaveAttributes}
          fields={attrFields}
          defaultOpen={open}
        />
      </View>
    ) : null;
  const metaFooter = (
    <RecordMetaFooter
      occurrenceId={record.occurrence_id}
      updatedAt={record.updated_at}
      inatObservationId={record.inat_uploaded_at != null ? record.inat_observation_id : null}
    />
  );
  const folded = {
    verbatim: vis(mode, 'verbatimLabel') === 'adv' ? verbatimField : null,
    keys: vis(mode, 'keyChip') === 'adv' && keyChips.length > 0 ? keyChips : null,
    elevation: vis(mode, 'recordElevation') === 'adv' ? elevationField : null,
    attributes: vis(mode, 'speciesAttributes') === 'adv' ? attributesBlock(true) : null,
    meta: vis(mode, 'recordMeta') === 'adv' ? metaFooter : null,
  };
  const hasFolded = Object.values(folded).some((x) => x !== null);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={sheetBack(onClose)}>
      <View className="flex-1">
        <Pressable
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
          }}
        />
        <View
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '85%' }}
          className="rounded-t-2xl bg-card dark:bg-gray-900"
        >
          {/* gesture-handler does not reach into a Modal's own native view
              hierarchy, so the swipe needs a root of its own here (same reason
              SurveyorAssignSheet carries one). */}
          <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaView edges={['bottom']} className="flex-1">
              <SwipeNavArea nav={nav}>
                <SwipeNavPager state={pager} grabber />
                {/* Name — the one thing that must stay in view, so it sits
                    above the scroll. Reordered for the field (03-screens-flow
                    §4); what belongs to the TAXON rather than to this record
                    lives behind 分類資訊 near the bottom. */}
                <View className="flex-row items-start border-b border-gray-100 px-4 py-3 dark:border-gray-800">
                  <View className="flex-1">
                    <Text selectable className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                      {record.common_name_c || t('species.noChineseName')}
                    </Text>
                    <ScientificName
                      name={record.simple_name}
                      rank={record.rank}
                      author={record.name_author}
                      kingdom={record.kingdom}
                      className="text-lg text-gray-800 dark:text-gray-200"
                      selectable
                    />
                    {record.family ? (
                      <Text className="text-sm text-gray-500 dark:text-gray-400">
                        {familyChineseFirst(record.family, record.family_c)}
                      </Text>
                    ) : null}
                    <View className="mt-1.5 flex-row flex-wrap items-center gap-1.5">
                      {isEndemic ? (
                        <Tag kind="endemic" size="md" label={endemicTagLabel(record.taxon_id)} />
                      ) : null}
                      {ab ? <Tag kind={ab.kind} size="md" label={ab.longLabel} /> : null}
                      {record.redlist ? <Tag kind="iucn" size="md" iucnCode={record.redlist} /> : null}
                      {record.protected ? (
                        <Tag kind="protected" size="md" label={`${t('species.protected')} ${record.protected}`} />
                      ) : null}
                    </View>
                    {onSaveVerbatim && vis(mode, 'verbatimLabel') === 'show' ? verbatimField : null}
                    <View className="mt-1 flex-row flex-wrap items-center gap-2">
                      {record.taxon_id ? <FavoriteToggle taxonId={record.taxon_id} /> : null}
                      {/* Identification keys for the genus / family: a field
                          tool, so they stay here rather than behind 分類資訊. */}
                      {vis(mode, 'keyChip') === 'show' ? keyChips : null}
                    </View>
                  </View>
                  <Pressable
                    onPress={async () => {
                      const actions = speciesCopyActions(record);
                      const idx = await showActionSheet({
                        titleParts: speciesParts(record.common_name_c, record.simple_name, record.rank, record.kingdom),
                        options: actions.map((a) => ({ label: a.label })),
                      });
                      if (idx >= 0 && idx < actions.length) {
                        const a = actions[idx];
                        await copyToClipboard(buildSpeciesCopyText(record, a.mode));
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t('clipboard.copyMenu')}
                    className="h-11 w-11 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800"
                  >
                    <Ionicons name="copy-outline" size={20} color={c.ink2} />
                  </Pressable>
                  <Pressable
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                    className="h-11 w-11 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800"
                  >
                    <Ionicons name="close" size={22} color={c.ink2} />
                  </Pressable>
                </View>

                {/* The sheet's inline text fields (RecordLocationMap's
                coordinate entry, the count, the verbatim label, the altitude)
                sit mid-sheet. `behavior="padding"` shrinks the ScrollView
                rather than moving the sheet container, which is what keeps the
                header from being pushed off the top edge. */}
                <KeyboardAvoidingView className="flex-1" behavior="padding">
                  {/* `keyboardShouldPersistTaps="handled"`: RecordLocationMap's
                  coordinate entry puts Cancel and OK directly under the field,
                  and RN's default 'never' spends the first tap dismissing the
                  keyboard. 'handled' still dismisses on taps no child takes. */}
                  <ScrollView
                    ref={scrollRef}
                    className="flex-1"
                    keyboardShouldPersistTaps="handled"
                  >
                    <View className="px-4 pt-2">
                      <Text selectable className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        {t('species.timeLabel', { time: observedStr })}
                      </Text>
                      {onAddPhoto ? (
                        <PhotoGrid
                          photos={parsePhotoPaths(record.photo_paths)}
                          onView={(idx) => setViewerIndex(idx)}
                          onAdd={() => onAddPhoto('camera')}
                          onPickLibrary={() => onAddPhoto('library')}
                          onRemove={onRemovePhoto}
                        />
                      ) : null}
                      {quantity ?? null}
                      {!quantity && onSaveQuantity ? (
                        <CountField
                          key={record.id}
                          quantity={record.organism_quantity}
                          quantityType={record.organism_quantity_type}
                          onCommit={onSaveQuantity}
                        />
                      ) : null}

                      {/* Quick actions: coordinate · audio · notes, one row. */}
                      <View className="mt-2 flex-row gap-2">
                        {onSaveLocation ? (
                          <Pressable
                            onPress={async () => {
                              // Tap captures the current GNSS; long-press clears.
                              const perm = await Location.requestForegroundPermissionsAsync();
                              if (perm.status !== 'granted') {
                                Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
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
                                // The fix's altitude comes along, rounded like
                                // every other altitude in the app.
                                if (onSaveElevation && pos.coords.altitude != null) {
                                  onSaveElevation(Math.round(pos.coords.altitude), 'gnss');
                                }
                              } catch (e) {
                                Alert.alert(t('gnss.posFailTitle'), errText(e));
                              }
                            }}
                            onLongPress={
                              record.lat !== null
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
                            accessibilityRole="button"
                            className="mt-2 flex-1 justify-center rounded-lg border border-line px-3 active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800"
                            style={{ minHeight: 88 }}
                          >
                            <Ionicons
                              name={record.lat !== null ? 'location' : 'location-outline'}
                              size={22}
                              color={record.lat !== null ? c.accent : c.ink2}
                            />
                            <Text className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                              {record.lat !== null ? t('species.coordinates') : t('species.locateSpecies')}
                            </Text>
                            <Text selectable numberOfLines={2} className="text-xs text-gray-500 dark:text-gray-400">
                              {record.lat !== null && record.lng !== null
                                ? `${record.accuracy !== null ? `±${Math.round(record.accuracy)} m` : `${record.lat.toFixed(4)}, ${record.lng.toFixed(4)}`}${
                                    record.elevation_m != null ? ` · ${record.elevation_m} m` : ''
                                  } · ${t('species.longPressClear')}`
                                : t('species.tapGnss')}
                            </Text>
                          </Pressable>
                        ) : null}
                        {onAddAudio ? <AudioRecordTile onAdd={onAddAudio} /> : null}
                        {onSaveNotes && !obsNotes ? (
                        <Pressable
                          onPress={() => setNotesModalOpen(true)}
                          accessibilityRole="button"
                          className="mt-2 flex-1 justify-center rounded-lg border border-line px-3 active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800"
                          style={{ minHeight: 88 }}
                        >
                          <Ionicons name="create-outline" size={22} color={record.notes ? c.accent : c.ink2} />
                          <Text className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                            {t('session.notes')}
                          </Text>
                          <Text numberOfLines={2} className="text-xs text-gray-500 dark:text-gray-400">
                            {record.notes ? record.notes : t('species.addNote')}
                          </Text>
                        </Pressable>
                        ) : null}
                      </View>
                      {onAddAudio ? (
                        <AudioClipRows
                          clips={parsePhotoPaths(record.audio_paths)}
                          onRemove={onRemoveAudio ?? (() => {})}
                        />
                      ) : null}
                      {obsNotes && onSaveNotes ? (
                        <ObservationNotes
                          key={`notes-${record.id}`}
                          kingdom={record.kingdom}
                          className={record.class}
                          note={record.notes}
                          onCommitNote={onSaveNotes}
                          repro={reproInNotes ? attrs.reproductive_condition : undefined}
                          onChangeRepro={
                            reproInNotes && onSaveAttributes
                              ? (next) => onSaveAttributes({ ...attrs, reproductive_condition: next })
                              : undefined
                          }
                          onTakePhoto={onAddPhoto ? () => onAddPhoto('camera') : undefined}
                        />
                      ) : null}

                      {/* Only when there is a photo and no position: a photo
                          taken at the plant carries the fix the recorder never
                          got round to saving, and reading it back beats
                          stamping wherever they are standing now. Hidden once a
                          position exists — silently overwriting a measured
                          coordinate is not something a button should offer. */}
                      {onSaveLocation && record.lat === null && parsePhotoPaths(record.photo_paths).length > 0 ? (
                        <Pressable
                          onPress={async () => {
                            const out = await firstPhotoFix(parsePhotoPaths(record.photo_paths));
                            // `Alert`, not a toast: the user has to read why
                            // nothing happened. (Toasts do show in this sheet —
                            // it mounts its own ToastHost — but one that times
                            // out is the wrong tool for a failure.)
                            if (out.kind === 'needs-photo-access') {
                              // Not asked for here: requesting it would present a
                              // system dialog on a view controller that is already
                              // presenting this sheet.
                              Alert.alert(t('species.usePhotoGnss'), t('species.photoNeedsAccess'));
                              return;
                            }
                            if (out.kind === 'no-gnss') {
                              Alert.alert(t('species.usePhotoGnss'), t('species.photoNoGnss'));
                              return;
                            }
                            // No success notice: the coordinate tile and the map
                            // point below update on the spot.
                            onSaveLocation(out.fix.lat, out.fix.lng, out.fix.accuracyM);
                            if (onSaveElevation && out.fix.altitudeM != null) onSaveElevation(out.fix.altitudeM, 'gnss');
                          }}
                          className="mt-2 flex-row items-center rounded-lg border border-gray-200 px-3 py-2 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
                        >
                          <Ionicons name="image-outline" size={18} color={c.ink2} />
                          <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">
                            {t('species.usePhotoGnss')}
                          </Text>
                        </Pressable>
                      ) : null}
                      {onSaveLocation && onChangeLocation ? (
                        // The map pans on its own; without this the horizontal drag
                        // that moves it would step to the next record instead.
                        <GestureDetector gesture={nav.blocker}>
                          <View>
                            <RecordLocationMap
                              lat={record.lat}
                              lng={record.lng}
                              accuracy={record.accuracy}
                              onChange={onChangeLocation}
                              taxon={{
                                localTaxonId: record.taxon_id,
                                name: record.simple_name,
                                kingdom: record.kingdom,
                              }}
                            />
                          </View>
                        </GestureDetector>
                      ) : null}
                      {vis(mode, 'recordElevation') === 'show' ? elevationField : null}
                      {vis(mode, 'speciesAttributes') === 'show' ? attributesBlock() : null}
                      {extra}
                      {inat ? <InatSyncButton state={inat} /> : null}
                      {/* This record's iNaturalist observation: a record-level
                          link, so it stays here (the taxon's own links moved to
                          分類資訊). */}
                      {record.inat_uploaded_at != null && record.inat_observation_id ? (
                        <Pressable
                          onPress={() => Linking.openURL(observationWebUrl(record.inat_observation_id!))}
                          className="mt-2 flex-row items-center self-start rounded-full bg-accent-50 px-3 py-1.5 active:bg-accent-100 dark:bg-accent-950/40 dark:active:bg-accent-900/60"
                        >
                          <Text className="text-xs font-medium text-accent-700 dark:text-accent-300">
                            {t('species.inatObservation')}
                          </Text>
                          <Ionicons name="open-outline" size={12} color={c.accent} />
                        </Pressable>
                      ) : null}

                      {/* 分類資訊: other names, status, conservation,
                          synonyms, lineage and the taxon's links — the same
                          page the species tab shows. */}
                      {record.taxon_id ? (
                        <Pressable
                          onPress={() => {
                            const r = searchByTaxonId(record.taxon_id);
                            if (r) setTaxonInfo(r);
                            else Alert.alert(t('species.taxonInfo'), t('search.noLocalMatch', { q: record.simple_name }));
                          }}
                          accessibilityRole="button"
                          className="mt-4 flex-row items-center rounded-card border border-line px-4 active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800"
                          style={{ minHeight: 52 }}
                        >
                          <Ionicons name="git-branch-outline" size={20} color={c.ink2} />
                          <Text className="ml-2 flex-1 text-base font-medium text-gray-900 dark:text-gray-100">
                            {t('species.taxonInfo')}
                          </Text>
                          <Ionicons name="chevron-forward" size={18} color={c.ink3} />
                        </Pressable>
                      ) : null}
                    </View>

                    {vis(mode, 'recordMeta') === 'show' ? metaFooter : null}
                    {hasFolded ? (
                      <AdvancedFold className="mx-4 mt-4" summary={t('mode.advSpecies')}>
                        {folded.verbatim}
                        {folded.keys ? <View className="mt-2 flex-row flex-wrap items-center gap-2">{folded.keys}</View> : null}
                        {folded.elevation}
                        {folded.attributes}
                        {folded.meta}
                      </AdvancedFold>
                    ) : null}

                    <View className="flex-row gap-2 px-4 pb-6 pt-4">
                      {onReplaceTaxon ? (
                        <Button
                          label={t('session.changeTaxon')}
                          icon="swap-horizontal"
                          variant="secondary"
                          onPress={onReplaceTaxon}
                          size="lg"
                          className="flex-1"
                        />
                      ) : null}
                      <Button
                        label={t('session.removeFromList')}
                        icon="trash-outline"
                        variant="danger"
                        onPress={() => {
                          onRemove();
                          onClose();
                        }}
                        size="lg"
                        className="flex-1"
                      />
                    </View>
                  </ScrollView>
                </KeyboardAvoidingView>
              </SwipeNavArea>
            </SafeAreaView>
          </GestureHandlerRootView>
        </View>

        <NotesEditModal
          visible={notesModalOpen}
          initialValue={record.notes ?? ''}
          title={record.common_name_c || record.simple_name || t('session.notes')}
          onCancel={() => setNotesModalOpen(false)}
          onSave={(newNotes) => {
            onSaveNotes?.(newNotes);
            setNotesModalOpen(false);
          }}
        />

        <PhotoViewerModal
          photos={parsePhotoPaths(record.photo_paths)}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />

        {/* Nested in this sheet's own Modal, like the two above: a root host
            would open behind it. No add button — the record already holds it. */}
        {taxonInfo ? (
          <LookupResultSheet key={taxonInfo.taxon_id} result={taxonInfo} onClose={() => setTaxonInfo(null)} />
        ) : null}
      </View>
      {/* Toasts fired while this sheet is up (it has its own window). */}
      <ToastHost inModal />
      <ActionSheetLayer />
    </Modal>
  );
}

/**
 * Individual count for one checklist record.
 *
 * Deliberately a plain count and nothing else. The plot survey's
 * `PlotSpeciesValueModal` also offers Braun-Blanquet, % cover and DBH, but
 * those are vegetation-plot methods: abundance RELATIVE to a declared sampling
 * effort (a plot id, a protocol, a sample size). A checklist has no such
 * denominator, so a cover value recorded here would be a fraction of nothing.
 * A bare count is an occurrence attribute and needs no denominator, which is
 * what DwC `individualCount` is.
 *
 * Stepper AND keyboard: field counts are usually 1-3, where tapping ＋ beats
 * opening a keyboard, but a flock is 200 and a stepper alone would be absurd.
 * So the redesign's CountStepper look (52 pt round keys, large figure) is used
 * here with the figure still typeable, rather than CountStepper itself.
 */
function CountField({
  quantity,
  quantityType,
  onCommit,
}: {
  quantity: string | null;
  quantityType: string | null;
  onCommit: (count: number | null) => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  // Anything not recorded as a plain count arrived by import — a BB code or a
  // cover value from a hand-edited yml. Show it, but do not offer to step it:
  // turning "BB: 3" into "4 individuals" would silently change the claim.
  const foreign = quantityType != null && quantityType !== '' && quantityType !== 'individuals';
  const parsed = quantity != null && quantity !== '' ? Number(quantity) : NaN;
  const valid = !foreign && Number.isFinite(parsed) && parsed >= 0;
  const current = valid ? parsed : null;
  const [draft, setDraft] = useState(valid ? String(parsed) : '');
  useEffect(() => {
    setDraft(valid ? String(parsed) : '');
  }, [parsed, valid]);

  if (foreign) {
    return (
      <View className="mt-2 flex-row items-center">
        <Text className="text-sm text-gray-500 dark:text-gray-400">{t('species.count')}</Text>
        <Text className="ml-2 text-sm text-gray-700 dark:text-gray-300">
          {formatQuantityBadge(quantity, quantityType)}
        </Text>
      </View>
    );
  }

  const step = (delta: number) => onCommit(Math.max(0, (current ?? 0) + delta));

  return (
    <View className="mt-3 flex-row items-center justify-center">
      <Text className="mr-3 text-sm text-gray-500 dark:text-gray-400">{t('species.count')}</Text>
      <Pressable
        onPress={() => step(-1)}
        disabled={current == null || current <= 0}
        accessibilityRole="button"
        accessibilityLabel={t('species.countMinus')}
        className={`h-[52px] w-[52px] items-center justify-center rounded-full border border-line bg-card dark:border-line-dark dark:bg-card-dark ${
          current == null || current <= 0 ? 'opacity-40' : 'active:bg-gray-100 dark:active:bg-gray-800'
        }`}
      >
        <Ionicons name="remove" size={26} color={c.ink} />
      </Pressable>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => {
          const raw = draft.trim();
          if (raw === '') {
            onCommit(null);
            return;
          }
          const n = Number(raw);
          // A typo falls back to what is already stored rather than wiping it.
          if (!Number.isFinite(n) || n < 0) {
            setDraft(valid ? String(parsed) : '');
            return;
          }
          onCommit(Math.floor(n));
        }}
        keyboardType="number-pad"
        placeholder={t('species.countUnset')}
        placeholderTextColor={c.ink3}
        className="mx-3 min-w-[72px] rounded-lg border border-line px-2 py-1 text-center text-3xl font-bold text-gray-900 dark:border-line-dark dark:text-gray-100"
        style={{ fontVariant: ['tabular-nums'] }}
      />
      <Pressable
        onPress={() => step(1)}
        accessibilityRole="button"
        accessibilityLabel={t('species.countPlus')}
        className="h-[52px] w-[52px] items-center justify-center rounded-full bg-accent-600 active:bg-accent-700 dark:bg-accent-400 dark:active:bg-accent-300"
      >
        <Ionicons name="add" size={26} color={c.onAccent} />
      </Pressable>
      {current != null ? (
        <Pressable onPress={() => onCommit(null)} hitSlop={8} className="ml-3 active:opacity-70">
          <Text className="text-xs text-gray-500 dark:text-gray-400">{t('species.countClear')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
