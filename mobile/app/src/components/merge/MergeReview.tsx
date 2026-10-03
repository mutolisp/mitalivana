/**
 * The team merge review's list (app/merge.tsx for records, app/survey/merge.tsx
 * for a census block): the items that need a decision, then those applied
 * unless unticked. A FlatList, so a block with thousands of new rows stays
 * responsive (Modular_survey.md §7.2); past AUTO_FOLD automatic rows they are
 * summed up and listed on request.
 */
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, Text, View } from 'react-native';
import { ScientificName } from '~/components/ScientificName';
import { SelectMark } from '~/components/ui/SelectMark';
import { defaultDecision, needsReview, type Decision, type MergeItem, type MergeRow } from '~/lib/mergeEngine';
import { fieldLabel, fmt, rowLabel } from '~/lib/mergeFormat';

/** More automatic rows than this are folded behind a summary line. */
export const AUTO_FOLD = 100;

/** `bold`: the line around it is semibold (the scientific name takes those files too). */
function rowTitle(t: (k: string) => string, tbl: string, r: MergeRow | null | undefined, bold = false): ReactNode {
  if (!r) return '';
  const group = r.group && r.group !== r.label ? `${r.group} · ` : '';
  // A title with scientific names: each in italics by its rank.
  if (r.title?.length) {
    return (
      <>
        {group}
        {r.title.map((p, i) => (typeof p === 'string' ? p : <ScientificName key={i} name={p.sci} rank={p.rank ?? ''} kingdom={p.kingdom ?? ''} className={bold ? 'font-semibold' : undefined} />))}
      </>
    );
  }
  return `${group}${rowLabel(t, tbl, r.label)}`;
}

