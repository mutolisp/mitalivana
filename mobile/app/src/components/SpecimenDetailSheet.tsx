/**
 * Specimen detail — the editable form behind a row in a collection trip.
 * Deliberately assembled from the components the plot / session flows
 * already use (RecordLocationMap, PhotoGrid, SpeciesAttributesBlock,
 * SurveyorAssignSheet) so a specimen looks and behaves like every other record.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Keyboard, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  SwipeNavArea,
  SwipeNavPager,
  usePagerNav,
  type SwipeNavPagerState,
} from './SwipeNavigator';
import { showActionSheet } from './ActionSheet';
import { DateTimeField } from './DateTimeField';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isRecordNumberTaken, nextRecordNumber, type SpecimenWithTaxon } from '~/db';
import { attributesFromRecord, attributesToColumns, EMPTY_DRAFT } from '~/lib/dwcAttributes';
import { errText } from '~/lib/errText';
import { firstPhotoFix } from '~/lib/photoMeta';
import { placeKey, placeNameAt } from '~/lib/reverseGeocode';
import { RecordMetaFooter } from './RecordMetaFooter';
import { PhotoGrid, PhotoViewerModal } from './PhotoGrid';
import { AudioClipList } from './AudioClipList';
import { InatSyncButton, type InatSheetState } from './InatSyncButton';
import { RecordLocationMap } from './RecordLocationMap';
import { ScientificName } from './ScientificName';
import { KeyboardAvoidingView } from './KeyboardAvoidingView';
import { SurveyorAssignSheet } from './SurveyorAssignSheet';
import { SpeciesAttributesBlock, type SpeciesAttributesDraft } from './SpeciesAttributesBlock';
import { VerbatimLabelField } from './VerbatimLabelField';
import { ToastHost } from './ToastHost';

export type SpecimenPatch = {
  record_number?: string;
  collected_at?: number;
  recorded_by?: string | null;
  locality?: string | null;
  identified_by?: string | null;
  notes?: string | null;
  sex?: string | null;
  life_stage?: string | null;
  reproductive_condition?: string | null;
  leaf_phenology?: string | null;
  verbatim_identification?: string | null;
  duplicate_count?: number | null;
  institution_code?: string | null;
  other_catalog_numbers?: string | null;
  catalog_number?: string | null;
  elevation_m?: number | null;
};

type Props = {
  specimen: SpecimenWithTaxon | null;
  onClose: () => void;
  onSave: (patch: SpecimenPatch) => void;
  /** Commit a coordinate. `accuracy` is the GNSS uncertainty in metres for a
   *  real fix, or null when the point was placed by hand on the map. */
  onChangeLocation: (lat: number, lng: number, accuracy: number | null) => void;
  /** Same as onChangeLocation but may clear: nulls remove the coordinate
   *  (long-press on the coordinate row). */
  onSaveLocation: (lat: number | null, lng: number | null, accuracy: number | null) => void;
  onDelete: () => void;
  onAddPhoto: (mode: 'camera' | 'library') => void;
  onRemovePhoto: (uri: string) => void;
  /** A finished recording (file:// URI, already persisted). Parent writes the DB. */
  onAddAudio: (uri: string) => void;
  onRemoveAudio: (uri: string) => void;
  /** Upload / sync to iNat row for this specimen. */
  inat?: InatSheetState;
  /** Hand off to the trip screen's docked SearchBox to re-identify this
   *  specimen. The sheet closes; the collection number is kept. */
  onReplaceTaxon: () => void;
  /** This number is carried by more than one specimen. */
  duplicate?: boolean;
  /** Position in the trip's ON-SCREEN specimen order, so the sheet can step to
   *  the neighbouring specimen by swipe or chevron. Omit to disable. */
  pager?: SwipeNavPagerState;
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="mt-4">
      <Text className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">{label}</Text>
      {children}
    </View>
  );
}

const INPUT_CLASS =
  'rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-gray-100';

