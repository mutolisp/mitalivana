/**
 * One GLORIA unit: a 1×1 m quadrat (cover estimation, with entries to
 * frequency and point-framing), a summit area section (abundance), or a
 * 10×10 m square (entry to line-pointing, derived hits, additional species).
 *
 * The species list gets the room; plot environment (aspect, slope, top
 * cover) folds away. Species are added from the docked search box.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import { showActionSheet } from '~/components/ActionSheet';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import {
  addUnitSpecies,
  markUnitStarted,
  removeUnitSpecies,
  updateUnit,
  updateUnitSpecies,
  type GloriaUnit,
  type UnitPatch,
} from '~/modules/gloria/db';
import { popcount, surfaceHits, visitedCount, SURFACE_CODES } from '~/modules/gloria/model/grid';
import { coverFromHits, WALK_OPTIONS, type WalkOption } from '~/modules/gloria/model/walk';
import { quadratsOf, unitTypeOf, type Direction } from '~/modules/gloria/model/units';
import { exactSum, speciesCoverSum, vascularCoverOk } from '~/modules/gloria/model/validate';
import { issueText } from '~/modules/gloria/issues';
import { displayName, toUnitSpecies, useSurvey, type SurveySpecies } from '~/modules/gloria/useSurvey';
import { OverviewPanel } from '~/modules/gloria/components/OverviewPanel';
import { SubtypeFields, TopCoverFields, topSum } from '~/modules/gloria/components/CoverFields';
import { SurveyTimes } from '~/modules/gloria/components/SurveyTimes';
import { Banner, BannerText, Btn, Card, FoldBanner, NumAccessory, NumField, PassBanner } from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';

const ABUNDANCE = ['r!', 'r', 's', 'c', 'd'] as const;
const CF_CYCLE: Array<'g' | 's' | 't' | null> = [null, 'g', 's', 't'];

export default function GloriaUnitScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; code: string }>();
  const id = Number(params.id);
  const code = String(params.code);
  const type = unitTypeOf(code);
  const { state, reload } = useSurvey(id);
  const [panel, setPanel] = useState(false);
  const [envOpen, setEnvOpen] = useState<boolean | null>(null);
  const [subOpen, setSubOpen] = useState(false);

  const unit = state?.unit(code);
  if (!state || !unit || !type) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: code, headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const active = state.survey.status === 'active';
  const spp = [...state.speciesOf(code)].sort((a, b) => a.serial - b.serial);
  const issues = state.issues.filter((i) => i.unit === code);
  const dir = code[0] as Direction;

  const patch = (p: UnitPatch) => {
    markUnitStarted(unit.id);
    updateUnit(unit.id, p);
    reload();
  };
  const addTaxon = (taxonId: string, name?: string) => {
    markUnitStarted(unit.id);
    addUnitSpecies(unit.id, taxonId);
    reload();
    if (name) toast(t('gloria.unit.added', { name }));
  };
  const speciesMenu = async (s: SurveySpecies) => {
    const idx = await showActionSheet({
      title: displayName(s),
      options: [{ label: t('gloria.unit.openDetail') }, { label: t('gloria.unit.remove'), destructive: true }],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) router.push(`/gloria/${id}/${code}/species/${s.id}` as Href);
    if (idx === 1) {
      removeUnitSpecies(s.id);
      reload();
    }
  };
  const toggleDone = () => {
    updateUnit(unit.id, { stop_ts: unit.stop_ts == null ? Date.now() : null });
    reload();
  };
  const title = `${code} · ${type === 'quadrat' ? '1×1 m' : type === 'sas' ? 'SAS' : '10×10 m'}`;

  // ── species row (quadrat / SAS / square share the shell) ───────────────
  const speciesRow = (s: SurveySpecies, i: number, right: React.ReactNode) => (
    <View key={s.id} className={`flex-row items-center px-3 py-2 ${i ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}>
      <Pressable
        className="flex-1 pr-2"
        onPress={() => router.push(`/gloria/${id}/${code}/species/${s.id}` as Href)}
        onLongPress={() => void speciesMenu(s)}
        accessibilityHint={t('gloria.unit.rowHint')}
      >
        <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100" numberOfLines={1}>{displayName(s)}</Text>
        <Text className="text-xs italic text-gray-500 dark:text-gray-400" numberOfLines={1}>{s.simple_name}</Text>
      </Pressable>
      {right}
      <Ionicons name="chevron-forward" size={14} color="#9ca3af" />
    </View>
  );

  const cfButton = (s: SurveySpecies) => (
    <Pressable
      onPress={() => {
        const next = CF_CYCLE[(CF_CYCLE.indexOf(s.cf) + 1) % CF_CYCLE.length];
        updateUnitSpecies(s.id, { cf: next });
        reload();
      }}
      accessibilityLabel={t('gloria.unit.cf')}
      className={`ml-1.5 w-8 items-center rounded-md border py-1 ${s.cf ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40' : 'border-gray-300 dark:border-gray-700'}`}
    >
      <Text className={`text-[11px] ${s.cf ? 'font-bold text-amber-700 dark:text-amber-300' : 'text-gray-400'}`}>{s.cf ?? 'cf'}</Text>
    </Pressable>
  );

  const envSummary = (u: GloriaUnit) => {
    const sum = topSum(u);
    return [
      u.aspect_deg != null ? t('gloria.unit.aspectShort', { v: u.aspect_deg }) : null,
      u.slope_deg != null ? t('gloria.unit.slopeShort', { v: u.slope_deg }) : null,
      sum != null ? t('gloria.unit.topSumShort', { sum }) : t('gloria.unit.topNotYet'),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const envIsOpen = envOpen ?? topSum(unit) == null;

  // ── quadrat ────────────────────────────────────────────────────────────
  const quadratBody = () => {
    const us = spp.map(toUnitSpecies);
    const vOk = vascularCoverOk(
      { vascular: unit.cov_vascular, solidRock: null, scree: null, lichens: null, bryophytes: null, bareGround: null, litter: null },
      us,
    );
    const sum = exactSum(speciesCoverSum(us));
    const freqN = spp.filter((s) => s.freq_cells != null || s.freq_count != null).length;
    const freqKey = unit.freq_mode === 'count' ? 'gloria.step.freqCounted' : 'gloria.step.freqDone';
    const cross = issues.filter((i) => i.kind === 'cover-no-freq' || i.kind === 'freq-no-cover');
    return (
      <>
        <Card>
          <Pressable onPress={() => setEnvOpen(!envIsOpen)} className="flex-row items-center px-3 py-2.5">
            <View className="flex-1">
              <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('gloria.unit.env')}</Text>
              <Text className="text-xs text-gray-500 dark:text-gray-400">{envSummary(unit)}</Text>
            </View>
            <Ionicons name={envIsOpen ? 'chevron-down' : 'chevron-forward'} size={16} color="#9ca3af" />
          </Pressable>
          {envIsOpen ? (
            <View className="gap-2 px-3 pb-3">
              <View className="flex-row gap-4">
                <View className="flex-row items-center gap-2">
                  <Text className="text-xs text-gray-700 dark:text-gray-300">{t('gloria.unit.aspect')}</Text>
                  <NumField value={unit.aspect_deg} onCommit={(v) => patch({ aspect_deg: v })} range={RANGES.aspect} accessibilityLabel={t('gloria.unit.aspect')} width={56} />
                </View>
                <View className="flex-row items-center gap-2">
                  <Text className="text-xs text-gray-700 dark:text-gray-300">{t('gloria.unit.slope')}</Text>
                  <NumField value={unit.slope_deg} onCommit={(v) => patch({ slope_deg: v })} range={RANGES.slope} accessibilityLabel={t('gloria.unit.slope')} width={56} />
                </View>
              </View>
              <TopCoverFields unit={unit} onCommit={patch} />
              <Pressable onPress={() => setSubOpen(!subOpen)} className="flex-row items-center">
                <Ionicons name={subOpen ? 'chevron-down' : 'chevron-forward'} size={14} color="#9ca3af" />
                <Text className="ml-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{t('gloria.unit.subtypes')}</Text>
              </Pressable>
              {subOpen ? <SubtypeFields unit={unit} onCommit={patch} /> : null}
            </View>
          ) : null}
        </Card>

        {vOk === false ? (
          <FoldBanner tone="error" title={t('gloria.issue.vascularExceeds', { vascular: unit.cov_vascular, sum })}>
            <BannerText tone="error">{t('gloria.unit.vascularHint')}</BannerText>
          </FoldBanner>
        ) : vOk === true ? (
          <PassBanner text={t('gloria.unit.vascularOk', { vascular: unit.cov_vascular, sum })} />
        ) : null}
        {cross.length ? (
          <FoldBanner tone="error" title={t('gloria.unit.crossTitle')} count={cross.length}>
            {cross.map((i, k) => (
              <BannerText key={k} tone="error">{issueText(t, i)}</BannerText>
            ))}
          </FoldBanner>
        ) : null}

        <View className="flex-row gap-2">
          <View className="flex-1">
            <Btn label={`${t('gloria.step.frequency')} · ${freqN ? t(freqKey, { count: freqN }) : t('gloria.step.notStarted')}`} onPress={() => router.push(`/gloria/${id}/${code}/frequency` as Href)} />
          </View>
          <View className="flex-1">
            <Btn label={`${t('gloria.step.pointframe')} · ${unit.point_surface ? `${visitedCount(unit.point_surface)}/100` : t('gloria.step.notStarted')}`} onPress={() => router.push(`/gloria/${id}/${code}/points` as Href)} />
          </View>
        </View>

        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">
          {t('gloria.unit.speciesHeader', { count: spp.length, sum })}
        </Text>
        <Card>
          {spp.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">{t('gloria.unit.noSpecies')}</Text>
          ) : (
            spp.map((s, i) =>
              speciesRow(
                s,
                i,
                <>
                  <NumField
                    value={s.cover_pct}
                    onCommit={(v) => {
                      updateUnitSpecies(s.id, { cover_pct: v });
                      reload();
                    }}
                    range={RANGES.percent}
                    width={76}
                    accessibilityLabel={t('gloria.unit.coverOf', { name: displayName(s) })}
                  />
                  {cfButton(s)}
                </>,
              ),
            )
          )}
        </Card>
        <Text className="text-xs text-gray-400">{t('gloria.unit.coverRule')}</Text>
      </>
    );
  };

  // ── summit area section ────────────────────────────────────────────────
  const sasBody = () => {
    const missing = issues.find((i) => i.kind === 'sas-missing');
    const missingTaxa = () => {
      const inSas = new Set(spp.map((s) => s.taxon_id));
      const out = new Map<string, string>();
      for (const q of quadratsOf(dir)) for (const s of state.speciesOf(q)) if (!inSas.has(s.taxon_id)) out.set(s.taxon_id, displayName(s));
      return out;
    };
    return (
      <>
        {missing ? (
          <FoldBanner tone="warn" title={t('gloria.unit.sasMissingTitle', { direction: dir })}>
            <BannerText tone="warn">{issueText(t, missing)}</BannerText>
            <View className="mt-1.5 flex-row">
              <Btn
                small
                label={t('gloria.unit.addAll')}
                onPress={() => {
                  for (const tid of missingTaxa().keys()) addUnitSpecies(unit.id, tid);
                  markUnitStarted(unit.id);
                  reload();
                }}
              />
            </View>
          </FoldBanner>
        ) : null}
        <Card>
          <Pressable onPress={() => setEnvOpen(!envIsOpen)} className="flex-row items-center px-3 py-2.5">
            <View className="flex-1">
              <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('gloria.cover.title')}</Text>
              <Text className="text-xs text-gray-500 dark:text-gray-400">{envSummary(unit)}</Text>
            </View>
            <Ionicons name={envIsOpen ? 'chevron-down' : 'chevron-forward'} size={16} color="#9ca3af" />
          </Pressable>
          {envIsOpen ? (
            <View className="px-3 pb-3">
              <TopCoverFields unit={unit} onCommit={patch} />
            </View>
          ) : null}
        </Card>
        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.unit.sasHeader', { count: spp.length })}</Text>
        <Card>
          {spp.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">{t('gloria.unit.noSpecies')}</Text>
          ) : (
            spp.map((s, i) =>
              speciesRow(
                s,
                i,
                <View className="flex-row">
                  {ABUNDANCE.map((a) => (
                    <Pressable
                      key={a}
                      onPress={() => {
                        updateUnitSpecies(s.id, { abundance: s.abundance === a ? null : a });
                        reload();
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: s.abundance === a }}
                      className={`ml-1 w-7 items-center rounded-md border py-1 ${s.abundance === a ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'}`}
                    >
                      <Text className={`text-[11px] ${s.abundance === a ? 'font-bold text-white' : 'text-gray-600 dark:text-gray-300'}`}>{a}</Text>
                    </Pressable>
                  ))}
                </View>,
              ),
            )
          )}
        </Card>
        <Text className="text-xs text-gray-400">{t('gloria.unit.abundanceLegend')}</Text>
        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.unit.grazing')}</Text>
        <TextInput
          defaultValue={unit.grazing_note ?? ''}
          onEndEditing={(e) => patch({ grazing_note: e.nativeEvent.text.trim() || null })}
          placeholder={t('gloria.unit.grazingPlaceholder')}
          multiline
          className="min-h-[64px] rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          placeholderTextColor="#9ca3af"
        />
      </>
    );
  };

  // ── 10×10 m square ─────────────────────────────────────────────────────
  const squareBody = () => {
    const visited = visitedCount(unit.point_surface);
    const hits = surfaceHits(unit.point_surface);
    const withHits = spp.map((s) => ({ s, n: s.point_hits != null ? popcount(s.point_hits) : (s.legacy_hits ?? 0) }));
    const hit = withHits.filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const extra = withHits.filter((x) => x.n === 0);
    const fromQuadrats = () => {
      const have = new Set(spp.map((s) => s.taxon_id));
      let n = 0;
      for (const q of quadratsOf(dir)) {
        for (const s of state.speciesOf(q)) {
          if (have.has(s.taxon_id)) continue;
          have.add(s.taxon_id);
          addUnitSpecies(unit.id, s.taxon_id);
          n++;
        }
      }
      markUnitStarted(unit.id);
      reload();
      toast(t('gloria.unit.fromQuadratsDone', { count: n }));
    };
    return (
      <>
        <Card className="gap-2 p-3">
          <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.square.walk')}</Text>
          <View className="flex-row flex-wrap">
            {WALK_OPTIONS.map((o) => (
              <Pressable
                key={o}
                onPress={() => patch({ walk_option: o as WalkOption })}
                className={`mb-1.5 mr-1.5 rounded-lg border px-2.5 py-1.5 ${unit.walk_option === o ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'}`}
              >
                <Text className={`text-xs ${unit.walk_option === o ? 'font-semibold text-white' : 'text-gray-700 dark:text-gray-300'}`}>
                  {t(`gloria.square.option${o}`)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Btn
            primary
            label={t('gloria.square.start', { done: visited })}
            disabled={unit.walk_option == null}
            onPress={() => router.push(`/gloria/${id}/${code}/points` as Href)}
          />
          {unit.walk_option == null ? <Text className="text-xs text-gray-400">{t('gloria.square.pickWalk')}</Text> : null}
        </Card>
        {visited > 0 ? (
          <Card className="p-3">
            <Text className="mb-1 text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.square.hitsTitle', { done: visited })}</Text>
            {hit.map(({ s, n }) => (
              <View key={s.id} className="flex-row py-0.5">
                <Text className="flex-1 text-xs text-gray-900 dark:text-gray-100">{displayName(s)}</Text>
                <Text className="w-14 text-right text-xs text-gray-700 dark:text-gray-300" style={{ fontVariant: ['tabular-nums'] }}>{n}</Text>
                <Text className="w-16 text-right text-xs text-gray-500" style={{ fontVariant: ['tabular-nums'] }}>{coverFromHits(n, 400).toFixed(2)}%</Text>
              </View>
            ))}
            <Text className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {SURFACE_CODES.map((c) => `${t(`gloria.surface.${c}`)} ${hits[c]}`).join(' · ')}
            </Text>
          </Card>
        ) : null}
        <View className="flex-row items-center">
          <Text className="flex-1 text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.square.extra', { count: extra.length })}</Text>
          <Btn small label={t('gloria.square.fromQuadrats')} onPress={fromQuadrats} />
        </View>
        <Card>
          {extra.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">{t('gloria.square.extraEmpty')}</Text>
          ) : (
            extra.map(({ s }, i) => speciesRow(s, i, null))
          )}
        </Card>
      </>
    );
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title,
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <HeaderIconButton icon="grid-outline" label={t('gloria.overview')} onPress={() => setPanel(true)} />
              <HeaderIconButton
                icon={unit.stop_ts != null ? 'checkmark-circle' : 'checkmark-circle-outline'}
                label={unit.stop_ts != null ? t('gloria.unit.markUndone') : t('gloria.unit.markDone')}
                onPress={toggleDone}
              />
            </View>
          ),
        }}
      />
      <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {type === 'quadrat' ? quadratBody() : type === 'sas' ? sasBody() : squareBody()}
        <SurveyTimes unit={unit} surveyBy={state.survey.recorded_by} reload={reload} />
      </ScrollView>
      {active ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <SearchBox onSelect={(r) => r.taxon_id && addTaxon(r.taxon_id, r.cname || r.name)} />
        </KeyboardStickyView>
      ) : null}
      <NumAccessory />
      {panel ? (
        <OverviewPanel state={state} code={code} current={type === 'square' ? 'cover' : type === 'sas' ? 'sas' : 'cover'} onClose={() => setPanel(false)} />
      ) : null}
    </SafeAreaView>
  );
}
