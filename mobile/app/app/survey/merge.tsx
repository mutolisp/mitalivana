/**
 * A teammate's census block that needs a person (src/survey/censusSync.ts):
 *
 * 1. Tag clashes first, since one tag cannot sit on two trees: renumber one
 *    of them, or call them one tree; a possible duplicate (two new tags on
 *    what may be one tree) is one tree or both kept. These are written when
 *    the step is confirmed, as corrections with history rows, so the
 *    teammate's phone does the same.
 * 2. The field review (src/components/merge/MergeReview.tsx), as for records.
 *
 * Before anything is written the block's quadrats are kept as versions, so a
 * merge can be undone from a quadrat's versions.
 */
import { router, Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from '~/components/KeyboardAvoidingView';
import { CARD, Choice, MergeItemList } from '~/components/merge/MergeReview';
import { resolveTaxa } from '~/db/taxonLookup';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { BackHeaderLeft } from '~/lib/goBack';
import { mergeSummary } from '~/lib/mergeSummaryText';
import { needsReview, summarizeItems, type Decision, type MergeItem, type MergeRow } from '~/lib/mergeEngine';
import { getTeam } from '~/lib/teamSync';
import { useToast } from '~/stores/toast';
import { applyCensusMerge, openCensusMerge, settleCensusMerge, useCensusMerge } from '~/survey/censusSync';
import type { CensusSlice } from '~/survey/db/sliceCore';
import type { Collision, CollisionDecision, TreeBrief } from '~/survey/db/censusSyncCore';
import { censusTemplate, getSurvey, getFrame, suggestTag } from '~/survey/db/stemmap';
import { censusValueName } from '~/survey/components/labels';
import { useThemeColors } from '~/theme/colors';

function TreeLine({ who, tree }: { who: string; tree: TreeBrief }) {
  const { t } = useTranslation();
  const f = resolveTaxa([tree.taxonId]).get(tree.taxonId);
  const name = [f?.common_name_c, tree.name ?? f?.simple_name].filter(Boolean).join(' ') || tree.taxonId;
  return (
    <View className="flex-row gap-2">
      <Text className="w-12 text-xs font-semibold text-gray-500">{who}</Text>
      <Text style={{ fontVariant: ['tabular-nums'] }} className="flex-1 text-xs text-gray-800 dark:text-gray-200">
        {t('survey.sync.treeLine', {
          tag: tree.tag,
          name,
          x: tree.x.toFixed(1),
          y: tree.y.toFixed(1),
          q: tree.quadrat,
          dbh: tree.dbh ?? '—',
        })}
      </Text>
    </View>
  );
}

type Draft = { kind: 'same' | 'renumberLocal' | 'renumberRemote' | 'sameLocal' | 'sameRemote' | 'both'; tag: string };

function ClashCard({ c, draft, onChange }: { c: Collision; draft: Draft | undefined; onChange: (d: Draft) => void }) {
  const { t } = useTranslation();
  const col = useThemeColors();
  const pick = draft?.kind;
  const distance = Math.hypot(c.local.x - c.remote.x, c.local.y - c.remote.y).toFixed(1);
  return (
    <View className={CARD}>
      <Text className="text-xs text-amber-700 dark:text-amber-400">
        {c.kind === 'tag' ? t('survey.sync.clashTagMsg', { tag: c.local.tag, d: distance }) : t('survey.sync.clashPossibleMsg', { d: distance })}
      </Text>
      <TreeLine who={t('teamMerge.local')} tree={c.local} />
      <TreeLine who={t('teamMerge.remote')} tree={c.remote} />
      <View className="flex-row flex-wrap gap-2">
        {c.kind === 'tag' ? (
          <>
            <Choice on={pick === 'renumberRemote'} label={t('survey.sync.renumberRemote')} onPress={() => onChange({ kind: 'renumberRemote', tag: draft?.tag ?? '' })} />
            <Choice on={pick === 'renumberLocal'} label={t('survey.sync.renumberLocal')} onPress={() => onChange({ kind: 'renumberLocal', tag: draft?.tag ?? '' })} />
            <Choice on={pick === 'same'} label={t('survey.sync.sameTree')} onPress={() => onChange({ kind: 'same', tag: c.local.tag })} />
          </>
        ) : (
          <>
            <Choice on={pick === 'both' || pick == null} label={t('survey.sync.keepBoth')} onPress={() => onChange({ kind: 'both', tag: '' })} />
            <Choice on={pick === 'sameLocal'} label={t('survey.sync.sameTreeTag', { tag: c.local.tag })} onPress={() => onChange({ kind: 'sameLocal', tag: c.local.tag })} />
            <Choice on={pick === 'sameRemote'} label={t('survey.sync.sameTreeTag', { tag: c.remote.tag })} onPress={() => onChange({ kind: 'sameRemote', tag: c.remote.tag })} />
          </>
        )}
      </View>
      {pick === 'renumberLocal' || pick === 'renumberRemote' ? (
        <View className="flex-row items-center gap-2">
          <Text className="text-xs text-gray-500">{t('survey.sync.newTag')}</Text>
          <TextInput
            value={draft?.tag ?? ''}
            onChangeText={(v) => onChange({ kind: pick, tag: v })}
            keyboardType="number-pad"
            accessibilityLabel={t('survey.sync.newTag')}
            placeholderTextColor={col.ink3}
            className="h-10 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </View>
      ) : null}
    </View>
  );
}

const toDecision = (d: Draft | undefined, c: Collision): CollisionDecision | null => {
  if (!d) return c.kind === 'possible' ? { kind: 'both' } : null;
  switch (d.kind) {
    case 'same':
      return { kind: 'same', tag: c.local.tag };
    case 'sameLocal':
    case 'sameRemote':
      return { kind: 'same', tag: d.tag };
    case 'renumberLocal':
      return d.tag.trim() ? { kind: 'renumber', which: 'local', tag: d.tag.trim() } : null;
    case 'renumberRemote':
      return d.tag.trim() ? { kind: 'renumber', which: 'remote', tag: d.tag.trim() } : null;
    case 'both':
      return { kind: 'both' };
  }
};

export default function CensusMergeScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast((s) => s.show);
  const pending = useCensusMerge((s) => s.pending);
  const [clashes, setClashes] = useState<Collision[] | null>(null);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [settled, setSettled] = useState<{ items: MergeItem[]; remote: CensusSlice } | null>(null);
  // A stem's or tree's value named in words (height, codes, AMS, a trait or code list), not by its stored field.
  const shownItems = useMemo(() => {
    if (!settled) return [];
    const tpl = pending ? censusTemplate(pending.surveyId) : null;
    const named = (tbl: string, r: MergeRow | null): MergeRow | null => {
      if (!r || (tbl !== 'sval' && tbl !== 'ival')) return r;
      const field = String(r.data.field ?? '');
      const prefix = r.label.endsWith(` ${field}`) ? r.label.slice(0, -(field.length + 1)) : r.label;
      return { ...r, label: `${prefix} ${censusValueName(t, i18n.language, tpl, String(r.data.component ?? ''), field)}` };
    };
    return settled.items.map((it) => ({ ...it, local: named(it.tbl, it.local), remote: named(it.tbl, it.remote) }));
  }, [settled, pending, t, i18n.language]);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [busy, setBusy] = useState(false);
  const by = pending?.teamId ? (getTeam(pending.teamId)?.member_name ?? null) : null;

  const settle = (map: Map<string, CollisionDecision>) => {
    if (!pending) return;
    try {
      setSettled(settleCensusMerge(pending, map, by));
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), errText(e));
    }
  };

  // Their folds are carried out and the clashes listed once, on opening.
  useEffect(() => {
    if (!pending) return;
    try {
      const list = openCensusMerge(pending);
      setClashes(list);
      if (!list.length) settle(new Map());
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), errText(e));
    }
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => summarizeItems(settled?.items ?? []), [settled]);
  const review = useMemo(() => (settled?.items ?? []).filter(needsReview), [settled]);

  if (!pending) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: t('teamMerge.title'), headerLeft: BackHeaderLeft }} />
        <Text className="text-sm text-gray-500">{t('teamMerge.none')}</Text>
      </SafeAreaView>
    );
  }

  const head = (
    <View className="mb-3 gap-1">
      <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">{pending.label}</Text>
      {pending.from ? (
        <Text className="text-sm text-accent-700 dark:text-accent-300">
          {pending.fromAt ? t('teamMerge.fromAt', { name: pending.from, date: isoStamp(pending.fromAt).slice(0, 16) }) : t('teamMerge.from', { name: pending.from })}
        </Text>
      ) : null}
      {settled ? (
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('teamMerge.summary', { added: counts.added, auto: counts.auto, review: review.length })}</Text>
      ) : null}
    </View>
  );

  const suggestFor = (c: Collision, which: 'local' | 'remote') => {
    try {
      const s = getSurvey(pending.surveyId);
      const f = s ? getFrame(s.frame_id) : null;
      const tree = which === 'local' ? c.local : c.remote;
      return f ? suggestTag(f, { x: tree.x, y: tree.y }) : '';
    } catch {
      return '';
    }
  };

  const confirmClashes = () => {
    const map = new Map<string, CollisionDecision>();
    for (const c of clashes ?? []) {
      const d = toDecision(drafts.get(c.id), c);
      if (!d) return Alert.alert(t('survey.sync.clashesTitle'), t('survey.sync.needDecision'));
      map.set(c.id, d);
    }
    settle(map);
  };

  const apply = () => {
    if (!settled) return;
    setBusy(true);
    try {
      const { changes } = applyCensusMerge(pending, settled.remote, settled.items, decisions);
      const what = mergeSummary(t, changes);
      toast(what ? t('teamSync.mergedWithSummary', { who: pending.from ?? t('teamMerge.remote'), what }) : t('teamMerge.doneMsg', { count: changes.length }), { durationMs: 6000 });
      // A file with several censuses here: the next one, on this screen.
      const [next, ...rest] = pending.next ?? [];
      if (next) {
        setClashes(null);
        setDrafts(new Map());
        setSettled(null);
        setDecisions(new Map());
        setBusy(false);
        useCensusMerge.getState().set({ ...next, next: rest });
        return;
      }
      useCensusMerge.getState().set(null);
      router.back();
    } catch (e) {
      setBusy(false);
      Alert.alert(t('teamSync.failTitle'), errText(e));
    }
  };

  const footerButton = (label: string, onPress: () => void) => (
    <View className="border-t border-gray-200 bg-card px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
      <Pressable
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        className={`items-center rounded-xl py-3 ${busy ? 'bg-gray-400' : 'bg-accent-600 active:bg-accent-700'}`}
      >
        <Text className="text-base font-semibold text-white">{label}</Text>
      </Pressable>
    </View>
  );

  // Step 1: the clashes.
  if (!settled && clashes?.length) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: t('teamMerge.title'), headerLeft: BackHeaderLeft }} />
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled">
            {head}
            <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('survey.sync.clashesTitle')}</Text>
            <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('survey.sync.clashesIntro')}</Text>
            {clashes.map((c) => (
              <ClashCard
                key={c.id}
                c={c}
                draft={drafts.get(c.id)}
                onChange={(d) => {
                  // A renumbering starts from the next free tag for that tree's place.
                  const next = (d.kind === 'renumberLocal' || d.kind === 'renumberRemote') && !d.tag ? { ...d, tag: suggestFor(c, d.kind === 'renumberLocal' ? 'local' : 'remote') } : d;
                  setDrafts((m) => new Map(m).set(c.id, next));
                }}
              />
            ))}
          </ScrollView>
          {footerButton(t('survey.sync.next'), confirmClashes)}
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Step 2: the review.
  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: t('teamMerge.title'), headerLeft: BackHeaderLeft }} />
      {settled ? (
        <MergeItemList
          items={shownItems}
          decisions={decisions}
          onDecisions={setDecisions}
          header={head}
          footer={<Text className="text-xs text-gray-500 dark:text-gray-400">{t('survey.sync.versionsNote')}</Text>}
        />
      ) : (
        <View className="flex-1 p-4">{head}</View>
      )}
      {settled ? footerButton(busy ? t('teamMerge.applying') : t('teamMerge.apply'), apply) : null}
    </SafeAreaView>
  );
}