export function SpecimenDetailSheet({
  specimen,
  onClose,
  onSave,
  onChangeLocation,
  onSaveLocation,
  onDelete,
  onAddPhoto,
  onRemovePhoto,
  onAddAudio,
  onRemoveAudio,
  inat,
  onReplaceTaxon,
  duplicate,
  pager,
}: Props) {
  const { t } = useTranslation();
  // SafeAreaView reports 0 inset inside a Modal (separate view hierarchy, no
  // provider) — apply the top inset by hand.
  const insets = useSafeAreaInsets();
  const [number, setNumber] = useState('');
  const [locality, setLocality] = useState('');
  const [institution, setInstitution] = useState('');
  const [otherNumbers, setOtherNumbers] = useState('');
  const [catalog, setCatalog] = useState('');
  const [elevation, setElevation] = useState('');
  // Mirrors for the async place lookup below: when it resolves, it must know
  // whether the same specimen is still open and its locality still empty.
  const openIdRef = useRef<number | null>(null);
  const localityRef = useRef('');
  useEffect(() => {
    openIdRef.current = specimen?.id ?? null;
  }, [specimen?.id]);
  useEffect(() => {
    localityRef.current = locality;
  }, [locality]);
  const [notes, setNotes] = useState('');
  const [attrs, setAttrs] = useState<SpeciesAttributesDraft>(EMPTY_DRAFT);
  const [assigning, setAssigning] = useState<'collector' | 'determiner' | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  /**
   * Every text field here commits on blur, and the parent's `onSave` writes to
   * whichever specimen is currently open — so stepping away while a field still
   * holds focus would land the old text on the new specimen. Dismissing the
   * keyboard fires those blur handlers, and the step waits one frame for them.
   */
  const guardedPager = useMemo<SwipeNavPagerState | undefined>(() => {
    if (!pager) return undefined;
    return {
      ...pager,
      onStep: (dir) => {
        Keyboard.dismiss();
        requestAnimationFrame(() => pager.onStep(dir));
      },
    };
  }, [pager]);
  const nav = usePagerNav(guardedPager);

  // Re-seed the drafts only when a DIFFERENT specimen is opened.
  //
  // Keyed on the id on purpose: every save hands back a fresh `specimen` object
  // for the same row, and depending on the object would re-seed mid-edit and
  // wipe whatever the user is currently typing in another field. Do not "fix"
  // this by adding `specimen` to the deps.
  useEffect(() => {
    if (!specimen) return;
    setNumber(specimen.record_number);
    setLocality(specimen.locality ?? '');
    setInstitution(specimen.institution_code ?? '');
    setOtherNumbers(specimen.other_catalog_numbers ?? '');
    setCatalog(specimen.catalog_number ?? '');
    setElevation(specimen.elevation_m != null ? String(specimen.elevation_m) : '');
    setNotes(specimen.notes ?? '');
    setAttrs(attributesFromRecord(specimen));
    // Stepping keeps the sheet mounted, so the next specimen would otherwise
    // open scrolled to wherever the previous one was left.
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specimen?.id]);

  /**
   * When the open specimen's coordinate CHANGES (GNSS button, photo GNSS, a
   * photo added with a position, a point placed on the map), fill an EMPTY
   * locality with the place the system geocoder names. Needs network; offline
   * nothing happens. Opening a specimen never triggers it — only a change seen
   * while the same specimen stays open — and it never overwrites: the checks
   * run again when the answer arrives, because the user may have typed a
   * locality, or moved to another specimen, meanwhile.
   */
  const lastCoordRef = useRef<{ id: number; key: string } | null>(null);
  useEffect(() => {
    if (!specimen) return;
    const { id, lat, lng } = specimen;
    const key = lat != null && lng != null ? placeKey(lat, lng) : '';
    const prev = lastCoordRef.current;
    lastCoordRef.current = { id, key };
    if (!prev || prev.id !== id || !key || prev.key === key) return;
    if (localityRef.current.trim()) return;
    void placeNameAt(lat!, lng!).then((place) => {
      if (!place || openIdRef.current !== id || localityRef.current.trim()) return;
      setLocality(place);
      onSave({ locality: place });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specimen?.id, specimen?.lat, specimen?.lng]);

  if (!specimen) return null;

  const photos = parsePhotoPaths(specimen.photo_paths);

  /**
   * Commit a hand-typed collection number.
   *
   * Auto-assigned numbers can't collide (`nextRecordNumber` skips occupied
   * ones), so this is the only path that can create a duplicate. It warns
   * rather than blocks: duplicate sheets of one gathering legitimately share a
   * number, and imported data may already contain repeats.
   */
  const commitNumber = async () => {
    if (!specimen) return;
    const value = number.trim();
    if (!value || value === specimen.record_number) {
      setNumber(specimen.record_number);
      return;
    }
    if (!isRecordNumberTaken(value, specimen.id)) {
      onSave({ record_number: value });
      return;
    }
    const free = nextRecordNumber().text;
    const idx = await showActionSheet({
      title: t('collection.dupTitle'),
      message: t('collection.dupMsg', { number: value }),
      cancelLabel: t('common.cancel'),
      options: [
        { label: t('collection.dupUseAnyway') },
        { label: t('collection.dupUseNext', { number: free }) },
      ],
    });
    if (idx === 0) onSave({ record_number: value });
    else if (idx === 1) {
      setNumber(free);
      onSave({ record_number: free });
    } else {
      setNumber(specimen.record_number); // cancelled — put the old one back
    }
  };

  const commitAttrs = (next: SpeciesAttributesDraft) => {
    setAttrs(next);
    // `attributesToColumns` serializes all four columns. Spelling this out by
    // hand is what previously dropped sex / life_stage on save.
    onSave(attributesToColumns(next));
  };

  const commitElevation = () => {
    const text = elevation.trim();
    if (!text) {
      onSave({ elevation_m: null });
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) {
      // Not a number — put the stored value back rather than save garbage.
      setElevation(specimen.elevation_m != null ? String(specimen.elevation_m) : '');
      return;
    }
    onSave({ elevation_m: n });
  };

  // The coordinate row, photo button and map below mirror SpeciesDetailSheet
  // and PlotSpeciesValueModal: one location block, three record kinds.
  const locateMe = async () => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
      return;
    }
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      // A real fix carries its uncertainty; keep it (DwC coordinateUncertaintyInMeters).
      onSaveLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
      // Altitude comes with the fix when the receiver reports one; rounded
      // like the plot's, and editable below.
      if (pos.coords.altitude != null) {
        const m = Math.round(pos.coords.altitude);
        setElevation(String(m));
        onSave({ elevation_m: m });
      }
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  // Same rule and messages as SpeciesDetailSheet's 「用照片的 GNSS 定位」:
  // `Alert`, not a toast: a failure the user has to read, not one that should
  // time out; and no permission request from in here (it would present a
  // system dialog over this Modal).
  const locateFromPhotos = async () => {
    const out = await firstPhotoFix(photos);
    if (out.kind === 'needs-photo-access') {
      Alert.alert(t('species.usePhotoGnss'), t('species.photoNeedsAccess'));
      return;
    }
    if (out.kind === 'no-gnss') {
      Alert.alert(t('species.usePhotoGnss'), t('species.photoNoGnss'));
      return;
    }
    onSaveLocation(out.fix.lat, out.fix.lng, out.fix.accuracyM);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      {/* gesture-handler needs its own root inside a Modal's view hierarchy. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 bg-gray-50 dark:bg-gray-900" style={{ paddingTop: insets.top }}>
          <View className="flex-row items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
            <Pressable onPress={onClose} hitSlop={8} className="active:opacity-60">
              <Ionicons name="chevron-down" size={24} color="#6b7280" />
            </Pressable>
            <Text
              className="flex-1 px-3 text-base font-semibold text-gray-900 dark:text-gray-100"
              numberOfLines={1}
            >
              {specimen.record_number}
            </Text>
            <Pressable onPress={onDelete} hitSlop={8} className="active:opacity-60">
              <Ionicons name="trash-outline" size={20} color="#dc2626" />
            </Pressable>
          </View>
          <SwipeNavPager state={guardedPager} />

          {/* This sheet has three text fields — locality, notes and the record
            number — and the last of them sits at the very bottom, so without
            keyboard avoidance the keyboard simply covers whatever is being
            typed. Every other sheet with a TextInput already wraps its
            ScrollView this way; this one was the only one that did not. */}
          <SwipeNavArea nav={nav}>
            <KeyboardAvoidingView className="flex-1" behavior="padding">
              <ScrollView
                ref={scrollRef}
                className="flex-1 px-4"
                contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
                keyboardShouldPersistTaps="handled"
              >
                {/* Species identity */}
                <View className="mt-4 rounded-lg bg-white p-3 dark:bg-gray-800">
                  {specimen.common_name_c ? (
                    <Text className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {specimen.common_name_c}
                    </Text>
                  ) : null}
                  <ScientificName
                    name={specimen.simple_name}
                    author={specimen.name_author}
                    kingdom={specimen.kingdom}
                    rank={specimen.rank}
                    className="text-base text-gray-700 dark:text-gray-300"
                  />
                  {specimen.family ? (
                    <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {specimen.family_c
                        ? `${specimen.family_c} (${specimen.family})`
                        : specimen.family}
                    </Text>
                  ) : null}
                  {/* Writes straight through rather than waiting for a blur
                      like the text fields around it: the field owns its own
                      confirm button, so there is nothing left pending. */}
                  <VerbatimLabelField
                    key={specimen.id}
                    rank={specimen.rank}
                    value={specimen.verbatim_identification}
                    onCommit={(v) => onSave({ verbatim_identification: v })}
                  />
                  <Pressable
                    onPress={onReplaceTaxon}
                    hitSlop={6}
                    className="mt-2 flex-row items-center self-start active:opacity-70"
                  >
                    <Ionicons name="swap-horizontal" size={14} color="#2563eb" />
                    <Text className="ml-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                      {t('collection.changeTaxon')}
                    </Text>
                  </Pressable>
                </View>

                <Field label={t('collection.recordNumber')}>
                  <TextInput
                    value={number}
                    onChangeText={setNumber}
                    onBlur={commitNumber}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    className={INPUT_CLASS}
                  />
                  {duplicate ? (
                    <View className="mt-1 flex-row items-center">
                      <Ionicons name="warning-outline" size={13} color="#d97706" />
                      <Text className="ml-1 text-[11px] text-amber-600 dark:text-amber-500">
                        {t('collection.dupBadge')}
                      </Text>
                    </View>
                  ) : null}
                  <Text className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                    {t('collection.recordNumberHint')}
                  </Text>
                </Field>

                {/* 日期與時間分成兩欄，但底下仍是同一個 collected_at timestamp —— 各自
                只改自己那一半（見 DateTimeField 的 mergePart），不需要動 schema。 */}
                <Field label={t('collection.collectedDate')}>
                  <DateTimeField
                    mode="date"
                    value={specimen.collected_at}
                    onChange={(ts) => onSave({ collected_at: ts })}
                  />
                </Field>

                <Field label={t('collection.collectedTime')}>
                  <DateTimeField
                    mode="time"
                    value={specimen.collected_at}
                    onChange={(ts) => onSave({ collected_at: ts })}
                  />
                </Field>

                <Field label={t('collection.collector')}>
                  <Pressable
                    onPress={() => setAssigning('collector')}
                    className="flex-row items-center rounded-lg border border-gray-300 bg-white px-3 py-2 active:opacity-70 dark:border-gray-600 dark:bg-gray-800"
                  >
                    <Ionicons
                      name="people-outline"
                      size={16}
                      color={specimen.recorded_by ? '#2563eb' : '#9ca3af'}
                    />
                    <Text
                      className={`ml-2 flex-1 text-base ${specimen.recorded_by ? 'text-gray-900 dark:text-gray-100' : 'italic text-gray-400 dark:text-gray-500'}`}
                      numberOfLines={1}
                    >
                      {specimen.recorded_by || t('collection.collectorEmpty')}
                    </Text>
                  </Pressable>
                </Field>

                {/* Who put the name on the sheet — routinely not the collector, and a
                re-determination changes only this. */}
                <Field label={t('collection.determiner')}>
                  <Pressable
                    onPress={() => setAssigning('determiner')}
                    className="flex-row items-center rounded-lg border border-gray-300 bg-white px-3 py-2 active:opacity-70 dark:border-gray-600 dark:bg-gray-800"
                  >
                    <Ionicons
                      name="ribbon-outline"
                      size={16}
                      color={specimen.identified_by ? '#2563eb' : '#9ca3af'}
                    />
                    <Text
                      className={`ml-2 flex-1 text-base ${specimen.identified_by ? 'text-gray-900 dark:text-gray-100' : 'italic text-gray-400 dark:text-gray-500'}`}
                      numberOfLines={1}
                    >
                      {specimen.identified_by || t('collection.determinerEmpty')}
                    </Text>
                  </Pressable>
                </Field>

                <Field label={t('collection.locality')}>
                  <TextInput
                    value={locality}
                    onChangeText={setLocality}
                    onBlur={() => onSave({ locality: locality.trim() || null })}
                    placeholder={t('collection.localityPlaceholder')}
                    placeholderTextColor="#9ca3af"
                    className={INPUT_CLASS}
                  />
                  <Pressable
                    onPress={locateMe}
                    onLongPress={
                      specimen.lat !== null
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
                    className="mt-2 flex-row items-center rounded-lg border border-gray-200 px-3 py-2 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
                  >
                    <Ionicons
                      name={specimen.lat !== null ? 'location' : 'location-outline'}
                      size={18}
                      color={specimen.lat !== null ? '#2563eb' : '#4b5563'}
                    />
                    <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300" selectable>
                      {specimen.lat !== null && specimen.lng !== null
                        ? `${specimen.lat.toFixed(5)}, ${specimen.lng.toFixed(5)}${
                            specimen.accuracy !== null
                              ? ` (±${Math.round(specimen.accuracy)}m)`
                              : ''
                          }`
                        : t('species.locateSpecies')}
                    </Text>
                    <Text className="text-xs text-gray-400 dark:text-gray-500">
                      {specimen.lat !== null ? t('species.longPressClear') : t('species.tapGnss')}
                    </Text>
                  </Pressable>
                  {/* Only with photos and no position — a measured point is
                      never overwritten by a button. */}
                  {specimen.lat === null && photos.length > 0 ? (
                    <Pressable
                      onPress={locateFromPhotos}
                      className="mt-2 flex-row items-center rounded-lg border border-gray-200 px-3 py-2 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
                    >
                      <Ionicons name="image-outline" size={18} color="#4b5563" />
                      <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">
                        {t('species.usePhotoGnss')}
                      </Text>
                    </Pressable>
                  ) : null}
                  {/* The map pans on its own; block the swipe so a sideways drag
                  moves the map instead of stepping to the next specimen. */}
                  <GestureDetector gesture={nav.blocker}>
                    <View>
                      <RecordLocationMap
                        lat={specimen.lat}
                        lng={specimen.lng}
                        accuracy={specimen.accuracy}
                        // A hand-placed point has no measured uncertainty and arrives
                        // with null; an undo hands the previous one back.
                        onChange={onChangeLocation}
                        taxon={{
                          localTaxonId: specimen.taxon_id,
                          name: specimen.simple_name,
                          kingdom: specimen.kingdom,
                        }}
                      />
                    </View>
                  </GestureDetector>
                </Field>

                <Field label={t('collection.elevation')}>
                  <View className="flex-row items-center">
                    <TextInput
                      value={elevation}
                      onChangeText={setElevation}
                      onBlur={commitElevation}
                      placeholder={t('collection.elevationPlaceholder')}
                      placeholderTextColor="#9ca3af"
                      keyboardType="numbers-and-punctuation"
                      className={`${INPUT_CLASS} flex-1`}
                    />
                    <Text className="ml-2 text-sm text-gray-500 dark:text-gray-400">m</Text>
                  </View>
                </Field>

                {/* Herbarium bookkeeping (v43). Duplicates are a count, not a
                    list of destinations: in the field you know you took three
                    sheets, and which herbaria they end up in is decided later
                    — usually not by the collector. */}
                <Field label={t('collection.duplicates')}>
                  <View className="flex-row items-center gap-3">
                    <Pressable
                      onPress={() =>
                        onSave({
                          duplicate_count: Math.max(0, (specimen.duplicate_count ?? 0) - 1),
                        })
                      }
                      disabled={(specimen.duplicate_count ?? 0) <= 0}
                      hitSlop={8}
                      className={`h-9 w-9 items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 ${
                        (specimen.duplicate_count ?? 0) <= 0 ? 'opacity-40' : 'active:bg-gray-100 dark:active:bg-gray-700'
                      }`}
                    >
                      <Ionicons name="remove" size={18} color="#4b5563" />
                    </Pressable>
                    <Text className="min-w-[48px] text-center text-base text-gray-900 dark:text-gray-100">
                      {specimen.duplicate_count ?? t('collection.duplicatesUnset')}
                    </Text>
                    <Pressable
                      onPress={() =>
                        onSave({ duplicate_count: (specimen.duplicate_count ?? 0) + 1 })
                      }
                      hitSlop={8}
                      className="h-9 w-9 items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 active:bg-gray-100 dark:active:bg-gray-700"
                    >
                      <Ionicons name="add" size={18} color="#4b5563" />
                    </Pressable>
                    {specimen.duplicate_count != null ? (
                      <Pressable
                        onPress={() => onSave({ duplicate_count: null })}
                        hitSlop={8}
                        className="active:opacity-70"
                      >
                        <Text className="text-xs text-gray-500 dark:text-gray-400">
                          {t('collection.duplicatesClear')}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </Field>

                <Field label={t('collection.institution')}>
                  <TextInput
                    value={institution}
                    onChangeText={setInstitution}
                    // Uppercased on commit: institutionCode is an acronym
                    // (TAI, HAST), and a lowercase one will not match anything
                    // downstream.
                    onBlur={() =>
                      onSave({ institution_code: institution.trim().toUpperCase() || null })
                    }
                    placeholder={t('collection.institutionPlaceholder')}
                    placeholderTextColor="#9ca3af"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label={t('collection.catalogNumber')}>
                  <TextInput
                    value={catalog}
                    onChangeText={setCatalog}
                    onBlur={() => onSave({ catalog_number: catalog.trim() || null })}
                    placeholder={t('collection.catalogNumberPlaceholder')}
                    placeholderTextColor="#9ca3af"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label={t('collection.otherNumbers')}>
                  <TextInput
                    value={otherNumbers}
                    onChangeText={setOtherNumbers}
                    onBlur={() =>
                      onSave({ other_catalog_numbers: otherNumbers.trim() || null })
                    }
                    placeholder={t('collection.otherNumbersPlaceholder')}
                    placeholderTextColor="#9ca3af"
                    autoCorrect={false}
                    className={INPUT_CLASS}
                  />
                </Field>

                <View className="mt-4">
                  <SpeciesAttributesBlock
                    kingdom={specimen.kingdom}
                    className={specimen.class}
                    value={attrs}
                    onChange={commitAttrs}
                    headerLabel={t('collection.attributes')}
                  />
                </View>

                <Field label={t('collection.remarks')}>
                  <TextInput
                    value={notes}
                    onChangeText={setNotes}
                    onBlur={() => onSave({ notes: notes.trim() || null })}
                    placeholder={t('collection.remarksPlaceholder')}
                    placeholderTextColor="#9ca3af"
                    multiline
                    className={`${INPUT_CLASS} min-h-[72px]`}
                    textAlignVertical="top"
                  />
                </Field>

                <Field label={t('collection.photos')}>
                  <PhotoGrid
                    photos={photos}
                    onAdd={() => onAddPhoto('camera')}
                    onPickLibrary={() => onAddPhoto('library')}
                    onView={(i) => setViewerIndex(i)}
                    onRemove={onRemovePhoto}
                  />
                </Field>

                <Field label={t('species.audioClips')}>
                  <AudioClipList
                    clips={parsePhotoPaths(specimen?.audio_paths ?? null)}
                    onAdd={onAddAudio}
                    onRemove={onRemoveAudio}
                  />
                </Field>
                {inat ? <InatSyncButton state={inat} /> : null}
                <RecordMetaFooter
                  occurrenceId={specimen.occurrence_id}
                  updatedAt={specimen.updated_at}
                  inatObservationId={
                    specimen.inat_uploaded_at != null ? specimen.inat_observation_id : null
                  }
                />
              </ScrollView>
            </KeyboardAvoidingView>
          </SwipeNavArea>
        </View>
      </GestureHandlerRootView>

      <PhotoViewerModal photos={photos} index={viewerIndex} onClose={() => setViewerIndex(null)} />
      <SurveyorAssignSheet
        visible={assigning !== null}
        // The determiner is its own list of people: whoever named the specimen
        // is often not whoever collected it.
        kind={assigning === 'determiner' ? 'identifier' : 'surveyor'}
        current={(assigning === 'determiner' ? specimen.identified_by : specimen.recorded_by) ?? ''}
        onCancel={() => setAssigning(null)}
        onAssign={(v) => {
          const field = assigning;
          setAssigning(null);
          if (field === 'determiner') onSave({ identified_by: v || null });
          else onSave({ recorded_by: v || null });
        }}
      />
      {/* Toasts fired while this sheet is up (it has its own window). */}
      <ToastHost inModal />
    </Modal>
  );
}
