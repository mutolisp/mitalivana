/**
 * 這是什麼？ — casual mode's screen for one observation (design 18e).
 *
 *   - From 記一筆觀察 (the draft queue, src/lib/observeDraft.ts): name it and
 *     加入 today's checklist, or keep it as 待鑑定 under a kingdom. Nothing is
 *     written before one of those two buttons.
 *   - `?pending=ID`: a pending observation, to name (identifyPending) or edit.
 *     `&next=1` (the 我的觀察 nudge) moves on to the next one after naming.
 *   - `?record=ID&session=ID`: a named observation, to edit, upload to
 *     iNaturalist or delete.
 *
 * The last two save each change as it is made, the way the record sheets do.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AudioClipList } from '~/components/AudioClipList';
import { ObservationNotes } from '~/components/ObservationNotes';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { ScientificName } from '~/components/ScientificName';
import { SearchBox } from '~/components/SearchBox';
import { CountStepper } from '~/components/ui/CountStepper';
import { KINGDOM_ICON } from '~/components/casual/kingdomIcon';
import { IconDisc } from '~/components/ui/IconDisc';
import { BackHeaderLeft } from '~/lib/goBack';
import {
  PENDING_KINGDOMS,
  addRecord,
  createPending,
  dailySessionOn,
  dayKey,
  deletePending,
  deleteRecord,
  getPending,
  identifyPending,
  listPending,
  listSessionRecords,
  parsePhotoPaths,
  recentTaxa,
  searchByTaxonId,
  stampRecordFix,
  updatePending,
  updateRecordAttributes,
  updateRecordAudio,
  updateRecordLocation,
  updateRecordNotes,
  updateRecordPhotos,
  updateRecordQuantity,
  updateRecordTaxon,
  withTransaction,
  type AdoptionInput,
  type PendingKingdom,
  type PendingPatch,
  type RecordWithTaxon,
  type SearchResult,
  type TaxonGroup,
} from '~/db';
import { apiErrorMessage } from '~/lib/apiErrorMessage';
import { safeAppFileUri } from '~/lib/appFiles';
import { openTodaysChecklist } from '~/lib/casualDaily';
import { whenShort } from '~/lib/casualFormat';
import { parseMultiAttribute, serializeMultiAttribute } from '~/lib/dwcAttributes';
import { errText } from '~/lib/errText';
import { hasInatChanges, syncRecord, useInatSync, useInatUpload, type UploadUnit } from '~/lib/inatUpload';
import { nextDraft, useObserveDraft, type ObserveDraft } from '~/lib/observeDraft';
import { pickPhotosWithExif, takePhotoWithExif, type PickedPhoto } from '~/lib/photoCapture';
import { firstPhotoFix, rememberPickedPhotos } from '~/lib/photoMeta';
import { stampNewRecord, takeFixNow, type Fix } from '~/lib/recordFix';
import { useActiveSession } from '~/stores/activeSession';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';

type Pick = {
  taxonId: string;
  cname: string;
  name: string;
  rank: string;
  kingdom: string;
  className: string;
  family: string;
  familyC: string;
  adopted?: AdoptionInput | null;
};

type Form = {
  photos: string[];
  audio: string[];
  observedAt: number;
  fix: Fix | null;
  pick: Pick | null;
  kingdom: PendingKingdom | null;
  quantity: number | null;
  note: string;
  repro: string[];
  inatUploaded: boolean;
};

type Source =
  | { kind: 'draft'; draft: ObserveDraft; n: number; total: number }
  | { kind: 'pending'; id: number; chain: boolean }
  | { kind: 'record'; id: number; session: number };

const pickOf = (sp: SearchResult, adopted?: AdoptionInput | null): Pick => ({
  taxonId: sp.taxon_id,
  cname: sp.cname ?? '',
  name: sp.name,
  rank: sp.rank ?? '',
  kingdom: sp.kingdom ?? '',
  className: sp.class_name ?? '',
  family: sp.family ?? '',
  familyC: sp.family_cname ?? '',
  adopted,
});

const pickOfRecord = (r: RecordWithTaxon): Pick => ({
  taxonId: r.taxon_id,
  cname: r.common_name_c ?? '',
  name: r.simple_name,
  rank: r.rank ?? '',
  kingdom: r.kingdom ?? '',
  className: r.class ?? '',
  family: r.family ?? '',
  familyC: r.family_c ?? '',
});

const isPendingKingdom = (k: string | null | undefined): k is PendingKingdom =>
  PENDING_KINGDOMS.includes(k as PendingKingdom);
const json = (a: string[]) => (a.length ? JSON.stringify(a) : null);
/** A stored count as the stepper shows it; anything but a whole number reads 「—」. */
const toCount = (q: string | null) =>
  q != null && /^\d+$/.test(q) && Number(q) > 0 ? Number(q) : null;
