import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import type { AdoptionInput } from '~/db';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { BackHeaderLeft, goBackOrHome } from '~/lib/goBack';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isoDateTime, isoTime } from '~/lib/datetime';
import { ContextChip, ContextStrip } from '~/components/ui/ContextChip';
import {
  Alert,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { RecordMenuButton } from '~/components/RecordMenuButton';
import { HeaderTitleText } from '~/components/HeaderTitleText';
import { RecordStatusLine } from '~/components/RecordStatusLine';
import { showActionSheet } from '~/components/ActionSheet';
import { hasInatChanges, syncRecord, useInatSync } from '~/lib/inatUpload';
import { inatTokenAvailableQuietly } from '~/lib/inatAuth';
import { apiErrorMessage } from '~/lib/apiErrorMessage';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  addRecord,
  deleteRecord,
  withTransaction,
  deleteSession,
  endSession,
  getActiveSession,
  getProject,
  getSession,
  getSite,
  isTaxonInSession,
  listSessionRecords,
  parseTrackSegments,
  reopenSession,
  updateRecordAttributes,
  updateRecordQuantity,
  updateRecordLocation,
  updateRecordElevation,
  updateRecordNotes,
  updateRecordTaxon,
  updateRecordPhotos,
  updateRecordAudio,
  parsePhotoPaths,
  updateSession,
  type Project,
  type RecordWithTaxon,
  type Session,
  type Site,
  type SearchResult,
} from '~/db';
import { SearchBox } from '~/components/SearchBox';
import { SpeciesCard } from '~/components/SpeciesCard';
import { SpeciesDetailSheet } from '~/components/SpeciesDetailSheet';
import { LookupResultSheet } from '~/components/LookupResultSheet';
import { EndSessionModal } from '~/components/EndSessionModal';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { SiteAssignSheet } from '~/components/SiteAssignSheet';
import { BatchImportModal } from '~/components/BatchImportModal';
import { PhotoImportModal } from '~/components/PhotoImportModal';
import { pickPhotosWithExif, takePhotoWithExif, type PickedPhoto } from '~/lib/photoCapture';
import { takeSpeciesPhotos } from '~/lib/speciesPhotos';
import { computeDiversity } from '~/lib/diversity';
import { firstPhotoFix, rememberPickedPhotos } from '~/lib/photoMeta';
import { SwipeRowActions } from '~/components/SwipeRowActions';
import { SelectionDock, SelectionToolbar } from '~/components/SelectionToolbar';
import { useListSelection } from '~/lib/useListSelection';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { useActiveSession } from '~/stores/activeSession';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveGloria } from '~/modules/gloria/store';
import { useFavorites } from '~/stores/favorites';
import { toastFavoriteAdded } from '~/lib/favoritesToast';
import {
  isRecordingTarget,
  pauseIfNot,
  pauseRecording,
  startRecording,
  useTrackRecorder,
} from '~/lib/trackRecorder';
import { stampNewRecord } from '~/lib/recordFix';
import { showSpatialMenu } from '~/lib/spatialMenu';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { SurveyTimesModal } from '~/components/SurveyTimeFields';
import { RecordEditButtons } from '~/components/RecordEditButtons';
import { EndRecordButton } from '~/components/EndRecordButton';
import type { SpeciesAttributesDraft } from '~/components/SpeciesAttributesBlock';
import { saveVersionSoon } from '~/db/recordVersions';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { useThemeColors } from '~/theme/colors';
import { Chip } from '~/components/ui/Chip';
import { sentenceParts, slot, speciesParts } from '~/lib/nameParts';
import { HIGH_LEVEL_GROUPS, sortRecords } from '~/lib/recordList';
import { RecordSortControls } from '~/components/RecordSortControls';