export function Choice({ on, label, onPress, danger }: { on: boolean; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      className={`rounded-lg border px-3 py-1.5 ${
        on
          ? danger
            ? 'border-red-500 bg-red-50 dark:bg-red-950/40'
            : 'border-accent-600 bg-accent-50 dark:bg-accent-950/40'
          : 'border-gray-300 dark:border-gray-700'
      }`}
    >
      <Text className={`text-sm ${on ? (danger ? 'text-red-700 dark:text-red-300' : 'text-accent-700 dark:text-accent-300') : 'text-gray-700 dark:text-gray-300'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

/** One field, two values; tap a side to take it. */
function FieldRow({
  label,
  local,
  remote,
  pick,
  onPick,
}: {
  label: string;
  local: string;
  remote: string;
  pick: 'local' | 'remote';
  onPick: (p: 'local' | 'remote') => void;
}) {
  const cell = (side: 'local' | 'remote', value: string) => (
    <Pressable
      onPress={() => onPick(side)}
      accessibilityRole="radio"
      accessibilityState={{ selected: pick === side }}
      className={`flex-1 rounded-md border px-2 py-1.5 ${pick === side ? 'border-accent-600 bg-accent-50 dark:bg-accent-950/40' : 'border-gray-200 dark:border-gray-800'}`}
    >
      <Text className="text-sm text-gray-900 dark:text-gray-100" numberOfLines={3}>
        {value}
      </Text>
    </Pressable>
  );
  return (
    <View className="gap-1">
      <Text className="text-xs text-gray-500 dark:text-gray-400">{label}</Text>
      <View className="flex-row gap-2">
        {cell('local', local)}
        {cell('remote', remote)}
      </View>
    </View>
  );
}

export const CARD = 'gap-2 rounded-xl border border-gray-200 bg-card p-3 dark:border-gray-800 dark:bg-gray-900';

function ReviewCard({
  item,
  decision,
  onChange,
  noBoth,
}: {
  item: MergeItem;
  decision: Decision;
  onChange: (d: Decision) => void;
  /** "Keep both" is not offered (GLORIA: one row per taxon and unit). */
  noBoth: boolean;
}) {
  const { t } = useTranslation();
  const title = rowTitle(t, item.tbl, item.local ?? item.remote ?? item.dup, true);
  const table = t(`teamMerge.table.${item.tbl}`);
  const head = (
    <View className="flex-row items-center gap-2">
      <Text className="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100" numberOfLines={2}>
        {title}
      </Text>
      <Text className="text-xs text-gray-500 dark:text-gray-400">{table}</Text>
    </View>
  );

  if (item.kind === 'conflict') {
    const pickOf = (f: string) => (decision.pick === 'remote' ? 'remote' : (decision.fields?.[f] ?? 'local'));
    return (
      <View className={CARD}>
        {head}
        <Text className="text-xs text-amber-700 dark:text-amber-400">{t('teamMerge.conflictMsg')}</Text>
        <View className="flex-row gap-2">
          <Text className="flex-1 text-[11px] font-semibold text-gray-500">{t('teamMerge.local')}</Text>
          <Text className="flex-1 text-[11px] font-semibold text-gray-500">{t('teamMerge.remote')}</Text>
        </View>
        {item.fields.map((f) => (
          <FieldRow
            key={f}
            label={fieldLabel(t, f, item.tbl)}
            local={fmt(f, item.local?.data[f], { t, tbl: item.tbl, key: item.key })}
            remote={fmt(f, item.remote?.data[f], { t, tbl: item.tbl, key: item.key })}
            pick={pickOf(f)}
            onPick={(p) =>
              onChange({
                pick: 'local',
                fields: { ...Object.fromEntries(item.fields.map((x) => [x, pickOf(x)])), [f]: p },
              })
            }
          />
        ))}
      </View>
    );
  }

  if (item.kind === 'duplicate') {
    return (
      <View className={CARD}>
        {head}
        <Text className="text-xs text-amber-700 dark:text-amber-400">{t('teamMerge.duplicateMsg')}</Text>
        {item.fields.map((f) => (
          <View key={f} className="flex-row gap-2">
            <Text className="w-24 text-xs text-gray-500">{fieldLabel(t, f, item.tbl)}</Text>
            <Text className="flex-1 text-xs text-gray-800 dark:text-gray-200">{fmt(f, item.dup?.data[f], { t, tbl: item.tbl, key: item.key })}</Text>
            <Text className="flex-1 text-xs text-gray-800 dark:text-gray-200">{fmt(f, item.remote?.data[f], { t, tbl: item.tbl, key: item.key })}</Text>
          </View>
        ))}
        <View className="flex-row flex-wrap gap-2">
          <Choice on={decision.pick === 'local'} label={t('teamMerge.keepMine')} onPress={() => onChange({ pick: 'local' })} />
          <Choice on={decision.pick === 'remote'} label={t('teamMerge.useTheirs')} onPress={() => onChange({ pick: 'remote' })} />
          {noBoth ? null : <Choice on={decision.pick === 'both'} label={t('teamMerge.keepBoth')} onPress={() => onChange({ pick: 'both' })} />}
        </View>
      </View>
    );
  }

  // Deletions: the only choices are to keep this device's state or follow theirs.
  const theyDeleted = item.remote == null;
  const msg =
    item.kind === 'remoteDeleted'
      ? t('teamMerge.remoteDeletedMsg')
      : theyDeleted
        ? t('teamMerge.deleteConflictTheirsMsg')
        : t('teamMerge.deleteConflictMineMsg');
  return (
    <View className={CARD}>
      {head}
      <Text className="text-xs text-amber-700 dark:text-amber-400">{msg}</Text>
      <View className="flex-row flex-wrap gap-2">
        <Choice on={decision.pick === 'local'} label={theyDeleted ? t('teamMerge.keep') : t('teamMerge.stayDeleted')} onPress={() => onChange({ pick: 'local' })} />
        <Choice
          on={decision.pick === 'remote'}
          label={theyDeleted ? t('teamMerge.delete') : t('teamMerge.restore')}
          danger={theyDeleted}
          onPress={() => onChange({ pick: 'remote' })}
        />
      </View>
    </View>
  );
}

function AutoRow({ item, on, onToggle, first, last }: { item: MergeItem; on: boolean; onToggle: () => void; first: boolean; last: boolean }) {
  const { t } = useTranslation();
  const detail =
    item.kind === 'added'
      ? t('teamMerge.addedLine')
      : [
          ...item.fields.map((f) => `${fieldLabel(t, f, item.tbl)} ${fmt(f, item.local?.data[f], { t, tbl: item.tbl, key: item.key })} → ${fmt(f, item.remote?.data[f], { t, tbl: item.tbl, key: item.key })}`),
          ...Object.keys(item.patch ?? {}).map((f) => `${fieldLabel(t, f, item.tbl)} ${t('teamMerge.combined')}`),
        ].join('；');
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      // The automatic rows read as one card: outer border on the first and last.
      className={`flex-row items-start gap-2 border-x border-gray-200 bg-card px-3 py-2 dark:border-gray-800 dark:bg-gray-900 ${first ? 'rounded-t-xl border-t' : ''} ${
        last ? 'mb-3 rounded-b-xl border-b' : 'border-b border-b-gray-100 dark:border-b-gray-800'
      }`}
    >
      <SelectMark state={on ? 'on' : 'off'} />
      <View className="flex-1">
        <Text className="text-sm text-gray-900 dark:text-gray-100">
          {rowTitle(t, item.tbl, item.remote ?? item.local)}
          <Text className="text-xs text-gray-500"> · {t(`teamMerge.table.${item.tbl}`)}</Text>
        </Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={3}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

type Line =
  | { key: string; type: 'reviewHead'; count: number }
  | { key: string; type: 'review'; item: MergeItem }
  | { key: string; type: 'autoHead'; count: number }
  | { key: string; type: 'auto'; item: MergeItem; first: boolean; last: boolean }
  | { key: string; type: 'fold'; count: number };

/**
 * Items and decisions of one merge as a virtualized list. `header` and
 * `footer` scroll with it.
 */
export function MergeItemList({
  items,
  decisions,
  onDecisions,
  header,
  footer,
  noBoth = false,
}: {
  items: MergeItem[];
  decisions: Map<string, Decision>;
  onDecisions: (next: Map<string, Decision>) => void;
  header: ReactElement;
  footer?: ReactElement;
  noBoth?: boolean;
}) {
  const { t } = useTranslation();
  const [unfolded, setUnfolded] = useState(false);
  const review = useMemo(() => items.filter(needsReview), [items]);
  const auto = useMemo(() => items.filter((i) => !needsReview(i)), [items]);
  const dec = (it: MergeItem) => decisions.get(it.id) ?? defaultDecision(it);
  const setDec = (it: MergeItem, d: Decision) => onDecisions(new Map(decisions).set(it.id, d));
  const setAll = (list: MergeItem[], pick: 'local' | 'remote') => {
    const next = new Map(decisions);
    for (const it of list) next.set(it.id, { pick });
    onDecisions(next);
  };
  const folded = auto.length > AUTO_FOLD && !unfolded;
  const lines: Line[] = useMemo(
    () => [
      ...(review.length ? [{ key: 'rh', type: 'reviewHead' as const, count: review.length }] : []),
      ...review.map((item) => ({ key: `r:${item.id}`, type: 'review' as const, item })),
      ...(auto.length ? [{ key: 'ah', type: 'autoHead' as const, count: auto.length }] : []),
      ...(folded
        ? [{ key: 'fold', type: 'fold' as const, count: auto.length }]
        : auto.map((item, i) => ({ key: `a:${item.id}`, type: 'auto' as const, item, first: i === 0, last: i === auto.length - 1 }))),
    ],
    [review, auto, folded],
  );

  return (
    <FlatList
      data={lines}
      keyExtractor={(l) => l.key}
      extraData={decisions}
      contentContainerClassName="p-4"
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      initialNumToRender={20}
      windowSize={11}
      renderItem={({ item: l }) => {
        switch (l.type) {
          case 'reviewHead':
            return (
              <View className="mb-2 flex-row items-center gap-2">
                <Text className="flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{t('teamMerge.reviewHeader', { count: l.count })}</Text>
                <Pressable onPress={() => setAll(review, 'local')} hitSlop={6}>
                  <Text className="text-xs text-accent-700 dark:text-accent-300">{t('teamMerge.allMine')}</Text>
                </Pressable>
                <Pressable onPress={() => setAll(review, 'remote')} hitSlop={6}>
                  <Text className="text-xs text-accent-700 dark:text-accent-300">{t('teamMerge.allTheirs')}</Text>
                </Pressable>
              </View>
            );
          case 'review':
            return (
              <View className="mb-3">
                <ReviewCard item={l.item} decision={dec(l.item)} onChange={(d) => setDec(l.item, d)} noBoth={noBoth} />
              </View>
            );
          case 'autoHead':
            return <Text className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{t('teamMerge.autoHeader', { count: l.count })}</Text>;
          case 'fold':
            return (
              <Pressable onPress={() => setUnfolded(true)} accessibilityRole="button" className={`mb-3 ${CARD}`}>
                <Text className="text-sm text-gray-700 dark:text-gray-300">{t('teamMerge.autoFolded', { count: l.count })}</Text>
                <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">{t('teamMerge.showAll')}</Text>
              </Pressable>
            );
          case 'auto': {
            const on = dec(l.item).pick !== 'local';
            return <AutoRow item={l.item} on={on} first={l.first} last={l.last} onToggle={() => setDec(l.item, { pick: on ? 'local' : 'remote' })} />;
          }
        }
      }}
    />
  );
}