const fixOf = (r: {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  elevation_m: number | null;
}): Fix | null =>
  r.lat != null && r.lng != null
    ? { lat: r.lat, lng: r.lng, accuracy: r.accuracy, elevation_m: r.elevation_m }
    : null;

function getRecord(session: number, id: number): RecordWithTaxon | null {
  return listSessionRecords(session).find((r) => r.id === id) ?? null;
}

function loadForm(source: Source): Form | null {
  if (source.kind === 'draft') {
    const d = source.draft;
    return {
      photos: d.photos,
      audio: d.audio,
      observedAt: d.observedAt,
      fix: d.fix,
      pick: d.pick ? pickOf(d.pick.sp, d.pick.adopted) : null,
      kingdom: null,
      quantity: null,
      note: '',
      repro: [],
      inatUploaded: false,
    };
  }
  if (source.kind === 'pending') {
    const p = getPending(source.id);
    if (!p) return null;
    return {
      photos: parsePhotoPaths(p.photo_paths),
      audio: parsePhotoPaths(p.audio_paths),
      observedAt: p.observed_at,
      fix: fixOf(p),
      pick: null,
      kingdom: p.kingdom,
      quantity: toCount(p.quantity),
      note: p.note ?? '',
      repro: parseMultiAttribute(p.reproductive_condition),
      inatUploaded: p.inat_uploaded_at != null,
    };
  }
  const r = getRecord(source.session, source.id);
  if (!r) return null;
  return {
    photos: parsePhotoPaths(r.photo_paths),
    audio: parsePhotoPaths(r.audio_paths),
    observedAt: r.observed_at,
    fix: fixOf(r),
    pick: pickOfRecord(r),
    kingdom: null,
    quantity: toCount(r.organism_quantity),
    note: r.notes ?? '',
    repro: parseMultiAttribute(r.reproductive_condition),
    inatUploaded: r.inat_uploaded_at != null,
  };
}

function pendingPatch(patch: Partial<Form>): PendingPatch {
  const out: PendingPatch = {};
  if (patch.photos) out.photo_paths = json(patch.photos);
  if (patch.audio) out.audio_paths = json(patch.audio);
  if ('note' in patch) out.note = patch.note?.trim() ? patch.note : null;
  if ('quantity' in patch) out.quantity = patch.quantity != null ? String(patch.quantity) : null;
  if (patch.repro) out.reproductive_condition = serializeMultiAttribute(patch.repro);
  if (patch.kingdom) out.kingdom = patch.kingdom;
  return out;
}

function writeRecord(id: number, patch: Partial<Form>): void {
  if (patch.photos) updateRecordPhotos(id, patch.photos);
  if (patch.audio) updateRecordAudio(id, patch.audio);
  if ('note' in patch) updateRecordNotes(id, patch.note?.trim() ? patch.note : null);
  if ('quantity' in patch) {
    const q = patch.quantity ?? null;
    updateRecordQuantity(id, q != null ? String(q) : null, q != null ? 'individuals' : null);
  }
  if (patch.repro)
    updateRecordAttributes(id, { reproductive_condition: serializeMultiAttribute(patch.repro) });
  if (patch.pick) updateRecordTaxon(id, patch.pick.taxonId, patch.pick.adopted ?? null);
}

