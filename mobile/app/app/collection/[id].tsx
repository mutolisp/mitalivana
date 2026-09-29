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
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler, FlatList, Keyboard, Pressable, ScrollView, Text, View } from 'react-native';
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
  duplicateCountOf,
  getDefaultNames,
  isUndetermined,
  UNDETERMINED_TAXON_ID,
  type CollectionTrip,
  type Project,
  type SearchResult,
  type SpecimenWithTaxon,
} from '~/db';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { EndRecordButton } from '~/components/EndRecordButton';
import { MenuButton, showMenu, type MenuSection } from '~/components/OverflowMenu';
import { CardGrid } from '~/components/ui/CardGrid';
import { Chip } from '~/components/ui/Chip';
import { ContextChip } from '~/components/ui/ContextChip';
import { CountStepper } from '~/components/ui/CountStepper';
import { CodeBadge, ListRow, Thumb } from '~/components/ui/ListRow';
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
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';

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

const SORT_KEYS: CollectionSort[] = ['collected', 'number', 'family', 'name'];

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

/** The row's name: the Chinese name, else the field label, else the Latin. */
function specimenTitle(sp: SpecimenWithTaxon): string {
  return sp.common_name_c || sp.verbatim_identification || sp.simple_name;
}

/**
 * One specimen as a list row (04-collection-listrow.md §3.4): photo or a
 * dashed camera frame that takes one on the spot, the name with its
 * collection number, the Latin name, and the duplicate-sheet stepper.
 */
