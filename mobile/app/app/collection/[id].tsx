/**
 * Collection trip detail — the specimens gathered on one outing, shown as a
 * list. Structurally the thin sibling of `app/session/[id].tsx`: a metadata
 * row, a list, and a sticky SearchBox at the bottom.
 *
 * Note there is no single-active conflict handling here. A collection trip is
 * not part of the app-wide single-active invariant, so opening or reopening one
 * never disturbs an in-progress checklist or plot survey.
 */
import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import type { AdoptionInput } from '~/db';
import * as Location from 'expo-location';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler, FlatList, Keyboard, Pressable, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import {
  addSpecimen,
  deleteSpecimen,
  withTransaction,
  duplicateRecordNumbers,
  duplicateSpecimen,
  endCollectionTrip,
  getCollectionTrip,
  getProject,
  getSpecimen,
  crossRegionVernacular,
  pickVernacular,
  regionOfTaxonId,
  listSpecimens,
  nextRecordNumber,
  reopenCollectionTrip,
  getSite,
  updateCollectionTrip,
  updateSpecimen,
  updateSpecimenTaxon,
  updateSpecimenLocation,
  updateSpecimenPhotos,
  updateSpecimenAudio,
  type CollectionTrip,
  type Project,
  type SearchResult,
  type SpecimenWithTaxon,
} from '~/db';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { RecordStepBar } from '~/components/RecordStepBar';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { showActionSheet } from '~/components/ActionSheet';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { SurveyTimesModal } from '~/components/SurveyTimeFields';
import { RecordEditButtons } from '~/components/RecordEditButtons';
import { hasInatChanges, syncRecord, useInatSync } from '~/lib/inatUpload';
import { inatTokenAvailableQuietly } from '~/lib/inatAuth';
import { apiErrorMessage } from '~/lib/apiErrorMessage';
import { rebaseAppFileUri } from '~/lib/appFiles';
import { familyLatinFirst } from '~/lib/familyLabel';
import { LabelExportSheet } from '~/components/LabelExportSheet';
import { DOC_FORMATS } from '~/lib/docFormat';
import i18n from '~/i18n';
import { placeKey, placeNameAt, placeNamesAt } from '~/lib/reverseGeocode';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { shareThenDelete } from '~/lib/shareFile';
import { useSettings, type CollectionSort, type SortDirection } from '~/stores/settings';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import { ScientificName } from '~/components/ScientificName';
import { SearchBox } from '~/components/SearchBox';
import { SpecimenDetailSheet, type SpecimenPatch } from '~/components/SpecimenDetailSheet';
import { SiteAssignSheet } from '~/components/SiteAssignSheet';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { SwipeRowActions } from '~/components/SwipeRowActions';
import { promptText } from '~/components/TextPromptModal';
import { BackHeaderLeft } from '~/lib/goBack';
import { isoDateTime } from '~/lib/datetime';
import { firstPhotoFix, rememberPickedPhotos } from '~/lib/photoMeta';
import {
  reproductiveLabel,
  leafPhenologyLabel,
  sexLabel,
  lifeStageLabel,
  parseMultiAttribute,
} from '~/lib/dwcAttributes';
import { useToast } from '~/stores/toast';

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

/** DwC species attributes, flattened to one short line for the row. Ordered to
 *  match the detail sheet: sex → life stage → phenology. */
function attributeSummary(sp: SpecimenWithTaxon): string {
  const parts = [
    sexLabel(sp.sex),
    lifeStageLabel(sp.life_stage),
    ...parseMultiAttribute(sp.reproductive_condition).map(reproductiveLabel),
    ...parseMultiAttribute(sp.leaf_phenology).map(leafPhenologyLabel),
  ].filter(Boolean);
  return parts.join('・');
}

const SORT_LABEL: Record<CollectionSort, string> = {
  collected: 'collection.sortCollected',
  number: 'collection.sortNumber',
  family: 'collection.sortFamily',
  name: 'collection.sortName',
};

/**
 * Order the specimen list.
 *
 * Collection number is NOT a string compare: `record_number` is `DAO0001`, and
 * `DAO10` would sort before `DAO9`. The numeric tail already exists as
 * `record_number_seq`, so that is what is compared; a specimen whose number has
 * no numeric tail (`s.n.`, a voucher code) has a null seq and is put after the
 * numbered ones rather than silently interleaved at zero.
 */
function sortSpecimens(
  list: SpecimenWithTaxon[],
  key: CollectionSort,
  dir: SortDirection,
): SpecimenWithTaxon[] {
  const sign = dir === 'desc' ? -1 : 1;
  const out = [...list];
  out.sort((a, b) => {
    switch (key) {
      case 'number': {
        const as = a.record_number_seq;
        const bs = b.record_number_seq;
        // Unnumbered specimens stay after the numbered ones in BOTH
        // directions — descending is about the numbers, not about them.
        if (as == null && bs == null) return sign * a.record_number.localeCompare(b.record_number);
        if (as == null) return 1;
        if (bs == null) return -1;
        return sign * (as - bs);
      }
      case 'family':
        return (
          sign *
          ((a.family || '\uffff').localeCompare(b.family || '\uffff') ||
            a.simple_name.localeCompare(b.simple_name))
        );
      case 'name':
        return sign * a.simple_name.localeCompare(b.simple_name);
      case 'collected':
      default:
        return sign * (a.collected_at - b.collected_at || a.id - b.id);
    }
  });
  return out;
}

