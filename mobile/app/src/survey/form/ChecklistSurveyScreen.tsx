/**
 * A checklist-style survey drawn with 快速名錄's screen (2G-c; Modular_survey.md
 * §9): the same header (status line, ⋯, lock, 結束 / 繼續編輯), context strip
 * (project, place with the same menu, time, surveyors, and 調查資料 for the
 * template's other survey components), group chips with sort — plus
 * 交互作用 when the template records them —, species rows with − n ＋,
 * long-press selection, the docked search with camera, the repeat prompt
 * (+1 / add anyway) and the add toast with undo, and the species detail sheet
 * stepping through the list.
 *
 * The template decides what the sheet shows (moduleMap.ts): a component the
 * sheet has a field for uses that field, the rest follow it in template order.
 *
 * Kept from the survey screen it replaces (Phase 2C): the template upgrade
 * banner, the blind phase of a recheck (its banner, 結束盲測, sealed rows), and
 * occurrences made only as an interaction's other side listed last, marked,
 * and not counted.
 */
import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Keyboard, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { EndRecordButton } from '~/components/EndRecordButton';
import { NumAccessory } from '~/components/form/NumField';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { HeaderTitleText } from '~/components/HeaderTitleText';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { LookupResultSheet } from '~/components/LookupResultSheet';
import { PhotoImportModal } from '~/components/PhotoImportModal';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import { RecordEditButtons } from '~/components/RecordEditButtons';
import { RecordMenuButton } from '~/components/RecordMenuButton';
import { RecordSortControls } from '~/components/RecordSortControls';
import { RecordStatusLine } from '~/components/RecordStatusLine';
import { SearchBox } from '~/components/SearchBox';
import { SelectionDock, SelectionToolbar } from '~/components/SelectionToolbar';
import { SiteAssignSheet } from '~/components/SiteAssignSheet';
import type { SpeciesAttributesDraft } from '~/components/SpeciesAttributesBlock';
import { SpeciesCard } from '~/components/SpeciesCard';
import { SpeciesDetailSheet } from '~/components/SpeciesDetailSheet';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { SurveyTimesModal } from '~/components/SurveyTimeFields';
import { SwipeRowActions } from '~/components/SwipeRowActions';
import { promptText } from '~/components/TextPromptModal';
import { Button } from '~/components/ui/Button';
import { Chip } from '~/components/ui/Chip';
import { ContextChip, ContextStrip } from '~/components/ui/ContextChip';
import { parseTrackSegments, type AdoptionInput, type RecordWithTaxon, type SearchResult } from '~/db';
import { withTransaction } from '~/db/init';
import { onVersionRestored, saveVersionSoon } from '~/db/recordVersions';
import { isoDateTime, isoTime } from '~/lib/datetime';
import { computeDiversity } from '~/lib/diversity';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { toastFavoriteAdded } from '~/lib/favoritesToast';
import { BackHeaderLeft } from '~/lib/goBack';
import { sentenceParts, slot, speciesParts } from '~/lib/nameParts';
import { pickPhotosWithExif, takePhotoWithExif, type PickedPhoto } from '~/lib/photoCapture';
import { firstPhotoFix, rememberPickedPhotos } from '~/lib/photoMeta';
import { confirmReopenOver } from '~/lib/recordCreate';
import { isPreviewId } from '~/db/previewDb';
import { stampNewRecord } from '~/lib/recordFix';
import { HIGH_LEVEL_GROUPS, sortRecords } from '~/lib/recordList';
import { showSpatialMenu } from '~/lib/spatialMenu';
import { takeSpeciesPhotos } from '~/lib/speciesPhotos';
import { isRecordingTarget, pauseIfNot, pauseRecording, startRecording, useTrackRecorder } from '~/lib/trackRecorder';
import { useListSelection } from '~/lib/useListSelection';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveMiren } from '~/modules/miren/store';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { useFavorites } from '~/stores/favorites';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { componentLabel } from '~/survey/components/editors/ComponentEditor';
import { InteractionCard } from '~/survey/components/InteractionCard';
import { InteractionSummary } from '~/survey/components/InteractionSummary';
import type { ComponentOwner } from '~/survey/db/surveyCore';
import {
  addMedia,
  addOccurrence,
  closeBlindPhase,
  deleteOccurrence,
  assertDeletableSurveys,
  deleteSurvey,
  finishSurvey,
  readComponent,
  removeMedia,
  reopenBlindPhase,
  reopenSurvey,
  updateOccurrence,
  updateSurvey,
  upgradeSurvey,
  writeComponent,
} from '~/survey/db/surveys';
import { useActiveSurvey } from './activeSurvey';
import { layerCountOf } from './checks';
import { ComponentCards } from './ComponentCards';
import { isIndividuals, occurrenceModules, surveyModules } from './moduleMap';
import { surveyDataStatus } from './surveyGroups';
import { blankOccurrenceHasErrors } from './occurrenceForm';
import { occurrenceRecord } from './occurrenceRecord';
import { formErrorText } from './text';
import { useSurveyForm, type OccurrenceView } from './useSurveyForm';
import { withLiveSegment } from '~/lib/track';

const refreshStores = () => {
  useActiveSurvey.getState().refresh();
  useActiveSession.getState().refresh();
  useActivePlot.getState().refresh();
  useActiveGloria.getState().refresh();
  useActiveMiren.getState().refresh();
};

/** The filter row: a group of 快速名錄's, or the survey's interactions in place of the list. */
type Filter = string | null;
const INTERACTIONS = '__interactions';

