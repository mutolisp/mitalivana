/**
 * One MIREN plot: species (blind recording) and plot data.
 *
 * Species: the search is docked at the bottom; a new species opens its cover
 * row, then abundance (big chips carrying the protocol's ranges). Trail plot
 * 1 (the optional 2×50 m plot) records presence only. No previous-survey
 * list is shown here — that is the blind rule; it appears on the recheck
 * screen once blind recording is closed (Road §2.5.3, §2.5.3.2).
 *
 * Plot data: road — tree cover (> 3 m), bare ground, litter in %, additional
 * data (≤ 50 characters, underscores); trail — habitat, disturbance and the
 * cover classes of (3) r–ac. Both: date (ISO), observers, position, protected
 * area, literature for status.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import { ScientificName } from '~/components/ScientificName';
import { SelectRow, SwitchRow } from '~/components/settings/rows';
import { showActionSheet } from '~/components/ActionSheet';
import { DateTimeField } from '~/components/DateTimeField';
import { errText } from '~/lib/errText';
import { isoDate } from '~/lib/datetime';
import { useToast } from '~/stores/toast';
import {
  addPlotSpecies,
  closeBlind,
  finishPlot,
  getPlot,
  getRegionStatus,
  listPlotSpecies,
  markPlotStarted,
  removePlotSpecies,
  reopenBlind,
  surveyContext,
  unfinishPlot,
  updatePlot,
  updatePlotSpecies,
  type MirenPlotSpeciesWithTaxon,
  type PlotPatch,
} from '~/modules/miren/db';
import { formatPlotCode } from '~/modules/miren/model/codes';
import { classLabel, plotMeasures, TRAIL_COVER } from '~/modules/miren/model/scales';
import { checkPlot, ADDITIONAL_DATA_MAX } from '~/modules/miren/model/validate';
import { plotState } from '~/modules/miren/model/survey';
import { templateStatus } from '~/modules/miren/model/status';
import { DISTURBANCE_TYPES, HABITATS, HERBIVORE_TYPES } from '~/modules/miren/model/vocab';
import { pickRegionName } from '~/modules/miren/morphoPick';
import { FieldRow, TextBlock, TextCommit } from '~/modules/miren/components/fields';
import { Banner, BannerText, Btn, Card, Label, NumAccessory, NumField, Seg } from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';
import { GLORIA_SEARCH_GROUPS } from '~/modules/gloria/useSurvey';
import { useThemeColors } from '~/theme/colors';
import { DoneMark } from '~/components/ui/DoneMark';

type Tab = 'species' | 'plot';

function ClassChips({
  scale,
  value,
  unit,
  onChange,
  disabled,
}: {
  scale: ReadonlyArray<{ value: number; label: string }>;
  value: number | null;
  unit: '%' | '';
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {scale.map((c) => {
        const on = c.value === value;
        return (
          <Pressable
            key={c.value}
            disabled={disabled}
            onPress={() => onChange(c.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled }}
            accessibilityLabel={classLabel(c, unit)}
            style={{ minWidth: 62, minHeight: 44 }}
            className={`items-center justify-center rounded-lg border px-2 ${on ? 'border-accent-600 bg-accent-600' : 'border-gray-300 bg-card dark:border-gray-700 dark:bg-gray-900'} ${disabled ? 'opacity-50' : ''}`}
          >
            <Text className={`text-base font-semibold ${on ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{c.value}</Text>
            <Text className={`text-[10px] ${on ? 'text-white/90' : 'text-gray-500 dark:text-gray-400'}`}>{`${c.label}${unit}`}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function MirenPlotScreen() {
  const tc = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [plot, setPlot] = useState(() => getPlot(id));
  const [species, setSpecies] = useState<MirenPlotSpeciesWithTaxon[]>(() => listPlotSpecies(id));
  const [tab, setTab] = useState<Tab>('species');
  const [openId, setOpenId] = useState<number | null>(null);
  const rootRef = useRef<View>(null);
  const [rootTop, setRootTop] = useState<number | undefined>(undefined);
  const reload = useCallback(() => {
    setPlot(getPlot(id));
    setSpecies(listPlotSpecies(id));
  }, [id]);
  useFocusEffect(reload);

  const ctx = plot ? surveyContext(plot.survey_id) : null;
  if (!plot || !ctx) {
    return <Text className="p-4 text-gray-500">{t('miren.notFound')}</Text>;
  }
  const { route, region, regionCode } = ctx;
  const code = formatPlotCode({ region: regionCode, route: route.code, site: plot.site_no, plot: plot.plot_no, suffix: plot.suffix });
  const measures = plotMeasures(route.kind, plot.plot_no);
  const state = plotState(plot);
  const finished = state === 'done';
  const sealed = plot.blind_closed_at != null;
  const canAdd = !!plot.sampled && !finished;
  const isRoad = route.kind === 'road';
  const issues = checkPlot(
    route.kind,
    {
      plotNo: plot.plot_no,
      sampled: !!plot.sampled,
      lat: plot.lat,
      lon: plot.lon,
      elev: plot.elev,
      date: plot.date,
      observers: plot.observers,
      treeCoverPct: plot.tree_cover_pct,
      bareGroundPct: plot.bare_ground_pct,
      litterPct: plot.litter_pct,
      additionalData: plot.additional_data,
    },
    species.map((s) => ({ coverClass: s.cover_class, abundanceClass: s.abundance_class })),
  );
  const incomplete = new Set(issues.flatMap((i) => (i.kind === 'species-incomplete' ? [species[i.index]?.id] : [])));

  const patch = (p: PlotPatch) => {
    markPlotStarted(plot.id);
    updatePlot(plot.id, p);
    reload();
  };
  const editable = (s: MirenPlotSpeciesWithTaxon) => !finished && (s.phase === 'recheck' || !sealed);

  const addTaxon = async (taxonId: string, rank: string | undefined, base: string) => {
    const label = await pickRegionName(region.id, regionCode, rank, base);
    if (label === undefined) return;
    const r = addPlotSpecies(plot.id, taxonId, label);
    if (!r.ok) {
      toast(t(r.error === 'finished' ? 'miren.plot.finishedToast' : 'miren.plot.notSampledToast'));
      return;
    }
    if (r.existed) toast(t('miren.plot.already', { name: label ?? base }));
    else if (measures.mode === 'cover-abundance') setOpenId(r.id);
    reload();
  };
  const speciesMenu = async (s: MirenPlotSpeciesWithTaxon) => {
    if (!editable(s)) {
      toast(t('miren.plot.sealedToast'));
      return;
    }
    const idx = await showActionSheet({
      title: s.verbatim_identification || s.simple_name || s.taxon_id,
      options: [{ label: t('common.remove'), destructive: true }],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) {
      removePlotSpecies(s.id);
      reload();
    }
  };
  const setValue = (s: MirenPlotSpeciesWithTaxon, key: 'cover_class' | 'abundance_class', v: number) => {
    if (!updatePlotSpecies(s.id, { [key]: v })) {
      toast(t('miren.plot.sealedToast'));
      return;
    }
    // Cover picked → abundance next; both set → close the row.
    const next = { ...s, [key]: v };
    if (next.cover_class != null && next.abundance_class != null) setOpenId(null);
    reload();
  };
  const endBlind = () =>
    Alert.alert(t('miren.plot.endBlindTitle'), t('miren.plot.endBlindMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('miren.plot.endBlind'),
        onPress: () => {
          closeBlind(plot.id);
          if (ctx.survey.prev_survey_id != null) router.push(`/miren/plot/${plot.id}/recheck` as Href);
          else if (finishPlot(plot.id)) toast(t('miren.plot.finished'));
          reload();
        },
      },
    ]);
  const undoBlind = () => {
    if (reopenBlind(plot.id)) reload();
    else Alert.alert(t('miren.plot.reopenBlindTitle'), t('miren.plot.reopenBlindRefused'));
  };
  const locate = async () => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
      return;
    }
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      patch({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        ...(pos.coords.altitude != null ? { elev: Math.round(pos.coords.altitude) } : {}),
      });
      toast(t('miren.plot.located', { acc: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : '?' }));
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };
  const clsOptions = [{ value: -1, label: t('miren.unset') }, ...TRAIL_COVER.map((c) => ({ value: c.value, label: classLabel(c) }))];
  const clsRow = (label: string, key: 'cls_bare_ground' | 'cls_bare_rock' | 'cls_vegetation' | 'cls_canopy' | 'cls_shrub' | 'cls_herb' | 'herbivore_rating' | 'trampling_rating', hint?: string) => (
    <View key={key} className="pt-1">
      <SelectRow variant="inline" label={label} description={hint} value={plot[key] ?? -1} options={clsOptions} onChange={(v) => patch({ [key]: v < 0 ? null : v })} />
    </View>
  );

  const speciesBody = () => (
    <>
      {species.length === 0 ? <Text className="text-sm text-gray-500 dark:text-gray-400">{t(canAdd ? 'miren.plot.emptyHint' : 'miren.plot.empty')}</Text> : null}
      {species.map((s, i) => {
        const status = getRegionStatus(region.id, { taxonId: s.taxon_id, verbatim: s.verbatim_identification })?.status ?? 'unknown';
        const open = openId === s.id && editable(s) && measures.mode === 'cover-abundance';
        const lockedRow = !editable(s);
        return (
          <Card key={s.id} className={`p-3 ${incomplete.has(s.id) ? 'border-amber-500' : ''}`}>
            <Pressable
              onPress={() => (measures.mode === 'cover-abundance' && editable(s) ? setOpenId(open ? null : s.id) : undefined)}
              onLongPress={() => void speciesMenu(s)}
              accessibilityRole="button"
              className="flex-row items-center gap-2"
            >
              <Text className="w-6 text-xs text-gray-400">{i + 1}</Text>
              <View className="flex-1">
                {s.verbatim_identification ? (
                  <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{s.verbatim_identification}</Text>
                ) : (
                  <ScientificName name={s.simple_name || s.taxon_id} rank={s.rank} className="text-sm font-semibold text-gray-900 dark:text-gray-100" />
                )}
                <Text className="text-xs text-gray-500 dark:text-gray-400">
                  {[s.common_name_c, s.family, templateStatus(status), s.phase === 'recheck' ? t('miren.plot.foundInRecheck') : null].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {measures.mode === 'presence' ? (
                <DoneMark />
              ) : (
                <Text className="font-mono text-xs text-gray-700 dark:text-gray-300">
                  {`C ${s.cover_class ?? '–'} · A ${s.abundance_class ?? '–'}`}
                </Text>
              )}
              {lockedRow ? <Ionicons name="lock-closed" size={14} color={tc.ink3} /> : null}
            </Pressable>
            {open && measures.mode === 'cover-abundance' ? (
              <View className="gap-2 pt-3">
                <Text className="text-xs text-gray-500">{t(isRoad ? 'miren.plot.coverRoad' : 'miren.plot.coverTrail')}</Text>
                <ClassChips scale={measures.cover} value={s.cover_class} unit="%" onChange={(v) => setValue(s, 'cover_class', v)} disabled={false} />
                <Text className="text-xs text-gray-500">{t('miren.plot.abundance')}</Text>
                <ClassChips scale={measures.abundance} value={s.abundance_class} unit="" onChange={(v) => setValue(s, 'abundance_class', v)} disabled={false} />
              </View>
            ) : null}
          </Card>
        );
      })}
    </>
  );

  const plotBody = () => (
    <>
      <Card className="gap-0.5 p-3">
        <SwitchRow
          label={t('miren.plot.sampled')}
          description={route.kind === 'trail' && plot.plot_no === 1 ? t('miren.plot.optionalPlot') : undefined}
          value={!!plot.sampled}
          onChange={(v) => {
            if (!v && species.length) {
              Alert.alert(t('miren.plot.sampled'), t('miren.plot.unsampleRefused'));
              return;
            }
            updatePlot(plot.id, { sampled: v ? 1 : 0 });
            reload();
          }}
        />
        {!plot.sampled ? (
          <FieldRow label={t('miren.plot.notSampledReason')}>
            <TextCommit value={plot.not_sampled_reason} onCommit={(v) => (updatePlot(plot.id, { not_sampled_reason: v }), reload())} accessibilityLabel={t('miren.plot.notSampledReason')} />
          </FieldRow>
        ) : null}
      </Card>
      {plot.sampled ? (
        <>
          <Card className="gap-1 p-3">
            <FieldRow label={t('miren.plot.date')} hint="YYYY-MM-DD">
              <View style={{ width: 160 }}>
                <DateTimeField mode="date" value={plot.date ? new Date(`${plot.date}T12:00:00`).getTime() : Date.now()} onChange={(ms) => patch({ date: isoDate(ms) })} />
              </View>
            </FieldRow>
            <FieldRow label={t('miren.plot.observers')}>
              <TextCommit value={plot.observers} onCommit={(v) => patch({ observers: v })} accessibilityLabel={t('miren.plot.observers')} />
            </FieldRow>
            <FieldRow label={t('miren.site.lat')}>
              <NumField value={plot.lat} onCommit={(v) => patch({ lat: v })} range={RANGES.latitude} signed width={130} accessibilityLabel={t('miren.site.lat')} />
            </FieldRow>
            <FieldRow label={t('miren.site.lon')}>
              <NumField value={plot.lon} onCommit={(v) => patch({ lon: v })} range={RANGES.longitude} signed width={130} accessibilityLabel={t('miren.site.lon')} />
            </FieldRow>
            <FieldRow label={t('miren.site.elev')}>
              <NumField value={plot.elev} onCommit={(v) => patch({ elev: v })} range={RANGES.elevation} width={100} accessibilityLabel={t('miren.site.elev')} />
            </FieldRow>
            <Btn small label={t('miren.plot.useGps')} onPress={() => void locate()} />
            <Text className="text-[11px] text-gray-500 dark:text-gray-400">{t(isRoad ? 'miren.plot.whereRoad' : 'miren.plot.whereTrail')}</Text>
          </Card>
          {isRoad ? (
            <Card className="gap-0.5 p-3">
              <FieldRow label={t('miren.plot.treeCover')} hint="Tree cover (> 3 m)">
                <NumField value={plot.tree_cover_pct} onCommit={(v) => patch({ tree_cover_pct: v })} range={RANGES.percent} width={80} accessibilityLabel={t('miren.plot.treeCover')} />
              </FieldRow>
              <FieldRow label={t('miren.plot.bareGround')} hint="Bare ground">
                <NumField value={plot.bare_ground_pct} onCommit={(v) => patch({ bare_ground_pct: v })} range={RANGES.percent} width={80} accessibilityLabel={t('miren.plot.bareGround')} />
              </FieldRow>
              <FieldRow label={t('miren.plot.litter')} hint="Litter">
                <NumField value={plot.litter_pct} onCommit={(v) => patch({ litter_pct: v })} range={RANGES.percent} width={80} accessibilityLabel={t('miren.plot.litter')} />
              </FieldRow>
              <FieldRow label={t('miren.plot.additional')} hint={t('miren.plot.additionalHint', { n: ADDITIONAL_DATA_MAX })}>
                <TextCommit
                  value={plot.additional_data}
                  onCommit={(v) => patch({ additional_data: v?.replace(/\s+/g, '_') ?? null })}
                  autoCapitalize="none"
                  maxLength={ADDITIONAL_DATA_MAX}
                  placeholder="grazing_cattle"
                  accessibilityLabel={t('miren.plot.additional')}
                />
              </FieldRow>
            </Card>
          ) : (
            <Card className="gap-0.5 p-3">
              <SelectRow
                variant="inline"
                label={t('miren.plot.habitat')}
                description="Habitat"
                value={plot.habitat ?? ''}
                options={[{ value: '', label: t('miren.unset') }, ...HABITATS.map((h) => ({ value: h, label: t(`miren.habitat.${h}`) }))]}
                onChange={(v) => patch({ habitat: v || null })}
              />
              <View className="pt-1">
                <SelectRow
                  variant="inline"
                  label={t('miren.plot.disturbance')}
                  description="Disturbance type"
                  value={plot.disturbance_type ?? ''}
                  options={[{ value: '', label: t('miren.unset') }, ...DISTURBANCE_TYPES.map((d) => ({ value: d, label: t(`miren.disturbance.${d}`) }))]}
                  onChange={(v) => patch({ disturbance_type: v || null })}
                />
              </View>
              <View className="pt-1">
                <SelectRow
                  variant="inline"
                  label={t('miren.plot.intensity')}
                  description="Disturbance intensity"
                  value={plot.disturbance_intensity ?? -1}
                  options={[
                    { value: -1, label: t('miren.unset') },
                    { value: 0, label: t('miren.plot.intensity0') },
                    { value: 1, label: t('miren.plot.intensity1') },
                    { value: 2, label: t('miren.plot.intensity2') },
                  ]}
                  onChange={(v) => patch({ disturbance_intensity: v < 0 ? null : v })}
                />
              </View>
              {clsRow(t('miren.plot.clsBareGround'), 'cls_bare_ground', 'Bare ground cover')}
              {clsRow(t('miren.plot.clsBareRock'), 'cls_bare_rock', 'Bare rock cover')}
              {clsRow(t('miren.plot.clsVegetation'), 'cls_vegetation', 'Vegetation cover')}
              {clsRow(t('miren.plot.clsCanopy'), 'cls_canopy', 'Forest canopy cover')}
              {clsRow(t('miren.plot.clsShrub'), 'cls_shrub', 'Shrub cover')}
              {clsRow(t('miren.plot.clsHerb'), 'cls_herb', 'Herb cover')}
              <SwitchRow label={t('miren.plot.riparian')} value={plot.riparian === 1} onChange={(v) => patch({ riparian: v ? 1 : 0 })} />
              <SwitchRow label={t('miren.plot.fenced')} value={plot.fenced === 1} onChange={(v) => patch({ fenced: v ? 1 : 0 })} />
              <Text className="pt-2 text-xs text-gray-500">{t('miren.plot.optional')}</Text>
              {clsRow(t('miren.plot.herbivoreRating'), 'herbivore_rating', 'Herbivore disturbance rating')}
              <View className="pt-1">
                <SelectRow
                  variant="inline"
                  label={t('miren.plot.herbivoreType')}
                  value={plot.herbivore_type ?? ''}
                  options={[{ value: '', label: t('miren.unset') }, ...HERBIVORE_TYPES.map((h) => ({ value: h, label: t(`miren.herbivoreType.${h}`) }))]}
                  onChange={(v) => patch({ herbivore_type: v || null })}
                />
              </View>
              {clsRow(t('miren.plot.tramplingRating'), 'trampling_rating', 'Trampling disturbance rating')}
              <FieldRow label={t('miren.plot.tramplingType')} hint="h, m, p, mu, o …">
                <TextCommit value={plot.trampling_type} onCommit={(v) => patch({ trampling_type: v })} width={100} autoCapitalize="none" accessibilityLabel={t('miren.plot.tramplingType')} />
              </FieldRow>
            </Card>
          )}
          <Card className="gap-0.5 p-3">
            <SwitchRow label={t('miren.plot.protected')} value={plot.protected_area === 1} onChange={(v) => patch({ protected_area: v ? 1 : 0 })} />
          </Card>
          <Label>{t('miren.plot.literature')}</Label>
          <TextBlock value={plot.literature} onCommit={(v) => patch({ literature: v })} placeholder={ctx.survey.literature ?? region.default_literature ?? undefined} accessibilityLabel={t('miren.plot.literature')} />
          <Label>{t('miren.plot.comments')}</Label>
          <TextBlock value={plot.comments} onCommit={(v) => patch({ comments: v })} accessibilityLabel={t('miren.plot.comments')} />
        </>
      ) : null}
    </>
  );

  return (
    <SafeAreaView
      ref={rootRef}
      onLayout={() => rootRef.current?.measureInWindow((_x, y) => setRootTop(y))}
      edges={['bottom']}
      className="flex-1 bg-gray-50 dark:bg-gray-950"
    >
      <Stack.Screen options={{ title: code }} />
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Banner tone={state === 'done' ? 'ok' : state === 'recheck' ? 'warn' : 'info'}>
          <BannerText tone={state === 'done' ? 'ok' : state === 'recheck' ? 'warn' : 'info'}>{t(`miren.plot.banner_${state}`)}</BannerText>
        </Banner>
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'species', label: t('miren.plot.tabSpecies', { n: species.length }) },
            { value: 'plot', label: t('miren.plot.tabPlot') },
          ]}
        />
        {tab === 'species' ? speciesBody() : plotBody()}
        {plot.sampled ? (
          <View className="gap-2 pt-2">
            {state === 'blind' || state === 'todo' ? <Btn primary label={t('miren.plot.endBlind')} onPress={endBlind} /> : null}
            {state === 'recheck' ? (
              <>
                <Btn primary label={t('miren.plot.toRecheck')} onPress={() => router.push(`/miren/plot/${plot.id}/recheck` as Href)} />
                <Btn label={t('miren.plot.reopenBlindTitle')} onPress={undoBlind} />
              </>
            ) : null}
            {finished ? <Btn label={t('miren.plot.unfinish')} onPress={() => (unfinishPlot(plot.id), reload())} /> : null}
          </View>
        ) : null}
      </ScrollView>
      {canAdd && tab === 'species' ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View>
            {sealed ? (
              <Text className="border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                {t('miren.plot.addingAfterBlind')}
              </Text>
            ) : null}
            <SearchBox
              scopeGroups={GLORIA_SEARCH_GROUPS}
              topLimit={rootTop}
              onSelect={(r) => {
                if (!r.taxon_id) return;
                void addTaxon(r.taxon_id, r.rank, r.name);
              }}
            />
          </View>
        </KeyboardStickyView>
      ) : null}
      <NumAccessory />
    </SafeAreaView>
  );
}