function SpecimenListRow({
  specimen,
  duplicate,
  selectMode,
  picked,
  onPress,
  onLongPress,
  onTakePhoto,
  onDuplicates,
}: {
  specimen: SpecimenWithTaxon;
  /** This collection number is carried by more than one specimen. */
  duplicate: boolean;
  selectMode: boolean;
  picked: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onTakePhoto: () => void;
  onDuplicates: (n: number) => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const photos = parsePhotoPaths(specimen.photo_paths);
  const undetermined = isUndetermined(specimen);
  // Latin first — the herbarium convention on this screen (asked for).
  const family = undetermined ? null : familyLatinFirst(specimen.family, specimen.family_c);
  const meta = [
    family,
    isoDateTime(specimen.collected_at),
    photos.length ? t('collection.photoCount', { count: photos.length }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <ListRow
      onPress={onPress}
      onLongPress={onLongPress}
      selected={selectMode && picked}
      tone={specimen.inat_uploaded_at != null ? 'uploaded' : 'default'}
      leading={
        selectMode ? (
          <Ionicons name={picked ? 'checkbox' : 'square-outline'} size={22} color={picked ? c.accent : c.ink3} />
        ) : (
          <Thumb
            uri={photos[0]}
            count={photos.length}
            // An empty frame takes the missing photo right here.
            onPress={photos.length ? undefined : onTakePhoto}
            accessibilityLabel={t('collection.retakePhoto')}
          />
        )
      }
      title={
        <View className="flex-row items-center">
          <Text
            className={`flex-shrink text-base font-medium ${undetermined ? 'text-acorn-deep dark:text-acorn' : 'text-ink dark:text-gray-100'}`}
            numberOfLines={1}
          >
            {undetermined ? t('collection.undetermined') : specimenTitle(specimen)}
          </Text>
          <View className="ml-2">
            <CodeBadge code={`#${specimen.record_number}`} />
          </View>
          {duplicate ? <Ionicons name="warning" size={13} color={c.acornDeep} style={{ marginLeft: 4 }} /> : null}
        </View>
      }
      subtitle={
        undetermined ? (
          specimen.verbatim_identification ? (
            <Text className="text-sm text-gray-600 dark:text-gray-300" numberOfLines={1}>
              {specimen.verbatim_identification}
            </Text>
          ) : null
        ) : (
          <ScientificName
            name={specimen.simple_name}
            author={specimen.name_author}
            kingdom={specimen.kingdom}
            rank={specimen.rank}
            className="text-sci text-gray-600 dark:text-gray-300"
            numberOfLines={1}
          />
        )
      }
      meta={meta}
      trailing={
        selectMode ? null : (
          <View className="items-center">
            <CountStepper
              value={specimen.duplicate_count}
              min={1}
              onChange={(v) => onDuplicates(duplicateCountOf(v))}
              accessibilityName={specimen.record_number}
            />
            <Text className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('collection.duplicates')}</Text>
          </View>
        )
      }
    />
  );
}

/** One specimen as a photo card (§2): 4:3 photo with the number, duplicates and photo count on it. */
function SpecimenCard({
  specimen,
  width,
  selectMode,
  picked,
  onPress,
  onLongPress,
  onTakePhoto,
}: {
  specimen: SpecimenWithTaxon;
  width: number;
  selectMode: boolean;
  picked: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onTakePhoto: () => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const photos = parsePhotoPaths(specimen.photo_paths);
  const undetermined = isUndetermined(specimen);
  const h = (width * 3) / 4;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      className={`overflow-hidden rounded-card border bg-card dark:bg-card-dark ${
        selectMode && picked ? 'border-accent-600 dark:border-accent-400' : 'border-line dark:border-line-dark'
      }`}
      style={selectMode && picked ? { borderWidth: 2 } : undefined}
    >
      <View style={{ width, height: h }}>
        {photos.length ? (
          <Image source={{ uri: rebaseAppFileUri(photos[0]) }} style={{ width, height: h }} contentFit="cover" />
        ) : (
          <Pressable
            onPress={selectMode ? onPress : onTakePhoto}
            accessibilityRole="button"
            accessibilityLabel={t('collection.retakePhoto')}
            className="flex-1 items-center justify-center bg-gray-100 active:bg-gray-200 dark:bg-gray-800 dark:active:bg-gray-700"
          >
            <Ionicons name="camera-outline" size={26} color={c.ink3} />
            <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('collection.retakePhoto')}</Text>
          </Pressable>
        )}
        <View className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5">
          <Text className="font-mono text-xs font-bold text-white">{specimen.record_number}</Text>
        </View>
        <View className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5">
          <Text className="text-xs font-medium text-white">
            {`${t('collection.duplicates')} ${duplicateCountOf(specimen.duplicate_count)}`}
          </Text>
        </View>
        {photos.length ? (
          <View className="absolute bottom-2 right-2 flex-row items-center rounded-md bg-black/60 px-1.5 py-0.5">
            <Ionicons name="images-outline" size={11} color="white" />
            <Text className="ml-1 text-xs font-medium text-white">{photos.length}</Text>
          </View>
        ) : null}
        {selectMode ? (
          <View className="absolute bottom-2 left-2">
            <Ionicons name={picked ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={picked ? c.accent : 'white'} />
          </View>
        ) : null}
      </View>
      <View className="p-2.5">
        <Text
          className={`text-sm font-medium ${undetermined ? 'text-acorn-deep dark:text-acorn' : 'text-ink dark:text-gray-100'}`}
          numberOfLines={1}
        >
          {undetermined ? t('collection.undetermined') : specimenTitle(specimen)}
        </Text>
        {undetermined ? null : (
          <ScientificName
            name={specimen.simple_name}
            author={specimen.name_author}
            kingdom={specimen.kingdom}
            rank={specimen.rank}
            className="text-xs text-gray-600 dark:text-gray-300"
            numberOfLines={1}
          />
        )}
        <Text className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {isoDateTime(specimen.collected_at)}
        </Text>
      </View>
    </Pressable>
  );
}

export default function CollectionTripScreen() {
  const c = useThemeColors();
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
  const layout = useSettings((st) => st.collection_layout);
  const [filter, setFilter] = useState<'all' | 'undetermined' | 'noPhoto'>('all');
  /** The search dock is open (以物種名稱新增); otherwise the add buttons show. */
  const [searching, setSearching] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  // Starred identifiers: what a new specimen's 鑑定者 will be. Re-read on focus
  // (edited on their own screen), like the specimen settings page does.
  const [determiners, setDeterminers] = useState('');

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
    setDeterminers(getDefaultNames('identifier').join(', '));
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
    setSearching(false);
    await createSpecimen(result.taxon_id, adopted ?? null, result.cname || result.name, []);
  };

  /**
   * Insert one specimen with the next collection number and open it. Shared
   * by the add-by-name search and the photo-first add, which passes the
   * placeholder Plantae and the photo it has just taken.
   */
  const createSpecimen = async (
    taxonId: string,
    adopted: AdoptionInput | null,
    displayName: string,
    photoUris: string[],
  ) => {
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
      taxon_id: taxonId,
      adopted,
      record_number: number,
      locality: null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      accuracy: coords?.accuracy ?? null,
      elevation_m: coords?.altitude ?? null,
      elevation_source: coords?.altitude != null ? 'gnss' : null,
    });
    if (newId && photoUris.length) updateSpecimenPhotos(newId, photoUris);
    reload();
    toast(t('collection.added', { number, name: displayName }));
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

  /**
   * 新增標本 (§3.6, "number first"): take the photo, then file it at once
   * under the next collection number, determination Plantae until named.
   * A cancelled camera files nothing.
   */
  const handleQuickAdd = async () => {
    if (quickBusy) return;
    setQuickBusy(true);
    try {
      const { captureAndSavePhoto } = await import('~/lib/photoCapture');
      const uri = await captureAndSavePhoto({
        taxon_id: UNDETERMINED_TAXON_ID,
        simple_name: 'Plantae',
        name_author: '',
        common_name_c: '',
        family: '',
        family_c: '',
        kingdom: 'Plantae',
        observed_at: Date.now(),
        collection_trip_id: tripId,
        record_number: nextRecordNumber().text,
      });
      if (!uri) return;
      rememberPickedPhotos([{ uri, exif: null }]);
      await createSpecimen(UNDETERMINED_TAXON_ID, null, t('collection.undetermined'), [uri]);
    } catch (e) {
      Alert.alert(t('session.photoFailTitle'), errText(e));
    } finally {
      setQuickBusy(false);
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
  const undeterminedCount = specimens.filter(isUndetermined).length;
  const noPhotoCount = specimens.filter((sp) => parsePhotoPaths(sp.photo_paths).length === 0).length;
  // The chip filter narrows only what is drawn; labels, select-all and the
  // detail pager keep working on the whole sorted list.
  const shown =
    filter === 'undetermined'
      ? display.filter(isUndetermined)
      : filter === 'noPhoto'
        ? display.filter((sp) => parsePhotoPaths(sp.photo_paths).length === 0)
        : display;

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

  /** The same sort again flips its direction; another starts ascending. */
  const pickSort = (key: CollectionSort) => {
    const { sortKey: cur, sortDir: dir } = latestMenu.current;
    if (key === cur) setSetting('collection_sort_dir', dir === 'asc' ? 'desc' : 'asc');
    else {
      setSetting('collection_sort', key);
      setSetting('collection_sort_dir', 'asc');
    }
  };

  // ⋯ stays open through undo / redo and the sort radios, rebuilding itself,
  // so it reads the latest values through a ref (as RecordMenuButton does).
  const latestMenu = useRef({ edit, sortKey, sortDir });
  latestMenu.current = { edit, sortKey, sortDir };
  const menuSections = (): MenuSection[] => {
    const { edit: e, sortKey: k, sortDir: d } = latestMenu.current;
    const out: MenuSection[] = [];
    if (!e.locked) {
      out.push({
        items: [
          {
            kind: 'stepper',
            id: 'history',
            undo: {
              label: t('recordLock.undo'),
              icon: 'arrow-undo-outline',
              count: e.undoCount,
              onPress: () => {
                e.undo();
                reload();
              },
            },
            redo: {
              label: t('recordLock.redo'),
              icon: 'arrow-redo-outline',
              count: e.redoCount,
              onPress: () => {
                e.redo();
                reload();
              },
            },
          },
        ],
      });
    }
    out.push({
      title: t('collection.sortTitle'),
      items: SORT_KEYS.map((key) => ({
        kind: 'radio' as const,
        id: `sort-${key}`,
        group: 'sort',
        label: key === k ? `${t(SORT_LABEL[key])} ${d === 'asc' ? '↑' : '↓'}` : t(SORT_LABEL[key]),
        checked: key === k,
        onSelect: () => pickSort(key),
      })),
    });
    out.push({ items: [{ kind: 'action', id: 'labels', label: t('collection.labels'), icon: 'pricetag-outline' }] });
    return out;
  };
  const openMenu = async (anchor: RefObject<View | null>) => {
    const choice = await showMenu(anchor, menuSections);
    if (choice === 'labels') openLabels();
  };
  /** 標籤 from ⋯: every specimen on screen, ready to narrow down or export. */
  const openLabels = () => {
    if (display.length === 0) {
      toast(t('collection.labelNoneSelected'));
      return;
    }
    setSelectMode(true);
    setPicked(new Set(display.map((sp) => sp.id)));
    setLabelSheetOpen(true);
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

  const handleAddPhoto = (mode: 'camera' | 'library') => {
    if (active) void addPhotoTo(active, mode, true);
  };

  /** Photos onto `target`; `openAfter` keeps its detail sheet in sync, while
   *  a photo taken from the list (the empty thumbnail) just reloads the list. */
  const addPhotoTo = async (target: SpecimenWithTaxon, mode: 'camera' | 'library', openAfter: boolean) => {
    const active = target;
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
      if (openAfter) refreshActive(active.id);
      else reload();
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

  // What 新增標本 will file under; recomputed per render so a hand-edited
  // number or a changed prefix shows at once.
  const nextNo = isActive ? nextRecordNumber().text : '';

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
              <View>
                <View className="flex-row items-center">
                  <Text
                    className="max-w-[200px] text-[17px] font-semibold text-gray-900 dark:text-gray-100"
                    numberOfLines={1}
                  >
                    {trip.name}
                  </Text>
                  <Ionicons name="pencil-outline" size={14} color={c.ink3} style={{ marginLeft: 6 }} />
                </View>
                <View className="flex-row items-center">
                  <View className={`mr-1.5 h-2 w-2 rounded-full ${isActive ? 'bg-accent-600 dark:bg-accent-400' : 'bg-gray-400'}`} />
                  <Text
                    numberOfLines={1}
                    className={`text-xs font-medium ${isActive ? 'text-accent-600 dark:text-accent-400' : 'text-gray-500 dark:text-gray-400'}`}
                  >
                    {isActive
                      ? t('collection.countSummary', { count: specimens.length })
                      : `${t('session.ended')} · ${t('collection.countDone', { count: specimens.length })}`}
                  </Text>
                </View>
              </View>
            </Pressable>
          ),
          headerLeft: () => <BackHeaderLeft />,
          headerRight: () => (
            // Icon rather than the words it used to be: 名錄 and 樣區 already
            // end / resume through exactly these two glyphs, and the odd one
            // out was 採集 — three sibling screens, one action, one shape.
            <View className="flex-row items-center gap-3">
              <MenuButton onOpen={openMenu} />
              <RecordEditButtons edit={edit} ended={!isActive} onChanged={reload} inMenu />
              {isActive ? (
                <EndRecordButton
                  onPress={async () => {
                    const chosen = await chooseEndTime(trip.ended_at);
                    if (chosen === undefined) return;
                    endCollectionTrip(trip.id, chosen);
                    reload();
                  }}
                />
              ) : edit.locked ? (
                <HeaderIconButton
                  icon="refresh-outline"
                  label={t('collection.resume')}
                  onPress={() => {
                    reopenCollectionTrip(trip.id);
                    reload();
                  }}
                />
              ) : null}
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
          <View className="flex-row items-center justify-between border-b border-gray-200 bg-card px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
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
                <Text className="text-sm text-accent-600 dark:text-accent-400">
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
                      : 'text-accent-600 dark:text-accent-400'
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
          <View>
            {/* Context: project · place · collector · determiner. Taps keep
                the screens they had; unset ones are dashed. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="grow-0 border-b border-line bg-card dark:border-line-dark dark:bg-card-dark"
              contentContainerClassName="gap-2 px-4 py-2"
            >
              <ContextChip
                icon="folder-outline"
                label={project && project.id !== 0 ? project.name : t('session.projectUnset')}
                set={!!project && project.id !== 0}
                onPress={guard(() => setProjectSheetOpen(true))}
              />
              <ContextChip
                icon={tripSite ? 'pin' : 'location-outline'}
                label={trip.locality || tripSite?.name || t('collection.tripLocalityEmpty')}
                set={!!(trip.locality || tripSite)}
                onPress={guard(() => void handleTripMeta())}
              />
              <ContextChip
                icon="people-outline"
                label={trip.recorded_by || t('collection.collectorEmpty')}
                set={!!trip.recorded_by}
                onPress={guard(() => setSurveyorSheetOpen(true))}
              />
              {/* The starred identifiers new specimens get; the trip has no
                  determiner of its own, so this opens that list. */}
              <ContextChip
                icon="ribbon-outline"
                label={determiners || t('collection.determinerEmpty')}
                set={!!determiners}
                onPress={() => router.push('/identifiers' as Href)}
              />
            </ScrollView>
            {specimens.length > 0 ? (
              <View className="flex-row items-center border-b border-line bg-card py-2 pl-4 pr-2 dark:border-line-dark dark:bg-card-dark">
                <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1" contentContainerClassName="gap-2 pr-2">
                  <Chip label={t('records.filterAll')} count={specimens.length} selected={filter === 'all'} onPress={() => setFilter('all')} />
                  <Chip
                    label={t('collection.filterUndetermined', { count: undeterminedCount })}
                    selected={filter === 'undetermined'}
                    onPress={() => setFilter('undetermined')}
                  />
                  <Chip
                    label={t('collection.filterNoPhoto', { count: noPhotoCount })}
                    selected={filter === 'noPhoto'}
                    onPress={() => setFilter('noPhoto')}
                  />
                </ScrollView>
                {/* List ｜ photo grid, remembered (collection_layout). */}
                <View className="flex-row rounded-full border border-line p-0.5 dark:border-line-dark">
                  {(
                    [
                      ['list', 'list-outline', 'collection.layoutList'],
                      ['grid', 'grid-outline', 'collection.layoutGrid'],
                    ] as const
                  ).map(([value, icon, label]) => (
                    <Pressable
                      key={value}
                      onPress={() => setSetting('collection_layout', value)}
                      accessibilityRole="button"
                      accessibilityLabel={t(label)}
                      accessibilityState={{ selected: layout === value }}
                      className={`items-center justify-center rounded-full ${layout === value ? 'bg-ink dark:bg-gray-100' : ''}`}
                      style={{ width: 44, height: 40 }}
                    >
                      <Ionicons name={icon} size={18} color={layout === value ? c.card : c.ink2} />
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}

        {specimens.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Ionicons name="leaf-outline" size={56} color={c.disabled} />
            <Text className="mt-3 text-center text-base text-gray-700 dark:text-gray-300">
              {t('collection.emptyHint')}
            </Text>
          </View>
        ) : layout === 'grid' ? (
          // No swipe actions on a card: long-press → select still reaches
          // labels and delete, as on the records tab's card view.
          <CardGrid
            data={shown}
            keyExtractor={(sp) => String(sp.id)}
            renderCard={(item, width) => (
              <SpecimenCard
                specimen={item}
                width={width}
                selectMode={selectMode}
                picked={picked.has(item.id)}
                onPress={() => (selectMode ? togglePick(item.id) : setActive(item))}
                onLongPress={() => handleLongPress(item)}
                onTakePhoto={guard(() => void addPhotoTo(item, 'camera', false))}
              />
            )}
          />
        ) : (
          <FlatList
            data={shown}
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
                <SpecimenListRow
                  specimen={item}
                  duplicate={dupNumbers.has(item.record_number)}
                  selectMode={selectMode}
                  picked={picked.has(item.id)}
                  onPress={() => (selectMode ? togglePick(item.id) : setActive(item))}
                  onLongPress={() => handleLongPress(item)}
                  onTakePhoto={guard(() => void addPhotoTo(item, 'camera', false))}
                  onDuplicates={guard((n: number) => {
                    updateSpecimen(item.id, { duplicate_count: n });
                    reload();
                  })}
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

      {replaceTarget || (isActive && searching) ? (
        // Re-identifying (also on a finished trip, so a specimen can be
        // corrected without reopening it), or adding by name.
        //
        // Sibling of the flex-1 content View, not a child, so the keyboard
        // translation lifts only the search box and not the list.
        // `opened` must equal the chrome sitting BELOW the dock — here the
        // root SafeAreaView's bottom inset. The two are a pair: drop the
        // SafeAreaView and this offset would shove the box behind the keyboard.
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          {/* 'dismiss': a pick opens the specimen's detail sheet, so the
              keyboard must not come back up underneath it. */}
          <SearchBox
            onSelect={handleAdd}
            afterSelect="dismiss"
            autoFocus={!replaceTarget}
            trailing={
              replaceTarget ? undefined : (
                <Pressable
                  onPress={() => {
                    Keyboard.dismiss();
                    setSearching(false);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.close')}
                  className="h-11 w-11 items-center justify-center"
                >
                  <Ionicons name="close" size={22} color={c.ink2} />
                </Pressable>
              )
            }
          />
        </KeyboardStickyView>
      ) : isActive ? (
        // "Number first" (§3.6): the photo files a specimen under the next
        // number at once; the round key adds one by species name instead.
        // Centred and capped so a tablet does not stretch it across the row.
        <View className="items-center border-t border-line bg-card px-4 py-2.5 dark:border-line-dark dark:bg-card-dark">
          <View className="w-full flex-row items-center gap-2.5" style={{ maxWidth: 520 }}>
            <Pressable
              onPress={guard(() => void handleQuickAdd())}
              disabled={quickBusy}
              accessibilityRole="button"
              accessibilityLabel={`${t('collection.addSpecimen')} ${nextNo}`}
              className={`flex-1 flex-row items-center justify-center rounded-full bg-accent-600 px-4 active:bg-accent-700 dark:bg-accent-400 dark:active:bg-accent-300 ${quickBusy ? 'opacity-60' : ''}`}
              style={{ minHeight: 56 }}
            >
              <Ionicons name="camera" size={20} color={c.onAccent} />
              <Text className="ml-2 text-base font-bold text-white dark:text-gray-950">{t('collection.addSpecimen')}</Text>
              <Text className="ml-2 font-mono text-base font-bold text-white/80 dark:text-gray-950/70" numberOfLines={1}>
                {`#${nextNo}`}
              </Text>
            </Pressable>
            <Pressable
              onPress={guard(() => setSearching(true))}
              accessibilityRole="button"
              accessibilityLabel={t('collection.addBySpecies')}
              className="items-center justify-center rounded-full border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
              style={{ width: 56, height: 56 }}
            >
              <Ionicons name="search" size={22} color={c.accent} />
            </Pressable>
          </View>
        </View>
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
        onAddPhoto={guard((mode: 'camera' | 'library') => handleAddPhoto(mode))}
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
