/**
 * Recording one interaction (Phase 2F; canvas 14a; Modular_survey.md §5.6),
 * full screen: it has a species search and a text field. `from`: the
 * occurrence it is recorded from (A); `id`: 'new', or the interaction to
 * change, seen from A's side. Nothing is written until 儲存 (✓), so leaving
 * is cancelling.
 *
 * B is one of the occurrences recorded in A's unit, or another species
 * from the search docked at the bottom (its results are a list: inside the
 * scroll view they would nest one list in another): then it is recorded in
 * A's unit too, as the interaction's other side (interactionCore.ts). A ← B is stored as B → A; ↔ is offered only for a
 * both-ways type. Photos are kept here and written on saving.
 *
 * Read-only on a locked survey and once recorded blind and the blind phase
 * closed. `?unlocked=1`: a finished survey unlocked on its screen.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Keyboard, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { KeyboardAvoidingView, KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { LockedBanner } from '~/components/RecordEditButtons';
import { ScientificName } from '~/components/ScientificName';
import { SearchBox } from '~/components/SearchBox';
import { Seg } from '~/components/form/Segmented';
import { Button } from '~/components/ui/Button';
import { Chip } from '~/components/ui/Chip';
import { Radio } from '~/components/ui/Radio';
import type { SearchResult } from '~/db';
import type { AdoptionInput } from '~/db/taxonLookup';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { PhotosEditor } from '~/survey/components/editors/BasicEditors';
import { FormCard, TextBox } from '~/survey/components/FormBits';
import { asSeenFrom, directionAllowed, interactionComponent, interactionTypes, type Direction } from '~/survey/db/interactionCore';
import { snapshotOf } from '~/survey/db/surveyCore';
import {
  addInteraction,
  addInteractionPhoto,
  deleteInteraction,
  getFwSurvey,
  getInteraction,
  getOccurrence,
  interactionSealed,
  listInteractionPhotos,
  listOccurrences,
  listUnits,
  removeInteractionPhoto,
  updateInteraction,
  type Partner,
} from '~/survey/db/surveys';
import { ARROW, sentence, slot, typeLabel } from '~/survey/form/interactionText';
import { OccurrenceName, withSlots, type NameParts } from '~/survey/components/NameText';
import { labelForNew } from '~/survey/form/labelPick';
import { formErrorText } from '~/survey/form/text';
import { unitPath } from '~/survey/form/units';
import { occurrenceTitle, withNames } from '~/survey/form/useSurveyForm';

/** B: an occurrence already here, or a species found by search (recorded on saving). */
type PartnerPick =
  | { kind: 'occ'; id: number }
  | { kind: 'taxon'; taxonId: string; label: string | null; name: NameParts; adopted: AdoptionInput | null };

function load(id: number | null, from: number) {
  const a = getOccurrence(from);
  const survey = a ? getFwSurvey(a.survey_id) : null;
  if (!a || !survey || survey.style === 'individual') return null;
  const template = snapshotOf(survey);
  const component = interactionComponent(template);
  if (!component) return null;
  const row = id == null ? null : getInteraction(id);
  if (id != null && (!row || (row.subject_occurrence_id !== from && row.object_occurrence_id !== from))) return null;
  const occurrences = withNames(listOccurrences(survey.id));
  const units = survey.style === 'plot' ? listUnits(survey.id) : [];
  return {
    survey,
    template,
    component,
    types: interactionTypes(template),
    a: occurrences.find((o) => o.id === from)!,
    // The occurrences recorded where A is (a checklist: all of them), A aside.
    here: occurrences.filter((o) => o.id !== from && o.unit_id === a.unit_id),
    byId: new Map(occurrences.map((o) => [o.id, o])),
    place: a.unit_id == null ? null : unitPath(units, a.unit_id),
    row,
    photos: row ? listInteractionPhotos(row.id) : [],
    sealed: row ? interactionSealed(row) : false,
  };
}