function SpecimenRow({
  specimen,
  duplicate,
  selectMode,
  picked,
  onPress,
  onLongPress,
}: {
  specimen: SpecimenWithTaxon;
  /** This collection number is carried by more than one specimen. */
  duplicate: boolean;
  selectMode: boolean;
  picked: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const photos = parsePhotoPaths(specimen.photo_paths);
  const attributes = attributeSummary(specimen);
  // Already on iNaturalist → tinted row (see migrations.ts v30).
  const uploaded = specimen.inat_uploaded_at != null;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      className={`flex-row items-center border-b border-gray-100 px-4 py-3 dark:border-gray-800 ${uploaded ? 'bg-lime-50 active:bg-lime-100 dark:bg-lime-900/30 dark:active:bg-lime-900/50' : 'bg-white active:bg-gray-50 dark:bg-gray-900 dark:active:bg-gray-800'}`}
    >
      {selectMode ? (
        <Ionicons
          name={picked ? 'checkbox' : 'square-outline'}
          size={20}
          color={picked ? '#2563eb' : '#9ca3af'}
          style={{ marginRight: 10 }}
        />
      ) : null}
      {photos.length > 0 ? (
        <View className="mr-3">
          <Image
            source={{ uri: rebaseAppFileUri(photos[0]) }}
            style={{ width: 44, height: 44, borderRadius: 6 }}
            contentFit="cover"
          />
          {photos.length > 1 ? (
            <View className="absolute -right-1 -top-1 rounded-full bg-gray-900/80 px-1.5">
              <Text className="text-[10px] font-medium text-white">{photos.length}</Text>
            </View>
          ) : null}
        </View>
      ) : (
        <View className="mr-3 h-11 w-11 items-center justify-center rounded-md bg-gray-100 dark:bg-gray-800">
          <Ionicons name="leaf-outline" size={18} color="#94a3b8" />
        </View>
      )}
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            {specimen.record_number}
          </Text>
          {duplicate ? (
            <Ionicons name="warning" size={12} color="#d97706" style={{ marginLeft: 3 }} />
          ) : null}
          {specimen.common_name_c || specimen.verbatim_identification ? (
            <Text
              className="ml-2 flex-1 text-base text-gray-900 dark:text-gray-100"
              numberOfLines={1}
            >
              {specimen.common_name_c}
              {/* The field determination (v39), on the name line for the same
                  reason SpeciesCard puts it there. Rendered even without a
                  Chinese name, which is the common case for a `sp1` under a
                  family. */}
              {specimen.verbatim_identification ? (
                <Text className="text-gray-500 dark:text-gray-400">
                  {specimen.common_name_c
                    ? ` · ${specimen.verbatim_identification}`
                    : specimen.verbatim_identification}
                </Text>
              ) : null}
            </Text>
          ) : null}
        </View>
        <ScientificName
          name={specimen.simple_name}
          author={specimen.name_author}
          kingdom={specimen.kingdom}
          rank={specimen.rank}
          className="text-xs text-gray-600 dark:text-gray-400"
          numberOfLines={1}
        />
        {/* Latin first here — the herbarium convention, and deliberately the
            reverse of every other list in the app, which leads with the Chinese
            name. Asked for explicitly for this screen. */}
        {familyLatinFirst(specimen.family, specimen.family_c) ? (
          <Text className="text-[11px] text-gray-500 dark:text-gray-400" numberOfLines={1}>
            {familyLatinFirst(specimen.family, specimen.family_c)}
          </Text>
        ) : null}
        <View className="mt-0.5 flex-row items-center">
          <Text className="text-[11px] text-gray-400 dark:text-gray-500">
            {isoDateTime(specimen.collected_at)}
          </Text>
          {specimen.lat !== null ? (
            <Ionicons name="location" size={11} color="#2563eb" style={{ marginLeft: 6 }} />
          ) : null}
          {attributes ? (
            <Text
              className="ml-2 flex-1 text-[11px] text-emerald-700 dark:text-emerald-400"
              numberOfLines={1}
            >
              {attributes}
            </Text>
          ) : null}
        </View>
      </View>
      {selectMode ? null : <Ionicons name="chevron-forward" size={16} color="#9ca3af" />}
    </Pressable>
  );
}