export default function ObserveScreen() {
  const params = useLocalSearchParams<{
    pending?: string;
    record?: string;
    session?: string;
    next?: string;
  }>();
  const draft = useObserveDraft((s) => s.queue[s.index] ?? null);
  const n = useObserveDraft((s) => s.index + 1);
  const total = useObserveDraft((s) => s.queue.length);
  const pendingId = Number(params.pending) || 0;
  const recordId = Number(params.record) || 0;
  const sessionId = Number(params.session) || 0;

  if (pendingId)
    return (
      <ObserveForm
        key={`p${pendingId}`}
        source={{ kind: 'pending', id: pendingId, chain: params.next === '1' }}
      />
    );
  if (recordId && sessionId)
    return (
      <ObserveForm
        key={`r${recordId}`}
        source={{ kind: 'record', id: recordId, session: sessionId }}
      />
    );
  if (draft)
    return <ObserveForm key={`d${draft.id}`} source={{ kind: 'draft', draft, n, total }} />;
  return null;
}

function ObserveForm({ source }: { source: Source }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const toast = useToast((s) => s.show);
  // Loaded once per observation (the screen keys this component on it).
  const [form, setForm] = useState<Form | null>(() => loadForm(source));
  const [viewer, setViewer] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(form);
  useEffect(() => {
    latest.current = form;
  });

  const recent = useMemo(
    () =>
      recentTaxa(12)
        .map((id) => searchByTaxonId(id))
        .filter((sp): sp is SearchResult => sp != null),
    [],
  );

  // A draft's position may still be on its way: read it from the queue.
  const fix = source.kind === 'draft' ? source.draft.fix : (form?.fix ?? null);
  const locating = source.kind === 'draft' && source.draft.locating;

  const write = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    if (source.kind === 'pending') updatePending(source.id, pendingPatch(patch));
    else if (source.kind === 'record') writeRecord(source.id, patch);
  };

  // Back from the iNaturalist upload page: whether it is there now.
  const recordAt = source.kind === 'record' ? { session: source.session, id: source.id } : null;
  const recordSession = recordAt?.session ?? 0;
  const recordId = recordAt?.id ?? 0;
  const pendingAt = source.kind === 'pending' ? source.id : 0;
  useFocusEffect(
    useCallback(() => {
      const uploadedAt = recordId
        ? getRecord(recordSession, recordId)?.inat_uploaded_at
        : pendingAt
          ? getPending(pendingAt)?.inat_uploaded_at
          : undefined;
      if (uploadedAt !== undefined)
        setForm((f) => (f ? { ...f, inatUploaded: uploadedAt != null } : f));
    }, [recordSession, recordId, pendingAt]),
  );

  // Pending: the search starts in its kingdom; otherwise in every group,
  // whatever was last picked elsewhere. Memoised: a new array would restart it.
  const kingdomScope = source.kind === 'pending' ? (form?.kingdom ?? null) : null;
  const scopeGroups = useMemo<TaxonGroup[]>(
    () => (kingdomScope ? [kingdomScope] : []),
    [kingdomScope],
  );

  // ── leaving a draft ──
  const finishDraft = () => {
    if (!nextDraft()) router.back();
  };
  const confirmLeave = () => {
    const f = latest.current;
    if (source.kind !== 'draft' || !f) return router.back();
    const kept = f.photos.length + f.audio.length > 0 || f.note.trim() !== '' || f.pick != null;
    if (!kept) return finishDraft();
    const buttons: Parameters<typeof Alert.alert>[2] = [
      { text: t('casual.keepEditing'), style: 'cancel' },
      { text: t('casual.discard'), style: 'destructive', onPress: finishDraft },
    ];
    if (source.n < source.total)
      buttons.push({
        text: t('casual.discardAll'),
        style: 'destructive',
        onPress: () => router.back(),
      });
    Alert.alert(t('casual.discardTitle'), undefined, buttons);
  };
  const leaveRef = useRef(confirmLeave);
  useEffect(() => {
    leaveRef.current = confirmLeave;
  });
  useFocusEffect(
    useCallback(() => {
      if (source.kind !== 'draft') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        leaveRef.current();
        return true;
      });
      return () => sub.remove();
    }, [source.kind]),
  );

  // ── media ──
  const addPhotos = (photos: PickedPhoto[]) => {
    const f = latest.current;
    if (!f || photos.length === 0) return;
    rememberPickedPhotos(photos);
    write({ photos: [...f.photos, ...photos.map((p) => p.uri)] });
    void fillPlaceFrom(photos);
  };
  // A photo carries the position the observation never got (no signal when it
  // was saved): applied only where there is none, as on 快速名錄 (code review
  // M30). A draft takes its place when it is added.
  const fillPlaceFrom = async (photos: PickedPhoto[]) => {
    if (source.kind === 'draft') return;
    const cur = source.kind === 'pending' ? getPending(source.id) : getRecord(source.session, source.id);
    if (!cur || !(cur.lat == null || cur.lng == null)) return;
    const out = await firstPhotoFix(photos);
    if (out.kind !== 'found') return;
    const { lat, lng, accuracyM, altitudeM } = out.fix;
    // A typed-in elevation stays (code review N3).
    const altitude = cur.elevation_m == null ? altitudeM : null;
    if (source.kind === 'pending') {
      updatePending(source.id, {
        lat,
        lng,
        accuracy: accuracyM,
        ...(altitude != null ? { elevation_m: altitude, elevation_source: 'gnss' as const } : {}),
      });
    } else {
      updateRecordLocation(source.id, lat, lng, accuracyM, altitude);
    }
    setForm((g) => (g ? { ...g, fix: { lat, lng, accuracy: accuracyM, elevation_m: altitude ?? cur.elevation_m ?? null } } : g));
  };
  const takePhoto = async () => addPhotos(await takePhotoWithExif());
  const pickLibrary = async () => {
    try {
      addPhotos(await pickPhotosWithExif());
    } catch (e) {
      Alert.alert(t('casual.libraryFail'), errText(e));
    }
  };

  // ── naming ──
  const choose = (sp: SearchResult, adopted?: AdoptionInput | null) => {
    const pick = pickOf(sp, adopted);
    if (source.kind === 'record') write({ pick });
    else setForm((f) => (f ? { ...f, pick } : f));
  };
  // Local in every mode: a record keeps its species until another is chosen.
  const unpick = () => setForm((f) => (f ? { ...f, pick: null } : f));

  const seeMine = { label: t('casual.seeMine'), onPress: () => router.navigate('/' as Href) };

  const addNamed = async () => {
    const f = latest.current;
    if (!f?.pick || busy || source.kind === 'record') return;
    const pick = f.pick;
    setBusy(true);
    try {
      if (source.kind === 'pending') {
        // Already on iNaturalist under its kingdom: the record keeps that
        // observation, and a sync sends the species (the owner's new ID).
        const onInat = getPending(source.id)?.inat_observation_id != null;
        const named = identifyPending(source.id, pick.taxonId, pick.adopted);
        // It may have opened today's checklist, or ended yesterday's (code review L35).
        useActiveSession.getState().refresh();
        const name = pick.cname || pick.name;
        if (onInat) {
          toast(t('casual.addedOnInat', { name }), {
            action: {
              label: t('casual.syncInat'),
              onPress: () =>
                void syncOnInat({ kind: 'session', id: named.sessionId }, named.recordId),
            },
          });
        } else {
          toast(t('casual.added', { name }), { action: seeMine });
        }
        const next = source.chain ? listPending()[0] : undefined;
        if (next) router.setParams({ pending: String(next.id) });
        else router.back();
        return;
      }
      // An earlier day's observation (a library photo) goes into that day's
      // checklist, as a pending one does when it is named; today's is opened.
      const sessionId =
        dayKey(f.observedAt) === dayKey(Date.now())
          ? await openTodaysChecklist(f.observedAt)
          : dailySessionOn(f.observedAt);
      if (sessionId == null) return;
      const live = useObserveDraft.getState().queue.find((d) => d.id === source.draft.id);
      const at = live?.fix ?? null;
      const q = f.quantity;
      const recordId = withTransaction(() => {
        const id = addRecord({
          session_id: sessionId,
          taxon_id: pick.taxonId,
          adopted: pick.adopted ?? null,
          observed_at: f.observedAt,
          notes: f.note.trim() ? f.note : null,
          photo_paths: json(f.photos),
          organism_quantity: q != null ? String(q) : null,
          organism_quantity_type: q != null ? 'individuals' : null,
        });
        if (at) stampRecordFix(id, at);
        if (f.audio.length) updateRecordAudio(id, f.audio);
        if (f.repro.length)
          updateRecordAttributes(id, { reproductive_condition: serializeMultiAttribute(f.repro) });
        return id;
      });
      // Still locating: the position is taken here and now. A library photo
      // without GPS is not (it was taken somewhere else).
      if (!at && live?.locating) stampNewRecord('session', recordId, sessionId, undefined, true);
      useActiveSession.getState().refresh();
      toast(t('casual.added', { name: pick.cname || pick.name }), { action: seeMine });
      finishDraft();
    } catch (e) {
      Alert.alert(t('casual.saveFail'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  const pendingKind: PendingKingdom | null = form?.pick
    ? isPendingKingdom(form.pick.kingdom)
      ? form.pick.kingdom
      : null
    : (form?.kingdom ?? null);

  const savePending = () => {
    const f = latest.current;
    if (!f || !pendingKind || busy || source.kind !== 'draft') return;
    const live = useObserveDraft.getState().queue.find((d) => d.id === source.draft.id);
    const at = live?.fix ?? null;
    const id = createPending({
      kingdom: pendingKind,
      observed_at: f.observedAt,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      accuracy: at?.accuracy ?? null,
      elevation_m: at?.elevation_m ?? null,
      elevation_source: at?.elevation_m != null ? 'gnss' : null,
      photo_paths: json(f.photos),
      audio_paths: json(f.audio),
      note: f.note.trim() ? f.note : null,
      quantity: f.quantity != null ? String(f.quantity) : null,
      reproductive_condition: serializeMultiAttribute(f.repro),
    });
    if (!at && live?.locating) {
      void takeFixNow().then((fx) => {
        if (fx && getPending(id)?.lat == null) {
          updatePending(id, {
            lat: fx.lat,
            lng: fx.lng,
            accuracy: fx.accuracy,
            elevation_m: fx.elevation_m,
            elevation_source: fx.elevation_m != null ? 'gnss' : null,
          });
        }
      });
    }
    toast(t('casual.savedPending', { kingdom: t(`casual.kingdom.${pendingKind}`) }), {
      action: seeMine,
    });
    finishDraft();
  };

  const remove = () => {
    if (source.kind === 'draft') return;
    // The one on its way to iNaturalist right now: deleting it here would
    // leave the observation there with nothing on the phone (code review M27).
    const up = useInatUpload.getState();
    if (source.kind === 'pending' && up.unit?.kind === 'pending' && up.progress?.currentId === source.id) {
      Alert.alert(t('inat.busy'));
      return;
    }
    Alert.alert(t('casual.deleteTitle'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (source.kind === 'pending') deletePending(source.id);
          else deleteRecord(source.id);
          toast(t('casual.deleted'));
          router.back();
        },
      },
    ]);
  };

  const inatRunning = useInatSync((s) => s.runningId);
  const syncOnInat = async (unit: UploadUnit, recordId: number) => {
    try {
      const r = await syncRecord(unit, recordId);
      toast(
        r.noop
          ? t('inat.syncNoChange')
          : t('inat.syncDone', {
              added: r.annotationsAdded,
              removed: r.annotationsRemoved,
              media: r.mediaSent,
            }),
      );
    } catch (e) {
      toast(t('inat.syncFailed', { msg: await apiErrorMessage(e) }));
    }
  };
  // A named observation is in its day's checklist; pending ones form one unit.
  const inatTarget: { unit: UploadUnit; id: number } | null =
    source.kind === 'record'
      ? { unit: { kind: 'session', id: source.session }, id: source.id }
      : source.kind === 'pending'
        ? { unit: { kind: 'pending', id: 0 }, id: source.id }
        : null;
  const toInat = async () => {
    if (!inatTarget || !form) return;
    const { unit, id } = inatTarget;
    if (!form.inatUploaded) {
      router.push(`/inat-upload?kind=${unit.kind}&id=${unit.id}&record=${id}` as Href);
      return;
    }
    if (!hasInatChanges(unit, id)) {
      toast(t('inat.syncNoChange'));
      return;
    }
    await syncOnInat(unit, id);
  };

  const title =
    source.kind === 'draft'
      ? source.total > 1
        ? t('casual.observeQueue', { n: source.n, total: source.total })
        : t('casual.observeTitle')
      : source.kind === 'pending'
        ? t('casual.pendingTitle')
        : t('casual.recordTitle');

  if (!form) {
    return (
      <View className="flex-1 items-center justify-center bg-paper p-6 dark:bg-paper-dark">
        <Stack.Screen options={{ title, headerLeft: BackHeaderLeft }} />
        <Text className="text-base text-gray-600 dark:text-gray-400">{t('casual.gone')}</Text>
      </View>
    );
  }

  const place = locating
    ? t('casual.locating')
    : fix
      ? fix.accuracy != null
        ? t('casual.accuracy', { m: Math.round(fix.accuracy) })
        : t('casual.hasPlace')
      : t('casual.noPlace');
  const groupKingdom = form.pick ? form.pick.kingdom : form.kingdom;
  const mismatch =
    source.kind === 'pending' && form.pick && form.kingdom && form.pick.kingdom !== form.kingdom
      ? t('casual.kingdomMismatch', {
          was: t(`casual.kingdom.${form.kingdom}`),
          now: isPendingKingdom(form.pick.kingdom)
            ? t(`casual.kingdom.${form.pick.kingdom}`)
            : form.pick.kingdom,
        })
      : null;
  const recentShown =
    source.kind === 'pending' ? recent.filter((sp) => sp.kingdom === form.kingdom) : recent;
  const hasMedia = form.photos.length + form.audio.length > 0;
  const cover = form.photos[0] ? safeAppFileUri(form.photos[0]) : null;
  // Recent names and the kingdoms, while nothing is chosen.
  const showChooser = !form.pick && (recentShown.length > 0 || source.kind !== 'record');

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title,
          ...(source.kind === 'draft'
            ? {
                gestureEnabled: false,
                headerLeft: () => (
                  <IconDisc
                    icon="close"
                    onPress={() => leaveRef.current()}
                    accessibilityLabel={t('common.close')}
                    edge="left"
                  />
                ),
              }
            : // The app's own back button, as on the other record screens: the
              // native one stopped responding on a device the second time this
              // screen was opened (the swipe back still worked).
              { headerLeft: BackHeaderLeft }),
        }}
      />
      {/* 這是什麼？ stays above the scroll: the search results open under the
          box, clear of the keyboard, and the species chosen stays in view. */}
      <View className="border-b border-line bg-card px-4 pb-3 pt-3 dark:border-line-dark dark:bg-card-dark">
        <View className="flex-row items-center gap-3">
          {cover ? (
            <Pressable
              onPress={() => setViewer(0)}
              accessibilityRole="imagebutton"
              accessibilityLabel={t('casual.photo')}
              className="h-16 w-16 overflow-hidden rounded-xl"
            >
              <Image source={{ uri: cover }} style={{ width: 64, height: 64 }} contentFit="cover" />
              {form.photos.length > 1 ? (
                <View className="absolute bottom-1 right-1 rounded-full bg-black/60 px-1.5">
                  <Text className="text-xs text-white">{form.photos.length}</Text>
                </View>
              ) : null}
            </Pressable>
          ) : form.audio.length > 0 ? (
            <View
              accessibilityLabel={t('casual.audio')}
              className="h-16 w-16 items-center justify-center rounded-xl bg-accent-tint dark:bg-accent-950/40"
            >
              <Ionicons name="mic-outline" size={28} color={c.accent} />
            </View>
          ) : null}
          <View className="flex-1">
            <View className="flex-row items-center gap-1.5">
              <Ionicons
                name={locating ? 'locate-outline' : 'location-outline'}
                size={14}
                color={c.ink3}
              />
              <Text className="flex-1 text-sm text-gray-600 dark:text-gray-400" numberOfLines={1}>
                {`${whenShort(form.observedAt)} · ${place}`}
              </Text>
            </View>
            <Text
              accessibilityRole="header"
              className="mt-1 text-lg font-bold text-gray-900 dark:text-gray-100"
            >
              {t('casual.whatIsIt')}
            </Text>
          </View>
        </View>
        <View className="mt-2">
          {form.pick ? (
            <View>
              <View className="flex-row items-center gap-3 rounded-xl border border-accent-600 bg-accent-tint px-3 py-2.5 dark:border-accent-400 dark:bg-accent-950/40">
                <View className="flex-1">
                  {form.pick.cname ? (
                    <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">
                      {form.pick.cname}
                    </Text>
                  ) : null}
                  <ScientificName
                    name={form.pick.name}
                    rank={form.pick.rank}
                    kingdom={form.pick.kingdom}
                    className="text-sci text-gray-800 dark:text-gray-200"
                    numberOfLines={1}
                  />
                  {form.pick.family ? (
                    <Text className="text-xs text-gray-600 dark:text-gray-400" numberOfLines={1}>
                      {[form.pick.familyC, form.pick.family].filter(Boolean).join(' ')}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={unpick}
                  accessibilityRole="button"
                  className="justify-center rounded-full border border-line bg-card px-3.5 active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
                  style={{ minHeight: 36 }}
                >
                  <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('casual.change')}
                  </Text>
                </Pressable>
              </View>
              {mismatch ? (
                <Text className="mt-2 text-sm text-acorn-deep dark:text-acorn">{mismatch}</Text>
              ) : null}
            </View>
          ) : (
            <View className="overflow-hidden rounded-xl border border-line dark:border-line-dark">
              <SearchBox
                layout="dropdown"
                afterSelect="dismiss"
                gbifFallback={false}
                scopeGroups={scopeGroups}
                renderNoMatch={(q) => (
                  <Text className="text-sm text-gray-600 dark:text-gray-400">
                    {t('casual.noMatch', { q })}
                  </Text>
                )}
                onSelect={choose}
              />
            </View>
          )}
        </View>
      </View>
      <KeyboardAwareScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
      >
        {showChooser ? (
          <View className="rounded-card border border-line bg-card p-3 dark:border-line-dark dark:bg-card-dark">
            {recentShown.length > 0 ? (
              <View>
                <Text className="mb-1.5 text-sm text-gray-600 dark:text-gray-400">
                  {t('casual.recent')}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {recentShown.slice(0, 8).map((sp) => (
                    <Pressable
                      key={sp.taxon_id}
                      onPress={() => choose(sp)}
                      accessibilityRole="button"
                      className="justify-center rounded-full border border-line bg-paper px-3.5 active:bg-gray-100 dark:border-line-dark dark:bg-paper-dark dark:active:bg-gray-800"
                      style={{ minHeight: 36 }}
                    >
                      <Text className="text-sm text-gray-900 dark:text-gray-100">
                        {sp.cname || sp.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            {source.kind !== 'record' ? (
              <View className={recentShown.length > 0 ? 'mt-4' : ''}>
                <Text className="mb-1.5 text-sm text-gray-600 dark:text-gray-400">
                  {source.kind === 'pending'
                    ? t('casual.kingdomOfPending')
                    : t('casual.chooseKingdom')}
                </Text>
                <View accessibilityRole="radiogroup" className="flex-row gap-2">
                  {PENDING_KINGDOMS.map((k) => {
                    const on = form.kingdom === k;
                    return (
                      <Pressable
                        key={k}
                        onPress={() =>
                          source.kind === 'pending'
                            ? write({ kingdom: k })
                            : setForm((f) => (f ? { ...f, kingdom: on ? null : k } : f))
                        }
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        className={`flex-1 items-center justify-center gap-1 rounded-2xl ${
                          on
                            ? 'border-[1.5px] border-accent-600 bg-accent-600 dark:border-accent-400 dark:bg-accent-400'
                            : 'border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800'
                        }`}
                        style={{ height: 76 }}
                      >
                        <Ionicons
                          name={KINGDOM_ICON[k]}
                          size={24}
                          color={on ? c.onAccent : c.ink}
                        />
                        <Text
                          className={`text-sm font-medium ${on ? 'text-white dark:text-gray-950' : 'text-gray-900 dark:text-gray-100'}`}
                        >
                          {t(`casual.kingdom.${k}`)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        <View
          className={`${showChooser ? 'mt-4' : ''}rounded-card border border-line bg-card p-3 dark:border-line-dark dark:bg-card-dark`}
        >
          <PhotoGrid
            photos={form.photos}
            onAdd={() => void takePhoto()}
            onPickLibrary={() => void pickLibrary()}
            onView={setViewer}
            onRemove={(uri) => write({ photos: form.photos.filter((p) => p !== uri) })}
          />
          <AudioClipList
            clips={form.audio}
            onAdd={(uri) => write({ audio: [...(latest.current?.audio ?? []), uri] })}
            onRemove={(uri) => write({ audio: form.audio.filter((a) => a !== uri) })}
          />
        </View>

        <View className="mt-4 flex-row items-center rounded-card border border-line bg-card px-3 py-2.5 dark:border-line-dark dark:bg-card-dark">
          <View className="flex-1">
            <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('casual.quantity')}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              {t('casual.quantityHint')}
            </Text>
          </View>
          <CountStepper
            value={form.quantity}
            onChange={(q) => write({ quantity: q != null && q > 0 ? q : null })}
            accessibilityName={form.pick?.cname || form.pick?.name || t('casual.quantity')}
          />
        </View>

        <ObservationNotes
          kingdom={groupKingdom}
          className={form.pick?.className ?? null}
          note={form.note}
          onCommitNote={(note) => write({ note })}
          repro={form.repro}
          onChangeRepro={(repro) => write({ repro })}
          onTakePhoto={() => void takePhoto()}
          commitOnChange
        />

        {source.kind === 'pending' && hasMedia && form.kingdom ? (
          <View className="mt-4 rounded-card border border-line bg-card p-3 dark:border-line-dark dark:bg-card-dark">
            <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('casual.inatAskTitle')}
            </Text>
            <Text className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {form.inatUploaded
                ? t('casual.inatAskDone', { kingdom: t(`casual.kingdom.${form.kingdom}`) })
                : t('casual.inatAskBody', { kingdom: t(`casual.kingdom.${form.kingdom}`) })}
            </Text>
            <Pressable
              onPress={() => void toInat()}
              disabled={inatRunning != null}
              accessibilityRole="button"
              className="mt-3 items-center justify-center self-start rounded-full border border-solid border-line bg-card px-4 active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
              style={{ minHeight: 40 }}
            >
              <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {form.inatUploaded ? t('casual.syncInat') : t('casual.uploadInat')}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAwareScrollView>

      <View className="flex-row gap-2.5 border-t border-line bg-card px-4 pb-2 pt-3 dark:border-line-dark dark:bg-card-dark">
        {source.kind === 'draft' ? (
          <FooterButton
            label={
              form.pick
                ? t('casual.saveLater')
                : form.kingdom
                  ? t('casual.savePendingAs', { kingdom: t(`casual.kingdom.${form.kingdom}`) })
                  : t('casual.pickKingdomFirst')
            }
            onPress={savePending}
            disabled={!pendingKind || busy}
          />
        ) : (
          <FooterButton label={t('common.delete')} onPress={remove} danger />
        )}
        {source.kind === 'record' ? (
          hasMedia ? (
            <FooterButton
              label={form.inatUploaded ? t('casual.syncInat') : t('casual.uploadInat')}
              onPress={() => void toInat()}
              disabled={inatRunning != null}
              primary
            />
          ) : (
            <FooterButton label={t('common.done')} onPress={() => router.back()} primary />
          )
        ) : (
          <FooterButton
            label={t('casual.add')}
            onPress={() => void addNamed()}
            disabled={!form.pick || busy}
            primary
          />
        )}
      </View>

      <PhotoViewerModal photos={form.photos} index={viewer} onClose={() => setViewer(null)} />
    </SafeAreaView>
  );
}

function FooterButton({
  label,
  onPress,
  disabled = false,
  primary = false,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const tone = primary
    ? disabled
      ? 'bg-line dark:bg-line-dark'
      : 'bg-accent-600 active:bg-accent-700 dark:bg-accent-400'
    : disabled
      ? 'border border-dashed border-gray-300 bg-paper dark:border-gray-600 dark:bg-paper-dark'
      : // border-solid: NativeWind keeps a removed border-dashed.
        'border border-solid border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800';
  const text = primary
    ? disabled
      ? 'text-gray-500 dark:text-gray-400'
      : 'font-bold text-white dark:text-gray-950'
    : disabled
      ? 'text-gray-500 dark:text-gray-400'
      : danger
        ? 'text-alert dark:text-alert-dark'
        : 'text-gray-900 dark:text-gray-100';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      className={`flex-1 items-center justify-center rounded-full px-3 ${tone}`}
      style={{ height: 52 }}
    >
      <Text className={`text-center text-[15px] ${text}`} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}