export function ChecklistSurveyScreen({ id, openId }: { id: number; openId?: number }) {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const { data, reload: load } = useSurveyForm(id);
  const survey = data?.survey ?? null;
  useVersionOnLeave('modular', id);

  // Lock + undo / redo, as on 快速名錄: an ended survey is read-only until unlocked here.
  const edit = useRecordEditing('modular', id, survey?.status === 'done');
  const { checkpoint, absorb } = edit;
  // Remounts the detail sheet after a refused edit, so its fields show the record again.
  const [detailKey, setDetailKey] = useState(0);

  // Row ± writes, coalesced as on 快速名錄: the row updates at once, the DB 300 ms after the last press.
  const pendingCounts = useRef(new Map<number, { value: number | null; timer: ReturnType<typeof setTimeout> }>());
  const [countPatch, setCountPatch] = useState<ReadonlyMap<number, number | null>>(new Map());
  const writeCount = (occ: number, value: number | null) => {
    try {
      updateOccurrence(occ, { organism_quantity: value == null ? null : String(value), organism_quantity_type: value == null ? null : 'individuals' });
    } catch (e) {
      toast(formErrorText(t, e));
    }
  };
  const flushCounts = useCallback(() => {
    for (const [occ, p] of pendingCounts.current) {
      clearTimeout(p.timer);
      writeCount(occ, p.value);
    }
    pendingCounts.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => flushCounts, [flushCounts]);

  const refresh = useCallback(() => {
    flushCounts();
    setCountPatch(new Map());
    load();
  }, [flushCounts, load]);
  const reload = useCallback(() => {
    refresh();
    checkpoint();
  }, [refresh, checkpoint]);
  /** For the app's own late writes (GNSS stamp): not an undo step. */
  const reloadQuiet = useCallback(() => {
    refresh();
    absorb();
  }, [refresh, absorb]);
  // A version restored from the versions screen (opened over this one): read everything again.
  useEffect(() => onVersionRestored((kind, rid) => kind === 'modular' && rid === id && load()), [id, load]);

  const [filterKey, setFilterKey] = useState<Filter>(null);
  const [activeId, setActiveId] = useState<number | null>(openId ?? null);
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [siteSheetOpen, setSiteSheetOpen] = useState(false);
  const [surveyorSheetOpen, setSurveyorSheetOpen] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);
  const [searchPreview, setSearchPreview] = useState<SearchResult | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<OccurrenceView | null>(null);
  const [pickedPhotos, setPickedPhotos] = useState<PickedPhoto[] | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const selection = useListSelection<number>();
  const sortOrder = useSettings((s) => s.last_record_sort);
  const sortDir = useSettings((s) => s.last_record_sort_dir);

  // Track recording lives in the module-level recorder, as on 快速名錄.
  const recordingTarget = useTrackRecorder((s) => s.recordingTarget);
  const livePoints = useTrackRecorder((s) => s.livePoints);
  const tracking = recordingTarget?.kind === 'modular' && recordingTarget.id === id;
  const persistedSegs = useMemo(() => parseTrackSegments(survey?.track_geojson ?? null), [survey?.track_geojson]);
  // The saved track may already hold an earlier copy of the live segment.
  const trackCount = (tracking ? withLiveSegment(persistedSegs, livePoints) : persistedSegs).reduce((n, s) => n + s.length, 0);

  const template = data?.template ?? null;
  const mods = useMemo(() => (template ? occurrenceModules(template) : null), [template]);
  const smods = useMemo(() => (template ? surveyModules(template) : null), [template]);
  const byId = useMemo(() => new Map((data?.occurrences ?? []).map((o) => [o.id, o])), [data]);
  /** The rows as 快速名錄 reads them, with any count still waiting to be written. */
  const records = useMemo(
    () =>
      (data?.occurrences ?? []).map((o) => {
        const r = occurrenceRecord(o);
        if (!countPatch.has(o.id)) return r;
        const v = countPatch.get(o.id) ?? null;
        return { ...r, organism_quantity: v == null ? null : String(v), organism_quantity_type: v == null ? null : 'individuals' };
      }),
    [data, countPatch],
  );
  const filtered = useMemo(() => {
    let result = records;
    const group = HIGH_LEVEL_GROUPS.find((g) => g.key === filterKey);
    if (group) result = records.filter((r) => r[group.field] === group.value);
    const sorted = sortRecords(result, sortOrder, sortDir);
    // Those made only as an interaction's other side come last (2F).
    return [...sorted.filter((r) => !byId.get(r.id)?.via_interaction), ...sorted.filter((r) => byId.get(r.id)?.via_interaction)];
  }, [records, filterKey, sortOrder, sortDir, byId]);
  // Counts leave out those made only as an interaction's other side (2F).
  const counted = useMemo(() => records.filter((r) => !byId.get(r.id)?.via_interaction), [records, byId]);
  const groupCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of HIGH_LEVEL_GROUPS) map.set(g.key, counted.filter((r) => r[g.field] === g.value).length);
    return map;
  }, [counted]);
  const richness = useMemo(
    () =>
      computeDiversity(
        counted.map((r) => ({
          taxon_id: r.taxon_id,
          used_scientific_name: r.used_scientific_name,
          organism_quantity: r.organism_quantity,
          organism_quantity_type: r.organism_quantity_type,
        })),
      ).richness,
    [counted],
  );
  const takenTaxa = useMemo(() => new Set(counted.map((r) => r.taxon_id)), [counted]);

  const active = activeId != null ? (records.find((r) => r.id === activeId) ?? null) : null;
  const activeOcc = activeId != null ? (byId.get(activeId) ?? null) : null;
  /** The extra components' values of the open occurrence, read again with every reload (`data`). */
  const extraValues = useMemo(() => {
    if (!mods || !activeOcc) return {};
    const comps = [...mods.extras, ...(mods.abundance && !mods.countOnly ? [mods.abundance] : [])];
    return Object.fromEntries(comps.map((x) => [x.key, readComponent({ kind: 'occurrence', id: activeOcc.id }, x.key)]));
  }, [mods, activeOcc]);
  /** Step the sheet through exactly what the list shows. */
  const detailPager = useMemo(() => {
    if (activeId == null) return undefined;
    const index = filtered.findIndex((r) => r.id === activeId);
    if (index < 0) return undefined;
    return {
      index,
      total: filtered.length,
      onStep: (dir: -1 | 1) => {
        const next = filtered[index + dir];
        if (next) setActiveId(next.id);
      },
    };
  }, [filtered, activeId]);

  if (!data || !survey || !template || !mods || !smods) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-ink-3 dark:text-gray-400">{t('surveyForm.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const isActive = survey.status === 'active';
  const blindOpen = !!data.recheck && survey.blind_closed_at == null;
  const unlockedQuery = edit.unlocked ? '?unlocked=1' : '';

  /** Run an edit unless the survey is locked; a value refused by the store is told and the sheet shows the record again. */
  const write = (fn: () => void): boolean => {
    if (edit.refuse()) {
      setDetailKey((k) => k + 1);
      return false;
    }
    try {
      fn();
    } catch (e) {
      toast(formErrorText(t, e));
      setDetailKey((k) => k + 1);
      return false;
    }
    reload();
    return true;
  };
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      if (edit.refuse()) {
        setDetailKey((k) => k + 1);
        return;
      }
      fn(...a);
    };
  // A preview's scratch database has no projects or sites of user.db: assigning
  // one would fail on its foreign key, and a new site would be left in user.db (code review V5).
  const preview = isPreviewId(id);
  const refusePreview = () => toast(t('builder.previewNoAssign'));

  // ── species ────────────────────────────────────────────────────────────────

  const handleRowCount = (rec: RecordWithTaxon, next: number | null) => {
    if (edit.refuse()) return;
    setCountPatch((m) => new Map(m).set(rec.id, next));
    const prev = pendingCounts.current.get(rec.id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      pendingCounts.current.delete(rec.id);
      writeCount(rec.id, next);
      checkpoint();
    }, 300);
    pendingCounts.current.set(rec.id, { value: next, timer });
  };

  const undoToast = (msg: string) =>
    toast(msg, {
      action: {
        label: t('common.undo'),
        onPress: () => {
          edit.undo();
          reload();
        },
      },
    });

  const handleAdd = async (result: SearchResult, adopted?: AdoptionInput | null, opts: { fromSheet?: boolean } = {}) => {
    if (!result.taxon_id) {
      toast(t('session.noTaxonId'));
      return;
    }
    const name = result.cname || result.name;
    const adoptedFields = { used_name_id: adopted?.name_id ?? null, used_scientific_name: adopted?.scientific_name ?? null };
    // Re-identification keeps the row (notes, photos, recordings, position, its interactions) and swaps only the name.
    if (replaceTarget) {
      const target = replaceTarget;
      if (result.taxon_id !== target.taxon_id && takenTaxa.has(result.taxon_id)) {
        toast(t('session.alreadyExists', { name }));
        return;
      }
      setReplaceTarget(null);
      Keyboard.dismiss();
      if (write(() => updateOccurrence(target.id, { taxon_id: result.taxon_id, ...adoptedFields }))) toast(t('session.taxonChanged', { name }));
      return;
    }
    if (edit.refuse()) return;
    // A second row for the same taxon is asked about, as on 快速名錄: two rows can be two morphospecies.
    const same = counted.filter((r) => r.taxon_id === result.taxon_id);
    if (same.length) {
      const countable = mods.counts
        ? same.filter((r) => isIndividuals(r.organism_quantity_type) && !byId.get(r.id)?.sealed).sort((a, b) => b.observed_at - a.observed_at)[0]
        : undefined;
      const choice = await showActionSheet({
        titleParts: sentenceParts(t('session.alreadyExists', { name: slot('name') }), {
          name: speciesParts(result.cname, result.name, result.rank, result.kingdom),
        }),
        message: t('session.duplicateHint'),
        cancelLabel: t('common.cancel'),
        options: [...(countable ? [{ label: t('count.plusOne') }] : []), { label: t('session.addAnyway') }],
      });
      if (choice < 0) return;
      if (countable && choice === 0) {
        const n = Number(countable.organism_quantity);
        handleRowCount(countable, Number.isFinite(n) && n > 0 ? n + 1 : 1);
        setFlashId(countable.id);
        toast(t('count.plusOneDone', { name }));
        return;
      }
    }
    let occ: number;
    try {
      occ = addOccurrence(id, { taxon_id: result.taxon_id, ...(adopted ? adoptedFields : {}) });
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    stampNewRecord('modular', occ, id, reloadQuiet);
    setFlashId(occ);
    reload();
    // A field the template requires and the add left empty: its sheet opens to fill it in.
    // Not in the same tick: iOS presents no Modal while the keyboard (or a
    // composing IME) is still up, nor over the lookup sheet that is closing
    // (code review M22). The search box does not refocus for it (afterSelect).
    if (blankOccurrenceHasErrors(template)) {
      Keyboard.dismiss();
      const wait = opts.fromSheet ? 450 : Platform.OS === 'ios' ? 150 : 0;
      setTimeout(() => setActiveId(occ), wait);
      return;
    }
    undoToast(t('session.added', { name }));
  };

  const handleTakePhotoToImport = async () => {
    try {
      const taken = await takePhotoWithExif();
      rememberPickedPhotos(taken);
      if (taken.length > 0) setPickedPhotos(taken);
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  const handleBulkFavorite = () => {
    const taxa = [...new Set(filtered.filter((r) => selection.picked.has(r.id)).map((r) => r.taxon_id).filter(Boolean))];
    const added = taxa.filter((tid) => useFavorites.getState().addById(tid)).length;
    selection.exit();
    if (added > 0) toastFavoriteAdded(t('favorites.addedCount', { count: added }));
    else toast(t('favorites.addFail'));
  };

  const handleBulkDelete = () => {
    if (edit.refuse()) return;
    const rows = filtered.filter((r) => selection.picked.has(r.id));
    const open = rows.filter((r) => !byId.get(r.id)?.sealed);
    if (rows.length === 0) return;
    if (open.length === 0) {
      toast(t('surveyForm.err.blindSealed'));
      return;
    }
    Alert.alert(t('species.deleteSelectedTitle'), t('species.deleteSelectedMsg', { count: open.length }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          withTransaction(() => {
            for (const r of open) deleteOccurrence(r.id);
          });
          selection.exit();
          reload();
          if (open.length < rows.length) toast(t('surveyForm.err.blindSealed'));
        },
      },
    ]);
  };

  const removeOne = (rec: RecordWithTaxon) => {
    if (write(() => deleteOccurrence(rec.id))) undoToast(t('session.removed', { name: rec.common_name_c || rec.simple_name }));
  };

  // ── the detail sheet's fields ──────────────────────────────────────────────

  const owner: ComponentOwner | null = active ? { kind: 'occurrence', id: active.id } : null;

  const handleAddPhoto = async (mode: 'camera' | 'library') => {
    if (!active || !owner || !mods.photos) return;
    const key = mods.photos.key;
    try {
      const { buildContext } = await import('~/lib/photoCapture');
      const picked = await takeSpeciesPhotos(buildContext(active), mode);
      if (picked.length === 0) return;
      if (!write(() => withTransaction(() => picked.forEach((p) => addMedia(owner, key, p.uri))))) return;
      // A photo of the plant carries the position the recorder never saved — only where none is (as on 快速名錄).
      if (mods.location && active.lat === null) {
        const out = await firstPhotoFix(picked);
        if (out.kind === 'found') {
          write(() =>
            updateOccurrence(active.id, {
              lat: out.fix.lat,
              lng: out.fix.lng,
              accuracy: out.fix.accuracyM,
              ...(out.fix.altitudeM != null ? { elevation_m: out.fix.altitudeM, elevation_source: 'gnss' } : {}),
            }),
          );
        }
      }
      toast(mode === 'camera' ? t('session.photoSavedLinked') : picked.length === 1 ? t('session.photoAdded') : t('session.photosAdded', { count: picked.length }));
    } catch (e) {
      Alert.alert(t('session.photoFailTitle'), errText(e));
    }
  };

  const occurrenceExtra =
    active && activeOcc ? (
      <View className="mt-3 gap-3">
        <ComponentCards
          owner={{ kind: 'occurrence', id: active.id }}
          instances={mods.extras}
          values={extraValues}
          readOnly={edit.locked || activeOcc.sealed}
          refuse={() => toast(t(activeOcc.sealed ? 'surveyForm.err.blindSealed' : 'recordLock.lockedToast'))}
          onChanged={reload}
          codelists={template.codelists}
          context={{
            kingdom: active.kingdom || null,
            className: active.class || null,
            layerCount: layerCountOf(template, data.surveyValues),
            noAutoFocus: true,
            // The sheet is an RN Modal: closed while a field's own screen is open, then opened again.
            aroundNavigate: async (go) => {
              const keep = active.id;
              setActiveId(null);
              try {
                return await go();
              } finally {
                setActiveId(keep);
              }
            },
          }}
          onAudioRemoved={edit.deferAudioDelete}
        />
        {mods.interaction ? (
          <InteractionCard
            surveyId={id}
            occurrenceId={active.id}
            instance={mods.interaction}
            template={template}
            locked={edit.locked}
            unlocked={edit.unlocked}
            refuse={() => toast(t('recordLock.lockedToast'))}
            beforeOpen={() => setActiveId(null)}
          />
        ) : null}
        <NumAccessory />
      </View>
    ) : null;

  const quantityField =
    active && activeOcc && mods.abundance && !mods.countOnly ? (
      <View className="mt-3">
        <ComponentCards
          owner={{ kind: 'occurrence', id: active.id }}
          instances={[mods.abundance]}
          values={extraValues}
          readOnly={edit.locked || activeOcc.sealed}
          refuse={() => toast(t(activeOcc.sealed ? 'surveyForm.err.blindSealed' : 'recordLock.lockedToast'))}
          onChanged={reload}
          // Opening a species is for looking first: the keyboard waits for a tap, as the sheet's own fields do.
          context={{ noAutoFocus: true }}
        />
      </View>
    ) : undefined;

  // ── place (as on 快速名錄) ──────────────────────────────────────────────────

  const ensureForegroundPermission = async (): Promise<boolean> => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
      return false;
    }
    return true;
  };

  const handleDropPoint = async () => {
    if (!(await ensureForegroundPermission())) return;
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      updateSurvey(id, {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
        // A track already in progress owns the mode; don't downgrade it.
        ...(survey.gps_mode === 'full_track' ? null : { gpsMode: 'single_point' as const }),
      });
      reload();
      toast(t('gnss.posRecorded'));
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  const handleStartTrack = async () => {
    if (recordingTarget && !(recordingTarget.kind === 'modular' && recordingTarget.id === id)) {
      Alert.alert(t('gnss.trackBusyTitle'), t('gnss.trackBusyMsg'));
      return;
    }
    try {
      await startRecording({ kind: 'modular', id });
      toast(t('gnss.trackStarted'));
    } catch (e) {
      Alert.alert(t('gnss.trackStartFail'), errText(e));
    }
  };

  const handleStopTrack = () => {
    if (isRecordingTarget({ kind: 'modular', id })) pauseRecording();
    reload();
    toast(t('gnss.trackSaved'));
  };

  const handleClearGps = () =>
    Alert.alert(t('gnss.clearTitle'), t('gnss.clearMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.clear'),
        style: 'destructive',
        onPress: () => {
          // Tear down the watch first so it can't re-write the row after it is cleared.
          if (tracking) pauseRecording();
          // The altitude range and a GNSS elevation came from the track and go with it; a typed elevation stays.
          updateSurvey(id, {
            siteId: null,
            lat: null,
            lng: null,
            accuracy: null,
            trackGeojson: null,
            gpsMode: null,
            elevationMinM: null,
            elevationMaxM: null,
            ...(survey.elevation_source === 'gnss' ? { elevationM: null, elevationSource: null } : {}),
          });
          reload();
          toast(t('gnss.cleared'));
        },
      },
    ]);

  const handleCreatePointSiteFromGps = async () => {
    if (preview) return refusePreview();
    if (!(await ensureForegroundPermission())) return;
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const { createSite } = await import('~/db');
      const siteId = createSite({
        project_id: survey.project_id,
        name: `${survey.name ?? ''} · ${isoDateTime(Date.now())}`,
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
      updateSurvey(id, { siteId, lat, lng });
      reload();
      toast(t('session.pointSiteCreated'));
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  const { site, project } = data;

  // The 空間資料 modules the template has (each optional since 2026-10-04).
  const spaceMods = {
    site: template.components.some((c) => c.type === 'site'),
    centre: template.components.some((c) => c.type === 'centre'),
    track: template.components.some((c) => c.type === 'track'),
  };
  const handleSpatialMenu = () =>
    showSpatialMenu({
      modules: spaceMods,
      siteName: survey.site_id !== null ? (site?.name ?? '') : null,
      hasPoint: survey.lat !== null && survey.lng !== null,
      trackHasData: trackCount > 0 || (survey.track_geojson ?? '').length > 0,
      tracking,
      trackCount,
      canTrack: isActive,
      onAssignSite: () => (preview ? refusePreview() : setSiteSheetOpen(true)),
      onCreatePointSite: () => void handleCreatePointSiteFromGps(),
      onDropPoint: () => void handleDropPoint(),
      onStartTrack: () => void handleStartTrack(),
      onStopTrack: handleStopTrack,
      onClear: handleClearGps,
    });

  // ── the survey: end, reopen, rename, blind phase, upgrade, delete ──────────

  const finish = async () => {
    // Counted at the last read (2G-e): an occurrence with a value that does not fit, or 必填未填; and the survey's own 必填.
    const errors = data.occurrences.filter((o) => !o.via_interaction && data.errorIds.has(o.id)).length;
    const dataMissing = surveyDataStatus(template, data.surveyValues, survey).missing;
    const open = data.recheckState?.open ?? 0;
    const note = [
      blindOpen ? t('surveyForm.finish.blindOpen') : null,
      open > 0 ? t('surveyForm.finish.recheckOpen', { count: open }) : null,
      errors > 0 ? t('surveyForm.finish.errors', { count: errors }) : null,
      dataMissing > 0 ? t('surveyForm.finish.dataMissing', { count: dataMissing }) : null,
    ]
      .filter(Boolean)
      .join('\n');
    const chosen = await chooseEndTime(survey.stop_ts, { title: t('surveyForm.finish.title'), note: note || undefined });
    if (chosen === undefined) return;
    if (tracking) pauseRecording();
    finishSurvey(id, chosen);
    saveVersionSoon('modular', id, 'done');
    refreshStores();
    reload();
  };

  const reopen = async () => {
    // A builder preview reopens in its scratch file only: no other record to end.
    if (!isPreviewId(id) && !(await confirmReopenOver())) return;
    // A GNSS watch on another record must not keep writing to it once it is ended.
    pauseIfNot({ kind: 'modular', id });
    reopenSurvey(id);
    refreshStores();
    reload();
    toast(t('session.reopened'));
  };

  const rename = async () => {
    if (edit.refuse()) return;
    const name = await promptText({ title: t('surveyForm.rename'), defaultValue: survey.name ?? '', autoCapitalize: 'none' });
    if (!name?.trim()) return;
    updateSurvey(id, { name: name.trim() });
    refreshStores();
    reload();
  };

  const endBlind = () =>
    Alert.alert(t('surveyForm.blind.endTitle'), t('surveyForm.blind.endMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('surveyForm.blind.end'),
        onPress: () => {
          closeBlindPhase(id);
          reload();
          router.push(`/survey/form/${id}/recheck` as Href);
        },
      },
    ]);

  const upgrade = () => {
    const to = data.upgradeTo;
    if (!to) return;
    Alert.alert(t('builder.upgrade.title'), t('surveyForm.upgrade.msg', { n: to.version }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('builder.upgrade.go'),
        onPress: () => {
          try {
            upgradeSurvey(id, to);
          } catch (e) {
            toast(formErrorText(t, e));
          }
          reload();
        },
      },
    ]);
  };

  const remove = () => {
    // Only the last survey of a plot's series can go (code review M17): said before asking.
    try {
      assertDeletableSurveys([id]);
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    Alert.alert(t('surveyForm.deleteTitle'), `${t('surveyForm.deleteMsg', { name: survey.name ?? '', count: data.occurrences.length })}\n\n${t('records.deleteRecoverable')}`, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (tracking) pauseRecording();
          deleteSurvey(id);
          refreshStores();
          router.back();
        },
      },
    ]);
  };

  const menuExtra = [
    { label: t('surveyForm.rename'), onPress: () => void rename() },
    ...(blindOpen && !edit.locked ? [{ label: t('surveyForm.blind.end'), onPress: endBlind }] : []),
    ...(data.recheck && survey.blind_closed_at != null ? [{ label: t('surveyForm.recheck.open'), onPress: () => router.push(`/survey/form/${id}/recheck` as Href) }] : []),
    ...(data.recheck && survey.blind_closed_at != null && !edit.locked
      ? [
          {
            label: t('surveyForm.blind.reopen'),
            onPress: () => {
              try {
                reopenBlindPhase(id);
              } catch (e) {
                Alert.alert(t('surveyForm.blind.reopen'), formErrorText(t, e));
              }
              reload();
            },
          },
        ]
      : []),
  ];

  // ── 調查資料: what the template puts on the survey besides time and investigators ──

  const dataStatus = surveyDataStatus(template, data.surveyValues, survey);

  const showInteractions = filterKey === INTERACTIONS && !!mods.interaction;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: survey.name ?? '',
          headerTitle: () => (
            <HeaderTitleText
              text={survey.name ?? ''}
              subtitle={<RecordStatusLine active={isActive} startedAt={survey.start_ts} endedAt={survey.stop_ts} species={richness} />}
            />
          ),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <RecordMenuButton
                kind="modular"
                id={id}
                extra={menuExtra}
                last={[{ label: t('surveyForm.deleteTitle'), icon: 'trash-outline', destructive: true, onPress: remove }]}
                edit={edit}
                onEdited={reload}
                onSynced={reload}
              />
              <RecordEditButtons edit={edit} ended={!isActive} onChanged={reload} inMenu />
              {isActive ? (
                <EndRecordButton onPress={() => void finish()} />
              ) : edit.locked ? (
                <HeaderIconButton icon="refresh-outline" onPress={() => void reopen()} label={t('session.continueEdit')} />
              ) : null}
            </View>
          ),
        }}
      />
      <View className="flex-1">
        <ContextStrip>
          <ContextChip
            icon="folder-outline"
            label={project && project.id !== 0 ? project.name : t('session.projectUnset')}
            set={!!project && project.id !== 0}
            onPress={guard(() => (preview ? refusePreview() : setProjectSheetOpen(true)))}
          />
          {spaceMods.site || spaceMods.centre || spaceMods.track ? (
            <ContextChip
              icon={site ? 'pin' : 'location-outline'}
              label={tracking ? t('session.trackBadge', { count: trackCount }) : site ? site.name : survey.lat !== null ? t('session.located') : t('session.spatial')}
              set={tracking || !!site || survey.lat !== null}
              tone={tracking ? 'live' : 'default'}
              onPress={isActive ? () => void handleSpatialMenu() : guard(() => (spaceMods.site && !preview ? setSiteSheetOpen(true) : void handleSpatialMenu()))}
            />
          ) : null}
          <ContextChip
            icon="time-outline"
            label={survey.stop_ts ? `${isoTime(survey.start_ts)}–${isoTime(survey.stop_ts)}` : isoTime(survey.start_ts)}
            set
            onPress={() => setTimesOpen(true)}
          />
          <ContextChip
            icon="people-outline"
            label={survey.investigators || t('session.surveyorUnset')}
            set={!!survey.investigators}
            onPress={guard(() => setSurveyorSheetOpen(true))}
          />
          {/* Every survey has time, place and surveyors: the four groups are always there (2G-f). */}
          <ContextChip
            icon="clipboard-outline"
            label={`${t('surveyForm.surveyData')} ${dataStatus.filled}/${dataStatus.total}`}
            set={dataStatus.filled > 0}
            missing={dataStatus.missing > 0}
            missingLabel={t('surveyForm.group.missing', { count: dataStatus.missing })}
            onPress={() => router.push(`/survey/form/${id}/data${unlockedQuery}` as Href)}
          />
        </ContextStrip>
        {data.upgradeTo && !edit.locked ? (
          <View className="mx-4 mt-3 flex-row items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 dark:border-line-dark dark:bg-card-dark">
            <Text className="flex-1 text-xs text-ink-2 dark:text-gray-300">{t('surveyForm.upgrade.banner', { n: data.upgradeTo.version })}</Text>
            <Button label={t('builder.upgrade.go')} variant="secondary" onPress={upgrade} />
          </View>
        ) : null}
        {data.recheck ? (
          <View className="mx-4 mt-3 flex-row items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 dark:border-line-dark dark:bg-card-dark">
            <Text className="flex-1 text-xs text-ink-2 dark:text-gray-300">
              {blindOpen ? t('surveyForm.blind.banner') : t('surveyForm.recheck.banner', { count: data.recheckState?.open ?? 0 })}
            </Text>
            {blindOpen ? (
              !edit.locked ? <Button label={t('surveyForm.blind.end')} variant="secondary" onPress={endBlind} /> : null
            ) : (
              <Button label={t('surveyForm.recheck.open')} variant="secondary" onPress={() => router.push(`/survey/form/${id}/recheck` as Href)} />
            )}
          </View>
        ) : null}
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
              contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8, alignItems: 'center', gap: 8 }}
            >
              <Chip label={t('records.filterAll')} count={counted.length} selected={filterKey === null} onPress={() => setFilterKey(null)} />
              {HIGH_LEVEL_GROUPS.map((g) => {
                const count = groupCounts.get(g.key) ?? 0;
                if (count === 0) return null;
                return <Chip key={g.key} label={t('group.' + g.key)} count={count} selected={filterKey === g.key} onPress={() => setFilterKey(g.key)} />;
              })}
              {mods.interaction ? (
                <>
                  <View className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
                  <Chip
                    label={componentLabel(t, i18n.language, mods.interaction)}
                    count={data.interactions ?? 0}
                    selected={showInteractions}
                    onPress={() => setFilterKey(INTERACTIONS)}
                  />
                </>
              ) : null}
            </ScrollView>
            {showInteractions ? null : <RecordSortControls />}
          </View>
        )}
        {showInteractions ? (
          <InteractionSummary surveyId={id} template={template} unlocked={edit.unlocked} />
        ) : filtered.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Ionicons name="search-outline" size={56} color={c.ink3} />
            <Text className="mt-3 text-base text-gray-700 dark:text-gray-300">{records.length === 0 ? t('session.emptyHint') : t('session.emptyGroup')}</Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(r) => `${r.id}`}
            renderItem={({ item }) => {
              const o = byId.get(item.id);
              const meta = [
                o?.phase === 'recheck' ? t('surveyForm.phase.recheck') : o?.phase === 'blind' && survey.blind_closed_at != null ? t('surveyForm.phase.blind') : null,
                o?.via_interaction ? t('survey.interaction.viaTag') : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <SwipeRowActions
                  disabled={selection.selectMode || !!o?.sealed}
                  actions={[{ label: t('common.remove'), icon: 'trash', color: 'red', onPress: () => removeOne(item) }]}
                >
                  <SpeciesCard
                    record={item}
                    onPress={() => (selection.selectMode ? selection.toggle(item.id) : setActiveId(item.id))}
                    onLongPress={() => selection.enter(item.id)}
                    selectMode={selection.selectMode}
                    picked={selection.picked.has(item.id)}
                    flash={item.id === flashId}
                    onCountChange={mods.counts && !edit.locked && !o?.sealed ? (next) => handleRowCount(item, next) : undefined}
                    meta={meta || undefined}
                    sealed={o?.sealed}
                    alert={o && data.errorIds.has(o.id) ? t('survey.editor.problem.requiredMissing') : undefined}
                  />
                </SwipeRowActions>
              );
            }}
          />
        )}
      </View>
      {replaceTarget ? (
        <View className="flex-row items-center border-t border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950/40">
          <Ionicons name="swap-horizontal" size={14} color={c.acornDeep} />
          <Text className="ml-2 flex-1 text-xs text-amber-800 dark:text-amber-300" numberOfLines={1}>
            {t('session.changeTaxonBanner', { name: replaceTarget.common_name_c || replaceTarget.simple_name })}
          </Text>
          <Pressable onPress={() => setReplaceTarget(null)} hitSlop={8} className="active:opacity-70">
            <Text className="text-xs font-medium text-amber-800 dark:text-amber-300">{t('common.cancel')}</Text>
          </Pressable>
        </View>
      ) : null}
      {selection.selectMode ? (
        <SelectionDock
          count={selection.picked.size}
          actions={[
            { label: t('favorites.add'), onPress: handleBulkFavorite },
            { label: t('common.delete'), onPress: handleBulkDelete, destructive: true },
          ]}
        />
      ) : null}
      {!selection.selectMode && ((isActive && !edit.locked) || replaceTarget) ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View>
            {survey.blind_closed_at != null ? (
              <Text className="border-t border-line bg-card px-4 py-1.5 text-xs text-ink-2 dark:border-line-dark dark:bg-card-dark dark:text-gray-300">
                {t('surveyForm.addingAfterBlind')}
              </Text>
            ) : null}
            <SearchBox
              onSelect={(r, adopted) => void handleAdd(r, adopted)}
              afterSelect={blankOccurrenceHasErrors(template) ? 'dismiss' : 'refocus'}
              markedTaxa={takenTaxa}
              markLabel={t('session.inList')}
              trailing={
                isActive && mods.photos ? (
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
                // iOS won't present a Modal while the keyboard / IME composition is still up.
                Keyboard.dismiss();
                if (Platform.OS === 'ios') await new Promise((res) => setTimeout(res, 150));
                setSearchPreview(r);
              }}
            />
          </View>
        </KeyboardStickyView>
      ) : null}

      <SpeciesDetailSheet
        key={detailKey}
        record={active}
        pager={detailPager}
        onClose={() => setActiveId(null)}
        onReplaceTaxon={guard(() => {
          if (!activeOcc) return;
          if (activeOcc.sealed) {
            toast(t('surveyForm.err.blindSealed'));
            return;
          }
          setReplaceTarget(activeOcc);
          setActiveId(null);
        })}
        onRemove={() => active && removeOne(active)}
        onSaveVerbatim={(value) => active && write(() => updateOccurrence(active.id, { verbatim_identification: value }))}
        onSaveNotes={mods.comments ? (notes) => active && write(() => updateOccurrence(active.id, { notes: notes || null })) : undefined}
        onSaveQuantity={
          mods.countOnly
            ? (count) =>
                active &&
                write(() =>
                  updateOccurrence(active.id, {
                    organism_quantity: count == null ? null : String(count),
                    organism_quantity_type: count == null ? null : 'individuals',
                  }),
                )
            : undefined
        }
        quantity={quantityField}
        onSaveLocation={
          mods.location
            ? (lat, lng, accuracy) => {
                if (active && write(() => updateOccurrence(active.id, { lat, lng, accuracy })))
                  toast(lat === null ? t('session.coordCleared') : t('session.coordRecorded'));
              }
            : undefined
        }
        onChangeLocation={mods.location ? (lat, lng, accuracy) => active && write(() => updateOccurrence(active.id, { lat, lng, accuracy })) : undefined}
        onSaveElevation={
          mods.location
            ? (metres, source) => active && write(() => updateOccurrence(active.id, { elevation_m: metres, elevation_source: metres != null ? source : null }))
            : undefined
        }
        onAddPhoto={mods.photos ? (mode) => void handleAddPhoto(mode) : undefined}
        onRemovePhoto={
          mods.photos
            ? (uri) => {
                if (owner && mods.photos && write(() => removeMedia(owner, mods.photos!.key, uri))) toast(t('session.photoRemoved'));
              }
            : undefined
        }
        onAddAudio={
          mods.audio
            ? (uri) => {
                if (owner && mods.audio && write(() => addMedia(owner, mods.audio!.key, uri))) toast(t('session.audioAdded'));
              }
            : undefined
        }
        onRemoveAudio={
          mods.audio
            ? (uri) => {
                if (!owner || !mods.audio || !write(() => removeMedia(owner, mods.audio!.key, uri))) return;
                // Deleted once no undo step can bring the clip back, as on 快速名錄.
                edit.deferAudioDelete(uri);
                toast(t('session.audioRemoved'));
              }
            : undefined
        }
        onSaveAttributes={
          mods.phenology
            ? (next: SpeciesAttributesDraft) =>
                active &&
                write(() =>
                  updateOccurrence(active.id, {
                    sex: next.sex,
                    life_stage: next.life_stage,
                    reproductive_condition: next.reproductive_condition.length > 0 ? JSON.stringify(next.reproductive_condition) : null,
                    leaf_phenology: next.leaf_phenology.length > 0 ? JSON.stringify(next.leaf_phenology) : null,
                    degree_of_establishment: next.degree_of_establishment,
                  }),
                )
            : undefined
        }
        attributeFields={mods.phenologyFields}
        extra={occurrenceExtra}
      />

      <ProjectAssignSheet
        visible={projectSheetOpen}
        currentProjectId={survey.project_id}
        onCancel={() => setProjectSheetOpen(false)}
        onAssign={(projectId) => {
          updateSurvey(id, { projectId });
          setProjectSheetOpen(false);
          reload();
          toast(t('session.projectUpdated'));
        }}
      />
      <SurveyorAssignSheet
        visible={surveyorSheetOpen}
        current={survey.investigators ?? ''}
        onCancel={() => setSurveyorSheetOpen(false)}
        onAssign={(v) => {
          updateSurvey(id, { investigators: v || null });
          reload();
          setSurveyorSheetOpen(false);
        }}
      />
      <SurveyTimesModal
        visible={timesOpen}
        onClose={() => setTimesOpen(false)}
        start={survey.start_ts}
        end={survey.stop_ts}
        startRequired
        readOnly={edit.locked}
        onChange={guard((which: 'start' | 'end', ts: number | null) => {
          const key = smods.timestamp?.key;
          if (which === 'start') {
            if (ts != null) write(() => (key ? writeComponent({ kind: 'survey', id }, key, { start_ts: ts }) : updateSurvey(id, { startTs: ts })));
          } else if (key) write(() => writeComponent({ kind: 'survey', id }, key, { stop_ts: ts }));
        })}
      />
      <SiteAssignSheet
        visible={siteSheetOpen}
        currentSiteId={survey.site_id}
        preferredProjectId={survey.project_id}
        onCancel={() => setSiteSheetOpen(false)}
        onAssign={(siteId) => {
          updateSurvey(id, { siteId });
          setSiteSheetOpen(false);
          reload();
          toast(siteId === null ? t('session.siteUnassigned') : t('session.siteAssigned'));
        }}
        onCreateNew={(drawType) => {
          setSiteSheetOpen(false);
          router.push(`/(tabs)/map?draw=${drawType}&survey=${id}`);
        }}
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
            const photosKey = mods.photos?.key;
            const ok = write(() =>
              withTransaction(() => {
                for (const r of rows) {
                  const occ = addOccurrence(id, {
                    taxon_id: r.taxon_id,
                    observed_at: r.observed_at,
                    ...(mods.location
                      ? { lat: r.lat, lng: r.lng, accuracy: r.accuracy, ...(r.elevation_m != null ? { elevation_m: r.elevation_m, elevation_source: 'gnss' } : {}) }
                      : {}),
                  });
                  if (photosKey) for (const uri of JSON.parse(r.photo_paths) as string[]) addMedia({ kind: 'occurrence', id: occ }, photosKey, uri);
                }
              }),
            );
            if (ok) toast(t('session.imported', { count: rows.length }));
          }}
        />
      ) : null}
      <LookupResultSheet
        result={searchPreview}
        onClose={() => setSearchPreview(null)}
        onAddToSession={() => {
          if (searchPreview) void handleAdd(searchPreview, null, { fromSheet: true });
        }}
      />
    </SafeAreaView>
  );
}