export default function CollectionTripScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tripId = Number(id);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const router = useRouter();

  const [trip, setTrip] = useState<CollectionTrip | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [specimens, setSpecimens] = useState<SpecimenWithTaxon[]>([]);
  const [active, setActive] = useState<SpecimenWithTaxon | null>(null);
  const [dupNumbers, setDupNumbers] = useState<Set<string>>(new Set());
  // Non-null = the docked SearchBox re-identifies that specimen instead of
  // adding a new one. Lives here because the SearchBox is a screen-level dock;
  // hosting one inside the detail Modal would need its own keyboard handling.
  const sortKey = useSettings((st) => st.collection_sort);
  const sortDir = useSettings((st) => st.collection_sort_dir);
  const docFormat = useSettings((st) => st.export_doc_format);
  const setSetting = useSettings((st) => st.set);
  /** Multi-select for the label export. Local state, like favorites: it belongs
   *  to this one screen and never has to survive navigation. */
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [labelSheetOpen, setLabelSheetOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<SpecimenWithTaxon | null>(null);
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [surveyorSheetOpen, setSurveyorSheetOpen] = useState(false);
  const [siteSheetOpen, setSiteSheetOpen] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);

  // Lock + undo / redo (src/lib/useRecordEditing): a finished trip is
  // read-only until unlocked here; every reload after an edit is one step.
  const edit = useRecordEditing('collection', tripId, trip != null && trip.status !== 'active');
  const { checkpoint, absorb } = edit;
  // Remounts the detail sheet after a refused edit, so its fields drop what
  // was typed and show the specimen again.
  const [detailKey, setDetailKey] = useState(0);
  /** Run an edit unless the trip is locked. */
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      if (edit.refuse()) {
        setDetailKey((k) => k + 1);
        return;
      }
      fn(...a);
    };

  const refresh = useCallback(() => {
    const tr = getCollectionTrip(tripId);
    setTrip(tr);
    setProject(tr ? getProject(tr.project_id) : null);
    setSpecimens(listSpecimens(tripId));
    setDupNumbers(duplicateRecordNumbers());
  }, [tripId]);
  const reload = useCallback(() => {
    refresh();
    checkpoint();
  }, [refresh, checkpoint]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  /** Keep the open sheet in sync after any write. */
  const refreshActive = (specimenId: number) => {
    setActive(getSpecimen(specimenId));
    reload();
  };

  const isActive = trip?.status === 'active';
  // Resolved on render rather than stored: the site row can be renamed or
  // deleted elsewhere, and the chip must not keep showing a stale name.
  const tripSite = trip?.site_id != null ? getSite(trip.site_id) : null;

  const handleAdd = async (result: SearchResult, adopted?: AdoptionInput | null) => {
    if (!result.taxon_id) {
      toast(t('session.noTaxonId'));
      return;
    }
    // Re-identification: keep the collection number (it names the physical
    // gathering) and swap only the determination.
    if (replaceTarget) {
      const target = replaceTarget;
      setReplaceTarget(null);
      // Not `updateSpecimen({ taxon_id })`: that leaves the adoption columns
      // pointing at the previous determination and skips the taxon cache copy.
      updateSpecimenTaxon(target.id, result.taxon_id, adopted);
      reload();
      toast(
        t('collection.taxonChanged', {
          number: target.record_number,
          name: result.cname || result.name,
        }),
      );
      return;
    }
    const number = nextRecordNumber().text;
    // The new specimen's detail sheet opens once it is inserted. When the pick
    // went through the name-usage picker (an action sheet, or the GBIF lookup
    // Modal), that UI is still animating out, and iOS silently refuses to
    // present a Modal over a dismissing one — so the sheet waits out the same
    // 450 ms the rest of the app uses. Started now, it overlaps the GNSS fix
    // below instead of adding to it.
    const settled = new Promise((r) => setTimeout(r, 450));
    // A specimen's coordinate is its collecting locality, so stamp the current
    // fix at insert when permission is already granted. Silent on failure — the
    // user can always place the point on the map in the detail sheet.
    let coords: {
      lat: number;
      lng: number;
      accuracy: number | null;
      altitude: number | null;
    } | null = null;
    try {
      const perm = await Location.getForegroundPermissionsAsync();
      if (perm.granted) {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        coords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          altitude: pos.coords.altitude != null ? Math.round(pos.coords.altitude) : null,
        };
      }
    } catch {
      // no fix — leave the specimen ungeoreferenced
    }
    // The specimen's locality starts EMPTY, not as a copy of the trip's: a
    // trip-wide name ("測試地點", a mountain) says nothing about where this
    // sheet was taken, and once filled it blocked the place lookup below. The
    // trip's locality still travels with the export at the event level.
    const newId = addSpecimen({
      trip_id: tripId,
      taxon_id: result.taxon_id,
      adopted,
      record_number: number,
      locality: null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      accuracy: coords?.accuracy ?? null,
      elevation_m: coords?.altitude ?? null,
      elevation_source: coords?.altitude != null ? 'gnss' : null,
    });
    reload();
    toast(t('collection.added', { number, name: result.cname || result.name }));
    if (newId) {
      await settled;
      Keyboard.dismiss();
      // Unless the user opened another specimen while the fix was coming in.
      setActive((prev) => prev ?? getSpecimen(newId));
    }
    // Name the place from the fix, in the background (needs network). Re-read
    // before writing — the user may have typed one while the lookup ran.
    // Offline or no answer: the locality stays blank.
    if (coords && newId) {
      const place = await placeNameAt(coords.lat, coords.lng);
      if (place && !getSpecimen(newId)?.locality) {
        updateSpecimen(newId, { locality: place });
        // The app's own late write: part of the add, not an undo step.
        refresh();
        absorb();
        // The sheet is most likely open on it by now; hand it the new row.
        setActive((prev) => (prev?.id === newId ? getSpecimen(newId) : prev));
      }
    }
  };

  const handleDuplicate = (specimen: SpecimenWithTaxon) => {
    const id = duplicateSpecimen(specimen.id);
    if (id === null) return;
    reload();
    const created = getSpecimen(id);
    toast(
      t('collection.duplicated', {
        number: created?.record_number ?? '',
        name: specimen.common_name_c || specimen.simple_name,
      }),
    );
  };

  const togglePick = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitSelect = () => {
    setSelectMode(false);
    setPicked(new Set());
  };

  // Long-press enters select mode with that row picked — the records tab,
  // favorites and sites screens all work this way.
  const handleLongPress = (sp: SpecimenWithTaxon) => {
    if (selectMode) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectMode(true);
    setPicked(new Set([sp.id]));
  };

  // Android hardware back unwinds select mode before leaving the screen. Read
  // through a ref so the once-registered listener never sees a stale flag.
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!selectModeRef.current) return false;
        setSelectMode(false);
        setPicked(new Set());
        return true;
      });
      return () => sub.remove();
    }, []),
  );

  // Sorted once: the list, select-all and the exported label order all read the
  // same array, so labels come out in whatever order is on screen.
  const display = sortSpecimens(specimens, sortKey, sortDir);

  /** Step the detail sheet through `display` — the order actually on screen. */
  const detailPager = useMemo(() => {
    if (!active) return undefined;
    const index = display.findIndex((s) => s.id === active.id);
    if (index < 0) return undefined;
    return {
      index,
      total: display.length,
      onStep: (dir: -1 | 1) => {
        const next = display[index + dir];
        if (next) setActive(next);
      },
    };
  }, [display, active]);

  const handlePickSort = async () => {
    const keys: CollectionSort[] = ['collected', 'number', 'family', 'name'];
    const idx = await showActionSheet({
      title: t('collection.sortTitle'),
      options: keys.map((k) => ({
        label: k === sortKey ? `\u2713 ${t(SORT_LABEL[k])}` : t(SORT_LABEL[k]),
      })),
    });
    if (idx < 0 || idx >= keys.length) return;
    // Same as the checklist screen: the active sort again flips direction; a
    // different sort starts from its default (ascending, as before).
    if (keys[idx] === sortKey) toggleSortDir();
    else {
      setSetting('collection_sort', keys[idx]);
      setSetting('collection_sort_dir', 'asc');
    }
  };

  const toggleSortDir = () =>
    setSetting('collection_sort_dir', sortDir === 'asc' ? 'desc' : 'asc');

  const handleExportLabels = async (title: string, includeFamily: boolean) => {
    // Filter `display`, not `picked`, so an id left over from a deleted
    // specimen simply vanishes instead of producing a blank label.
    const rows = display.filter((sp) => picked.has(sp.id));
    if (rows.length === 0) {
      toast(t('collection.labelNoneSelected'));
      return;
    }
    setExportBusy(true);
    try {
      // One vernacular per label, in the app language (see pickVernacular).
      const cross = crossRegionVernacular(
        rows.map((r) => r.taxon_id),
        ['TW', 'JP'],
      );
      // A specimen with no locality but a coordinate gets the geocoded place
      // name — for the label only, not written back. Offline, the Loc. line
      // simply carries the coordinates.
      const unnamed = rows.filter(
        (r) => !r.locality?.trim() && r.lat != null && r.lng != null,
      );
      const places =
        unnamed.length > 0
          ? await placeNamesAt(unnamed.map((r) => ({ lat: r.lat!, lng: r.lng! })))
          : new Map<string, string>();
      const labelRows = rows.map((r) => ({
        ...r,
        common_name_c: pickVernacular(
          r.common_name_c,
          regionOfTaxonId(r.taxon_id),
          cross.get(r.taxon_id),
          i18n.language,
        ),
        locality:
          r.locality?.trim() ||
          (r.lat != null && r.lng != null ? (places.get(placeKey(r.lat, r.lng)) ?? null) : null),
      }));
      const doc = DOC_FORMATS[docFormat];
      const bytes = doc.labels(labelRows, { title, includeFamily });
      // A date + count basename, deliberately not the trip name: the existing
      // filename sanitiser strips every CJK character, which would turn
      // 「福州山公園」 into a row of underscores.
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `labels_${stamp}_${rows.length}.${doc.ext}`;
      const file = new File(Paths.cache, filename);
      if (file.exists) file.delete();
      file.create();
      file.write(bytes);

      setLabelSheetOpen(false);
      // iOS cannot present the share sheet over a Modal that is still
      // dismissing. Same unconditional wait as the records-tab export.
      await new Promise((r) => setTimeout(r, 450));
      if (await Sharing.isAvailableAsync()) {
        await shareThenDelete(file.uri, {
          mimeType: doc.mime,
          UTI: doc.uti,
          dialogTitle: filename,
        });
      } else {
        Alert.alert(t('export.shareUnavailable'), t('export.fileGenerated', { uri: file.uri }));
      }
      exitSelect();
    } catch (e) {
      Alert.alert(t('export.failed'), errText(e));
    } finally {
      setExportBusy(false);
    }
  };

  const handleRename = async () => {
    if (!trip) return;
    const name = await promptText({
      title: t('collection.renameTitle'),
      defaultValue: trip.name,
      confirmText: t('common.save'),
    });
    const next = name?.trim();
    if (!next || next === trip.name) return;
    updateCollectionTrip(trip.id, { name: next });
    reload();
  };

  // Trip-level metadata, behind one chip rather than three.
  //
  // The header row is already carrying the project, the collectors, the sort
  // and the select toggle; three more would not fit on a phone. An
  // ActionSheet also keeps each field on the component built for it —
  // `promptText` for the two text values, the screen-level `SiteAssignSheet`
  // for the site. Nesting that sheet inside a modal of our own is not an
  // option: iOS refuses a Modal presented over a Modal.
  const handleTripMeta = async () => {
    if (!trip) return;
    const idx = await showActionSheet({
      title: t('collection.tripMetaTitle'),
      options: [
        { label: `${t('collection.tripLocality')}${trip.locality ? `：${trip.locality}` : ''}` },
        { label: `${t('collection.tripInstitution')}${trip.institution_code ? `：${trip.institution_code}` : ''}` },
        { label: `${t('collection.tripSite')}${tripSite ? `：${tripSite.name}` : ''}` },
        { label: t('surveyTime.title') },
      ],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) {
      const v = await promptText({
        title: t('collection.tripLocality'),
        defaultValue: trip.locality ?? '',
        confirmText: t('common.save'),
      });
      if (v === null) return;
      updateCollectionTrip(trip.id, { locality: v.trim() || null });
      reload();
    } else if (idx === 1) {
      const v = await promptText({
        title: t('collection.tripInstitution'),
        // The herbarium acronym a specimen inherits unless it sets its own.
        defaultValue: trip.institution_code ?? '',
        confirmText: t('common.save'),
      });
      if (v === null) return;
      updateCollectionTrip(trip.id, { institution_code: v.trim().toUpperCase() || null });
      reload();
    } else if (idx === 2) {
      setSiteSheetOpen(true);
    } else if (idx === 3) {
      setTimesOpen(true);
    }
  };

  const handleSave = (patch: SpecimenPatch) => {
    if (!active) return;
    updateSpecimen(active.id, patch);
    refreshActive(active.id);
  };

  const handleBulkDelete = () => {
    if (edit.refuse()) return;
    // From `display`, so an id left over from an already-deleted row is ignored.
    const rows = display.filter((sp) => picked.has(sp.id));
    if (rows.length === 0) return;
    Alert.alert(
      t('collection.deleteTitle'),
      t('collection.deleteSelectedMsg', { count: rows.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            withTransaction(() => {
              for (const sp of rows) deleteSpecimen(sp.id);
            });
            exitSelect();
            reload();
          },
        },
      ],
    );
  };

  const handleDelete = (specimen: SpecimenWithTaxon) => {
    Alert.alert(
      t('collection.deleteTitle'),
      t('collection.deleteMsg', { number: specimen.record_number }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteSpecimen(specimen.id);
            setActive(null);
            reload();
          },
        },
      ],
    );
  };

  const handleAddPhoto = async (mode: 'camera' | 'library') => {
    if (!active) return;
    try {
      const { captureAndSavePhoto, pickPhotosWithExif, buildContextFromSpecimen } =
        await import('~/lib/photoCapture');
      let picked: { uri: string; exif: Record<string, unknown> | null }[] = [];
      if (mode === 'camera') {
        const uri = await captureAndSavePhoto(buildContextFromSpecimen(active));
        if (uri) picked = [{ uri, exif: null }];
      } else {
        // `pickPhotosWithExif`, not `pickPhotos` — see the same handler in
        // app/session/[id].tsx. The picker's exif map is the only legible
        // source of a HEIC's position, and without it a specimen created
        // before it was photographed never picks up the coordinate.
        picked = await pickPhotosWithExif();
      }
      if (picked.length === 0) return;
      rememberPickedPhotos(picked);
      const newUris = picked.map((p) => p.uri);
      updateSpecimenPhotos(active.id, [...parsePhotoPaths(active.photo_paths), ...newUris]);
      // Only when the specimen has no collecting point of its own. A specimen
      // records where it was collected, so a photo of it in place carries that
      // position — but a measured one is never replaced.
      if (active.lat === null || active.lng === null) {
        const out = await firstPhotoFix(picked);
        if (out.kind === 'found') {
          updateSpecimenLocation(active.id, out.fix.lat, out.fix.lng, out.fix.accuracyM);
        }
      }
      refreshActive(active.id);
    } catch (e) {
      Alert.alert(t('session.photoFailTitle'), errText(e));
    }
  };

  const handleRemovePhoto = (uri: string) => {
    if (!active) return;
    updateSpecimenPhotos(
      active.id,
      parsePhotoPaths(active.photo_paths).filter((u) => u !== uri),
    );
    refreshActive(active.id);
  };

  // One record → the upload page with only this row pre-selected (see
  // app/session/[id].tsx handleUploadInat for the media gate rationale).
  const handleUploadInat = (specimen: SpecimenWithTaxon) => {
    if (
      parsePhotoPaths(specimen.photo_paths).length +
        parsePhotoPaths(specimen.audio_paths).length ===
      0
    ) {
      toast(t('inat.noMediaRecord'));
      return;
    }
    router.push(`/inat-upload?kind=collection&id=${tripId}&record=${specimen.id}` as Href);
  };

  const inatSyncingId = useInatSync((s) => s.runningId);
  const activeInatChanged = useMemo(
    () =>
      active && active.inat_uploaded_at != null
        ? hasInatChanges({ kind: 'collection', id: tripId }, active.id)
        : false,
    [active, tripId],
  );
  const handleInatSync = async (specimen: SpecimenWithTaxon) => {
    if (specimen.inat_uploaded_at == null) {
      setActive(null);
      handleUploadInat(specimen);
      return;
    }
    try {
      // The login WebView cannot be presented over the detail sheet (a Modal);
      // when a login is needed the sheet closes first.
      if (!(await inatTokenAvailableQuietly())) {
        setActive(null);
        await new Promise((res) => setTimeout(res, 450));
      }
      const r = await syncRecord({ kind: 'collection', id: tripId }, specimen.id);
      toast(
        r.noop
          ? t('inat.syncNoChange')
          : t('inat.syncDone', {
              added: r.annotationsAdded,
              removed: r.annotationsRemoved,
              media: r.mediaSent,
            }),
      );
      refreshActive(specimen.id);
    } catch (e) {
      toast(t('inat.syncFailed', { msg: await apiErrorMessage(e) }));
    }
  };

  const handleAddAudio = (uri: string) => {
    if (!active) return;
    updateSpecimenAudio(active.id, [...parsePhotoPaths(active.audio_paths), uri]);
    refreshActive(active.id);
  };

  const handleRemoveAudio = (uri: string) => {
    if (!active) return;
    updateSpecimenAudio(
      active.id,
      parsePhotoPaths(active.audio_paths).filter((u) => u !== uri),
    );
    // Deleted once no undo step can bring the clip back, and only if no other
    // record (a merge shares clips) still points at it.
    edit.deferAudioDelete(uri);
    refreshActive(active.id);
  };

  if (!trip) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Stack.Screen options={{ title: t('collection.title') }} />
        <Text className="text-gray-500 dark:text-gray-400">{t('collection.missing')}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-900">
      <Stack.Screen
        options={{
          // The rename affordance lives beside the title, not out in the
          // metadata row: a pencil floating next to the collector name reads as
          // "edit the collector" and the trip name looked uneditable.
          headerTitle: () => (
            <Pressable
              onPress={guard(() => void handleRename())}
              hitSlop={8}
              className="flex-row items-center active:opacity-60"
            >
              <Text
                className="max-w-[220px] text-[17px] font-semibold text-gray-900 dark:text-gray-100"
                numberOfLines={1}
              >
                {trip.name}
              </Text>
              <Ionicons name="pencil-outline" size={14} color="#9ca3af" style={{ marginLeft: 6 }} />
            </Pressable>
          ),
          headerLeft: () => <BackHeaderLeft />,
          headerRight: () => (
            // Icon rather than the words it used to be: 名錄 and 樣區 already
            // end / resume through exactly these two glyphs, and the odd one
            // out was 採集 — three sibling screens, one action, one shape.
            <View className="flex-row items-center gap-3">
              <RecordEditButtons edit={edit} ended={!isActive} onChanged={reload} />
              {!isActive && !edit.locked ? null : (
                <HeaderIconButton
                  icon={isActive ? 'stop-circle-outline' : 'refresh-outline'}
                  tone={isActive ? 'danger' : 'default'}
                  label={isActive ? t('collection.endTrip') : t('collection.resume')}
                  onPress={async () => {
                    if (isActive) {
                      const chosen = await chooseEndTime(trip.ended_at);
                      if (chosen === undefined) return;
                      endCollectionTrip(trip.id, chosen);
                    } else {
                      reopenCollectionTrip(trip.id);
                    }
                    reload();
                  }}
                />
              )}
            </View>
          ),
        }}
      />
      <View className="flex-1">
        {/* Metadata row: project · collectors · locality · sort. Select mode is
            entered by long-pressing a row.
            While selecting, it is replaced wholesale by the selection toolbar —
            the same swap the records tab does. */}
        {selectMode ? (
          <View className="flex-row items-center justify-between border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
            <Text className="text-sm text-gray-500 dark:text-gray-400">
              {t('collection.selectedCount', { count: picked.size })}
            </Text>
            <View className="flex-row items-center gap-3">
              <Pressable
                onPress={() =>
                  setPicked(
                    picked.size === display.length
                      ? new Set()
                      : new Set(display.map((sp) => sp.id)),
                  )
                }
                hitSlop={8}
              >
                <Text className="text-sm text-blue-600 dark:text-blue-400">
                  {picked.size === display.length && display.length > 0
                    ? t('favorites.deselectAll')
                    : t('favorites.selectAll')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setLabelSheetOpen(true)}
                disabled={picked.size === 0}
                hitSlop={8}
              >
                <Text
                  className={`text-sm font-medium ${
                    picked.size === 0
                      ? 'text-gray-300 dark:text-gray-600'
                      : 'text-blue-600 dark:text-blue-400'
                  }`}
                >
                  {t('collection.exportLabels')}
                </Text>
              </Pressable>
              <Pressable onPress={handleBulkDelete} disabled={picked.size === 0} hitSlop={8}>
                <Text
                  className={`text-sm font-medium ${
                    picked.size === 0
                      ? 'text-gray-300 dark:text-gray-600'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {t('common.delete')}
                </Text>
              </Pressable>
              <Pressable onPress={exitSelect} hitSlop={8}>
                <Text className="text-sm text-gray-500 dark:text-gray-400">
                  {t('common.cancel')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View className="flex-row items-center gap-3 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
            <Pressable
              onPress={guard(() => setProjectSheetOpen(true))}
              hitSlop={8}
              className="active:opacity-70"
            >
              <Ionicons
                name={project && project.id !== 0 ? 'folder' : 'folder-open-outline'}
                size={18}
                color={project && project.id !== 0 ? '#2563eb' : '#9ca3af'}
              />
            </Pressable>
            <Pressable
              onPress={guard(() => setSurveyorSheetOpen(true))}
              hitSlop={6}
              className="flex-1 flex-row items-center active:opacity-70"
            >
              <Ionicons
                name="people-outline"
                size={14}
                color={trip.recorded_by ? '#2563eb' : '#9ca3af'}
              />
              <Text
                className={`ml-1 flex-1 text-xs ${trip.recorded_by ? 'font-medium text-blue-700 dark:text-blue-300' : 'italic text-gray-500 dark:text-gray-400'}`}
                numberOfLines={1}
              >
                {trip.recorded_by || t('collection.collectorEmpty')}
              </Text>
            </Pressable>
            <Pressable
              onPress={guard(() => void handleTripMeta())}
              hitSlop={6}
              className="flex-row items-center active:opacity-70"
            >
              <Ionicons
                name="location-outline"
                size={14}
                color={trip.locality || tripSite ? '#2563eb' : '#9ca3af'}
              />
              <Text
                className={`ml-1 max-w-[96px] text-xs ${trip.locality || tripSite ? 'font-medium text-blue-700 dark:text-blue-300' : 'italic text-gray-500 dark:text-gray-400'}`}
                numberOfLines={1}
              >
                {trip.locality || tripSite?.name || t('collection.tripLocalityEmpty')}
              </Text>
            </Pressable>
            {specimens.length > 0 ? (
              <Pressable
                onPress={handlePickSort}
                hitSlop={6}
                className="flex-row items-center rounded-full bg-gray-100 px-2.5 py-1 active:bg-gray-200 dark:bg-gray-800 dark:active:bg-gray-700"
              >
                <Ionicons name="swap-vertical" size={13} color="#4b5563" />
                <Text className="ml-1 text-[11px] font-medium text-gray-700 dark:text-gray-300">
                  {t(SORT_LABEL[sortKey])}
                </Text>
              </Pressable>
            ) : null}
            {specimens.length > 0 ? (
              <Pressable
                onPress={toggleSortDir}
                hitSlop={6}
                className="active:opacity-50"
              >
                <Ionicons
                  name={sortDir === 'desc' ? 'arrow-down' : 'arrow-up'}
                  size={14}
                  color="#6b7280"
                />
              </Pressable>
            ) : null}
          </View>
        )}

        {specimens.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Ionicons name="leaf-outline" size={56} color="#cbd5e1" />
            <Text className="mt-3 text-center text-base text-gray-700 dark:text-gray-300">
              {t('collection.emptyHint')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={display}
            keyExtractor={(sp) => String(sp.id)}
            renderItem={({ item }) => (
              // Destructive action sits last = closest to the swipe origin,
              // per SwipeRowActions' documented convention.
              <SwipeRowActions
                disabled={selectMode}
                actions={[
                  {
                    label: t('collection.duplicate'),
                    icon: 'copy-outline',
                    color: 'blue',
                    onPress: guard(() => handleDuplicate(item)),
                  },
                  {
                    label: t('records.uploadInat'),
                    icon: 'cloud-upload-outline',
                    color: 'inat',
                    onPress: () => handleUploadInat(item),
                  },
                  {
                    label: t('common.delete'),
                    icon: 'trash-outline',
                    color: 'red',
                    onPress: guard(() => handleDelete(item)),
                  },
                ]}
              >
                <SpecimenRow
                  specimen={item}
                  duplicate={dupNumbers.has(item.record_number)}
                  selectMode={selectMode}
                  picked={picked.has(item.id)}
                  onPress={() => (selectMode ? togglePick(item.id) : setActive(item))}
                  onLongPress={() => handleLongPress(item)}
                />
              </SwipeRowActions>
            )}
          />
        )}
      </View>

      {/* Above the dock on purpose — see RecordStepBar's header comment. */}

      {/* Directly above the search box it refers to, matching the checklist
        and plot screens; also puts Cancel in the thumb zone. */}
      {replaceTarget ? (
        <View className="flex-row items-center border-t border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950/40">
          <Ionicons name="swap-horizontal" size={14} color="#d97706" />
          <Text
            className="ml-2 flex-1 text-xs text-amber-800 dark:text-amber-300"
            numberOfLines={1}
          >
            {t('collection.changeTaxonBanner', { number: replaceTarget.record_number })}
          </Text>
          <Pressable
            onPress={() => setReplaceTarget(null)}
            hitSlop={8}
            className="active:opacity-70"
          >
            <Text className="text-xs font-medium text-amber-800 dark:text-amber-300">
              {t('common.cancel')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <RecordStepBar kind="collection" id={tripId} />
      <LabelExportSheet
        visible={labelSheetOpen}
        count={picked.size}
        busy={exportBusy}
        onCancel={() => setLabelSheetOpen(false)}
        onConfirm={handleExportLabels}
      />

      {isActive || replaceTarget ? (
        // Also shown while re-identifying, so a finished trip's specimen can
        // still be corrected without reopening the whole trip.
        //
        // Sibling of the flex-1 content View, not a child, so the keyboard
        // translation lifts only the search box and not the list.
        // `opened` must equal the chrome sitting BELOW the dock — here the
        // root SafeAreaView's bottom inset. The two are a pair: drop the
        // SafeAreaView and this offset would shove the box behind the keyboard.
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          {/* 'dismiss': a pick opens the specimen's detail sheet, so the
              keyboard must not come back up underneath it. */}
          <SearchBox onSelect={handleAdd} afterSelect="dismiss" />
        </KeyboardStickyView>
      ) : null}

      <SpecimenDetailSheet
        key={detailKey}
        specimen={active}
        onClose={() => setActive(null)}
        onSave={guard(handleSave)}
        onChangeLocation={guard((lat: number, lng: number, accuracy: number | null) => {
          if (!active) return;
          updateSpecimenLocation(active.id, lat, lng, accuracy);
          refreshActive(active.id);
        })}
        onSaveLocation={guard((lat: number | null, lng: number | null, accuracy: number | null) => {
          if (!active) return;
          updateSpecimenLocation(active.id, lat, lng, accuracy);
          refreshActive(active.id);
        })}
        onReplaceTaxon={guard(() => {
          if (!active) return;
          setReplaceTarget(active);
          setActive(null);
        })}
        duplicate={active ? dupNumbers.has(active.record_number) : false}
        pager={detailPager}
        onDelete={guard(() => {
          if (active) handleDelete(active);
        })}
        onAddPhoto={guard((mode: 'camera' | 'library') => void handleAddPhoto(mode))}
        onRemovePhoto={guard(handleRemovePhoto)}
        onAddAudio={guard(handleAddAudio)}
        onRemoveAudio={guard(handleRemoveAudio)}
        inat={
          active
            ? {
                uploaded: active.inat_uploaded_at != null,
                changed: activeInatChanged,
                syncing: inatSyncingId === active.id,
                onPress: () => void handleInatSync(active),
              }
            : undefined
        }
      />
      <ProjectAssignSheet
        visible={projectSheetOpen}
        currentProjectId={trip.project_id}
        onCancel={() => setProjectSheetOpen(false)}
        onAssign={(projectId) => {
          setProjectSheetOpen(false);
          updateCollectionTrip(trip.id, { project_id: projectId });
          reload();
        }}
      />
      <SiteAssignSheet
        visible={siteSheetOpen}
        currentSiteId={trip.site_id}
        preferredProjectId={trip.project_id}
        onCancel={() => setSiteSheetOpen(false)}
        onAssign={(siteId) => {
          updateCollectionTrip(trip.id, { site_id: siteId });
          setSiteSheetOpen(false);
          reload();
        }}
      />

      <SurveyTimesModal
        visible={timesOpen}
        onClose={() => setTimesOpen(false)}
        start={trip.started_at}
        end={trip.ended_at}
        startRequired
        readOnly={edit.locked}
        onChange={guard((which: 'start' | 'end', ts: number | null) => {
          if (which === 'start') {
            if (ts != null) updateCollectionTrip(trip.id, { started_at: ts });
          } else updateCollectionTrip(trip.id, { ended_at: ts });
          reload();
        })}
      />

      <SurveyorAssignSheet
        visible={surveyorSheetOpen}
        current={trip.recorded_by ?? ''}
        onCancel={() => setSurveyorSheetOpen(false)}
        onAssign={(v) => {
          setSurveyorSheetOpen(false);
          updateCollectionTrip(trip.id, { recorded_by: v || null });
          reload();
        }}
      />
    </SafeAreaView>
  );
}
