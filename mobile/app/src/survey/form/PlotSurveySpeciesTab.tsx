/**
 * The 物種 tab of a plot-style survey (2G-d), the fixed plot's species tab
 * (src/components/PlotSpeciesTab.tsx) drawn from the survey's template:
 *
 *   - the unit button picks where species go and which are listed (the fixed
 *     plot's subplot sheet; here any unit, by its path, or outside every unit);
 *   - layer chips (when the template puts Structure on its occurrences) pick
 *     the layer the next species goes into; the list shows every layer,
 *     grouped; a template with interactions adds a 交互作用 chip at the end,
 *     which puts the survey's interactions where the list was;
 *   - rows are the fixed plot's, ± on counted individuals; long-press selects;
 *   - the docked search adds a species through the fixed plot's value sheet,
 *     which shows the template's components: abundance (its scales only),
 *     notes, coordinate, photos, recordings and phenology in their places,
 *     the rest after them (once the species is saved), interactions last.
 *
 * Frequency and quadrats have their own tabs (2G-d3, 2G-d4); until then a
 * frequency is entered among the species' other components.
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Keyboard, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { NumAccessory } from '~/components/form/NumField';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { LayerChip, PlotSpeciesRow } from '~/components/plot/PlotSpeciesRow';
import { PlotDiversityCard } from '~/components/PlotDiversityCard';
import { SubplotLayerInputsView } from '~/components/PlotSpeciesTab';
import { runOverModal } from '~/components/GbifLookupHost';
import { PlotSpeciesValueModal, type PlotValueDraft } from '~/components/PlotSpeciesValueModal';
import { RecordSortControls } from '~/components/RecordSortControls';
import { SearchBox } from '~/components/SearchBox';
import { SelectionDock, SelectionToolbar } from '~/components/SelectionToolbar';
import { SwipeBlockedArea } from '~/components/SwipeNavigator';
import { SwipeRowActions } from '~/components/SwipeRowActions';
import { getActiveLayers, layerIndexOf, layerLabel, mediaUriReferenced, type AdoptionInput, type FixedLayer, type Layer, type RecordWithTaxon, type SearchResult } from '~/db';
import { withTransaction } from '~/db/init';
import { deleteAudioFile } from '~/lib/audioCapture';
import { kindForType, legacyMethodToType } from '~/lib/dwcAbundance';
import { parseMultiAttribute, serializeMultiAttribute } from '~/lib/dwcAttributes';
import { errText } from '~/lib/errText';
import { toastFavoriteAdded } from '~/lib/favoritesToast';
import { firstPhotoFix, rememberPickedPhotos } from '~/lib/photoMeta';
import { stampNewRecord } from '~/lib/recordFix';
import { sortRecords } from '~/lib/recordList';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useListSelection } from '~/lib/useListSelection';
import { useFavorites } from '~/stores/favorites';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { componentLabel } from '~/survey/components/editors/ComponentEditor';
import { InteractionCard } from '~/survey/components/InteractionCard';
import { InteractionSummary } from '~/survey/components/InteractionSummary';
import { addMedia, addOccurrence, deleteOccurrence, readComponent, removeMedia, updateOccurrence, writeComponent } from '~/survey/db/surveys';
import { ABUNDANCE_TYPE, type FieldValue } from '~/survey/registry';
import { layerCountOf } from './checks';
import { ComponentCards } from './ComponentCards';
import { labelForEdit, labelForNew } from './labelPick';
import { isIndividuals, occurrenceModules } from './moduleMap';
import { formComponents } from './occurrenceForm';
import { occurrenceRecord } from './occurrenceRecord';
import { layerRows } from './plotStyle';
import { formErrorText } from './text';
import type { OccurrenceView, SurveyForm } from './useSurveyForm';
import { UnitScopeButton, scopeLabel } from './UnitScopeButton';
import type { UnitPick } from './viewState';

type SheetState =
  | { mode: 'create'; taxon: SearchResult; layer: Layer; adopted?: AdoptionInput | null; label: string | null }
  | { mode: 'edit'; id: number };

type Pending = { photos: string[]; audio: string[]; loc: { lat: number; lng: number; accuracy: number | null; fromPhotoUri: string | null } | null; elevation: { metres: number; source: 'gnss' | 'manual' } | null };
const EMPTY: Pending = { photos: [], audio: [], loc: null, elevation: null };

export function PlotSurveySpeciesTab({
  data,
  edit,
  scope,
  onScope,
  onChanged,
  onChangedQuiet,
}: {
  data: SurveyForm;
  edit: RecordEditing;
  /** Where species go and which are listed: a unit, or outside every unit. */
  scope: UnitPick;
  onScope: (next: UnitPick) => void;
  onChanged: () => void;
  /** A write the app made by itself (a late GNSS fix): not an undo step. */
  onChangedQuiet: () => void;
}) {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const toast = useToast((s) => s.show);
  // The docked search sits in PlotSurveyScreen's root <SafeAreaView edges={['bottom']}>, as the fixed plot's.
  const insets = useSafeAreaInsets();
  const { survey, template } = data;
  const id = survey.id;
  // The layer is this screen's own (its chips and 變更分層) and frequency has its own tab, so neither is repeated among the rest.
  const mods = useMemo(() => {
    const m = occurrenceModules(template);
    return { ...m, extras: m.extras.filter((x) => x.type !== 'structure' && x.type !== 'frequency') };
  }, [template]);
  const stratified = useMemo(() => formComponents(template, 'occurrence').some((x) => x.type === 'structure'), [template]);
  const layerCount = layerCountOf(template, data.surveyValues) ?? 4;
  const activeLayers = useMemo<FixedLayer[]>(() => (stratified ? getActiveLayers(layerCount) : []), [stratified, layerCount]);
  const defaultLayer: Layer = !stratified ? 'T' : ((activeLayers.includes('E2') ? 'E2' : activeLayers[0]) ?? 'E1');
  const [layer, setLayer] = useState<Layer>(defaultLayer);
  // Fewer layers set on the 環境 tab: snap back to one a chip can pick.
  useEffect(() => {
    if (stratified && activeLayers.length && !activeLayers.includes(layer as FixedLayer)) setLayer(activeLayers[0]);
  }, [stratified, activeLayers, layer]);
  const [showInter, setShowInter] = useState(false);
  // The value sheet stepping aside for a root-hosted question (runOverModal): its record stays.
  const [sheetAside, setSheetAside] = useState(false);
  const [modal, setModal] = useState<SheetState | null>(null);
  const [pending, setPending] = useState<Pending>(EMPTY);
  const [replaceTarget, setReplaceTarget] = useState<OccurrenceView | null>(null);
  /** The last value per layer, carried to the next species there (the fixed plot's batch entry). */
  const [lastValue, setLastValue] = useState<Partial<Record<Layer, PlotValueDraft>>>({});
  const selection = useListSelection<number>();
  const sortOrder = useSettings((s) => s.last_record_sort);
  const sortDir = useSettings((s) => s.last_record_sort_dir);

  const units = data.units;
  const level1 = template.units?.[0]?.key ?? null;
  const scopeId = typeof scope === 'number' ? scope : null;
  const scopeText = scopeLabel(t, data, scope);
  /** Each occurrence's first-level unit (the fixed plot's subplot), for the diversity card's per-subplot estimate. */
  const topOf = useMemo(() => {
    const parent = new Map(units.map((u) => [u.unit.id, u.unit.parent_id]));
    const levelOf = new Map(units.map((u) => [u.unit.id, u.unit.level_key]));
    return (unitId: number | null): number | null => {
      let cur = unitId;
      while (cur != null && levelOf.get(cur) !== level1) cur = parent.get(cur) ?? null;
      return cur;
    };
  }, [units, level1]);
  const counted = useMemo(() => data.occurrences.filter((o) => !o.via_interaction), [data]);
  const scoped = useMemo(() => data.occurrences.filter((o) => (o.unit_id ?? null) === scopeId), [data, scopeId]);
  const byId = useMemo(() => new Map(data.occurrences.map((o) => [o.id, o])), [data]);

  /** The rows exactly as the list shows them, layer headers included, so the sheet steps in screen order. */
  const listData = useMemo(() => {
    const recs = sortRecords(scoped.map(occurrenceRecord), sortOrder, sortDir);
    // Those made only as an interaction's other side come last (2F).
    const ordered = [...recs.filter((r) => !byId.get(r.id)?.via_interaction), ...recs.filter((r) => byId.get(r.id)?.via_interaction)];
    if (!stratified) return ordered.map((r) => ({ kind: 'row' as const, record: r }));
    const groups: Layer[] = [...activeLayers, 'T'];
    return groups.flatMap((l) => {
      const list = ordered.filter((r) => (byId.get(r.id)?.layer ?? 'T') === l || (l === 'T' && !activeLayers.includes(byId.get(r.id)?.layer as FixedLayer) && byId.get(r.id)?.layer !== 'T'));
      return list.length ? [{ kind: 'header' as const, layer: l, count: list.length }, ...list.map((r) => ({ kind: 'row' as const, record: r }))] : [];
    });
  }, [scoped, sortOrder, sortDir, stratified, activeLayers, byId]);
  const visible = useMemo(() => listData.flatMap((i) => (i.kind === 'row' ? [i.record] : [])), [listData]);

  const editOcc = modal?.mode === 'edit' ? (byId.get(modal.id) ?? null) : null;
  const editRec = editOcc ? occurrenceRecord(editOcc) : null;
  const pager = useMemo(() => {
    if (modal?.mode !== 'edit') return undefined;
    const index = visible.findIndex((r) => r.id === modal.id);
    if (index < 0) return undefined;
    return { index, total: visible.length, onStep: (dir: -1 | 1) => visible[index + dir] && setModal({ mode: 'edit', id: visible[index + dir].id }) };
  }, [modal, visible]);

  /** One write on a saved row: refused while locked; a refusal from the store is told. */
  const write = useCallback(
    (run: () => void): boolean => {
      if (edit.refuse()) return false;
      try {
        run();
      } catch (e) {
        toast(formErrorText(t, e));
        return false;
      }
      onChanged();
      return true;
    },
    [edit, toast, t, onChanged],
  );

  // ── adding ─────────────────────────────────────────────────────────────────

  const handleSelect = async (taxon: SearchResult, adopted?: AdoptionInput | null) => {
    if (!taxon.taxon_id) return;
    const name = taxon.cname || taxon.name;
    // Re-identification keeps the row and swaps only the name.
    if (replaceTarget) {
      const target = replaceTarget;
      setReplaceTarget(null);
      Keyboard.dismiss();
      if (write(() => updateOccurrence(target.id, { taxon_id: taxon.taxon_id, used_name_id: adopted?.name_id ?? null, used_scientific_name: adopted?.scientific_name ?? null })))
        toast(t('plotSpecies.taxonChanged', { name }));
      return;
    }
    if (edit.refuse()) return;
    // On a permanent plot a label comes from the plot's list (labelPick.ts).
    const label = await labelForNew(survey, { taxon_id: taxon.taxon_id, rank: taxon.rank, kingdom: taxon.kingdom, cname: taxon.cname, sci: taxon.name });
    if (label === undefined) return;
    // iOS will not present a Modal while the keyboard / IME composition is still up.
    Keyboard.dismiss();
    if (Platform.OS === 'ios') await new Promise((r) => setTimeout(r, 150));
    setPending(EMPTY);
    setModal({ mode: 'create', taxon, layer, adopted, label });
  };

  const fieldsOf = (v: PlotValueDraft) => ({
      organism_quantity: mods.abundance ? v.organism_quantity : undefined,
      organism_quantity_type: mods.abundance ? v.organism_quantity_type : undefined,
      notes: mods.comments ? v.notes : undefined,
      ...(mods.phenology
        ? {
            sex: v.sex,
            life_stage: v.life_stage,
            reproductive_condition: serializeMultiAttribute(v.reproductive_condition),
            leaf_phenology: serializeMultiAttribute(v.leaf_phenology),
            degree_of_establishment: v.degree_of_establishment,
          }
        : {}),
      ...(survey.frame_id == null ? { verbatim_identification: v.verbatim_identification } : {}),
  });
  /** The sheet's on-screen value written before it is taken away (saveFirst; code review M21). */
  const commitDraft = (v: PlotValueDraft) => {
    if (modal?.mode === 'edit' && !readOnly) write(() => updateOccurrence(modal.id, fieldsOf(v)));
  };
  const handleSave = (v: PlotValueDraft) => {
    if (!modal) return;
    const fields = fieldsOf(v);
    if (modal.mode === 'edit') {
      if (write(() => updateOccurrence(modal.id, fields))) setModal(null);
      return;
    }
    const m = modal;
    let occ = 0;
    const ok = write(() =>
      withTransaction(() => {
        occ = addOccurrence(id, {
          ...fields,
          taxon_id: m.taxon.taxon_id,
          unit_id: scopeId,
          layer: stratified ? m.layer : null,
          verbatim_identification: survey.frame_id == null ? v.verbatim_identification : m.label,
          ...(m.adopted ? { used_name_id: m.adopted.name_id ?? null, used_scientific_name: m.adopted.scientific_name } : {}),
          ...(pending.loc ? { lat: pending.loc.lat, lng: pending.loc.lng, accuracy: pending.loc.accuracy } : {}),
          ...(pending.elevation ? { elevation_m: pending.elevation.metres, elevation_source: pending.elevation.source } : {}),
        });
        const o = { kind: 'occurrence' as const, id: occ };
        if (mods.photos) for (const uri of pending.photos) addMedia(o, mods.photos.key, uri);
        if (mods.audio) for (const uri of pending.audio) addMedia(o, mods.audio.key, uri);
      }),
    );
    if (!ok) return;
    // Its own fix, unless a photo above already gave it one.
    stampNewRecord('modular', occ, id, onChangedQuiet);
    const kind = kindForType(v.organism_quantity_type);
    setLastValue((prev) => ({
      ...prev,
      [m.layer]: {
        organism_quantity: kind === 'DBH' ? null : v.organism_quantity,
        organism_quantity_type: v.organism_quantity_type,
        notes: null,
        sex: null,
        life_stage: null,
        reproductive_condition: [],
        leaf_phenology: [],
        degree_of_establishment: null,
        detection_type: null,
        verbatim_identification: null,
      },
    }));
    setPending(EMPTY);
    setModal(null);
  };

  const cancelModal = () => {
    // Clips were written to disk the moment recording stopped: an abandoned draft takes its files with it.
    for (const uri of pending.audio) if (!mediaUriReferenced(uri, 'audio_paths')) void deleteAudioFile(uri);
    setPending(EMPTY);
    setModal(null);
  };

  // ── the sheet's media and position (written at once on a saved row, buffered on a new one) ──

  const occOwner = editOcc ? { kind: 'occurrence' as const, id: editOcc.id } : null;
  const handleAddPhoto = async (mode: 'camera' | 'library') => {
    if (!modal || !mods.photos) return;
    try {
      const { captureAndSavePhoto, pickPhotosWithExif, buildContext } = await import('~/lib/photoCapture');
      const ctx = editRec
        ? buildContext(editRec)
        : {
            taxon_id: modal.mode === 'create' ? modal.taxon.taxon_id : '',
            simple_name: modal.mode === 'create' ? modal.taxon.name : '',
            name_author: modal.mode === 'create' ? modal.taxon.fullname.replace(modal.taxon.name, '').trim() : '',
            common_name_c: modal.mode === 'create' ? (modal.taxon.cname ?? '') : '',
            family: modal.mode === 'create' ? (modal.taxon.family ?? '') : '',
            family_c: modal.mode === 'create' ? (modal.taxon.family_cname ?? '') : '',
            kingdom: modal.mode === 'create' ? (modal.taxon.kingdom ?? '') : '',
            observed_at: Date.now(),
          };
      let picked: { uri: string; exif: Record<string, unknown> | null }[] = [];
      if (mode === 'camera') {
        const uri = await captureAndSavePhoto(ctx);
        if (uri) picked = [{ uri, exif: null }];
      } else picked = await pickPhotosWithExif();
      if (picked.length === 0) return;
      rememberPickedPhotos(picked);
      // A photo carries the position the recorder never saved — only where none is.
      const fix = mods.location ? await firstPhotoFix(picked) : null;
      if (occOwner && editOcc) {
        write(() =>
          withTransaction(() => {
            for (const p of picked) addMedia(occOwner, mods.photos!.key, p.uri);
            if (fix?.kind === 'found' && editOcc.lat == null)
              updateOccurrence(editOcc.id, {
                lat: fix.fix.lat,
                lng: fix.fix.lng,
                accuracy: fix.fix.accuracyM,
                ...(fix.fix.altitudeM != null ? { elevation_m: fix.fix.altitudeM, elevation_source: 'gnss' } : {}),
              });
          }),
        );
      } else {
        setPending((p) => ({
          ...p,
          photos: [...p.photos, ...picked.map((x) => x.uri)],
          loc: p.loc ?? (fix?.kind === 'found' ? { lat: fix.fix.lat, lng: fix.fix.lng, accuracy: fix.fix.accuracyM, fromPhotoUri: fix.fix.uri } : null),
          elevation: p.elevation ?? (fix?.kind === 'found' && fix.fix.altitudeM != null ? { metres: fix.fix.altitudeM, source: 'gnss' } : null),
        }));
      }
    } catch (e) {
      Alert.alert(t('plotSpecies.addPhotoFail'), errText(e));
    }
  };

  const handleChangeLayer = async (o: OccurrenceView) => {
    const idx = await showActionSheet({
      title: t('plotSpecies.changeLayer'),
      cancelLabel: t('common.cancel'),
      options: activeLayers.map((l) => ({ label: layerLabel(l), selected: l === o.layer })),
    });
    if (idx < 0 || idx >= activeLayers.length || activeLayers[idx] === o.layer) return;
    const next = activeLayers[idx];
    if (write(() => updateOccurrence(o.id, { layer: next }))) toast(t('plotSpecies.movedTo', { layer: layerLabel(next) }));
  };

  const handleDelete = (o: OccurrenceView) =>
    Alert.alert(t('plotSpecies.deleteRecord'), t('plotSpecies.deleteRecordMsg', { name: o.common_name_c || o.simple_name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (write(() => deleteOccurrence(o.id))) setModal(null);
        },
      },
    ]);

  // ── the list ───────────────────────────────────────────────────────────────

  const handleAdjust = (r: RecordWithTaxon, delta: number) => {
    const cur = Number(r.organism_quantity);
    const next = Math.max(1, (Number.isFinite(cur) ? cur : 0) + delta);
    write(() => updateOccurrence(r.id, { organism_quantity: String(next), organism_quantity_type: 'individuals' }));
  };

  const handleBulkFavorite = () => {
    const taxa = [...new Set(visible.filter((r) => selection.picked.has(r.id)).map((r) => r.taxon_id).filter(Boolean))];
    const added = taxa.filter((x) => useFavorites.getState().addById(x)).length;
    selection.exit();
    if (added > 0) toastFavoriteAdded(t('favorites.addedCount', { count: added }));
    else toast(t('favorites.addFail'));
  };
  const handleBulkDelete = () => {
    if (edit.refuse()) return;
    const rows = visible.filter((r) => selection.picked.has(r.id));
    if (!rows.length) return;
    Alert.alert(t('species.deleteSelectedTitle'), t('species.deleteSelectedMsg', { count: rows.length }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (write(() => withTransaction(() => rows.forEach((r) => deleteOccurrence(r.id))))) selection.exit();
        },
      },
    ]);
  };

  // The scope's own layer cover / height (a unit-level Structure), as the fixed plot's per-subplot rows.
  const scopeUnit = scopeId != null ? units.find((u) => u.unit.id === scopeId)?.unit : undefined;
  const unitStructure = scopeUnit ? formComponents(template, { unit: scopeUnit.level_key }).find((x) => x.type === 'structure') : undefined;
  const surveyStructure = formComponents(template, 'survey').find((x) => x.type === 'structure');
  const unitLayerRows = useMemo(
    () => (scopeUnit && unitStructure ? layerRows(readComponent({ kind: 'unit', id: scopeUnit.id }, unitStructure.key), layerCount) : []),
    // `data` is read again after every edit, so it stands for the unit's values too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeUnit, unitStructure, layerCount, data],
  );
  const surveyLayers = surveyStructure ? layerRows(data.surveyValues[surveyStructure.key] ?? {}, layerCount) : [];

  // ── the value sheet ────────────────────────────────────────────────────────

  const initial = useMemo((): PlotValueDraft | null => {
    if (modal?.mode === 'create') return { ...(lastValue[modal.layer] ?? EMPTY_DRAFT), verbatim_identification: modal.label };
    if (!editOcc) return null;
    return {
      organism_quantity: editOcc.organism_quantity,
      organism_quantity_type: editOcc.organism_quantity_type,
      notes: editOcc.notes,
      sex: editOcc.sex,
      life_stage: editOcc.life_stage,
      reproductive_condition: parseMultiAttribute(editOcc.reproductive_condition),
      leaf_phenology: parseMultiAttribute(editOcc.leaf_phenology),
      degree_of_establishment: editOcc.degree_of_establishment,
      detection_type: editOcc.detection_type,
      verbatim_identification: editOcc.verbatim_identification,
    };
    // Only what the sheet drafts: a photo or a position saved meanwhile must not reset what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    modal,
    lastValue,
    editOcc?.id,
    editOcc?.organism_quantity,
    editOcc?.organism_quantity_type,
    editOcc?.notes,
    editOcc?.sex,
    editOcc?.life_stage,
    editOcc?.reproductive_condition,
    editOcc?.leaf_phenology,
    editOcc?.degree_of_establishment,
    editOcc?.verbatim_identification,
  ]);
  const extraValues = useMemo(
    () => (editOcc ? Object.fromEntries(mods.extras.map((x) => [x.key, readComponent({ kind: 'occurrence', id: editOcc.id }, x.key)])) : {}),
    [editOcc, mods],
  );
  const modalLayer: Layer = modal?.mode === 'create' ? modal.layer : ((editOcc?.layer as Layer | null) ?? 'T');
  const layerMethod = (l: Layer) => (l === 'T' ? null : legacyMethodToType(surveyLayers.find((x) => x.layer_index === layerIndexOf(l as FixedLayer))?.method ?? null));
  const allowedKinds = mods.abundance && Array.isArray(mods.abundance.params.kinds) ? (mods.abundance.params.kinds as PlotValueKinds) : undefined;
  /**
   * The scale a new value opens on: the layer's cover method when the
   * template's abundance allows it, else the template's default scale — not
   * the sheet's own guess from the kingdom (Braun-Blanquet for a plant), which
   * showed BB on a template that asks for % cover only (2026-10-04).
   */
  const openType = (l: Layer): string | null => {
    const m = layerMethod(l);
    if (m && (!allowedKinds || allowedKinds.includes(kindForType(m)))) return m;
    const d = mods.abundance?.params.default;
    if (d === 'custom') return '';
    return typeof d === 'string' && d in ABUNDANCE_TYPE ? ABUNDANCE_TYPE[d as keyof typeof ABUNDANCE_TYPE] : null;
  };
  const header =
    modal?.mode === 'create'
      ? {
          taxonId: modal.taxon.taxon_id,
          cname: modal.taxon.cname ?? '',
          name: modal.taxon.name,
          author: modal.taxon.fullname.replace(modal.taxon.name, '').trim(),
          kingdom: modal.taxon.kingdom ?? '',
          phylum: modal.taxon.phylum ?? '',
          class_name: modal.taxon.class_name ?? '',
          order: modal.taxon.order ?? '',
          family: modal.taxon.family ?? '',
          family_c: modal.taxon.family_cname ?? '',
          genus: modal.taxon.genus ?? '',
          rank: modal.taxon.rank ?? '',
        }
      : editRec
        ? {
            taxonId: editRec.taxon_id,
            cname: editRec.common_name_c ?? '',
            name: editRec.simple_name,
            author: editRec.name_author ?? '',
            kingdom: editRec.kingdom ?? '',
            phylum: editRec.phylum ?? '',
            class_name: editRec.class ?? '',
            order: editRec.order ?? '',
            family: editRec.family ?? '',
            family_c: editRec.family_c ?? '',
            genus: editRec.genus ?? '',
            rank: editRec.rank ?? '',
          }
        : null;
  const sealed = !!editOcc?.sealed;
  const readOnly = edit.locked || sealed;
  const refuseOcc = () => toast(t(sealed ? 'surveyForm.err.blindSealed' : 'recordLock.lockedToast'));

  const extra = (saveFirst: () => void) =>
    editOcc && editRec ? (
      <View className="mt-3 gap-3">
        {survey.frame_id != null ? (
          <Pressable
            onPress={async () => {
              if (readOnly) return refuseOcc();
              saveFirst();
              // A new label is asked in a root-hosted prompt, which iOS cannot present over this sheet (code review H5).
              const label = await runOverModal(setSheetAside, () =>
                labelForEdit(survey, { taxon_id: editOcc.taxon_id, rank: editOcc.rank, kingdom: editOcc.kingdom, cname: editOcc.common_name_c, sci: editOcc.simple_name }, editOcc.verbatim_identification),
              );
              if (label !== undefined) write(() => updateOccurrence(editOcc.id, { verbatim_identification: label }));
            }}
            accessibilityRole="button"
            className="flex-row items-center rounded-lg border border-gray-200 px-3 py-2.5 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
          >
            <Text className="flex-1 text-sm text-gray-900 dark:text-gray-100">{t('common.labelValue', { label: t('surveyForm.label.field'), value: editOcc.verbatim_identification ?? '—' })}</Text>
            <Ionicons name="chevron-forward" size={16} color={c.ink3} />
          </Pressable>
        ) : null}
        <ComponentCards
          owner={{ kind: 'occurrence', id: editOcc.id }}
          instances={mods.extras}
          values={extraValues}
          readOnly={readOnly}
          refuse={refuseOcc}
          onChanged={onChanged}
          codelists={template.codelists}
          context={{
            kingdom: editOcc.kingdom || null,
            className: editOcc.class || null,
            layerCount,
            noAutoFocus: true,
            // The value sheet is an RN Modal: closed while a field's own screen is open, then opened again.
            aroundNavigate: async (go) => {
              saveFirst();
              const keep = modal;
              setModal(null);
              try {
                return await go();
              } finally {
                setModal(keep);
              }
            },
          }}
          onAudioRemoved={edit.deferAudioDelete}
        />
        {mods.interaction ? (
          <InteractionCard
            surveyId={id}
            occurrenceId={editOcc.id}
            instance={mods.interaction}
            template={template}
            locked={edit.locked}
            unlocked={edit.unlocked}
            refuse={() => toast(t('recordLock.lockedToast'))}
            beforeOpen={() => {
              saveFirst();
              setModal(null);
            }}
          />
        ) : null}
        <NumAccessory />
      </View>
    ) : modal?.mode === 'create' && mods.extras.length ? (
      <Text className="mt-3 text-xs text-gray-500 dark:text-gray-400">{t('surveyForm.extrasAfterSave')}</Text>
    ) : null;

  const guarded =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      if (modal?.mode === 'edit' && readOnly) return refuseOcc();
      fn(...a);
    };

  return (
    <View className="flex-1 bg-gray-50 dark:bg-gray-950">
      <PlotDiversityCard
        allRecords={counted.map((o) => ({ ...occurrenceRecord(o), subplot_id: topOf(o.unit_id) }))}
        subplotRecords={scoped.filter((o) => !o.via_interaction).map((o) => ({ ...occurrenceRecord(o), subplot_id: topOf(o.unit_id) }))}
        subplotMode={units.length > 0}
        subplotIds={units.filter((u) => u.unit.level_key === level1).map((u) => u.unit.id)}
        activeSubplotLabel={units.length > 0 ? scopeText : null}
      />
      {selection.selectMode ? (
        <SelectionToolbar
          count={selection.picked.size}
          allPicked={visible.length > 0 && visible.every((r) => selection.picked.has(r.id))}
          onToggleAll={() => selection.toggleAll(visible.map((r) => r.id))}
          onCancel={selection.exit}
        />
      ) : (
        <View className="flex-row items-center border-b border-gray-100 bg-card dark:border-gray-800 dark:bg-gray-900">
          {units.length > 0 ? <UnitScopeButton data={data} scope={scope} onScope={onScope} /> : null}
          {/* The 環境↔物種 swipe would swallow this strip's drag. */}
          <SwipeBlockedArea style={{ flex: 1 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8, alignItems: 'center', gap: 4 }}>
              {stratified ? <Ionicons name="layers-outline" size={13} color={c.ink3} style={{ marginRight: 2 }} /> : null}
              {activeLayers.map((l) => (
                <LayerChip
                  key={l}
                  label={l}
                  a11yLabel={`${t('plotSpecies.layer')} ${layerLabel(l)}`}
                  active={!showInter && layer === l}
                  onPress={() => {
                    setLayer(l);
                    setShowInter(false);
                  }}
                  onLongPress={() => toast(layerLabel(l))}
                />
              ))}
              {mods.interaction ? (
                <>
                  {stratified ? <View className="mx-1 h-5 w-px bg-gray-300 dark:bg-gray-600" /> : null}
                  <LayerChip
                    label={`${componentLabel(t, i18n.language, mods.interaction)} ${data.interactions ?? 0}`}
                    a11yLabel={componentLabel(t, i18n.language, mods.interaction)}
                    active={showInter}
                    onPress={() => setShowInter((x) => !x)}
                  />
                </>
              ) : null}
            </ScrollView>
          </SwipeBlockedArea>
          {showInter ? null : <RecordSortControls />}
        </View>
      )}
      {showInter ? (
        <InteractionSummary surveyId={id} template={template} unlocked={edit.unlocked} />
      ) : (
        <FlatList
          data={listData}
          keyExtractor={(item, idx) => (item.kind === 'header' ? `h-${item.layer}` : `r-${item.record.id}-${idx}`)}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          ListHeaderComponent={
            scopeUnit && unitStructure && stratified ? (
              <View pointerEvents={edit.locked ? 'none' : 'auto'} className="border-b border-gray-100 bg-card px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
                <SubplotLayerInputsView
                  activeLayers={activeLayers}
                  rows={unitLayerRows}
                  heightUnitOf={(idx) => surveyLayers.find((x) => x.layer_index === idx)?.height_unit ?? 'cm'}
                  onPatch={(idx, fields) =>
                    write(() =>
                      writeComponent({ kind: 'unit', id: scopeUnit.id }, unitStructure.key, Object.fromEntries(Object.entries(fields).map(([f, x]) => [f, { [idx]: x } as FieldValue]))),
                    )
                  }
                />
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            if (item.kind === 'header')
              return (
                <View className="bg-gray-100 px-4 py-1.5 dark:bg-gray-800">
                  <Text className="text-xs font-semibold text-gray-600 dark:text-gray-400">
                    {/* 'T' gathers those recorded without a layer (before Structure was added, or from elsewhere). */}
                    {item.layer === 'T' ? t('surveyForm.noLayer') : layerLabel(item.layer)} ({item.count})
                  </Text>
                </View>
              );
            const o = byId.get(item.record.id);
            return (
              <SwipeRowActions
                disabled={selection.selectMode || !!o?.sealed}
                actions={[{ label: t('common.delete'), icon: 'trash', color: 'red', onPress: () => write(() => deleteOccurrence(item.record.id)) }]}
              >
                <PlotSpeciesRow
                  record={item.record}
                  onPress={() => (selection.selectMode ? selection.toggle(item.record.id) : setModal({ mode: 'edit', id: item.record.id }))}
                  onLongPress={() => selection.enter(item.record.id)}
                  onAdjust={
                    selection.selectMode || edit.locked || o?.sealed || !mods.counts || !isIndividuals(item.record.organism_quantity_type)
                      ? undefined
                      : (d) => handleAdjust(item.record, d)
                  }
                  selectMode={selection.selectMode}
                  picked={selection.picked.has(item.record.id)}
                  alert={data.errorIds.has(item.record.id) ? t('survey.editor.problem.requiredMissing') : undefined}
                />
              </SwipeRowActions>
            );
          }}
          ListEmptyComponent={
            <View className="items-center px-8 py-12">
              <Ionicons name="leaf-outline" size={40} color={c.ink3} />
              <Text className="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
                {stratified ? t('plotSpecies.emptyHintStratified') : t('plotSpecies.emptyHint')}
              </Text>
            </View>
          }
        />
      )}
      {replaceTarget ? (
        <View className="flex-row items-center border-t border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950/40">
          <Ionicons name="swap-horizontal" size={14} color={c.acornDeep} />
          <Text className="ml-2 flex-1 text-xs text-amber-800 dark:text-amber-300" numberOfLines={1}>
            {t('plotSpecies.changeTaxonBanner', { name: replaceTarget.common_name_c || replaceTarget.simple_name })}
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
      {(edit.locked && !replaceTarget) || selection.selectMode ? null : (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View>
            {units.length > 0 || survey.blind_closed_at != null ? (
              <Text className="border-t border-line bg-card px-4 py-1.5 text-xs text-ink-2 dark:border-line-dark dark:bg-card-dark dark:text-gray-300">
                {[units.length > 0 ? t('surveyForm.addingTo', { unit: scopeText }) : null, survey.blind_closed_at != null ? t('surveyForm.addingAfterBlind') : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
            <SearchBox onSelect={(r, adopted) => void handleSelect(r, adopted)} />
          </View>
        </KeyboardStickyView>
      )}
      {modal && header ? (
        <PlotSpeciesValueModal
          visible={!sheetAside}
          layer={modalLayer}
          title={`${header.cname} ${header.name}`.trim()}
          header={header}
          initial={initial}
          kingdom={header.kingdom || null}
          className={header.class_name || null}
          defaultType={initial?.organism_quantity_type ?? openType(modalLayer)}
          showDetection={false}
          showAbundance={!!mods.abundance}
          allowedKinds={allowedKinds}
          showNotes={!!mods.comments}
          showAttributes={!!mods.phenology}
          attributeFields={mods.phenologyFields}
          showVerbatim={survey.frame_id == null}
          lat={editOcc ? editOcc.lat : (pending.loc?.lat ?? null)}
          lng={editOcc ? editOcc.lng : (pending.loc?.lng ?? null)}
          accuracy={editOcc ? editOcc.accuracy : (pending.loc?.accuracy ?? null)}
          onSaveLocation={
            mods.location
              ? guarded((lat: number | null, lng: number | null, accuracy: number | null) => {
                  if (editOcc) write(() => updateOccurrence(editOcc.id, { lat, lng, accuracy }));
                  else setPending((p) => ({ ...p, loc: lat == null || lng == null ? null : { lat, lng, accuracy, fromPhotoUri: null } }));
                })
              : undefined
          }
          onChangeLocation={
            mods.location
              ? guarded((lat: number, lng: number, accuracy: number | null) => {
                  if (editOcc) write(() => updateOccurrence(editOcc.id, { lat, lng, accuracy }));
                  else setPending((p) => ({ ...p, loc: { lat, lng, accuracy, fromPhotoUri: null } }));
                })
              : undefined
          }
          elevation={editOcc ? editOcc.elevation_m : (pending.elevation?.metres ?? null)}
          onSaveElevation={
            mods.location
              ? guarded((metres: number | null, source: 'gnss' | 'manual') => {
                  if (editOcc) write(() => updateOccurrence(editOcc.id, { elevation_m: metres, elevation_source: metres != null ? source : null }));
                  else setPending((p) => ({ ...p, elevation: metres == null ? null : { metres, source } }));
                })
              : undefined
          }
          plotGeo={{ lat: survey.lat, lng: survey.lng, trackGeojson: survey.track_geojson, radiusM: null }}
          photoUris={editOcc ? editOcc.photos : pending.photos}
          onAddPhoto={mods.photos ? guarded((mode: 'camera' | 'library') => void handleAddPhoto(mode)) : undefined}
          onRemovePhoto={
            mods.photos
              ? guarded((uri: string) => {
                  if (occOwner) write(() => removeMedia(occOwner, mods.photos!.key, uri));
                  else setPending((p) => ({ ...p, photos: p.photos.filter((u) => u !== uri), loc: p.loc?.fromPhotoUri === uri ? null : p.loc }));
                })
              : undefined
          }
          audioUris={editOcc ? editOcc.audio : pending.audio}
          onAddAudio={
            mods.audio
              ? guarded((uri: string) => {
                  if (occOwner) write(() => addMedia(occOwner, mods.audio!.key, uri));
                  else setPending((p) => ({ ...p, audio: [...p.audio, uri] }));
                })
              : undefined
          }
          onRemoveAudio={
            mods.audio
              ? guarded((uri: string) => {
                  if (occOwner) {
                    // Deleted once no undo step can bring the clip back.
                    if (write(() => removeMedia(occOwner, mods.audio!.key, uri))) edit.deferAudioDelete(uri);
                  } else {
                    setPending((p) => ({ ...p, audio: p.audio.filter((u) => u !== uri) }));
                    if (!mediaUriReferenced(uri, 'audio_paths')) void deleteAudioFile(uri);
                  }
                })
              : undefined
          }
          occurrenceId={editOcc ? editOcc.uuid : null}
          updatedAt={editOcc ? editOcc.updated_at : null}
          pager={pager}
          recordActions={
            editOcc
              ? {
                  onReplaceTaxon: guarded(() => {
                    setReplaceTarget(editOcc);
                    setModal(null);
                  }),
                  onChangeLayer: stratified ? guarded(() => void handleChangeLayer(editOcc)) : undefined,
                  onDelete: guarded(() => handleDelete(editOcc)),
                }
              : undefined
          }
          extra={extra}
          onCommit={commitDraft}
          onCancel={cancelModal}
          onSave={(v) => (modal.mode === 'edit' && readOnly ? refuseOcc() : handleSave(v))}
        />
      ) : null}
    </View>
  );
}

type PlotValueKinds = NonNullable<Parameters<typeof PlotSpeciesValueModal>[0]['allowedKinds']>;

const EMPTY_DRAFT: PlotValueDraft = {
  organism_quantity: null,
  organism_quantity_type: null,
  notes: null,
  sex: null,
  life_stage: null,
  reproductive_condition: [],
  leaf_phenology: [],
  degree_of_establishment: null,
  detection_type: null,
  verbatim_identification: null,
};