export default function InteractionScreen() {
  const { t, i18n } = useTranslation();
  const c = useThemeColors();
  const insets = useSafeAreaInsets();
  const rootRef = useRef<View>(null);
  const [rootTop, setRootTop] = useState<number | undefined>(undefined);
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; from: string; unlocked?: string }>();
  const from = Number(params.from);
  const editId = params.id === 'new' ? null : Number(params.id);
  const [data] = useState(() => load(editId, from));
  const seen = data?.row ? asSeenFrom(data.row, from) : null;
  const firstType = data?.row?.type_code ?? data?.types.find((x) => x.offered)?.code ?? '';
  const [type, setType] = useState(firstType);
  const [direction, setDirection] = useState<Direction>(() => seen?.direction ?? (data?.types.find((x) => x.code === firstType)?.mutual ? 'mutual' : 'forward'));
  const [partner, setPartner] = useState<PartnerPick | null>(seen ? { kind: 'occ', id: seen.partner } : null);
  const [count, setCount] = useState<number | null>(() => data?.row?.count ?? (data?.component.params.count === true ? 1 : null));
  const [notes, setNotes] = useState(data?.row?.notes ?? '');
  const [photos, setPhotos] = useState<string[]>(data?.photos ?? []);
  // Arriving with the keyboard still up (the occurrence screen's abundance field) latches the docked
  // search at the keyboard's height on iOS (found 2026-10-03): close it, so the dock follows it down.
  useEffect(() => {
    if (Keyboard.isVisible()) Keyboard.dismiss();
  }, []);

  if (!data) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-ink-3 dark:text-gray-400">{t('surveyForm.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const { survey, component, types, a } = data;
  const lang = i18n.language;
  const locked = survey.status === 'done' && params.unlocked !== '1';
  const readOnly = locked || data.sealed;
  const ty = types.find((x) => x.code === type);
  // Offered types, and the one recorded even if no longer offered.
  const shownTypes = types.filter((x) => x.offered || x.code === data.row?.type_code);
  const directions: Direction[] = ty?.mutual ? ['mutual'] : ['forward', 'backward'];
  // B's name parts: an occurrence here, or the species picked from the search.
  const bParts: NameParts | null = partner == null ? null : partner.kind === 'occ' ? (data.byId.get(partner.id) ?? null) : { ...partner.name, verbatim_identification: partner.label };
  // Plain text where no styling is possible (the delete dialog).
  const aName = occurrenceTitle(a);
  const bName = bParts ? occurrenceTitle({ verbatim_identification: bParts.verbatim_identification ?? null, common_name_c: bParts.common_name_c ?? '', simple_name: bParts.simple_name ?? '', taxon_id: bParts.taxon_id }) : '';
  const aNode = <OccurrenceName o={a} bold />;
  const bNode = bParts ? <OccurrenceName o={bParts} bold /> : '…';
  const maxPhotos = Number(component.params.photos) || 0;

  const pickType = (code: string) => {
    const next = types.find((x) => x.code === code);
    setType(code);
    if (next && !directionAllowed(next, direction)) setDirection(next.mutual ? 'mutual' : 'forward');
  };

  /** A species found by search: the occurrence here when it is already recorded in A's unit. */
  const pickSearched = async (r: SearchResult, adopted?: AdoptionInput | null) => {
    if (!r.taxon_id) return;
    const label = await labelForNew(survey, { taxon_id: r.taxon_id, rank: r.rank, kingdom: r.kingdom, cname: r.cname, sci: r.name });
    if (label === undefined) return;
    const same = data.here.find((o) => o.taxon_id === r.taxon_id && (o.verbatim_identification ?? null) === label);
    if (same) setPartner({ kind: 'occ', id: same.id });
    else
      setPartner({
        kind: 'taxon',
        taxonId: r.taxon_id,
        label,
        name: { taxon_id: r.taxon_id, common_name_c: r.cname || null, simple_name: r.name, rank: r.rank, kingdom: r.kingdom },
        adopted: adopted ?? null,
      });
  };

  const save = () => {
    if (readOnly) return;
    if (!partner) {
      toast(t('survey.interaction.needPartner'));
      return;
    }
    const target: Partner =
      partner.kind === 'occ'
        ? { occurrenceId: partner.id }
        : {
            taxonId: partner.taxonId,
            verbatim: partner.label,
            ...(partner.adopted ? { usedNameId: partner.adopted.name_id ?? null, usedScientificName: partner.adopted.scientific_name } : {}),
          };
    const input = { from, partner: target, type, direction, count: component.params.count === true ? count : null, notes };
    try {
      if (editId == null) {
        const id = addInteraction(input);
        for (const uri of photos) addInteractionPhoto(id, uri);
      } else {
        updateInteraction(editId, input);
        for (const uri of data.photos.filter((u) => !photos.includes(u))) removeInteractionPhoto(editId, uri);
        for (const uri of photos.filter((u) => !data.photos.includes(u))) addInteractionPhoto(editId, uri);
      }
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    // Back with the keyboard closed: arriving with it open latches a docked search.
    Keyboard.dismiss();
    router.back();
  };

  const remove = () =>
    Alert.alert(t('survey.interaction.deleteTitle'), sentence(t, lang, ty, type, direction, aName, bName), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          try {
            if (editId != null) deleteInteraction(editId);
          } catch (e) {
            toast(formErrorText(t, e));
            return;
          }
          Keyboard.dismiss();
          router.back();
        },
      },
    ]);

  return (
    <SafeAreaView
      ref={rootRef}
      onLayout={() => rootRef.current?.measureInWindow((_x, y) => setRootTop(y))}
      edges={['bottom']}
      className="flex-1 bg-paper dark:bg-paper-dark"
    >
      <Stack.Screen
        options={{
          title: editId == null ? t('survey.interaction.addTitle') : t('survey.interaction.editTitle'),
          headerLeft: BackHeaderLeft,
          headerRight: readOnly ? undefined : () => <HeaderIconButton icon="checkmark" label={t('common.save')} onPress={save} />,
        }}
      />
      {locked ? <LockedBanner text={t('surveyForm.lockedBanner')} /> : data.sealed ? <LockedBanner text={t('surveyForm.err.blindSealed')} /> : null}
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
          <Text className="text-xs text-ink-3 dark:text-gray-400">
            {withSlots(t('survey.interaction.aIs', { name: slot('a') }), { a: <OccurrenceName o={a} /> })}
            {data.place ? ` · ${data.place}` : ''}
          </Text>

          <FormCard>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="text-base font-bold text-ink dark:text-gray-100">{direction === 'backward' ? bNode : aNode}</Text>
              <Text className="rounded-full bg-accent-50 px-2.5 py-0.5 text-sm font-bold text-accent-800 dark:bg-accent-900 dark:text-accent-100">
                {`${direction === 'mutual' ? ARROW.mutual : ARROW.forward} ${typeLabel(t, lang, ty, type)}`}
              </Text>
              <Text className="text-base font-bold text-ink dark:text-gray-100">{direction === 'backward' ? aNode : bNode}</Text>
            </View>
            {bParts ? (
              <Text className="text-xs leading-4 text-ink-2 dark:text-gray-300">
                {withSlots(sentence(t, lang, ty, type, direction, slot('a'), slot('b')), { a: <OccurrenceName o={a} />, b: <OccurrenceName o={bParts} /> })}
              </Text>
            ) : null}
          </FormCard>

          <FormCard title={t('survey.interaction.kind')}>
            <View className="flex-row flex-wrap gap-2" pointerEvents={readOnly ? 'none' : 'auto'}>
              {shownTypes.map((x) => (
                <Chip key={x.code} label={typeLabel(t, lang, x, x.code)} selected={x.code === type} onPress={() => pickType(x.code)} />
              ))}
            </View>
          </FormCard>

          <FormCard title={t('survey.interaction.direction')}>
            <View pointerEvents={readOnly ? 'none' : 'auto'}>
              <Seg value={direction} options={directions.map((d) => ({ value: d, label: t(`survey.interaction.dir.${d}`) }))} onChange={setDirection} />
            </View>
            {ty?.mutual ? <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('survey.interaction.mutualOnly')}</Text> : null}
          </FormCard>

          <FormCard title={t('survey.interaction.partner')}>
            {data.here.length === 0 ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t('survey.interaction.noneHere')}</Text> : null}
            {data.here.map((o) => {
              const on = partner?.kind === 'occ' && partner.id === o.id;
              return (
                <Pressable
                  key={o.id}
                  disabled={readOnly}
                  onPress={() => setPartner({ kind: 'occ', id: o.id })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  className="flex-row items-center gap-2.5"
                  style={{ minHeight: 48 }}
                >
                  <Radio selected={on} />
                  <View className="flex-1">
                    {o.verbatim_identification || o.common_name_c ? (
                      <Text className="text-base font-semibold text-ink dark:text-gray-100">{o.verbatim_identification || o.common_name_c}</Text>
                    ) : null}
                    <ScientificName
                      name={o.simple_name || o.taxon_id}
                      rank={o.rank}
                      kingdom={o.kingdom}
                      className={o.verbatim_identification || o.common_name_c ? 'text-sm text-ink-2 dark:text-gray-300' : 'text-base font-semibold text-ink dark:text-gray-100'}
                    />
                  </View>
                  {o.via_interaction ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t('survey.interaction.viaTag')}</Text> : null}
                </Pressable>
              );
            })}
            {partner?.kind === 'taxon' ? (
              <View className="flex-row items-center gap-2.5" style={{ minHeight: 48 }}>
                <Radio selected />
                <View className="flex-1">
                  <Text className="text-base font-semibold text-ink dark:text-gray-100">
                    <OccurrenceName o={{ ...partner.name, verbatim_identification: partner.label }} bold />
                  </Text>
                  <Text className="text-xs text-ink-3 dark:text-gray-400">{t('survey.interaction.addedToRecord')}</Text>
                </View>
                {!readOnly ? (
                  <Pressable onPress={() => setPartner(null)} accessibilityRole="button" accessibilityLabel={t('common.clear')} hitSlop={8}>
                    <Ionicons name="close-circle" size={20} color={c.ink3} />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {!readOnly ? <Text className="border-t border-line pt-2 text-xs leading-4 text-ink-3 dark:border-line-dark dark:text-gray-400">{t('survey.interaction.searchBelow')}</Text> : null}
          </FormCard>

          {component.params.count === true ? (
            <FormCard>
              <View className="flex-row items-center gap-2" style={{ minHeight: 48 }}>
                <Text className="flex-1 text-base text-ink dark:text-gray-100">{t('survey.interaction.times')}</Text>
                <Button label="−" variant="secondary" disabled={readOnly || (count ?? 1) <= 1} onPress={() => setCount(Math.max(1, (count ?? 1) - 1))} accessibilityLabel={t('survey.interaction.less')} />
                <Text className="w-10 text-center text-base font-bold text-ink dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
                  {count ?? 1}
                </Text>
                <Button label="＋" variant="secondary" disabled={readOnly} onPress={() => setCount((count ?? 1) + 1)} accessibilityLabel={t('survey.interaction.more')} />
              </View>
            </FormCard>
          ) : null}

          {maxPhotos > 0 ? (
            <FormCard title={t('survey.interaction.photoTitle', { count: maxPhotos })}>
              <PhotosEditor
                instance={component}
                values={{ photos }}
                problems={[]}
                readOnly={readOnly}
                onChange={() => undefined}
                context={{
                  onAddMedia: (uri) => {
                    if (photos.length >= maxPhotos) toast(t('survey.interaction.photoLimit', { count: maxPhotos }));
                    // Several from the library arrive at once: the list caps itself.
                    setPhotos((p) => (p.length >= maxPhotos ? p : [...p, uri]));
                  },
                  onRemoveMedia: (uri) => setPhotos((p) => p.filter((x) => x !== uri)),
                }}
              />
            </FormCard>
          ) : null}

          <FormCard title={t('survey.component.comments')}>
            <TextBox value={notes} onChange={setNotes} accessibilityLabel={t('survey.component.comments')} multiline editable={!readOnly} />
          </FormCard>

          {editId != null && !readOnly ? <Button label={t('survey.interaction.deleteTitle')} icon="trash-outline" variant="danger" onPress={remove} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
      {!readOnly ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View>
            <Text className="border-t border-line bg-card px-4 py-1.5 text-xs text-ink-2 dark:border-line-dark dark:bg-card-dark dark:text-gray-300">{t('survey.interaction.other')}</Text>
            <SearchBox onSelect={(r, adopted) => void pickSearched(r, adopted)} afterSelect="dismiss" topLimit={rootTop} />
          </View>
        </KeyboardStickyView>
      ) : null}
    </SafeAreaView>
  );
}