export default function SessionDetailScreen() {
  const c = useThemeColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = parseInt(id as string, 10);
  useVersionOnLeave('session', sessionId);
  const router = useRouter();
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const refreshActive = useActiveSession((s) => s.refresh);
  const refreshActivePlot = useActivePlot((s) => s.refresh);
  // KSV offset compensation: the outer <SafeAreaView edges={['bottom']}>
  // pulls the container bottom up by safe-area-bottom (~34px home indicator
  // on iPhone). Without re-adding this as `opened` offset, the search box
  // floats that gap above the keyboard top. Same family of bug as the tabs'
  // tabBarHeight gap fix in taxonomy.tsx / KeyListView / SpeciesSearchPanel.
  const insets = useSafeAreaInsets();

  const [session, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [records, setRecords] = useState<RecordWithTaxon[]>([]);
  const [filterKey, setFilterKey] = useState<string | null>(null);
  const [activeRecord, setActiveRecord] = useState<RecordWithTaxon | null>(null);
  const [endModalOpen, setEndModalOpen] = useState(false);
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [siteSheetOpen, setSiteSheetOpen] = useState(false);
  const [surveyorSheetOpen, setSurveyorSheetOpen] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);
  const [batchImportOpen, setBatchImportOpen] = useState(false);
  const [searchPreview, setSearchPreview] = useState<SearchResult | null>(null);
  // Track recording lives in the module-level recorder (src/lib/trackRecorder.ts)
  // so it survives leaving this screen for the map/species tabs. Read live
  // state from the store instead of component refs.
  const recordingTarget = useTrackRecorder((s) => s.recordingTarget);
  const livePoints = useTrackRecorder((s) => s.livePoints);
  const tracking = recordingTarget?.kind === 'session' && recordingTarget.id === sessionId;
  const persistedSegs = useMemo(
    () => parseTrackSegments(session?.track_geojson ?? null),
    [session?.track_geojson],
  );
  const trackCount =
    persistedSegs.reduce((n, s) => n + s.length, 0) + (tracking ? livePoints.length : 0);
  const sortOrder = useSettings((s) => s.last_record_sort);
  const sortDir = useSettings((s) => s.last_record_sort_dir);

  // Lock + undo / redo (src/lib/useRecordEditing): an ended checklist is
  // read-only until unlocked here; every reload after an edit is one step.
  const edit = useRecordEditing('session', sessionId, session != null && session.status === 'done');
  const { checkpoint, absorb } = edit;
  // `detailKey` remounts the detail sheet after a refused edit, so its fields
  // drop what was typed and show the record again.
  const [detailKey, setDetailKey] = useState(0);
  /** Run an edit unless the record is locked. */
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      if (edit.refuse()) {
        setDetailKey((k) => k + 1);
        return;
      }
      fn(...a);
    };

  // Row ± writes, coalesced: the list updates at once, the DB 300 ms after the
  // last press on that row — ten quick taps are one write and one undo step.
  const pendingCounts = useRef(new Map<number, { value: number | null; timer: ReturnType<typeof setTimeout> }>());
  const writeCount = (id: number, value: number | null) =>
    updateRecordQuantity(id, value == null ? null : String(value), value == null ? null : 'individuals');
  /** Write any count still waiting — before a reload reads the DB back. */
  const flushCounts = useCallback(() => {
    for (const [id, p] of pendingCounts.current) {
      clearTimeout(p.timer);
      writeCount(id, p.value);
    }
    pendingCounts.current.clear();
  }, []);
  useEffect(() => flushCounts, [flushCounts]);

  const refresh = useCallback(() => {
    flushCounts();
    const s = getSession(sessionId);
    setSession(s);
    setProject(s ? getProject(s.project_id) : null);
    setSite(s && s.site_id !== null ? getSite(s.site_id) : null);
    setRecords(listSessionRecords(sessionId));
  }, [sessionId, flushCounts]);
  const reload = useCallback(() => {
    refresh();
    checkpoint();
  }, [refresh, checkpoint]);
  /** For the app's own late writes (GNSS stamp): not an undo step. */
  const reloadQuiet = useCallback(() => {
    refresh();
    absorb();
  }, [refresh, absorb]);

  useFocusEffect(
    useCallback(() => {
      reload();
      refreshActive();
    }, [reload, refreshActive]),
  );

  const filtered = useMemo(() => {
    let result = records;
    if (filterKey) {
      const group = HIGH_LEVEL_GROUPS.find((g) => g.key === filterKey);
      if (group) result = records.filter((r) => r[group.field] === group.value);
    }
    return sortRecords(result, sortOrder, sortDir);
  }, [records, filterKey, sortOrder, sortDir]);

  /** Step the detail sheet through `filtered` — i.e. exactly the order and the
   *  subset the user is looking at, filter chips and sort included. */
  const detailPager = useMemo(() => {
    if (!activeRecord) return undefined;
    const index = filtered.findIndex((r) => r.id === activeRecord.id);
    if (index < 0) return undefined;
    return {
      index,
      total: filtered.length,
      onStep: (dir: -1 | 1) => {
        const next = filtered[index + dir];
        if (next) setActiveRecord(next);
      },
    };
  }, [filtered, activeRecord]);

  const handleRowCount = (rec: RecordWithTaxon, next: number | null) => {
    if (edit.refuse()) return;
    // Not reload(): patch the one row. `records` feeds `filtered`, which is
    // the FlatList's data, so the cell redraws without extraData.
    setRecords((rs) =>
      rs.map((r) =>
        r.id === rec.id
          ? {
              ...r,
              organism_quantity: next == null ? null : String(next),
              organism_quantity_type: next == null ? null : 'individuals',
            }
          : r,
      ),
    );
    const prev = pendingCounts.current.get(rec.id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      pendingCounts.current.delete(rec.id);
      writeCount(rec.id, next);
      checkpoint();
    }, 300);
    pendingCounts.current.set(rec.id, { value: next, timer });
  };

  /** Taxa already on this list, for the search box's 已在名錄 mark. */
  const takenTaxa = useMemo(() => new Set(records.map((r) => r.taxon_id)), [records]);
  /** S for the header, counted as the records tab counts it. */
  const richness = useMemo(
    () =>
      computeDiversity(
        records.map((r) => ({
          taxon_id: r.taxon_id,
          used_scientific_name: r.used_scientific_name,
          organism_quantity: r.organism_quantity,
          organism_quantity_type: r.organism_quantity_type,
        })),
      ).richness,
    [records],
  );

  const groupCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of HIGH_LEVEL_GROUPS) map.set(g.key, 0);
    for (const r of records) {
      for (const g of HIGH_LEVEL_GROUPS) {
        if (r[g.field] === g.value) map.set(g.key, (map.get(g.key) ?? 0) + 1);
      }
    }
    return map;
  }, [records]);

  // Non-null = the docked SearchBox re-identifies that record instead of adding
  // a new one. Screen-level state because the search box is screen-level chrome;
  // putting one inside the detail Modal would need its own keyboard handling
  // (see `npm run check:dock`).
  const [replaceTarget, setReplaceTarget] = useState<RecordWithTaxon | null>(null);
  // Non-null = the picker returned and the import sheet is open over the list.
  const [pickedPhotos, setPickedPhotos] = useState<PickedPhoto[] | null>(null);

  const handlePickPhotosToImport = async () => {
    try {
      const picked = await pickPhotosWithExif();
      // Remember before the sheet opens: records created here start out
      // positioned, but clearing that coordinate later must still be able to
      // recover it from the same photo.
      rememberPickedPhotos(picked);
      if (picked.length > 0) setPickedPhotos(picked);
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  /** The dock's camera key: one photo, then the same import sheet as picking. */
  const handleTakePhotoToImport = async () => {
    try {
      const taken = await takePhotoWithExif();
      rememberPickedPhotos(taken);
      if (taken.length > 0) setPickedPhotos(taken);
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  const handleAdd = async (result: SearchResult, adopted?: AdoptionInput | null) => {
    if (!result.taxon_id) {
      toast(t('session.noTaxonId'));
      return;
    }
    // Re-identification keeps the row — notes, photos, audio, coordinates,
    // attributes, occurrence_id and the iNat link — and swaps only the name.
    if (replaceTarget) {
      const target = replaceTarget;
      // checklist_records has no UNIQUE(session_id, taxon_id); this is the only
      // guard. Re-identifying onto a species the list already holds would make
      // two rows share a taxon, so refuse rather than merge — merging would
      // have to decide whose notes, photos and occurrence_id survive, and that
      // occurrence_id may already be published to GBIF or iNaturalist.
      //
      // Landing on the SAME taxon is not a collision: that is "same concept,
      // filed under this synonym instead", which is a legitimate edit.
      if (result.taxon_id !== target.taxon_id && isTaxonInSession(sessionId, result.taxon_id)) {
        toast(t('session.alreadyExists', { name: result.cname || result.name }));
        return; // replaceTarget stays: they are still replacing, just picked wrong
      }
      setReplaceTarget(null);
      Keyboard.dismiss();
      updateRecordTaxon(target.id, result.taxon_id, adopted);
      reload();
      toast(t('session.taxonChanged', { name: result.cname || result.name }));
      return;
    }
    // A second row for the same taxon is asked about, not refused. Two rows CAN
    // be right: an identification that stops at a family or genus gives
    // `Orchidaceae sp1` and `sp2` the same taxon_id although they are different
    // morphospecies, and that is ordinary field work. A double tap is still the
    // commoner case, so it stays one tap away from being undone.
    if (isTaxonInSession(sessionId, result.taxon_id)) {
      // "+1" only where a count means individuals — the row the ± would step.
      // The newest such row, when a morphospecies split left several.
      const countable = records
        .filter(
          (r) =>
            r.taxon_id === result.taxon_id &&
            (r.organism_quantity_type == null || r.organism_quantity_type === 'individuals'),
        )
        .sort((a, b) => b.observed_at - a.observed_at)[0];
      const options = [
        ...(countable && !edit.locked ? [{ label: t('count.plusOne') }] : []),
        { label: t('session.addAnyway') },
      ];
      const choice = await showActionSheet({
        titleParts: sentenceParts(t('session.alreadyExists', { name: slot('name') }), {
          name: speciesParts(result.cname, result.name, result.rank, result.kingdom),
        }),
        message: t('session.duplicateHint'),
        cancelLabel: t('common.cancel'),
        options,
      });
      if (choice < 0) return;
      if (countable && !edit.locked && choice === 0) {
        const n = Number(countable.organism_quantity);
        handleRowCount(countable, Number.isFinite(n) && n > 0 ? n + 1 : 1);
        setFlashId(countable.id);
        toast(t('count.plusOneDone', { name: result.cname || result.name }));
        return;
      }
    }
    const recordId = addRecord({ session_id: sessionId, taxon_id: result.taxon_id, adopted });
    stampNewRecord('session', recordId, sessionId, reloadQuiet);
    setFlashId(recordId);
    reload();
    toast(t('session.added', { name: result.cname || result.name }), {
      action: {
        label: t('common.undo'),
        onPress: () => {
          edit.undo();
          reload();
        },
      },
    });
  };

  // The row just added from the search box lights up once (SpeciesCard).
  const [flashId, setFlashId] = useState<number | null>(null);

  // Long-press multi-select. What the old long-press menu offered (notes,
  // change taxon, favourites, remove) now lives in the detail sheet.
  const selection = useListSelection<number>();

  const handleBulkFavorite = () => {
    const rows = filtered.filter((r) => selection.picked.has(r.id));
    const taxa = [...new Set(rows.map((r) => r.taxon_id).filter(Boolean))];
    const added = taxa.filter((id) => useFavorites.getState().addById(id)).length;
    selection.exit();
    if (added > 0) toastFavoriteAdded(t('favorites.addedCount', { count: added }));
    else toast(t('favorites.addFail'));
  };

  const handleBulkDelete = () => {
    if (edit.refuse()) return;
    const rows = filtered.filter((r) => selection.picked.has(r.id));
    if (rows.length === 0) return;
    Alert.alert(
      t('species.deleteSelectedTitle'),
      t('species.deleteSelectedMsg', { count: rows.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            withTransaction(() => {
              for (const r of rows) deleteRecord(r.id);
            });
            selection.exit();
            reload();
          },
        },
      ],
    );
  };

  const handleSwipeRemove = (record: RecordWithTaxon) => {
    if (edit.refuse()) return;
    deleteRecord(record.id);
    reload();
    // The removal is the newest history step, so undo brings the whole row
    // back — photos, audio, coordinates, occurrence_id and iNat link included.
    toast(t('session.removed', { name: record.common_name_c || record.simple_name }), {
      action: {
        label: t('common.undo'),
        onPress: () => {
          edit.undo();
          reload();
        },
      },
    });
  };

  // The end time is asked first, before the end-session Modal: an iOS sheet
  // presented while a Modal is closing silently never appears.
  const [endTs, setEndTs] = useState<number | null>(null);
  const handleEnd = async () => {
    if (!session) return;
    const chosen = await chooseEndTime(session.ended_at);
    if (chosen === undefined) return;
    setEndTs(chosen);
    setEndModalOpen(true);
  };

  const handleEndConfirm = (data: { name: string; project_id: number; notes: string }) => {
    if (session) {
      endSession(session.id, data, endTs);
      saveVersionSoon('session', session.id, 'done');
      refreshActive();
      setEndModalOpen(false);
      goBackOrHome();
    }
  };

  const handleSaveActiveNotes = (newNotes: string) => {
    if (!activeRecord) return;
    updateRecordNotes(activeRecord.id, newNotes || null);
    setActiveRecord({ ...activeRecord, notes: newNotes || null });
    reload();
  };

  const handleAddPhoto = async (mode: 'camera' | 'library') => {
    if (!activeRecord) return;
    try {
      const { buildContext } = await import('~/lib/photoCapture');
      const picked = await takeSpeciesPhotos(buildContext(activeRecord), mode);
      if (picked.length === 0) return;
      const newUris = picked.map((p) => p.uri);
      const existing = parsePhotoPaths(activeRecord.photo_paths);
      const next = [...existing, ...newUris];
      updateRecordPhotos(activeRecord.id, next);
      setActiveRecord({ ...activeRecord, photo_paths: JSON.stringify(next) });
      reload();
      // A photo of the plant carries the position the recorder never got round
      // to saving. Applied ONLY when the record has none — silently replacing a
      // measured coordinate is not something attaching a photo should do. Same
      // rule as the 「用照片的 GNSS」 button, which stays for photos added before
      // this existed.
      if (activeRecord.lat === null || activeRecord.lng === null) {
        const out = await firstPhotoFix(picked);
        if (out.kind === 'found') {
          updateRecordLocation(activeRecord.id, out.fix.lat, out.fix.lng, out.fix.accuracyM, out.fix.altitudeM);
          setActiveRecord({
            ...activeRecord,
            photo_paths: JSON.stringify(next),
            lat: out.fix.lat,
            lng: out.fix.lng,
            accuracy: out.fix.accuracyM,
            ...(out.fix.altitudeM != null ? { elevation_m: out.fix.altitudeM, elevation_source: 'gnss' } : null),
          });
          reload();
        }
      }
      toast(
        mode === 'camera'
          ? t('session.photoSavedLinked')
          : newUris.length === 1
            ? t('session.photoAdded')
            : t('session.photosAdded', { count: newUris.length }),
      );
    } catch (e) {
      Alert.alert(t('session.photoFailTitle'), errText(e));
    }
  };

  const handleRemovePhoto = (uri: string) => {
    if (!activeRecord) return;
    const existing = parsePhotoPaths(activeRecord.photo_paths);
    const next = existing.filter((u) => u !== uri);
    updateRecordPhotos(activeRecord.id, next);
    setActiveRecord({
      ...activeRecord,
      photo_paths: next.length > 0 ? JSON.stringify(next) : null,
    });
    reload();
    toast(t('session.photoRemoved'));
  };

  // One record → the upload page with only this row pre-selected. A row with
  // neither photo nor clip cannot be uploaded at all, so say so here instead
  // of landing on a page that silently omits it.
  const handleUploadInat = (record: RecordWithTaxon) => {
    if (
      parsePhotoPaths(record.photo_paths).length + parsePhotoPaths(record.audio_paths).length ===
      0
    ) {
      toast(t('inat.noMediaRecord'));
      return;
    }
    router.push(`/inat-upload?kind=session&id=${sessionId}&record=${record.id}` as Href);
  };

  const inatSyncingId = useInatSync((s) => s.runningId);
  const activeInatChanged = useMemo(
    () =>
      activeRecord && activeRecord.inat_uploaded_at != null
        ? hasInatChanges({ kind: 'session', id: sessionId }, activeRecord.id)
        : false,
    [activeRecord, sessionId],
  );
  const handleInatSync = async (record: RecordWithTaxon) => {
    if (record.inat_uploaded_at == null) {
      // Not on iNat yet → the upload page, with this row pre-selected. The
      // sheet is a Modal, so it must close before the route push.
      setActiveRecord(null);
      handleUploadInat(record);
      return;
    }
    try {
      // The login WebView cannot be presented over the detail sheet (a Modal);
      // when a login is needed the sheet closes first.
      if (!(await inatTokenAvailableQuietly())) {
        setActiveRecord(null);
        await new Promise((res) => setTimeout(res, 450));
      }
      const r = await syncRecord({ kind: 'session', id: sessionId }, record.id);
      toast(
        r.noop
          ? t('inat.syncNoChange')
          : t('inat.syncDone', {
              added: r.annotationsAdded,
              removed: r.annotationsRemoved,
              media: r.mediaSent,
            }),
      );
      reload();
      const fresh = listSessionRecords(sessionId).find((x) => x.id === record.id);
      if (fresh) setActiveRecord(fresh);
    } catch (e) {
      toast(t('inat.syncFailed', { msg: await apiErrorMessage(e) }));
    }
  };

  const handleAddAudio = (uri: string) => {
    if (!activeRecord) return;
    const next = [...parsePhotoPaths(activeRecord.audio_paths), uri];
    updateRecordAudio(activeRecord.id, next);
    setActiveRecord({ ...activeRecord, audio_paths: JSON.stringify(next) });
    reload();
    toast(t('session.audioAdded'));
  };

  const handleRemoveAudio = (uri: string) => {
    if (!activeRecord) return;
    const next = parsePhotoPaths(activeRecord.audio_paths).filter((u) => u !== uri);
    updateRecordAudio(activeRecord.id, next);
    // Deleted once no undo step can bring the clip back, and only if no other
    // record (a merge shares clips) still points at it.
    edit.deferAudioDelete(uri);
    setActiveRecord({
      ...activeRecord,
      audio_paths: next.length > 0 ? JSON.stringify(next) : null,
    });
    reload();
    toast(t('session.audioRemoved'));
  };

  const handleAssignProject = (projectId: number) => {
    if (!session) return;
    updateSession(session.id, { project_id: projectId });
    setProjectSheetOpen(false);
    reload();
    toast(t('session.projectUpdated'));
  };

  // ── GNSS ───────────────────────────────────────────────────────

  const ensureForegroundPermission = async (): Promise<boolean> => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
      return false;
    }
    return true;
  };

  const handleDropPoint = async () => {
    if (!session) return;
    const ok = await ensureForegroundPermission();
    if (!ok) return;
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      updateSession(session.id, {
        start_lat: pos.coords.latitude,
        start_lng: pos.coords.longitude,
        // Dropping a point IS the single-point mode. The column existed and the
        // yml round-trip carried it, but nothing ever wrote this value, so a
        // session located this way exported with no mode at all — the export
        // could not tell it apart from one that was never located.
        // A track already in progress owns the mode; don't downgrade it.
        ...(session.gps_mode === 'full_track' ? null : { gps_mode: 'single_point' as const }),
      });
      reload();
      toast(t('gnss.posRecorded'));
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  const handleStartTrack = async () => {
    if (!session) return;
    // Single recorder: block if another record is already recording. The
    // recorder owns permission prompting (throws '需要定位權限').
    if (
      recordingTarget &&
      !(recordingTarget.kind === 'session' && recordingTarget.id === session.id)
    ) {
      Alert.alert(t('gnss.trackBusyTitle'), t('gnss.trackBusyMsg'));
      return;
    }
    try {
      // Resume (if a track already exists) is handled inside the recorder,
      // which loads prior segments and appends a new one.
      await startRecording({ kind: 'session', id: session.id });
      toast(t('gnss.trackStarted'));
    } catch (e) {
      Alert.alert(t('gnss.trackStartFail'), errText(e));
    }
  };

  const handleStopTrack = useCallback(() => {
    if (isRecordingTarget({ kind: 'session', id: sessionId })) {
      pauseRecording(); // commits the in-progress segment
    }
    reload();
    toast(t('gnss.trackSaved'));
  }, [sessionId, reload, toast]);

  const handleClearGps = () => {
    if (!session) return;
    Alert.alert(t('gnss.clearTitle'), t('gnss.clearMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.clear'),
        style: 'destructive',
        onPress: () => {
          // Tear down the watch first so it can't re-write the row after we
          // null it out below.
          if (tracking) pauseRecording();
          updateSession(session.id, {
            site_id: null,
            start_lat: null,
            start_lng: null,
            track_geojson: null,
            gps_mode: null,
          });
          reload();
          toast(t('gnss.cleared'));
        },
      },
    ]);
  };

  /** Create a Point site from current GNSS and assign to this session. */
  const handleCreatePointSiteFromGps = async () => {
    if (!session) return;
    const ok = await ensureForegroundPermission();
    if (!ok) return;
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const { createSite } = await import('~/db');
      const stamp = isoDateTime(Date.now());
      const newSiteId = createSite({
        project_id: session.project_id,
        session_id: session.id,
        name: `${session.name} · ${stamp}`,
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
      updateSession(session.id, { site_id: newSiteId, start_lat: lat, start_lng: lng });
      reload();
      toast(t('session.pointSiteCreated'));
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  const handleSpatialMenu = async () => {
    if (!session) return;
    await showSpatialMenu({
      siteName: session.site_id !== null ? (site?.name ?? '') : null,
      hasPoint: session.start_lat !== null && session.start_lng !== null,
      trackHasData: trackCount > 0 || (session.track_geojson ?? '').length > 0,
      tracking,
      trackCount,
      onAssignSite: () => setSiteSheetOpen(true),
      onCreatePointSite: handleCreatePointSiteFromGps,
      onDropPoint: handleDropPoint,
      onStartTrack: handleStartTrack,
      onStopTrack: handleStopTrack,
      onClear: handleClearGps,
    });
  };

  const handleAssignSite = (siteId: number | null) => {
    if (!session) return;
    updateSession(session.id, { site_id: siteId });
    setSiteSheetOpen(false);
    reload();
    toast(siteId === null ? t('session.siteUnassigned') : t('session.siteAssigned'));
  };

  const handleCreateSiteForSession = (drawType: 'Point' | 'LineString' | 'Polygon') => {
    setSiteSheetOpen(false);
    if (!session) return;
    // Hand off to map tab in drawing mode, scoped to current session.
    router.push(`/(tabs)/map?draw=${drawType}&session=${session.id}`);
  };

  const handleReopen = () => {
    if (!session) return;
    const otherActive = getActiveSession();
    const proceed = () => {
      // Reopen force-ends any other active record DB-side; stop a GNSS watch
      // that belongs to something other than this session so it can't keep
      // writing to a now-ended record.
      pauseIfNot({ kind: 'session', id: session.id });
      reopenSession(session.id);
      // Reopen force-ends any active plot DB-side too, so refresh both stores
      // — otherwise activePlot store keeps the stale plot reference and the
      // ActiveSessionBar / StalePlotWatcher misbehave until the next nav.
      refreshActive();
      refreshActivePlot();
      useActiveGloria.getState().refresh();
      reload();
      toast(t('session.reopened'));
    };
    if (otherActive && otherActive.id !== session.id) {
      Alert.alert(
        t('session.otherActiveTitle'),
        t('session.otherActiveMsg', { name: otherActive.name }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('session.endOldAndReopen'),
            style: 'destructive',
            onPress: () => {
              endSession(otherActive.id);
              proceed();
            },
          },
        ],
      );
    } else {
      proceed();
    }
  };

  if (!session) {
    return (
      <View className="flex-1 items-center justify-center bg-card dark:bg-gray-900">
        <Stack.Screen options={{ title: t('nav.session'), headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500 dark:text-gray-400">{t('common.loading')}</Text>
      </View>
    );
  }

  const isActive = session.status === 'active';

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          // The record's own name; the project moved to the context strip.
          title: session.name,
          headerTitle: () => (
            <HeaderTitleText
              text={session.name}
              subtitle={
                <RecordStatusLine
                  active={isActive}
                  startedAt={session.started_at}
                  endedAt={session.ended_at}
                  species={richness}
                />
              }
            />
          ),
          // Override the default chevron back so a fresh deep-link / replace
          // entry doesn't strand the user with a dead button.
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <RecordMenuButton
                kind="session"
                id={sessionId}
                reportHref={`/report/session/${sessionId}` as Href}
                onSynced={reload}
                // Moved here from the filter row: two actions that only mean
                // something while recording, taking width from the chips.
                extra={
                  isActive
                    ? [
                        {
                          label: t('batchImport.title'),
                          icon: 'list-outline',
                          section: t('menu.addSpecies'),
                          onPress: () => setBatchImportOpen(true),
                        },
                        {
                          label: t('photoImport.entry'),
                          icon: 'images-outline',
                          section: t('menu.addSpecies'),
                          onPress: () => void handlePickPhotosToImport(),
                        },
                      ]
                    : []
                }
                edit={edit}
                onEdited={reload}
              />
              <RecordEditButtons edit={edit} ended={!isActive} onChanged={reload} inMenu />
              {isActive ? (
                <EndRecordButton onPress={() => void handleEnd()} />
              ) : edit.locked ? (
                <HeaderIconButton
                  icon="refresh-outline"
                  onPress={handleReopen}
                  label={t('session.continueEdit')}
                />
              ) : null}
            </View>
          ),
        }}
      />
      <View className="flex-1">
        {/* Context strip — project · place · survey time · surveyor. Every
            chip keeps the tap it had as a bare icon; unset ones are dashed so
            what is still missing before ending shows at a glance. */}
        <ContextStrip>
          <ContextChip
            icon="folder-outline"
            label={project && project.id !== 0 ? project.name : t('session.projectUnset')}
            set={!!project && project.id !== 0}
            onPress={guard(() => setProjectSheetOpen(true))}
          />
          {/* Priority: tracking > site assigned > start point > empty */}
          <ContextChip
            icon={site ? 'pin' : 'location-outline'}
            label={
              tracking
                ? t('session.trackBadge', { count: trackCount })
                : site
                  ? site.name
                  : session.start_lat !== null
                    ? t('session.located')
                    : t('session.spatial')
            }
            set={tracking || !!site || session.start_lat !== null}
            tone={tracking ? 'live' : 'default'}
            onPress={isActive ? handleSpatialMenu : guard(() => setSiteSheetOpen(true))}
          />
          {/* Survey start / end — typed by hand for old field sheets. */}
          <ContextChip
            icon="time-outline"
            label={
              session.ended_at
                ? `${isoTime(session.started_at)}–${isoTime(session.ended_at)}`
                : isoTime(session.started_at)
            }
            set
            onPress={() => setTimesOpen(true)}
          />
          <ContextChip
            icon="people-outline"
            label={session.recorded_by || t('session.surveyorUnset')}
            set={!!session.recorded_by}
            onPress={guard(() => setSurveyorSheetOpen(true))}
          />
        </ContextStrip>
        {/* Row 2 — filter chips (scrollable) + sort + batch import. While
            selecting, the selection bar takes its place (row 1 stays). */}
        {selection.selectMode ? (
          <SelectionToolbar
            count={selection.picked.size}
            allPicked={filtered.length > 0 && filtered.every((r) => selection.picked.has(r.id))}
            onToggleAll={() => selection.toggleAll(filtered.map((r) => r.id))}
            onCancel={selection.exit}
          />
        ) : (
          <View className="flex-row items-center border-b border-gray-200 bg-card dark:border-gray-700 dark:bg-gray-900">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="flex-1"
              accessibilityRole="tablist"
              contentContainerStyle={{
                paddingHorizontal: 8,
                paddingVertical: 8,
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Chip
                label={t('records.filterAll')}
                count={records.length}
                selected={filterKey === null}
                onPress={() => setFilterKey(null)}
              />
              {HIGH_LEVEL_GROUPS.map((g) => {
                const count = groupCounts.get(g.key) ?? 0;
                if (count === 0) return null;
                return (
                  <Chip
                    key={g.key}
                    label={t('group.' + g.key)}
                    count={count}
                    selected={filterKey === g.key}
                    onPress={() => setFilterKey(g.key)}
                  />
                );
              })}
            </ScrollView>
            {/* Sort and its direction. Batch and photo import moved to the header's ⋯. */}
            <RecordSortControls />
          </View>
        )}
        {filtered.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Ionicons name="search-outline" size={56} color={c.ink3} />
            <Text className="mt-3 text-base text-gray-700 dark:text-gray-300">
              {records.length === 0 ? t('session.emptyHint') : t('session.emptyGroup')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(r) => `${r.id}`}
            renderItem={({ item }) => (
              <SwipeRowActions
                disabled={selection.selectMode}
                actions={[
                  {
                    label: t('records.uploadInat'),
                    icon: 'cloud-upload-outline',
                    color: 'inat',
                    onPress: () => handleUploadInat(item),
                  },
                  {
                    label: t('common.remove'),
                    icon: 'trash',
                    color: 'red',
                    onPress: () => handleSwipeRemove(item),
                  },
                ]}
              >
                <SpeciesCard
                  record={item}
                  onPress={() =>
                    selection.selectMode ? selection.toggle(item.id) : setActiveRecord(item)
                  }
                  onLongPress={() => selection.enter(item.id)}
                  selectMode={selection.selectMode}
                  picked={selection.picked.has(item.id)}
                  flash={item.id === flashId}
                  onCountChange={edit.locked ? undefined : (next) => handleRowCount(item, next)}
                />
              </SwipeRowActions>
            )}
          />
        )}
      </View>
      {/* Sits directly above the search box it is talking about ("pick one
          below"), which also puts Cancel in the thumb zone. It must stay ABOVE
          the KeyboardStickyView. */}
      {replaceTarget ? (
        <View className="flex-row items-center border-t border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950/40">
          <Ionicons name="swap-horizontal" size={14} color="#d97706" />
          <Text className="ml-2 flex-1 text-xs text-amber-800 dark:text-amber-300" numberOfLines={1}>
            {t('session.changeTaxonBanner', {
              name: replaceTarget.common_name_c || replaceTarget.simple_name,
            })}
          </Text>
          <Pressable onPress={() => setReplaceTarget(null)} hitSlop={8} className="active:opacity-70">
            <Text className="text-xs font-medium text-amber-800 dark:text-amber-300">
              {t('common.cancel')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {/* While selecting, the actions take the dock's place (05-controls.md §2.1). */}
      {selection.selectMode ? (
        <SelectionDock
          count={selection.picked.size}
          actions={[
            { label: t('favorites.add'), onPress: handleBulkFavorite },
            { label: t('common.delete'), onPress: handleBulkDelete, destructive: true },
          ]}
        />
      ) : null}
      {/* `|| replaceTarget`: a finished checklist still needs the box to fix a
          wrong determination, without reopening the whole record. */}
      {!selection.selectMode && (isActive || replaceTarget) ? (
        // Sticks above the keyboard regardless of accessory-bar height
        // changes (e.g. iOS predictive suggestions). Sibling to the content
        // View, not a child, so kbd-driven translation doesn't push the
        // records list around.
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <SearchBox
            onSelect={handleAdd}
            markedTaxa={takenTaxa}
            markLabel={t('session.inList')}
            trailing={
              isActive ? (
                <Pressable
                  onPress={() => void handleTakePhotoToImport()}
                  accessibilityRole="button"
                  accessibilityLabel={t('session.cameraAdd')}
                  className="h-12 w-12 items-center justify-center rounded-full border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
                >
                  <Ionicons name="camera-outline" size={22} color={c.ink2} />
                </Pressable>
              ) : undefined
            }
            onLongPressResult={async (r) => {
              // iOS UIKit won't present a Modal while keyboard / Chinese IME
              // composition is still active. Dismiss first, wait one frame,
              // then mount LookupResultSheet.
              Keyboard.dismiss();
              if (Platform.OS === 'ios') await new Promise((res) => setTimeout(res, 150));
              setSearchPreview(r);
            }}
          />
        </KeyboardStickyView>
      ) : null}

      <SpeciesDetailSheet
        key={detailKey}
        onReplaceTaxon={guard(() => {
          if (!activeRecord) return;
          setReplaceTarget(activeRecord);
          // The sheet is a Modal and the docked SearchBox lives under it, so it
          // has to close before the hand-off means anything.
          setActiveRecord(null);
        })}
        record={activeRecord}
        pager={detailPager}
        onClose={() => setActiveRecord(null)}
        onRemove={guard(() => {
          if (activeRecord) {
            deleteRecord(activeRecord.id);
            reload();
          }
        })}
        onSaveNotes={guard(handleSaveActiveNotes)}
        onSaveQuantity={guard((count: number | null) => {
          if (!activeRecord) return;
          // Always `individuals` — see CountField. Clearing wipes BOTH columns:
          // a type with no quantity would export an organismQuantityType that
          // quantifies nothing.
          updateRecordQuantity(
            activeRecord.id,
            count == null ? null : String(count),
            count == null ? null : 'individuals',
          );
          setActiveRecord({
            ...activeRecord,
            organism_quantity: count == null ? null : String(count),
            organism_quantity_type: count == null ? null : 'individuals',
          });
          reload();
        })}
        onSaveVerbatim={guard((value: string | null) => {
          if (!activeRecord) return;
          updateRecordAttributes(activeRecord.id, { verbatim_identification: value });
          // Patch the open sheet too — `reload()` refreshes the list behind it,
          // but activeRecord is a snapshot and would keep showing the old label.
          setActiveRecord({ ...activeRecord, verbatim_identification: value });
          reload();
        })}
        onSaveLocation={guard((lat: number | null, lng: number | null, accuracy: number | null) => {
          if (!activeRecord) return;
          updateRecordLocation(activeRecord.id, lat, lng, accuracy);
          setActiveRecord({ ...activeRecord, lat, lng, accuracy });
          reload();
          toast(lat === null ? t('session.coordCleared') : t('session.coordRecorded'));
        })}
        onChangeLocation={guard((lat: number, lng: number, accuracy: number | null) => {
          // Inline map edit: persist quietly (no toast). A hand-placed point
          // arrives with accuracy null; an undo restoring a GNSS fix carries the
          // measured value back, so pass it through rather than clearing it.
          if (!activeRecord) return;
          updateRecordLocation(activeRecord.id, lat, lng, accuracy);
          setActiveRecord({ ...activeRecord, lat, lng, accuracy });
          reload();
        })}
        onSaveElevation={guard((metres: number | null, source: 'gnss' | 'manual') => {
          if (!activeRecord) return;
          updateRecordElevation(activeRecord.id, metres, source);
          // Functional: the GNSS button saves the coordinate and then this in
          // the same tap, and a spread of the `activeRecord` snapshot here
          // would put the old coordinate back.
          setActiveRecord((prev) =>
            prev
              ? { ...prev, elevation_m: metres, elevation_source: metres != null ? source : null }
              : prev,
          );
          reload();
        })}
        onAddPhoto={guard((mode: 'camera' | 'library') => void handleAddPhoto(mode))}
        onRemovePhoto={guard(handleRemovePhoto)}
        onAddAudio={guard(handleAddAudio)}
        onRemoveAudio={guard(handleRemoveAudio)}
        inat={
          activeRecord
            ? {
                uploaded: activeRecord.inat_uploaded_at != null,
                changed: activeInatChanged,
                syncing: inatSyncingId === activeRecord.id,
                onPress: () => void handleInatSync(activeRecord),
              }
            : undefined
        }
        onSaveAttributes={guard((next: SpeciesAttributesDraft) => {
          if (!activeRecord) return;
          // SpeciesAttributesDraft holds arrays in-memory; serialize before
          // writing to the TEXT column.
          const persisted = {
            sex: next.sex,
            life_stage: next.life_stage,
            reproductive_condition:
              next.reproductive_condition.length > 0
                ? JSON.stringify(next.reproductive_condition)
                : null,
            leaf_phenology:
              next.leaf_phenology.length > 0 ? JSON.stringify(next.leaf_phenology) : null,
            degree_of_establishment: next.degree_of_establishment,
          };
          updateRecordAttributes(activeRecord.id, persisted);
          setActiveRecord({ ...activeRecord, ...persisted });
          reload();
        })}
      />

      {/* Long-press → 編輯備註 走獨立 modal（不在 detail sheet 開時）*/}

      {endModalOpen ? (
        <EndSessionModal
          visible={endModalOpen}
          session={session}
          recordCount={records.length}
          onCancel={() => setEndModalOpen(false)}
          onConfirm={handleEndConfirm}
          onDeleteEmpty={() => {
            deleteSession(session.id);
            refreshActive();
            setEndModalOpen(false);
            goBackOrHome();
          }}
        />
      ) : null}

      <ProjectAssignSheet
        visible={projectSheetOpen}
        currentProjectId={session.project_id}
        onCancel={() => setProjectSheetOpen(false)}
        onAssign={handleAssignProject}
      />

      <SurveyorAssignSheet
        visible={surveyorSheetOpen}
        current={session.recorded_by ?? ''}
        onCancel={() => setSurveyorSheetOpen(false)}
        onAssign={(v) => {
          updateSession(session.id, { recorded_by: v || null });
          reload();
          setSurveyorSheetOpen(false);
        }}
      />

      <SurveyTimesModal
        visible={timesOpen}
        onClose={() => setTimesOpen(false)}
        start={session.started_at}
        end={session.ended_at}
        startRequired
        readOnly={edit.locked}
        onChange={guard((which: 'start' | 'end', ts: number | null) => {
          if (which === 'start') {
            if (ts != null) updateSession(session.id, { started_at: ts });
          } else updateSession(session.id, { ended_at: ts });
          reload();
        })}
      />

      <SiteAssignSheet
        visible={siteSheetOpen}
        currentSiteId={session.site_id}
        preferredProjectId={session.project_id}
        onCancel={() => setSiteSheetOpen(false)}
        onAssign={handleAssignSite}
        onCreateNew={handleCreateSiteForSession}
      />

      {pickedPhotos ? (
        <PhotoImportModal
          picked={pickedPhotos}
          onCancel={() => setPickedPhotos(null)}
          onConfirm={(rows) => {
            setPickedPhotos(null);
            if (rows.length === 0) {
              toast(t('photoImport.none'));
              return;
            }
            for (const r of rows) {
              const id = addRecord({
                session_id: sessionId,
                taxon_id: r.taxon_id,
                observed_at: r.observed_at,
                lat: r.lat,
                lng: r.lng,
                accuracy: r.accuracy,
                photo_paths: r.photo_paths,
              });
              if (id && r.elevation_m != null) updateRecordElevation(id, r.elevation_m, 'gnss');
            }
            reload();
            toast(t('session.imported', { count: rows.length }));
          }}
        />
      ) : null}

      <BatchImportModal
        visible={batchImportOpen}
        target={{ kind: 'session', sessionId: session.id }}
        onClose={() => setBatchImportOpen(false)}
        onCommitted={(added) => {
          reload();
          if (added > 0) toast(t('session.imported', { count: added }));
        }}
      />

      <LookupResultSheet
        result={searchPreview}
        onClose={() => setSearchPreview(null)}
        onAddToSession={() => {
          if (searchPreview) handleAdd(searchPreview);
        }}
      />
    </SafeAreaView>
  );
}
