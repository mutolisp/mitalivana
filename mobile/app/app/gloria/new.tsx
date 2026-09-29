/**
 * New GLORIA survey (03-screens-flow.md §4d, design 06): pick a summit, see
 * what this cycle carries over, start. The survey itself is created by
 * startGloriaAndOpen, which runs the single-active guard.
 *
 * Adding a summit is its own full-screen page (/gloria/summit-new): it has a
 * keyboard, and a form unfolded in this list pushed the summary and the start
 * button off screen. The saved summit comes back through useSummitPick.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { defaultSurveyorString } from '~/db/surveyors';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { Button } from '~/components/ui/Button';
import { Chip } from '~/components/ui/Chip';
import { ContextChip } from '~/components/ui/ContextChip';
import { Tag } from '~/components/ui/Tag';
import { startGloriaAndOpen } from '~/lib/recordCreate';
import { errText } from '~/lib/errText';
import { startSummitImport } from '~/modules/gloria/summitImportFile';
import { listSummits, prefillSummary, type SummitWithLast } from '~/modules/gloria/db';
import { useSummitPick } from '~/modules/gloria/store';
import { useThemeColors } from '~/theme/colors';
import { SelectMark } from '~/components/ui/SelectMark';
import { DoneMark } from '~/components/ui/DoneMark';

/** Region chips are keyed by country too: TW-DAS and JP-DAS are different places. */
const regionKey = (s: Pick<SummitWithLast, 'country' | 'target_region'>) => `${s.country}-${s.target_region}`;

export default function NewGloriaScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const [summits, setSummits] = useState<SummitWithLast[]>(() => listSummits());
  const [picked, setPicked] = useState<number | null>(summits[0]?.id ?? null);
  const [region, setRegion] = useState<string | null>(null);

  // Scroll a newly saved summit into view once its card has laid out.
  const scrollRef = useRef<ScrollView>(null);
  const listY = useRef(0);
  const [scrollTo, setScrollTo] = useState<number | null>(null);

  // Back from the import review or the new-summit page: show what was added.
  useFocusEffect(
    useCallback(() => {
      const list = listSummits();
      setSummits(list);
      const added = useSummitPick.getState().take();
      const hit = added != null ? list.find((s) => s.id === added) : undefined;
      if (hit) {
        setPicked(hit.id);
        // Keep the filter unless it would hide the new summit.
        setRegion((r) => (r == null || r === regionKey(hit) ? r : null));
        setScrollTo(hit.id);
      } else {
        setPicked((p) => (p != null && list.some((s) => s.id === p) ? p : (list[0]?.id ?? null)));
      }
    }, []),
  );
  const runImport = () =>
    void startSummitImport(
      () => router.push('/gloria/summit-import' as Href),
      (e) => Alert.alert(t('gloria.summitImport.readFail'), errText(e)),
    );

  const regions = useMemo(() => [...new Set(summits.map(regionKey))], [summits]);
  const shown = region == null ? summits : summits.filter((s) => regionKey(s) === region);
  const pickedSummit = summits.find((s) => s.id === picked) ?? null;
  const summary = picked != null ? prefillSummary(picked) : null;
  // Starts from the default surveyors (設定 → 調查者); the picker changes it for this survey.
  const [surveyors, setSurveyors] = useState<string | null>(() => defaultSurveyorString());
  const [pickingSurveyors, setPickingSurveyors] = useState(false);

  const openNewSummit = () => {
    // The filtered region is the new summit's default region.
    const [country, target] = region ? region.split('-') : [];
    const q = target ? `?country=${country}&region=${target}` : '';
    router.push(`/gloria/summit-new${q}` as Href);
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <ScrollView ref={scrollRef} contentContainerClassName="gap-3 p-4">
        <Text className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400" style={{ letterSpacing: 0.96 }}>
          {t('gloria.new.stepPick')}
        </Text>

        {regions.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
            <Chip label={t('gloria.new.allRegions')} selected={region == null} onPress={() => setRegion(null)} />
            {regions.map((r) => (
              <Chip
                key={r}
                label={r}
                count={summits.filter((s) => regionKey(s) === r).length}
                selected={region === r}
                onPress={() => setRegion(r)}
              />
            ))}
          </ScrollView>
        ) : null}

        {summits.length === 0 ? (
          <Text className="text-sm text-gray-600 dark:text-gray-300">{t('gloria.new.noSummits')}</Text>
        ) : null}

        <View className="gap-2" onLayout={(e) => (listY.current = e.nativeEvent.layout.y)}>
          {shown.map((s) => (
            <SummitCard
              key={s.id}
              summit={s}
              selected={picked === s.id}
              onPress={() => setPicked(s.id)}
              onLayout={(y) => {
                if (scrollTo !== s.id) return;
                setScrollTo(null);
                scrollRef.current?.scrollTo({ y: Math.max(0, listY.current + y - 16), animated: true });
              }}
            />
          ))}
        </View>

        <View className="flex-row gap-2">
          <Pressable
            onPress={openNewSummit}
            accessibilityRole="button"
            accessibilityLabel={t('gloria.new.addSummit')}
            className="flex-1 flex-row items-center justify-center rounded-full border-[1.5px] border-dashed border-gray-400 active:bg-gray-100 dark:border-gray-500 dark:active:bg-gray-800"
            style={{ minHeight: 48 }}
          >
            <Ionicons name="add" size={18} color={c.accent} />
            <Text className="ml-1 text-sm font-bold text-accent-600 dark:text-accent-400">{t('gloria.new.addSummit')}</Text>
          </Pressable>
          <Button
            label={t('gloria.summitImport.button')}
            variant="secondary"
            size="lg"
            icon="download-outline"
            onPress={runImport}
            className="flex-1"
          />
        </View>

        {summary && pickedSummit ? (
          <>
            <Text className="mt-3 text-xs font-bold uppercase text-gray-500 dark:text-gray-400" style={{ letterSpacing: 0.96 }}>
              {t('gloria.new.stepSurvey')}
            </Text>
            <View className="gap-3 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
              <View className="flex-row items-start">
                <View className="flex-1">
                  <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.new.cycle')}</Text>
                  <Text className="text-3xl font-bold text-ink dark:text-gray-100">{`mocy ${summary.mocy}`}</Text>
                </View>
                <Text className="font-mono text-sm font-bold text-gray-600 dark:text-gray-300">{pickedSummit.full_code}</Text>
              </View>
              {summary.fromMocy != null ? (
                <View className="gap-2">
                  <CheckLine done text={t('gloria.new.carryPoints', { from: summary.fromMocy, points: summary.points })} />
                  <CheckLine done text={t('gloria.new.carryPlot')} />
                  <CheckLine done={false} text={t('gloria.new.carryBlind')} />
                </View>
              ) : (
                <View className="rounded-xl bg-acorn-tint px-3 py-2.5 dark:bg-gray-800">
                  <Text className="text-sm text-acorn-deep dark:text-acorn">{t('gloria.new.noCarryOver')}</Text>
                </View>
              )}
              <View className="flex-row">
                <ContextChip
                  icon="people-outline"
                  label={surveyors || t('session.surveyorUnset')}
                  set={!!surveyors}
                  onPress={() => setPickingSurveyors(true)}
                />
              </View>
            </View>
          </>
        ) : null}
        <SurveyorAssignSheet
          visible={pickingSurveyors}
          current={surveyors ?? ''}
          onCancel={() => setPickingSurveyors(false)}
          onAssign={(v) => {
            setPickingSurveyors(false);
            setSurveyors(v.trim() || null);
          }}
        />
      </ScrollView>
      <View className="border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
        <Button
          size="lg"
          fullWidth
          label={
            pickedSummit && summary
              ? t('gloria.new.startWith', { code: pickedSummit.full_code, mocy: summary.mocy })
              : t('gloria.new.start')
          }
          disabled={picked == null}
          onPress={() => picked != null && void startGloriaAndOpen(picked, surveyors)}
        />
      </View>
    </SafeAreaView>
  );
}

