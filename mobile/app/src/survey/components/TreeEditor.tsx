/**
 * The tree form (design 13c; docs/ForestGEO/Stem_mapping.md "單株畫面"):
 * tag, species, position, stems with DBH / POM / main flag, census codes,
 * height, photos, notes. Used full screen (app/survey/[id]/tree.tsx) and as
 * the right pane of the tablet layout.
 *
 * What it asks follows the census's template (2D-b): height and photos only
 * when the template has them, its location methods, the AMS entries, its own
 * health code lists per stem, and a card per Traits component on the tree.
 *
 * - The form is text until saved (treeForm.ts); "Save" and "Save, next tree"
 *   write it in one transaction (saveTreeDraft).
 * - A tree first recorded in this census is edited in the form. An older
 *   tree's species, position and tag are corrections: written at once, with a
 *   reason, into its history.
 * - Errors block the save; hints (smaller DBH, tenfold) ask first — Condit
 *   1998 p.83: a smaller DBH is still recorded.
 * - The bottom dock is either the two save buttons or the species search.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { NumAccessory } from '~/components/form/NumField';
import { Seg } from '~/components/form/Segmented';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { SearchBox } from '~/components/SearchBox';
import { promptText } from '~/components/TextPromptModal';
import { Button } from '~/components/ui/Button';
import { Checkbox } from '~/components/ui/Checkbox';
import { resolveTaxa } from '~/db/taxonLookup';
import { errText } from '~/lib/errText';
import { captureFix } from '~/lib/gnssFix';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { useToast } from '~/stores/toast';
import { enterableCensusCodes } from '~/survey/codesets/forestgeoCensus1998';
import { CodeChips } from '~/survey/components/CodeChips';
import { DraftNum } from '~/survey/components/DraftNum';
import { Field, FormCard, Hint, Problem, TextBox } from '~/survey/components/FormBits';
import { codeLabel, issueText } from '~/survey/components/labels';
import { labelText } from '~/survey/components/editors/shared';
import { AMS_CODESET } from '~/survey/codesets/forestgeoAms2021';
import { healthCodesets, LOCATION_METHODS } from '~/survey/registry';
import type { Label } from '~/survey/template/types';
import { STEMMAP_TEMPLATE } from '~/survey/templates/stemmap';
import { AmsStemFields } from '~/survey/components/AmsStemFields';
import {
  addTreeMedia,
  censusCustomLists,
  censusTemplate,
  correctIndividual,
  listTreeMedia,
  loadTree,
  removeTreeMedia,
  saveTreeDraft,
  suggestTag,
  SurveyError,
  type FrameRow,
  type TreeState,
  type TreeView,
} from '~/survey/db/stemmap';
import { treeBasalAreaCm2 } from '~/survey/stemmap/basal';
import { frameGeometry } from '~/survey/db/stemmap';
import {
  formDbhs,
  formFromView,
  formStemInputs,
  unreadableFields,
  formIssues,
  formToDraft,
  locationInput,
  newStem,
  previewLocation,
  stemNumbers,
  stemTagOf,
  traitIssues,
  treeTraits,
  type LocForm,
  type LocMethod,
  type TreeForm,
} from '~/survey/stemmap/treeForm';
import { isMultiStem } from '~/survey/stemmap/status';
import type { StakeCorner } from '~/survey/stemmap/coords';
import { useThemeColors } from '~/theme/colors';
import { checkpointQuadrats } from '~/survey/undo';
import { claimedByOthers } from '~/survey/censusSync';

export type TreeEditorProps = {
  surveyId: number;
  frame: FrameRow;
  firstCensus: boolean;
  /** null: a new tree. */
  individualId: number | null;
  /** For a new tree: the quadrat being walked, and the map point if tapped there. */
  quadrat: string;
  at?: { x: number; y: number } | null;
  /** Every tree of the census (reference trees for distance + bearing). */
  states: readonly TreeState[];
  recordedBy: string | null;
  onSaved: (individualId: number, next: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** A correction was written (tag, species, position): the screen re-reads. */
  onChanged?: () => void;
};

const STEM_CODES = (first: boolean) => enterableCensusCodes('stem', first).map((c) => c.code);
const TREE_CODES = enterableCensusCodes('tree', false).map((c) => c.code);
const CORNERS: StakeCorner[] = ['SW', 'NW', 'NE', 'SE'];

