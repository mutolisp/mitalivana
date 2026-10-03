/**
 * A census (designs 13a / 13b; docs/ForestGEO/Stem_mapping.md "回合主畫面"):
 * progress, the quadrat being walked, and its trees as a list or a stem map.
 *
 * - Progress leaves out trees dead or not recorded last census: they are
 *   listed (they may have resprouted, Condit 1998 p.87) but are not work.
 * - Trees are listed in walking order; problems are known per quadrat.
 * - Wide windows (tablets, iPad split view at full width) put the tree form
 *   beside the list / map instead of pushing it (Modular_survey.md §7.6).
 */
import { Ionicons } from '@expo/vector-icons';
import { usePreventRemove } from '@react-navigation/native';
import { Stack, useFocusEffect, useLocalSearchParams, useNavigation, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { LineTabs } from '~/components/form/Segmented';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { promptText } from '~/components/TextPromptModal';
import { Button } from '~/components/ui/Button';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { chipText } from '~/survey/components/labels';
import { StemMap, type MapMode } from '~/survey/components/StemMap';
import { TreeEditor } from '~/survey/components/TreeEditor';
import { censusSeriesCode, finishCensus, reopenCensus, setFgQuadratRecorder, setFgQuadratStatus, updateCensus } from '~/survey/db/stemmap';
import { changedQuadratIds, quadratRowId } from '~/survey/db/censusVersions';
import { saveVersionSoon } from '~/db/recordVersions';
import { canUndo, checkpointQuadrats, clearCensusUndo, redoQuadrat, undoQuadrat, useQuadratUndo } from '~/survey/undo';
import { formatBytes } from '~/lib/exportSize';
import { mergeSummary } from '~/lib/mergeSummaryText';
import { pickSyncTeam } from '~/lib/teamPickPrompt';
import { hasSecret, linkedTeams, listTeams, teamServerLabel } from '~/lib/teamSync';
import { teamSyncErrorText } from '~/lib/teamSyncText';
import { syncCensus, type BlockSizeOption } from '~/survey/censusSync';
import { getTagRollStart, setTagRollStart } from '~/survey/tagRoll';
import { isOpenWork, type TreeChip } from '~/survey/stemmap/review';
import { allQuadratCodes, loadQuadratRows, useCensus, type TreeRowData } from '~/survey/useCensus';
import { useThemeColors } from '~/theme/colors';

type Filter = 'all' | 'todo' | 'fresh' | 'warn' | 'pending';
type Tab = 'list' | 'map';
/** Window width from which the tree form sits beside the list. */
const SPLIT_MIN_WIDTH = 768;

/** The quadrat last open in each census, for coming back to it. */
const lastQuadrat = new Map<number, string>();

const CHIP_LOOK: Record<TreeChip, string> = {
  warn: 'bg-alert-tint text-alert dark:bg-alert-dark-tint dark:text-alert-dark',
  pending: 'bg-acorn-tint text-acorn-deep dark:bg-gray-800 dark:text-acorn',
  fresh: 'bg-acorn-tint text-acorn-deep dark:bg-gray-800 dark:text-acorn',
  dead: 'bg-disc text-ink dark:bg-disc-dark dark:text-gray-200',
  done: 'bg-accent-tint text-accent-800 dark:bg-accent-950 dark:text-accent-300',
  partial: 'bg-gray-100 text-ink-2 dark:bg-gray-800 dark:text-gray-300',
  prevDead: 'bg-disc text-ink dark:bg-disc-dark dark:text-gray-200',
  prevMissing: 'bg-disc text-ink dark:bg-disc-dark dark:text-gray-200',
  todo: 'bg-gray-100 text-ink-2 dark:bg-gray-800 dark:text-gray-300',
};

function dbhLine(r: TreeRowData, stemsWord: (n: number) => string): string {
  const stems = r.view.stems;
  const fmt = (v: number | null | undefined) => (v == null ? '—' : String(v));
  if (stems.length === 1) {
    const s = stems[0];
    const prev = s.previous?.dbh_cm;
    const cur = s.measure?.dbh_cm;
    if (prev != null && cur != null) return `${prev} → ${cur}`;
    return fmt(cur ?? prev);
  }
  return `${stemsWord(stems.length)} · ${stems.map((s) => fmt(s.measure?.dbh_cm ?? s.previous?.dbh_cm)).join(' · ')}`;
}

export default function CensusScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const navigation = useNavigation();
  const toast = useToast((s) => s.show);
  const surveyId = Number(useLocalSearchParams<{ id: string }>().id);
  const { data, reload } = useCensus(surveyId);
  const wide = useWindowDimensions().width >= SPLIT_MIN_WIDTH;
  const codes = useMemo(() => (data ? allQuadratCodes(data.geometry) : []), [data]);

  const firstOpen = () => {
    if (!data) return '0000';
    const open = data.states.find((s) => !s.done && s.prev !== 'dead' && s.prev !== 'missing');
    return open?.quadratCode ?? codes[0] ?? '0000';
  };
  const [quadrat, setQuadratState] = useState<string>(() => lastQuadrat.get(surveyId) ?? firstOpen());
  /** A version of a quadrat that holds data (Modular_survey.md §7.2: versions per quadrat). */
  const keepQuadrat = (code: string, reason: 'leave' | 'done') => {
    const id = quadratRowId(surveyId, code);
    if (id != null) saveVersionSoon('survey_quadrat', id, reason);
  };
  const setQuadrat = (q: string) => {
    if (q !== quadrat) keepQuadrat(quadrat, 'leave');
    lastQuadrat.set(surveyId, q);
    setQuadratState(q);
    setSelected(null);
  };
  // Leaving the screen (or opening a tree over it) keeps the quadrat being walked.
  const walking = useRef(quadrat);
  useEffect(() => {
    walking.current = quadrat;
  }, [quadrat]);
  useFocusEffect(
    useCallback(
      () => () => {
        const id = quadratRowId(surveyId, walking.current);
        if (id != null) saveVersionSoon('survey_quadrat', id, 'leave');
      },
      [surveyId],
    ),
  );
  // Undo history lives while the census is open.
  useEffect(() => () => clearCensusUndo(surveyId), [surveyId]);
  const undoStacks = useQuadratUndo((st) => st.stacks);
  const [rows, setRows] = useState<TreeRowData[]>(() => (data ? loadQuadratRows(data, quadrat) : []));
  useEffect(() => {
    if (data) setRows(loadQuadratRows(data, quadrat));
  }, [data, quadrat]);

  const [tab, setTab] = useState<Tab>('list');
  const [mode, setMode] = useState<MapMode>('quadrat');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [assign, setAssign] = useState<null | 'census' | 'quadrat'>(null);
  // Tablet: what the right pane edits; `new` carries the quadrat and map point.
  const [pane, setPane] = useState<null | { id: number | null; at?: { x: number; y: number } | null; n: number }>(null);
  const [paneDirty, setPaneDirty] = useState(false);
  // 同步 is offered once this phone holds a team key (as on records).
  const [hasTeam, setHasTeam] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useFocusEffect(
    useCallback(() => {
      void Promise.all(listTeams().map((x) => hasSecret(x.team_id))).then((keys) => setHasTeam(keys.some(Boolean)));
    }, []),
  );
  usePreventRemove(wide && paneDirty, ({ data: ev }) => {
    Alert.alert(t('survey.tree.unsavedTitle'), t('survey.tree.unsavedMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('survey.tree.discard'), style: 'destructive', onPress: () => navigation.dispatch(ev.action) },
    ]);
  });

  if (!data) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
      </SafeAreaView>
    );
  }
  const { survey, frame, states } = data;
  const active = survey.status === 'active';
  // A plot with several census series: which one (2D-b).
  const seriesCode = censusSeriesCode(survey.id);

  // Progress over the plot (problems are counted per quadrat, below).
  const work = states.filter((s) => s.done || (s.prev !== 'dead' && s.prev !== 'missing'));
  const doneCount = work.filter((s) => s.done).length;
  const newCount = states.filter((s) => s.isNew).length;
  const qStates = states.filter((s) => s.quadratCode === quadrat);
  const qWork = qStates.filter((s) => s.done || (s.prev !== 'dead' && s.prev !== 'missing'));
  const qRow = data.quadrats.find((q) => q.quadrat_code === quadrat);
  const qDone = qRow?.status === 'done';
  const warnCount = rows.filter((r) => r.chip === 'warn').length;
  const qIndex = Math.max(0, codes.indexOf(quadrat));

  const shown = rows.filter((r) => {
    switch (filter) {
      case 'all':
        return true;
      case 'todo':
        return isOpenWork(r.chip);
      case 'fresh':
        return r.flags.isNew;
      case 'warn':
        return r.chip === 'warn';
      case 'pending':
        return r.flags.pending;
    }
  });
  const chips = new Map(rows.map((r) => [r.view.individual.id, r.chip]));
  const selectedRow = rows.find((r) => r.view.individual.id === selected) ?? null;

  const confirmLeavePane = (go: () => void) => {
    if (!paneDirty) return go();
    Alert.alert(t('survey.tree.unsavedTitle'), t('survey.tree.unsavedMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('survey.tree.discard'), style: 'destructive', onPress: go },
    ]);
  };
  const openTree = (id: number) => {
    if (wide) return confirmLeavePane(() => setPane({ id, n: Date.now() }));
    router.push(`/survey/${surveyId}/tree?ind=${id}&q=${quadrat}` as Href);
  };
  const newTree = (at?: { x: number; y: number }) => {
    if (wide) return confirmLeavePane(() => setPane({ id: null, at: at ?? null, n: Date.now() }));
    router.push(`/survey/${surveyId}/tree?q=${quadrat}${at ? `&x=${at.x}&y=${at.y}` : ''}` as Href);
  };
  const findTag = () => {
    const tag = (search ?? '').trim();
    if (!tag) return;
    const hit = states.find((s) => s.tag === tag);
    if (!hit) return toast(t('survey.census.tagNotFound', { tag }));
    setSearch(null);
    if (hit.quadratCode !== quadrat) setQuadrat(hit.quadratCode);
    openTree(hit.id);
  };
  const stepQuadrat = (dir: -1 | 1) => {
    const next = codes[qIndex + dir];
    if (next) setQuadrat(next);
  };
  const toggleQuadratDone = () => {
    checkpointQuadrats(surveyId, [quadrat]);
    setFgQuadratStatus(surveyId, quadrat, qDone ? 'open' : 'done');
    if (!qDone) keepQuadrat(quadrat, 'done');
    reload();
  };
  const steps = canUndo(undoStacks, surveyId, quadrat);
  const stepQuadratHistory = (dir: 'undo' | 'redo') => {
    const ok = dir === 'undo' ? undoQuadrat(surveyId, quadrat) : redoQuadrat(surveyId, quadrat);
    if (!ok) return;
    reload();
    toast(dir === 'undo' ? t('survey.census.undone') : t('survey.census.redone'));
  };
  // The first team sync fixes the block size (Modular_survey.md §7.9).
  const chooseBlockSize = async (opts: BlockSizeOption[]): Promise<number | null> => {
    const idx = await showActionSheet({
      title: t('survey.sync.blockSizeTitle'),
      message: t('survey.sync.blockSizeMsg'),
      options: opts.map((o) => ({
        label: [
          t('survey.sync.blockSizeOption', { k: o.edge, m: frame.quadrat_m, blocks: o.blocks, size: formatBytes(o.estimatedBytes) }),
          o.recommended ? t('survey.sync.recommended') : '',
          o.tooLarge ? t('survey.sync.tooLarge') : '',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      cancelLabel: t('common.cancel'),
    });
    return idx >= 0 ? (opts[idx]?.edge ?? null) : null;
  };
  const sync = async () => {
    const teamId = await pickSyncTeam(linkedTeams('survey', survey.uuid));
    if (!teamId) return;
    const dest = listTeams().find((x) => x.team_id === teamId);
    // Every result says where it went.
    const where = dest ? `\n${t('teamSync.sentTo', { name: dest.name, host: teamServerLabel(dest) })}` : '';
    setSyncing(true);
    try {
      const r = await syncCensus(teamId, surveyId, { chooseBlockSize });
      useToast.getState().dismiss();
      if (!r) return;
      if (r.queued) toast(t('teamSync.queuedToast') + where);
      else if (!r.review) {
        const who = r.mergedFrom.length
          ? t('teamSync.mergedFromToast', { names: [...new Set(r.mergedFrom)].join('、') })
          : r.merged
            ? t('teamSync.mergedToast', { count: r.merged })
            : null;
        const what = mergeSummary(t, r.changes);
        const head = who ? (what ? t('teamSync.mergedWithSummary', { who, what }) : who) : r.blocksSent ? t('survey.sync.sentBlocks', { count: r.blocksSent }) : t('teamSync.upToDate');
        toast(head + where, { durationMs: 6000 });
      }
      // Teammates on another template: said so, to be read (decided 2026-10-03).
      if (r.templateDiffers?.length) {
        const names = r.templateDiffers.map((n) => n || t('survey.sync.someone')).join('、');
        Alert.alert(t('survey.sync.templateDiffersTitle'), t('survey.sync.templateDiffersMsg', { names }));
      }
      reload();
    } catch (e) {
      useToast.getState().dismiss();
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e) + where);
    } finally {
      setSyncing(false);
    }
  };
  const editTagRoll = async () => {
    const cur = getTagRollStart(frame.uuid);
    const v = await promptText({
      title: t('survey.sync.tagRoll'),
      message: t('survey.sync.tagRollMsg'),
      defaultValue: cur == null ? '' : String(cur),
      keyboardType: 'numeric',
      allowEmpty: true,
    });
    if (v == null) return;
    const n = Number(v.trim());
    if (!v.trim()) setTagRollStart(frame.uuid, null);
    else if (Number.isInteger(n) && n > 0) setTagRollStart(frame.uuid, n);
    else return toast(t('survey.sync.tagRollBad'));
    toast(v.trim() ? t('survey.sync.tagRollSet', { n }) : t('survey.sync.tagRollCleared'));
  };
  const more = async () => {
    const roll = getTagRollStart(frame.uuid);
    const items: { id: string; label: string }[] = [
      ...(hasTeam && !syncing ? [{ id: 'sync', label: t('teamSync.sync') }] : []),
      { id: 'checks', label: t('survey.census.checks') },
      { id: 'versions', label: t('survey.census.versions', { q: quadrat, m: frame.quadrat_m }) },
      ...(hasTeam ? [{ id: 'blocks', label: t('survey.sync.blocks') }] : []),
      { id: 'roll', label: roll == null ? t('survey.sync.tagRoll') : t('survey.sync.tagRollNow', { n: roll }) },
      { id: 'investigators', label: t('survey.census.investigators') },
      { id: 'recorder', label: t('survey.census.quadratRecorder', { q: quadrat, m: frame.quadrat_m }) },
      { id: 'notes', label: t('survey.census.notes') },
      { id: 'finish', label: active ? t('survey.census.finish') : t('survey.census.reopen') },
      { id: 'frame', label: t('survey.census.frame') },
    ];
    const idx = await showActionSheet({ options: items.map(({ label }) => ({ label })), cancelLabel: t('common.cancel') });
    const id = items[idx]?.id;
    if (id === 'sync') void sync();
    if (id === 'checks') router.push(`/survey/${surveyId}/checks` as Href);
    if (id === 'versions') {
      const rowId = quadratRowId(surveyId, quadrat);
      if (rowId == null) toast(t('survey.census.noVersions'));
      else router.push(`/record-versions?kind=survey_quadrat&id=${rowId}` as Href);
    }
    if (id === 'blocks') router.push(`/survey/${surveyId}/blocks` as Href);
    if (id === 'roll') void editTagRoll();
    if (id === 'investigators') setAssign('census');
    if (id === 'recorder') setAssign('quadrat');
    if (id === 'notes') {
      const v = await promptText({ title: t('survey.census.notes'), defaultValue: survey.notes ?? '', allowEmpty: true });
      if (v != null) {
        updateCensus(surveyId, { notes: v.trim() || null });
        reload();
      }
    }
    if (id === 'finish') {
      if (active) {
        Alert.alert(t('survey.census.finish'), t('survey.census.finishMsg', { open: work.length - doneCount }), [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('survey.census.finish'),
            onPress: () => {
              finishCensus(surveyId);
              for (const id of changedQuadratIds(surveyId)) saveVersionSoon('survey_quadrat', id, 'done');
              reload();
            },
          },
        ]);
      } else {
        reopenCensus(surveyId);
        reload();
      }
    }
    if (id === 'frame') router.push(`/survey/frame/${frame.id}` as Href);
  };
  const recorder = qRow?.recorded_by ?? survey.investigators ?? null;

  const header = (
    <View className="gap-2.5 px-4 pb-2 pt-1">
      <View className="gap-1.5">
        <View className="h-2 flex-row overflow-hidden rounded bg-line dark:bg-line-dark">
          <View className="bg-accent-600 dark:bg-accent-400" style={{ flex: doneCount }} />
          <View style={{ flex: Math.max(0, work.length - doneCount) }} />
        </View>
        <View className="flex-row flex-wrap gap-x-3.5">
          <Text className="text-xs text-ink-2 dark:text-gray-400">
            <Text className="font-mono font-bold text-ink dark:text-gray-100">{doneCount}</Text>
            {data.firstCensus ? t('survey.census.progressFirst', { total: work.length }) : t('survey.census.progress', { total: work.length })}
          </Text>
          <Text className="text-xs text-ink-2 dark:text-gray-400">
            <Text className="font-mono font-bold text-ink dark:text-gray-100">{newCount}</Text> {t('survey.chip.fresh')}
          </Text>
        </View>
      </View>
      <LineTabs
        value={tab}
        options={[
          { value: 'list', label: t('survey.census.tabList') },
          { value: 'map', label: t('survey.census.tabMap') },
        ]}
        onChange={setTab}
      />
      <View className="flex-row items-center gap-2">
        <HeaderIconButton icon="chevron-back" label={t('survey.census.prevQuadrat')} disabled={qIndex <= 0} onPress={() => stepQuadrat(-1)} />
        <View className="flex-1 items-center">
          <Text style={{ fontVariant: ['tabular-nums'] }} className="text-base font-bold text-ink dark:text-gray-100">{t('survey.census.quadrat', { q: quadrat, m: frame.quadrat_m })}</Text>
          <Text className="text-xs text-ink-3 dark:text-gray-400">
            {t('survey.census.quadratProgress', { done: qWork.filter((s) => s.done).length, total: qWork.length })}
            {warnCount ? ` · ${t('survey.census.warnCount', { count: warnCount })}` : ''}
          </Text>
        </View>
        <HeaderIconButton icon="chevron-forward" label={t('survey.census.nextQuadrat')} disabled={qIndex >= codes.length - 1} onPress={() => stepQuadrat(1)} />
        <HeaderIconButton icon="arrow-undo-outline" label={t('recordLock.undo')} disabled={steps.undo === 0} onPress={() => stepQuadratHistory('undo')} />
        <HeaderIconButton icon="arrow-redo-outline" label={t('recordLock.redo')} disabled={steps.redo === 0} onPress={() => stepQuadratHistory('redo')} />
        <Pressable
          onPress={toggleQuadratDone}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: qDone }}
          accessibilityLabel={t('survey.census.quadratDone')}
          className={`h-9 flex-row items-center rounded-full border px-3 ${qDone ? 'border-accent-600 bg-accent-600 dark:border-accent-400 dark:bg-accent-400' : 'border-line dark:border-line-dark'}`}
        >
          <Ionicons name="checkmark" size={16} color={qDone ? c.onAccent : c.ink2} />
        </Pressable>
      </View>
    </View>
  );

  const list = (
    <View className="flex-1">
      <View className="flex-row items-center gap-1.5 px-4 pb-2">
        {search == null ? (
          <Pressable onPress={() => setSearch('')} accessibilityRole="button" accessibilityLabel={t('survey.census.findTag')} className="h-9 w-10 items-center justify-center rounded-full border border-line bg-card dark:border-line-dark dark:bg-card-dark">
            <Ionicons name="search" size={17} color={c.ink} />
          </Pressable>
        ) : (
          <TextInput
            value={search}
            onChangeText={setSearch}
            autoFocus
            onSubmitEditing={findTag}
            onBlur={() => !search && setSearch(null)}
            placeholder={t('survey.census.findTag')}
            placeholderTextColor={c.ink3}
            returnKeyType="search"
            autoCapitalize="none"
            className="h-9 flex-1 rounded-full border border-line bg-card px-3 text-sm text-ink dark:border-line-dark dark:bg-card-dark dark:text-gray-100"
          />
        )}
        {search == null
          ? (['all', 'todo', 'fresh', 'warn', 'pending'] as const).map((f) => {
              const on = filter === f;
              const label =
                f === 'all'
                  ? t('records.filterAll')
                  : f === 'todo'
                    ? t('survey.chip.todo')
                    : f === 'fresh'
                      ? t('survey.chip.fresh')
                      : f === 'warn'
                        ? t('survey.chip.warn')
                        : t('survey.chip.pending');
              return (
                <Pressable
                  key={f}
                  onPress={() => setFilter(f)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  className={`h-9 justify-center rounded-full border px-2.5 ${on ? 'border-ink bg-ink dark:border-gray-100 dark:bg-gray-100' : 'border-line bg-card dark:border-line-dark dark:bg-card-dark'}`}
                >
                  <Text className={`text-xs font-bold ${on ? 'text-card dark:text-gray-900' : 'text-ink dark:text-gray-100'}`} numberOfLines={1}>
                    {label}
                  </Text>
                </Pressable>
              );
            })
          : null}
      </View>
      <FlatList
        data={shown}
        keyExtractor={(r) => String(r.view.individual.id)}
        contentContainerClassName="gap-2 px-4 pb-4"
        ListEmptyComponent={<Text className="py-8 text-center text-sm text-ink-3 dark:text-gray-400">{t('survey.census.emptyQuadrat')}</Text>}
        renderItem={({ item: r }) => {
          const chip = r.chip === 'warn' && r.issues[0] ? r.issues[0].code : null;
          const on = wide && pane?.id === r.view.individual.id;
          return (
            <Pressable
              onPress={() => openTree(r.view.individual.id)}
              accessibilityRole="button"
              className={`min-h-[64px] flex-row items-center gap-3 rounded-2xl border bg-card px-3 py-2.5 active:opacity-70 dark:bg-card-dark ${
                r.chip === 'warn' ? 'border-[1.5px] border-alert dark:border-alert-dark' : on ? 'border-[1.5px] border-acorn' : 'border-line dark:border-line-dark'
              }`}
            >
              <Text className="w-14 font-mono text-[15px] font-bold text-ink dark:text-gray-100">{r.view.individual.tag}</Text>
              <View className="min-w-0 flex-1">
                {r.cname ? <Text className="text-[15px] text-ink dark:text-gray-100" numberOfLines={1}>{r.cname}</Text> : null}
                <Text className="font-latin text-sm text-ink-2 dark:text-gray-300" numberOfLines={1}>
                  {r.sci}
                </Text>
              </View>
              <View className="items-end gap-1">
                <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink dark:text-gray-100">{dbhLine(r, (n) => t('survey.census.stems', { count: n }))}</Text>
                <Text className={`overflow-hidden rounded px-1.5 py-px text-[11px] font-bold ${CHIP_LOOK[r.chip]}`}>
                  {chip ? issueShort(t, chip) : r.chip === 'done' && r.view.stems.some((s) => s.codes.length) ? [...new Set(r.view.stems.flatMap((s) => s.codes))].join(' ') : chipText(t, r.chip)}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );

  const map = (
    <View className="flex-1 gap-2 px-4 pb-2">
      <View className="flex-row items-center justify-between">
        <Text style={{ fontVariant: ['tabular-nums'] }} className="text-sm font-bold text-ink dark:text-gray-100">
          {mode === 'quadrat' ? t('survey.map.quadratTitle', { q: quadrat, m: frame.quadrat_m }) : t('survey.map.wholeTitle', { x: frame.size_x_m, y: frame.size_y_m })}
        </Text>
        <Button label={mode === 'quadrat' ? t('survey.map.whole') : t('survey.map.quadrat')} variant="secondary" onPress={() => setMode(mode === 'quadrat' ? 'whole' : 'quadrat')} />
      </View>
      <StemMap
        geometry={data.geometry}
        states={states}
        quadrat={quadrat}
        mode={mode}
        chips={chips}
        selectedId={selected}
        onSelect={setSelected}
        onPickQuadrat={(q) => {
          setQuadrat(q);
          setMode('quadrat');
        }}
        onAddAt={(p) =>
          Alert.alert(t('survey.map.addTitle'), t('survey.map.addMsg', { x: p.x.toFixed(1), y: p.y.toFixed(1) }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('survey.census.newTree'), onPress: () => newTree(p) },
          ])
        }
      />
      <View className="flex-row flex-wrap gap-x-3.5 gap-y-1">
        <Legend c={c} kind="done" label={t('survey.chip.done')} />
        <Legend c={c} kind="todo" label={t('survey.chip.todo')} />
        <Legend c={c} kind="dead" label={t('survey.chip.dead')} />
        <Legend c={c} kind="fresh" label={t('survey.chip.fresh')} />
        <Legend c={c} kind="warn" label={t('survey.chip.warn')} />
        <Text className="text-xs text-ink-2 dark:text-gray-400">{t('survey.map.areaNote')}</Text>
      </View>
      {selectedRow ? (
        <View className="flex-row items-center gap-3 rounded-card border-[1.5px] border-acorn bg-card px-3.5 py-3 dark:bg-card-dark">
          <Text className="w-14 font-mono text-[15px] font-bold text-ink dark:text-gray-100">{selectedRow.view.individual.tag}</Text>
          <View className="flex-1">
            <Text className="text-[15px] text-ink dark:text-gray-100" numberOfLines={1}>
              {selectedRow.cname ? `${selectedRow.cname} ` : ''}
              <Text className="font-latin text-sm text-ink-2 dark:text-gray-300">{selectedRow.sci}</Text>
            </Text>
            <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink-2 dark:text-gray-400">{dbhLine(selectedRow, (n) => t('survey.census.stems', { count: n }))}</Text>
          </View>
          <Button label={t('common.edit')} onPress={() => openTree(selectedRow.view.individual.id)} />
        </View>
      ) : (
        <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('survey.map.hint')}</Text>
      )}
    </View>
  );

  const left = (
    <View className="flex-1">
      {header}
      {tab === 'list' ? list : map}
      <View className="px-4 pb-2 pt-1">
        <Button label={t('survey.census.newTree')} icon="add" size="lg" fullWidth onPress={() => newTree()} />
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          headerLeft: BackHeaderLeft,
          headerTitle: () => (
            <View>
              <Text className={`text-xs font-bold ${active ? 'text-accent-600 dark:text-accent-400' : 'text-ink-3 dark:text-gray-400'}`}>
                {active ? t('survey.census.statusActive', { n: survey.census_no }) : t('survey.census.statusDone', { n: survey.census_no })}
                {seriesCode ? ` · ${seriesCode}` : ''}
              </Text>
              <Text className="text-base font-bold text-ink dark:text-gray-100" numberOfLines={1}>
                {frame.name ? `${frame.code} ${frame.name}` : frame.code}
              </Text>
            </View>
          ),
          // One button: a second one pushes ⋯ off a narrow header next to a long title (iOS). 同步 is in the menu, as on records.
          headerRight: () => <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void more()} />,
        }}
      />
      {wide ? (
        <View className="flex-1 flex-row">
          <View className="flex-[0.9] border-r border-line dark:border-line-dark">{left}</View>
          <View className="flex-1">
            {pane ? (
              <TreeEditor
                key={`${pane.id ?? 'new'}-${pane.n}`}
                surveyId={surveyId}
                frame={frame}
                firstCensus={data.firstCensus}
                individualId={pane.id}
                quadrat={quadrat}
                at={pane.at}
                states={states}
                recordedBy={recorder}
                onDirtyChange={setPaneDirty}
                onChanged={reload}
                onSaved={(id, next) => {
                  reload();
                  if (!next) return setPane({ id, n: Date.now() });
                  const order = rows.map((r) => r.view.individual.id);
                  const after = order[order.indexOf(id) + 1];
                  if (pane.id == null) setPane({ id: null, n: Date.now() });
                  else if (after != null) setPane({ id: after, n: Date.now() });
                  else {
                    setPane(null);
                    toast(t('survey.tree.lastInQuadrat'));
                  }
                }}
              />
            ) : (
              <View className="flex-1 items-center justify-center p-8">
                <Text className="text-center text-sm text-ink-3 dark:text-gray-400">{t('survey.census.pickTree')}</Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        left
      )}
      <SurveyorAssignSheet
        visible={assign != null}
        current={(assign === 'quadrat' ? qRow?.recorded_by : survey.investigators) ?? ''}
        onCancel={() => setAssign(null)}
        onAssign={(v) => {
          if (assign === 'quadrat') setFgQuadratRecorder(surveyId, quadrat, v.trim() || null);
          else updateCensus(surveyId, { investigators: v.trim() || null });
          setAssign(null);
          reload();
        }}
      />
    </SafeAreaView>
  );
}

function issueShort(t: (k: string) => string, code: string): string {
  switch (code) {
    case 'shrank':
      return t('survey.issue.shrankShort');
    case 'tenfold':
      return t('survey.issue.tenfoldShort');
    default:
      return t('survey.chip.warn');
  }
}

function Legend({ c, kind, label }: { c: ReturnType<typeof useThemeColors>; kind: 'done' | 'todo' | 'dead' | 'fresh' | 'warn'; label: string }) {
  const style =
    kind === 'done'
      ? { backgroundColor: c.accent, opacity: 0.8 }
      : kind === 'todo'
        ? { borderWidth: 1.4, borderColor: c.accent }
        : kind === 'dead'
          ? { borderWidth: 1.4, borderColor: c.ink2, borderStyle: 'dashed' as const }
          : kind === 'fresh'
            ? { backgroundColor: c.acorn }
            : { backgroundColor: c.alert };
  return (
    <View className="flex-row items-center gap-1.5">
      <View style={[{ width: 12, height: 12, borderRadius: 6 }, style]} />
      <Text className="text-xs text-ink-2 dark:text-gray-400">{label}</Text>
    </View>
  );
}