/** One summit, design 06: the code with the part that differs in ink. */
function SummitCard({
  summit: s,
  selected,
  onPress,
  onLayout,
}: {
  summit: SummitWithLast;
  selected: boolean;
  onPress: () => void;
  onLayout: (y: number) => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const detail = [s.name, s.elevation_m != null ? `${s.elevation_m} m` : null].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={onPress}
      onLayout={(e) => onLayout(e.nativeEvent.layout.y)}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={s.full_code}
      className={`flex-row items-center rounded-card px-4 py-3 ${
        selected
          ? 'border-[1.5px] border-accent-600 bg-accent-50 dark:border-accent-400 dark:bg-accent-950'
          : 'border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800'
      }`}
      style={{ minHeight: 72 }}
    >
      <View className="flex-1 gap-1">
        <Text className="font-mono text-lg font-bold">
          <Text className="text-gray-500 dark:text-gray-400">{`${s.country}-${s.target_region}-`}</Text>
          <Text className="text-ink dark:text-gray-100">{s.summit}</Text>
        </Text>
        {detail ? <Text className="text-sm text-gray-600 dark:text-gray-300">{detail}</Text> : null}
        <View className="flex-row flex-wrap gap-1.5">
          {s.veg_zone ? <Tag kind="neutral" label={s.veg_zone} /> : null}
          {s.last_mocy != null ? (
            <Tag kind="neutral" label={t('gloria.new.lastMocy', { mocy: s.last_mocy })} />
          ) : (
            <Tag kind="acorn" label={t('gloria.new.firstSurvey')} />
          )}
        </View>
      </View>
      {selected ? (
        <SelectMark state="on" />
      ) : (
        <SelectMark state="off" />
      )}
    </Pressable>
  );
}

/** A carry-over line: moss tick for what comes over, dashed circle for what never does. */
function CheckLine({ done, text }: { done: boolean; text: string }) {
  const c = useThemeColors();
  return (
    <View className="flex-row items-start">
      {done ? (
        <DoneMark />
      ) : (
        <View className="mt-0.5 h-[18px] w-[18px] rounded-full border-[1.5px] border-dashed border-gray-400 dark:border-gray-500" style={{ marginHorizontal: 1 }} />
      )}
      <Text className="ml-2 flex-1 text-sm text-ink dark:text-gray-100">{text}</Text>
    </View>
  );
}