export function TreeEditor(props: TreeEditorProps) {
  const { surveyId, frame, firstCensus, individualId, quadrat, states, recordedBy } = props;
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const c = useThemeColors();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const g = useMemo(() => frameGeometry(frame), [frame]);
  const [view, setView] = useState<TreeView | null>(() => (individualId == null ? null : loadTree(surveyId, individualId)));
  // What the census template records; an unreadable snapshot reads as the built-in census.
  const tpl = useMemo(() => censusTemplate(surveyId) ?? STEMMAP_TEMPLATE, [surveyId]);
  const parts = useMemo(() => {
    const comps = tpl.components;
    const loc = comps.find((x) => x.type === 'location' && x.level === 'individual');
    const allowed = Array.isArray(loc?.params.methods) ? (loc.params.methods as string[]) : [];
    const methods = LOCATION_METHODS.filter((m) => !loc || allowed.includes(m));
    return {
      // With AMS, each stem gets the AMS entries and its death follows AMS survival.
      ams: healthCodesets(comps).includes(AMS_CODESET),
      height: comps.some((x) => x.type === 'height' && x.level === 'individual'),
      photos: comps.find((x) => x.type === 'photos' && x.level === 'individual') ?? null,
      traits: treeTraits(tpl),
      lists: censusCustomLists(tpl),
      methods: (methods.length ? methods : LOCATION_METHODS) as readonly LocMethod[],
    };
  }, [tpl]);
  const amsOn = parts.ams;
  /** The form of a tree as stored, its position method one the template offers. */
  const formOf = (v: TreeView | null): TreeForm => {
    const f = formFromView(v, { quadrat, at: props.at, geometry: g, amsOn });
    return parts.methods.includes(f.loc.method) ? f : { ...f, loc: { ...f.loc, method: parts.methods[0] } };
  };
  const [form, setForm] = useState<TreeForm>(() => formOf(view));
  const [base, setBase] = useState(() => JSON.stringify(form));
  const [searching, setSearching] = useState(individualId == null);
  const [locEditing, setLocEditing] = useState(false);
  const [photos, setPhotos] = useState<string[]>(() => (individualId == null ? [] : listTreeMedia(surveyId, individualId).map((m) => m.uri)));
  const [viewing, setViewing] = useState<number | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  // Required fields are marked only once a save was tried.
  const [tried, setTried] = useState(false);

  const isNewTree = view == null;
  const recruit = isNewTree || view.individual.first_survey_id === surveyId;
  const locOpen = recruit || locEditing;
  const dirty = JSON.stringify(form) !== base;
  const { onDirtyChange } = props;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const set = (patch: Partial<TreeForm>) => setForm((f) => ({ ...f, ...patch }));
  const setLoc = (patch: Partial<LocForm>) => setForm((f) => ({ ...f, loc: { ...f.loc, ...patch } }));
  const treeAt = (tag: string) => {
    const s = states.find((x) => x.tag === tag);
    return s ? { x: s.x, y: s.y } : null;
  };
  const preview = useMemo(() => previewLocation(form.loc, g, treeAt), [form.loc, g, states]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new tree's tag follows its position until the user types one.
  const suggested = useMemo(() => {
    if (!isNewTree || !preview?.inside) return '';
    try {
      return suggestTag(frame, preview);
    } catch {
      return '';
    }
  }, [isNewTree, preview, frame]);
  const tag = isNewTree && !form.tagTyped ? suggested : form.tag;

  const names = useMemo(() => {
    const id = form.taxon?.taxonId;
    if (!id) return null;
    const f = resolveTaxa([id]).get(id);
    return { cname: f?.common_name_c || '', sci: form.taxon?.usedScientificName || f?.simple_name || id };
  }, [form.taxon]);

  const issues = useMemo(
    () => formIssues({ ...form, tag }, view, { surveyId, firstCensus, thresholdCm: frame.dbh_min_cm }),
    [form, tag, view, surveyId, firstCensus, frame.dbh_min_cm],
  );
  const numbers = stemNumbers(form);
  const traitProblems = useMemo(() => traitIssues(form, tpl), [form, tpl]);
  const traitName = (key: string, id: string) => {
    const tr = parts.traits.find((x) => x.key === key)?.traits.find((x) => x.id === id);
    return labelText(t, lang, tr?.label as Label | undefined, id);
  };
  const ba = treeBasalAreaCm2(formDbhs(form));
  const multi = isMultiStem({ treeCodes: form.treeCodes, stems: formStemInputs(form), existed: true, thresholdCm: frame.dbh_min_cm });

  /** After a correction: take the corrected tag / species (and position)
   *  into the form AND its saved baseline — a correction is already stored,
   *  so it must not make the form look unsaved. Other typing is kept. */
  const reload = (position = false) => {
    if (individualId == null) return;
    const v = loadTree(surveyId, individualId);
    setView(v);
    if (!v) return;
    const fresh = formOf(v);
    const patch: Partial<TreeForm> = { tag: fresh.tag, taxon: fresh.taxon, ...(position ? { loc: fresh.loc } : {}) };
    setForm((f) => ({ ...f, ...patch }));
    setBase((b) => JSON.stringify({ ...(JSON.parse(b) as TreeForm), ...patch }));
    props.onChanged?.();
  };

  const askReason = () => promptText({ title: t('survey.tree.reasonTitle'), message: t('survey.tree.reasonMsg'), allowEmpty: true });
  /** Undo point for the quadrats this tree's edit touches (its own, and where it moves to). */
  const checkpoint = (to?: string | null) =>
    checkpointQuadrats(surveyId, [view?.individual.quadrat_code ?? to ?? quadrat, ...(to ? [to] : [])], view ? [view.individual.uuid] : []);

  const onSpecies = async (taxonId: string, sci: string | null, nameId: number | null | undefined) => {
    setSearching(false);
    const taxon = { taxonId, usedNameId: nameId != null ? String(nameId) : null, usedScientificName: sci, verbatimIdentification: form.taxon?.verbatimIdentification ?? null };
    if (recruit) {
      set({ taxon });
      return;
    }
    const reason = await askReason();
    if (reason == null) return;
    checkpoint();
    correctIndividual(view!.individual.id, { taxon }, { surveyId, reason: reason || null, by: recordedBy });
    reload();
    toast(t('survey.tree.corrected'));
  };

  const correctLocation = async () => {
    const input = locationInput(form.loc);
    if (!input || !preview?.inside) {
      toast(t('survey.tree.errPosition'));
      return;
    }
    const reason = await askReason();
    if (reason == null) return;
    checkpoint(preview.quadrat);
    try {
      correctIndividual(view!.individual.id, { location: input }, { surveyId, reason: reason || null, by: recordedBy });
    } catch (e) {
      toast(e instanceof SurveyError ? t('survey.tree.errPosition') : errText(e));
      return;
    }
    setLocEditing(false);
    reload(true);
    toast(t('survey.tree.corrected'));
  };

  const correctTag = async () => {
    const next = await promptText({ title: t('survey.tree.correctTag'), defaultValue: view!.individual.tag, autoCapitalize: 'none' });
    if (next == null || next.trim() === view!.individual.tag) return;
    const reason = await askReason();
    if (reason == null) return;
    checkpoint();
    try {
      correctIndividual(view!.individual.id, { tag: next.trim() }, { surveyId, reason: reason || null, by: recordedBy });
    } catch (e) {
      if (e instanceof SurveyError && e.code === 'tag_taken') return toast(t('survey.tree.errTagTaken', { tag: next.trim() }));
      if (e instanceof SurveyError && e.code === 'tag_retired') return toast(t('survey.tree.errTagRetired', { tag: next.trim() }));
      throw e;
    }
    reload();
    toast(t('survey.tree.corrected'));
  };

  const takeFix = async () => {
    setFixBusy(true);
    try {
      const fix = await captureFix();
      if (fix) setLoc({ lat: String(fix.lat), lng: String(fix.lng), acc: fix.accuracy == null ? '' : String(Math.round(fix.accuracy * 10) / 10) });
    } finally {
      setFixBusy(false);
    }
  };

  const claimWarned = useRef(false);
  const save = (next: boolean) => {
    const f = { ...form, tag };
    setTried(true);
    const bad = unreadableFields(f, tag);
    if (bad.length) {
      const name = (b: (typeof bad)[number]) => {
        switch (b.field) {
          case 'dbh':
            return t('survey.tree.dbhOf', { tag: b.stemTag });
          case 'pom':
            return t('survey.tree.pomOf', { tag: b.stemTag });
          case 'height':
            return t('survey.tree.height');
          case 'position':
            return t('survey.tree.position');
          case 'trait':
            return b.trait ? traitName(b.trait.key, b.trait.id) : '';
        }
      };
      Alert.alert(t('survey.tree.cannotSave'), `${t('survey.tree.errNumber')}\n${bad.map((b) => `• ${name(b)}`).join('\n')}`);
      return;
    }
    if (traitProblems.length) {
      Alert.alert(t('survey.tree.cannotSave'), traitProblems.map((x) => `• ${traitName(x.key, x.id)}：${traitProblemText(x.key, x.id, x.code)}`).join('\n'));
      return;
    }
    if (!f.taxon) return toast(t('survey.tree.errSpecies'));
    if (recruit && (!preview || !preview.inside)) return toast(t('survey.tree.errPosition'));
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      Alert.alert(t('survey.tree.cannotSave'), errors.map((i) => `• ${issueLine(i.stemNo, i.code)}`).join('\n'));
      return;
    }
    const write = () => {
      try {
        checkpoint(recruit ? (preview?.quadrat ?? null) : null);
        const id = saveTreeDraft(surveyId, formToDraft(f, view, { surveyId, recordedBy }));
        setBase(JSON.stringify(form));
        props.onSaved(id, next);
      } catch (e) {
        if (e instanceof SurveyError) {
          switch (e.code) {
            case 'tag_taken':
              return toast(t('survey.tree.errTagTaken', { tag: f.tag }));
            case 'tag_retired':
              return toast(t('survey.tree.errTagRetired', { tag: f.tag }));
            case 'tag_range_full':
              return toast(t('survey.tree.errTagRange'));
            case 'outside_plot':
            case 'bad_reference':
              return toast(t('survey.tree.errPosition'));
            default:
              break;
          }
        }
        toast(errText(e));
      }
    };
    const proceed = () => {
      const soft = issues.filter((i) => i.severity !== 'error');
      if (soft.length) {
        Alert.alert(t('survey.tree.confirmTitle'), `${soft.map((i) => `• ${issueLine(i.stemNo, i.code)}`).join('\n')}\n\n${t('survey.tree.confirmMsg')}`, [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('survey.tree.saveAnyway'), onPress: write },
        ]);
        return;
      }
      write();
    };
    // A block another group claims: only a hint (decided 2026-10-01), asked once per form.
    const where = (recruit ? preview?.quadrat : view?.individual.quadrat_code) ?? quadrat;
    const claimers = claimWarned.current || !where ? [] : claimedByOthers(surveyId, where);
    if (claimers.length) {
      Alert.alert(t('survey.sync.claimedTitle'), t('survey.sync.claimedMsg', { names: claimers.join('、') }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('survey.sync.claimedGo'),
          onPress: () => {
            claimWarned.current = true;
            proceed();
          },
        },
      ]);
      return;
    }
    proceed();
  };

  const issueLine = (stemNo: number | null, code: string) =>
    stemNo == null ? issueText(t, code) : `${stemTagOf(tag, stemNo)} ${issueText(t, code)}`;

  const photoMax = Number(parts.photos?.params.max) || 0;
  const addPhotos = (uris: string[]) => {
    if (individualId == null) return;
    // As many as the template allows; the rest are not kept.
    const take = uris.slice(0, Math.max(0, photoMax - photos.length));
    if (take.length < uris.length) toast(t('survey.tree.photosMax', { max: photoMax }));
    if (!take.length) return;
    checkpoint();
    for (const u of take) addTreeMedia(surveyId, individualId, u);
    setPhotos(listTreeMedia(surveyId, individualId).map((m) => m.uri));
  };

  /** A trait value out of its range, said with the range. */
  const traitProblemText = (key: string, id: string, code: string) => {
    if (code === 'not_integer') return t('survey.tree.traitInteger');
    const tr = parts.traits.find((x) => x.key === key)?.traits.find((x) => x.id === id);
    const range = tr?.min != null && tr?.max != null ? `${tr.min}–${tr.max}` : tr?.min != null ? `≥ ${tr.min}` : tr?.max != null ? `≤ ${tr.max}` : '';
    return t('survey.tree.traitRange', { range });
  };
  const setTrait = (key: string, id: string, v: string) => setForm((f) => ({ ...f, traits: { ...f.traits, [key]: { ...(f.traits[key] ?? {}), [id]: v } } }));

  const stemCodes = STEM_CODES(firstCensus);
  const methodLabel = { grid: t('survey.loc.grid'), xy: t('survey.loc.xy'), polar: t('survey.loc.polar'), gps: t('survey.loc.gps') };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <KeyboardAwareScrollView className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {/* Tag and species */}
        <FormCard>
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <Text className="font-mono text-xl font-bold text-ink dark:text-gray-100">#{tag || '—'}</Text>
              {names ? (
                <Text className="text-base text-ink dark:text-gray-100">
                  {names.cname ? `${names.cname} ` : ''}
                  <Text className="font-latin text-sm text-ink-2 dark:text-gray-300">{names.sci}</Text>
                </Text>
              ) : (
                <Text className="text-sm text-alert dark:text-alert-dark">{t('survey.tree.noSpecies')}</Text>
              )}
            </View>
            <Button label={recruit ? t('survey.tree.pickSpecies') : t('survey.tree.correctSpecies')} variant="secondary" onPress={() => setSearching(true)} />
          </View>
          {recruit ? (
            <Field label={t('survey.tree.tag')}>
              <TextBox value={tag} onChange={(v) => set({ tag: v, tagTyped: true })} accessibilityLabel={t('survey.tree.tag')} autoCapitalize="none" invalid={tried && !tag.trim()} />
            </Field>
          ) : (
            <Pressable onPress={() => void correctTag()} accessibilityRole="button" className="self-start">
              <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{t('survey.tree.correctTag')}</Text>
            </Pressable>
          )}
        </FormCard>

        {/* Position */}
        <FormCard
          title={t('survey.tree.position')}
          right={
            !recruit && !locEditing ? (
              <Pressable onPress={() => setLocEditing(true)} accessibilityRole="button" hitSlop={6}>
                <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{t('survey.tree.correctPosition')}</Text>
              </Pressable>
            ) : null
          }
        >
          {!recruit ? <Hint>{t('survey.tree.positionReadOnly')}</Hint> : null}
          {locOpen ? (
            <>
              {parts.methods.length > 1 ? <Seg value={form.loc.method} options={parts.methods.map((m) => ({ value: m, label: methodLabel[m] }))} onChange={(m) => setLoc({ method: m })} /> : null}
              {form.loc.method === 'grid' ? (
                <View className="flex-row gap-2">
                  <Field label={t('survey.loc.quadrat', { m: frame.quadrat_m })} className="flex-1">
                    <TextBox value={form.loc.quadrat} onChange={(v) => setLoc({ quadrat: v })} accessibilityLabel={t('survey.loc.quadrat', { m: frame.quadrat_m })} autoCapitalize="none" />
                  </Field>
                  <Field label={t('survey.loc.localX')} className="flex-1">
                    <DraftNum value={form.loc.lx} onChange={(v) => setLoc({ lx: v })} accessibilityLabel={t('survey.loc.localX')} width="100%" />
                  </Field>
                  <Field label={t('survey.loc.localY')} className="flex-1">
                    <DraftNum value={form.loc.ly} onChange={(v) => setLoc({ ly: v })} accessibilityLabel={t('survey.loc.localY')} width="100%" />
                  </Field>
                </View>
              ) : null}
              {form.loc.method === 'xy' ? (
                <View className="flex-row gap-2">
                  <Field label={t('survey.loc.plotX')} className="flex-1">
                    <DraftNum value={form.loc.x} onChange={(v) => setLoc({ x: v })} accessibilityLabel={t('survey.loc.plotX')} width="100%" />
                  </Field>
                  <Field label={t('survey.loc.plotY')} className="flex-1">
                    <DraftNum value={form.loc.y} onChange={(v) => setLoc({ y: v })} accessibilityLabel={t('survey.loc.plotY')} width="100%" />
                  </Field>
                </View>
              ) : null}
              {form.loc.method === 'polar' ? (
                <>
                  <Seg
                    value={form.loc.refKind}
                    options={[
                      { value: 'stake', label: t('survey.loc.refStake') },
                      { value: 'tree', label: t('survey.loc.refTree') },
                    ]}
                    onChange={(v) => setLoc({ refKind: v })}
                  />
                  {form.loc.refKind === 'stake' ? (
                    <View className="flex-row items-end gap-2">
                      <Field label={t('survey.loc.stakeQuadrat', { m: frame.quadrat_m })} className="w-24">
                        <TextBox value={form.loc.refQuadrat} onChange={(v) => setLoc({ refQuadrat: v })} accessibilityLabel={t('survey.loc.stakeQuadrat', { m: frame.quadrat_m })} autoCapitalize="none" />
                      </Field>
                      <View className="flex-1">
                        <Seg value={form.loc.refCorner} options={CORNERS.map((k) => ({ value: k, label: k }))} onChange={(v) => setLoc({ refCorner: v })} />
                      </View>
                    </View>
                  ) : (
                    <Field label={t('survey.loc.refTag')}>
                      <TextBox value={form.loc.refTag} onChange={(v) => setLoc({ refTag: v })} accessibilityLabel={t('survey.loc.refTag')} autoCapitalize="none" invalid={!!form.loc.refTag && !treeAt(form.loc.refTag.trim())} />
                    </Field>
                  )}
                  <View className="flex-row gap-2">
                    <Field label={t('survey.loc.distance')} className="flex-1">
                      <DraftNum value={form.loc.dist} onChange={(v) => setLoc({ dist: v })} accessibilityLabel={t('survey.loc.distance')} width="100%" />
                    </Field>
                    <Field label={t('survey.loc.azimuth')} className="flex-1">
                      <DraftNum value={form.loc.az} onChange={(v) => setLoc({ az: v })} accessibilityLabel={t('survey.loc.azimuth')} width="100%" />
                    </Field>
                    <Field label={t('survey.loc.slope')} className="flex-1">
                      <DraftNum value={form.loc.slope} onChange={(v) => setLoc({ slope: v })} accessibilityLabel={t('survey.loc.slope')} width="100%" />
                    </Field>
                  </View>
                  <Seg
                    value={form.loc.azRef}
                    options={[
                      { value: 'magnetic', label: t('survey.loc.compass') },
                      { value: 'true', label: t('survey.frame.trueNorth') },
                    ]}
                    onChange={(v) => setLoc({ azRef: v })}
                  />
                </>
              ) : null}
              {form.loc.method === 'gps' ? (
                <>
                  <View className="flex-row gap-2">
                    <Field label={t('survey.frame.lat')} className="flex-1">
                      <DraftNum value={form.loc.lat} onChange={(v) => setLoc({ lat: v })} accessibilityLabel={t('survey.frame.lat')} width="100%" signed />
                    </Field>
                    <Field label={t('survey.frame.lng')} className="flex-1">
                      <DraftNum value={form.loc.lng} onChange={(v) => setLoc({ lng: v })} accessibilityLabel={t('survey.frame.lng')} width="100%" signed />
                    </Field>
                  </View>
                  <Button label={t('survey.frame.takeFix')} icon="locate-outline" variant="secondary" loading={fixBusy} onPress={() => void takeFix()} />
                  {frame.origin_lat == null ? <Problem>{t('survey.loc.gpsNoOrigin')}</Problem> : <Hint>{t('survey.loc.gpsHint')}</Hint>}
                </>
              ) : null}
            </>
          ) : null}
          {locOpen ? (
            preview ? (
              <Text style={{ fontVariant: ['tabular-nums'] }} className={`text-sm ${preview.inside ? 'text-accent-700 dark:text-accent-300' : 'text-alert dark:text-alert-dark'}`}>
                {preview.inside
                  ? t('survey.loc.preview', { x: preview.x.toFixed(1), y: preview.y.toFixed(1), q: preview.quadrat, i: preview.sub.i, j: preview.sub.j })
                  : t('survey.loc.outside')}
              </Text>
            ) : (
              <Hint>{t('survey.loc.incomplete')}</Hint>
            )
          ) : view ? (
            <Text style={{ fontVariant: ['tabular-nums'] }} className="text-sm text-ink dark:text-gray-100">
              {t('survey.loc.current', { x: view.individual.x_m.toFixed(1), y: view.individual.y_m.toFixed(1), q: view.individual.quadrat_code })}
            </Text>
          ) : null}
          {locOpen && preview?.inside && preview.quadrat !== quadrat ? <Hint>{t('survey.loc.otherQuadrat', { q: preview.quadrat })}</Hint> : null}
          {locEditing ? (
            <View className="flex-row gap-2">
              <Button label={t('common.cancel')} variant="secondary" onPress={() => setLocEditing(false)} className="flex-1" />
              <Button label={t('survey.tree.applyCorrection')} onPress={() => void correctLocation()} className="flex-1" />
            </View>
          ) : null}
        </FormCard>

        {/* Stems */}
        <FormCard
          title={t('survey.tree.stems', { cm: frame.dbh_min_cm })}
          right={
            parts.height ? (
              <View className="flex-row items-center gap-1.5">
                <Text className="text-xs text-ink-2 dark:text-gray-400">{t('survey.tree.height')}</Text>
                <DraftNum value={form.height} onChange={(v) => set({ height: v })} accessibilityLabel={t('survey.tree.height')} width={56} />
                <Text className="text-xs text-ink-2 dark:text-gray-400">m</Text>
              </View>
            ) : undefined
          }
        >
          {!firstCensus ? (
            <View className="gap-1.5">
              <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('survey.tree.wholeDead')}</Text>
              <CodeChips codes={TREE_CODES} selected={form.treeCodes} single onChange={(v) => set({ treeCodes: v })} labelOf={(k) => codeLabel(t, k)} />
              {view?.previousTreeCodes.length ? <Hint>{t('survey.tree.prevTreeCodes', { codes: view.previousTreeCodes.join(' ') })}</Hint> : null}
            </View>
          ) : null}
          {form.stems.map((s, i) => {
            const no = numbers.get(s.key)!;
            const codes = form.same ? form.allCodes : s.codes;
            const needsPom = codes.includes('A') || codes.includes('Y');
            const stemIssues = issues.filter((x) => x.stemNo === no);
            const patch = (p: Partial<typeof s>) => set({ stems: form.stems.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            const main = form.mainKey === s.key;
            return (
              <View key={s.key} className={`gap-2 rounded-xl border bg-card px-2.5 py-2 dark:bg-gray-900 ${stemIssues.some((x) => x.severity === 'error') ? 'border-alert dark:border-alert-dark' : 'border-line dark:border-line-dark'}`}>
                <View className="flex-row items-center gap-2">
                  <Pressable onPress={() => set({ mainKey: s.key })} accessibilityRole="button" accessibilityLabel={t('survey.tree.setMain')} accessibilityState={{ selected: main }} hitSlop={6} className="w-[72px] flex-row items-center">
                    <Text className="font-mono text-sm font-bold text-ink dark:text-gray-100">{stemTagOf(tag, no)}</Text>
                    <Ionicons name={main ? 'star' : 'star-outline'} size={14} color={main ? c.acornDeep : c.ink3} style={{ marginLeft: 3 }} />
                  </Pressable>
                  <DraftNum value={s.dbh} onChange={(v) => patch({ dbh: v })} accessibilityLabel={t('survey.tree.dbhOf', { tag: stemTagOf(tag, no) })} width={68} strong invalid={stemIssues.some((x) => x.severity === 'error' && x.code !== 'pom_required')} />
                  <Text className="text-xs text-ink-2 dark:text-gray-400">cm</Text>
                  <Text className="ml-1 text-xs text-ink-2 dark:text-gray-400">POM</Text>
                  <DraftNum value={s.pom} onChange={(v) => patch({ pom: v })} accessibilityLabel={t('survey.tree.pomOf', { tag: stemTagOf(tag, no) })} width={48} invalid={needsPom && stemIssues.some((x) => x.code === 'pom_required')} />
                  <Text className="text-xs text-ink-2 dark:text-gray-400">m</Text>
                  <View className="flex-1" />
                  {s.stemNo == null && form.stems.length > 1 ? (
                    <Pressable onPress={() => set({ stems: form.stems.filter((_, j) => j !== i), mainKey: main ? form.stems[0].key : form.mainKey })} accessibilityRole="button" accessibilityLabel={t('survey.tree.removeStem')} hitSlop={8}>
                      <Ionicons name="close" size={18} color={c.ink3} />
                    </Pressable>
                  ) : null}
                </View>
                {s.previous ? (
                  <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink-3 dark:text-gray-400">
                    {t('survey.tree.previous', {
                      dbh: s.previous.stem_dead ? t('survey.tree.dead') : (s.previous.dbh_cm ?? '—'),
                      pom: s.previous.pom_m,
                      codes: s.previousCodes.join(' ') || '—',
                    })}
                  </Text>
                ) : null}
                {!amsOn && !firstCensus && s.stemNo != null ? (
                  <Checkbox checked={s.dead} onChange={(v) => patch({ dead: v })} label={t('survey.tree.stemDead')} />
                ) : null}
                {!form.same ? <CodeChips codes={stemCodes} selected={s.codes} onChange={(v) => patch({ codes: v })} labelOf={(k) => codeLabel(t, k)} /> : null}
                {codes.includes('P') ? (
                  <TextBox value={s.notes} onChange={(v) => patch({ notes: v })} accessibilityLabel={t('survey.tree.problemNote')} placeholder={t('survey.tree.problemNote')} />
                ) : null}
                {amsOn ? <AmsStemFields value={s.ams} onChange={(ams) => patch({ ams })} stemTag={stemTagOf(tag, no)} /> : null}
                {parts.lists.map((l) => {
                  const sel = s.custom[l.id] ?? [];
                  // A retired code shows only where it was recorded.
                  const offered = l.items.filter((x) => !x.deprecated || sel.includes(x.code)).map((x) => x.code);
                  const prev = s.previousCustom[l.id] ?? [];
                  const nameOf = (k: string) => labelText(t, lang, l.items.find((x) => x.code === k)?.label, k);
                  return (
                    <View key={l.id} className="gap-1">
                      <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{labelText(t, lang, l.label, l.id)}</Text>
                      <CodeChips codes={offered} selected={sel} named onChange={(v) => patch({ custom: { ...s.custom, [l.id]: v } })} labelOf={nameOf} />
                      {prev.length ? <Hint>{t('survey.tree.prevTreeCodes', { codes: prev.map((k) => `${k} ${nameOf(k)}`).join(t('builder.listSep')) })}</Hint> : null}
                    </View>
                  );
                })}
                {stemIssues.map((x) => (
                  <Text key={x.code} className={`text-xs ${x.severity === 'error' ? 'text-alert dark:text-alert-dark' : 'text-acorn-deep dark:text-acorn'}`}>
                    {issueText(t, x.code)}
                  </Text>
                ))}
              </View>
            );
          })}
          <Pressable
            onPress={() => {
              const key = `new-${Date.now()}`;
              set({ stems: [...form.stems, newStem(key)] });
            }}
            accessibilityRole="button"
            className="items-center justify-center rounded-xl border-[1.5px] border-dashed border-accent-300 active:opacity-70 dark:border-accent-700"
            style={{ height: 40 }}
          >
            <Text className="text-sm font-bold text-accent-600 dark:text-accent-400">
              {t('survey.tree.addStem', { tag: stemTagOf(tag, Math.max(0, ...numbers.values()) + 1) })}
            </Text>
          </Pressable>
          <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink-2 dark:text-gray-400">
            {t('survey.tree.size', { ba: Math.round(ba), count: form.stems.length })}
            {multi ? ` · ${t('survey.tree.multiM')}` : ''}
          </Text>
          {issues
            .filter((x) => x.stemNo == null)
            .map((x) => (
              <Problem key={x.code}>{issueText(t, x.code)}</Problem>
            ))}
        </FormCard>

        {/* Codes */}
        <FormCard
          title={t('survey.tree.codes')}
          right={
            <Pressable
              onPress={() => (form.same ? set({ same: false, stems: form.stems.map((s) => ({ ...s, codes: [...form.allCodes] })) }) : set({ same: true, allCodes: [...(form.stems[0]?.codes ?? [])] }))}
              accessibilityRole="switch"
              accessibilityState={{ checked: form.same }}
              className={`rounded-full border px-3 py-1.5 ${form.same ? 'border-accent-200 bg-accent-50 dark:border-accent-800 dark:bg-accent-950' : 'border-line bg-card dark:border-line-dark dark:bg-gray-900'}`}
            >
              <Text className={`text-xs font-bold ${form.same ? 'text-accent-700 dark:text-accent-300' : 'text-ink dark:text-gray-100'}`}>{form.same ? t('survey.tree.sameCodes') : t('survey.tree.perStem')}</Text>
            </Pressable>
          }
        >
          {form.same ? <CodeChips codes={stemCodes} selected={form.allCodes} onChange={(v) => set({ allCodes: v })} labelOf={(k) => codeLabel(t, k)} /> : null}
          <Hint>{t('survey.tree.codesHint')}</Hint>
        </FormCard>

        {parts.traits.map((comp) => (
          <FormCard key={comp.key} title={labelText(t, lang, comp.label as Label | undefined, t('survey.component.traits'))}>
            {comp.traits.map((tr) => {
              const name = labelText(t, lang, tr.label as Label | undefined, tr.id);
              const bad = traitProblems.find((x) => x.key === comp.key && x.id === tr.id);
              return (
                <Field key={tr.id} label={tr.unit ? `${name} (${tr.unit})` : name}>
                  <DraftNum
                    value={form.traits[comp.key]?.[tr.id] ?? ''}
                    onChange={(v) => setTrait(comp.key, tr.id, v)}
                    accessibilityLabel={name}
                    width="100%"
                    signed={tr.min == null || tr.min < 0}
                    invalid={!!bad}
                  />
                  {bad ? <Problem>{traitProblemText(comp.key, tr.id, bad.code)}</Problem> : null}
                </Field>
              );
            })}
          </FormCard>
        ))}

        <FormCard title={parts.photos ? t('survey.tree.photos') : undefined}>
          {!parts.photos ? null : individualId == null ? (
            <Hint>{t('survey.tree.photosAfterSave')}</Hint>
          ) : (
            <PhotoGrid
              photos={photos}
              onAdd={() => void captureEnvPhoto().then((u) => u && addPhotos([u])).catch((e) => toast(errText(e)))}
              onPickLibrary={() => void pickPhotos().then(addPhotos).catch((e) => toast(errText(e)))}
              onView={setViewing}
              onRemove={(uri) => {
                checkpoint();
                removeTreeMedia(surveyId, individualId, uri);
                setPhotos(listTreeMedia(surveyId, individualId).map((m) => m.uri));
              }}
            />
          )}
          <Field label={t('survey.tree.notes')}>
            <TextBox value={form.notes} onChange={(v) => set({ notes: v })} accessibilityLabel={t('survey.tree.notes')} multiline />
          </Field>
        </FormCard>
      </KeyboardAwareScrollView>

      {searching ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View className="border-t border-line bg-paper px-2 pt-2 dark:border-line-dark dark:bg-paper-dark">
            <View className="mb-1 flex-row items-center justify-between px-2">
              <Text className="text-sm font-bold text-ink dark:text-gray-100">{recruit ? t('survey.tree.pickSpecies') : t('survey.tree.correctSpecies')}</Text>
              <Pressable onPress={() => setSearching(false)} accessibilityRole="button" hitSlop={8}>
                <Text className="text-sm text-accent-600 dark:text-accent-400">{t('common.cancel')}</Text>
              </Pressable>
            </View>
            <SearchBox autoFocus afterSelect="dismiss" onSelect={(r, adopted) => r.taxon_id && void onSpecies(r.taxon_id, adopted?.scientific_name ?? null, adopted?.name_id)} />
          </View>
        </KeyboardStickyView>
      ) : (
        <View className="flex-row gap-2.5 border-t border-line bg-paper px-4 pb-2 pt-2.5 dark:border-line-dark dark:bg-paper-dark">
          <Button label={t('common.save')} variant="secondary" size="lg" onPress={() => save(false)} className="flex-1" />
          <Button label={t('survey.tree.saveNext')} size="lg" onPress={() => save(true)} className="flex-[1.6]" />
        </View>
      )}
      <NumAccessory />
      <PhotoViewerModal photos={photos} index={viewing} onClose={() => setViewing(null)} />
    </SafeAreaView>
  );
}
