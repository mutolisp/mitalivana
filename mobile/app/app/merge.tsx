/**
 * Team merge review: what another surveyor's file would change here, and the
 * reviewer's decisions (src/lib/mergeEngine.ts, src/lib/teamMergeFlow.ts).
 *
 * Two groups:
 *   - 需要決定: conflicts, possible duplicates, deletions — each needs a tap to
 *     move off "keep mine";
 *   - 自動套用: rows only the sender added or changed, applied unless unticked.
 * Nothing is written until 套用, and the record is saved to
 * Documents/merge-backups first.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { searchByTaxonId } from '~/db/search';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { BackHeaderLeft } from '~/lib/goBack';
import {
  defaultDecision,
  needsReview,
  summarizeItems,
  type Decision,
  type MergeItem,
  type MergeRow,
} from '~/lib/mergeEngine';
import { applyPendingMerge, usePendingMerge, type PendingMerge } from '~/lib/teamMergeFlow';
import { useToast } from '~/stores/toast';

/** Field → label key; fields not listed show their column name. */
const FIELD_KEY: Record<string, string> = {
  lat: 'latitude',
  start_lat: 'latitude',
  decimal_latitude: 'latitude',
  lng: 'longitude',
  start_lng: 'longitude',
  decimal_longitude: 'longitude',
  accuracy: 'accuracy',
  coord_uncertainty_m: 'accuracy',
  comments: 'notes',
  field_note: 'notes',
  used_name_id: 'usedName',
  used_scientific_name: 'usedName',
};
const LABELLED = new Set([
  'name', 'type', 'notes', 'gps_mode', 'taxon_id', 'observed_at', 'elevation_m', 'organism_quantity',
  'organism_quantity_type', 'sex', 'life_stage', 'reproductive_condition', 'leaf_phenology',
  'degree_of_establishment', 'verbatim_identification', 'plotid', 'layer_count', 'locality', 'slope_deg',
  'aspect_deg', 'cover_pct', 'height_cm', 'layer', 'subplot', 'label', 'year', 'unit', 'abundance', 'cf',
  'freq_cells', 'freq_count', 'point_hits', 'distance_m', 'compass_deg', 'is_p5m', 'checked', 'recorded_by',
  'start_ts', 'stop_ts', 'total_cover_pct', 'detection_type', 'done_locked', 'freq_locked', 'pf_locked',
  // Temperature loggers (v65)
  'visit_ts', 'researchers', 'locked', 'role', 'direction', 'quadrat', 'serial', 'logger_type', 'utc_diff_h', 'dist11_m',
  'dist31_m', 'photo_open', 'photo_closed', 'flags', 'researcher', 'visit', 'prev_uuid',
  // A cleared GLORIA unit: no researchers (v66)
  'no_researchers',
]);
/** GLORIA 完成 locks and other 1 / null flags. */
const LOCKS = new Set(['done_locked', 'freq_locked', 'pf_locked', 'locked', 'photo_open', 'photo_closed', 'no_researchers']);
/** Grids and point strings: shown as a count, not 100–400 characters. */
const MASKS = new Set(['freq_cells', 'point_hits', 'dist_hi1', 'dist_hi2', 'dist_hi3', 'point_surface']);
const TIMES = /(_ts|_at)$/;

function fieldLabel(t: (k: string) => string, f: string): string {
  if (f.startsWith('cov_') || f.startsWith('sub_')) return t(`gloria.cover.${f}`);
  const k = FIELD_KEY[f] ?? (LABELLED.has(f) ? f : null);
  return k ? t(`teamMerge.field.${k}`) : f;
}

function fmt(f: string, v: unknown): string {
  if (LOCKS.has(f)) return v ? '✓' : '—';
  if (v === null || v === undefined || v === '') return '—';
  if (MASKS.has(f) && typeof v === 'string') {
    const on = f === 'point_surface' ? [...v].filter((c) => c !== '.').length : [...v].filter((c) => c === '1').length;
    return `${on}/${v.length}`;
  }
  if (TIMES.test(f) && typeof v === 'number') return isoStamp(v).slice(0, 16);
  if (f === 'taxon_id' && typeof v === 'string') {
    const hit = searchByTaxonId(v);
    return hit ? [hit.cname, hit.name].filter(Boolean).join(' ') : v;
  }
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}${x}`).join(' ');
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      return (JSON.parse(v) as unknown[]).join('、');
    } catch {
      return v;
    }
  }
  return String(v);
}

function rowTitle(r: MergeRow | null | undefined): string {
  if (!r) return '';
  return r.group && r.group !== r.label ? `${r.group} · ${r.label}` : r.label;
}

function Choice({ on, label, onPress, danger }: { on: boolean; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      className={`rounded-lg border px-3 py-1.5 ${
        on
          ? danger
            ? 'border-red-500 bg-red-50 dark:bg-red-950/40'
            : 'border-[#00A2A5] bg-cyan-50 dark:bg-cyan-950/40'
          : 'border-gray-300 dark:border-gray-700'
      }`}
    >
      <Text className={`text-sm ${on ? (danger ? 'text-red-700 dark:text-red-300' : 'text-[#00797b] dark:text-cyan-300') : 'text-gray-700 dark:text-gray-300'}`}>
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
      className={`flex-1 rounded-md border px-2 py-1.5 ${pick === side ? 'border-[#00A2A5] bg-cyan-50 dark:bg-cyan-950/40' : 'border-gray-200 dark:border-gray-800'}`}
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

function ReviewCard({
  item,
  decision,
  onChange,
  gloria,
}: {
  item: MergeItem;
  decision: Decision;
  onChange: (d: Decision) => void;
  gloria: boolean;
}) {
  const { t } = useTranslation();
  const title = rowTitle(item.local ?? item.remote ?? item.dup);
  const table = t(`teamMerge.table.${item.tbl}`);
  const head = (
    <View className="flex-row items-center gap-2">
      <Text className="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100" numberOfLines={2}>
        {title}
      </Text>
      <Text className="text-xs text-gray-500 dark:text-gray-400">{table}</Text>
    </View>
  );
  const card = 'gap-2 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900';

  if (item.kind === 'conflict') {
    const pickOf = (f: string) => (decision.pick === 'remote' ? 'remote' : (decision.fields?.[f] ?? 'local'));
    return (
      <View className={card}>
        {head}
        <Text className="text-xs text-amber-700 dark:text-amber-400">{t('teamMerge.conflictMsg')}</Text>
        <View className="flex-row gap-2">
          <Text className="flex-1 text-[11px] font-semibold text-gray-500">{t('teamMerge.local')}</Text>
          <Text className="flex-1 text-[11px] font-semibold text-gray-500">{t('teamMerge.remote')}</Text>
        </View>
        {item.fields.map((f) => (
          <FieldRow
            key={f}
            label={fieldLabel(t, f)}
            local={fmt(f, item.local?.data[f])}
            remote={fmt(f, item.remote?.data[f])}
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
      <View className={card}>
        {head}
        <Text className="text-xs text-amber-700 dark:text-amber-400">{t('teamMerge.duplicateMsg')}</Text>
        {item.fields.map((f) => (
          <View key={f} className="flex-row gap-2">
            <Text className="w-24 text-xs text-gray-500">{fieldLabel(t, f)}</Text>
            <Text className="flex-1 text-xs text-gray-800 dark:text-gray-200">{fmt(f, item.dup?.data[f])}</Text>
            <Text className="flex-1 text-xs text-gray-800 dark:text-gray-200">{fmt(f, item.remote?.data[f])}</Text>
          </View>
        ))}
        <View className="flex-row flex-wrap gap-2">
          <Choice on={decision.pick === 'local'} label={t('teamMerge.keepMine')} onPress={() => onChange({ pick: 'local' })} />
          <Choice on={decision.pick === 'remote'} label={t('teamMerge.useTheirs')} onPress={() => onChange({ pick: 'remote' })} />
          {/* One row per taxon and unit is a GLORIA rule (UNIQUE in the schema). */}
          {gloria ? null : (
            <Choice on={decision.pick === 'both'} label={t('teamMerge.keepBoth')} onPress={() => onChange({ pick: 'both' })} />
          )}
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
    <View className={card}>
      {head}
      <Text className="text-xs text-amber-700 dark:text-amber-400">{msg}</Text>
      <View className="flex-row flex-wrap gap-2">
        <Choice
          on={decision.pick === 'local'}
          label={theyDeleted ? t('teamMerge.keep') : t('teamMerge.stayDeleted')}
          onPress={() => onChange({ pick: 'local' })}
        />
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

function AutoRow({ item, on, onToggle }: { item: MergeItem; on: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const detail =
    item.kind === 'added'
      ? t('teamMerge.addedLine')
      : [
          ...item.fields.map((f) => `${fieldLabel(t, f)} ${fmt(f, item.local?.data[f])} → ${fmt(f, item.remote?.data[f])}`),
          ...Object.keys(item.patch ?? {}).map((f) => `${fieldLabel(t, f)} ${t('teamMerge.combined')}`),
        ].join('；');
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      className="flex-row items-start gap-2 border-b border-gray-100 py-2 dark:border-gray-800"
    >
      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? '#00A2A5' : '#9ca3af'} />
      <View className="flex-1">
        <Text className="text-sm text-gray-900 dark:text-gray-100">
          {rowTitle(item.remote ?? item.local)}
          <Text className="text-xs text-gray-500"> · {t(`teamMerge.table.${item.tbl}`)}</Text>
        </Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={3}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

function hrefOf(p: PendingMerge): Href {
  return (p.kind === 'session' ? `/session/${p.localId}` : p.kind === 'plot' ? `/plot/${p.localId}` : `/gloria/${p.localId}`) as Href;
}

export default function MergeReviewScreen() {
  const { t } = useTranslation();
  const pending = usePendingMerge((s) => s.pending);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [busy, setBusy] = useState(false);
  const toast = useToast((s) => s.show);

  const review = useMemo(() => (pending?.items ?? []).filter(needsReview), [pending]);
  const auto = useMemo(() => (pending?.items ?? []).filter((i) => !needsReview(i)), [pending]);
  const counts = useMemo(() => summarizeItems(pending?.items ?? []), [pending]);

  if (!pending) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: t('teamMerge.title'), headerLeft: BackHeaderLeft }} />
        <Text className="text-sm text-gray-500">{t('teamMerge.none')}</Text>
      </SafeAreaView>
    );
  }
  const gloria = pending.kind === 'gloria';
  const dec = (it: MergeItem) => decisions.get(it.id) ?? defaultDecision(it);
  const setDec = (it: MergeItem, d: Decision) => setDecisions((m) => new Map(m).set(it.id, d));
  const setAll = (items: MergeItem[], pick: 'local' | 'remote') =>
    setDecisions((m) => {
      const next = new Map(m);
      for (const it of items) next.set(it.id, { pick });
      return next;
    });

  const run = async (backup: boolean) => {
    setBusy(true);
    try {
      const res = await applyPendingMerge(pending, decisions, { backup });
      usePendingMerge.getState().set(null);
      const lines = [t('teamMerge.doneMsg', { count: res.ops })];
      if (res.backup) lines.push(t('teamMerge.doneBackup', { name: res.backup.name }));
      if (res.skippedPhotos > 0) lines.push(t('recordImport.donePhotosSkipped', { count: res.skippedPhotos }));
      Alert.alert(t('teamMerge.doneTitle'), lines.join('\n'));
      router.replace(hrefOf(pending));
    } catch (e) {
      setBusy(false);
      if (backup) {
        // The backup (an export) failed before anything was written.
        Alert.alert(t('teamMerge.backupFailTitle'), t('teamMerge.backupFailMsg', { error: errText(e) }), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('teamMerge.continueWithout'), style: 'destructive', onPress: () => void run(false) },
        ]);
      } else {
        toast(errText(e));
      }
    }
  };
  const apply = () => {
    const deletes = review.filter((it) => dec(it).pick === 'remote' && (it.remote == null)).length;
    Alert.alert(
      t('teamMerge.applyTitle'),
      [t('teamMerge.applyMsg', { name: pending.label }), deletes ? t('teamMerge.applyDeletes', { count: deletes }) : '']
        .filter(Boolean)
        .join('\n'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('teamMerge.apply'), onPress: () => void run(true) },
      ],
    );
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: t('teamMerge.title'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4">
        <View className="gap-1">
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">{pending.label}</Text>
          {pending.from ? (
            <Text className="text-sm text-[#00797b] dark:text-cyan-300">
              {pending.fromAt
                ? t('teamMerge.fromAt', { name: pending.from, date: isoStamp(pending.fromAt).slice(0, 16) })
                : t('teamMerge.from', { name: pending.from })}
            </Text>
          ) : null}
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {t('teamMerge.summary', {
              added: counts.added,
              auto: counts.auto,
              review: review.length,
            })}
          </Text>
          {gloria ? <Text className="text-xs text-gray-500 dark:text-gray-400">{t('teamMerge.gloriaMediaNote')}</Text> : null}
        </View>

        {review.length > 0 ? (
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
                {t('teamMerge.reviewHeader', { count: review.length })}
              </Text>
              <Pressable onPress={() => setAll(review, 'local')} hitSlop={6}>
                <Text className="text-xs text-[#00797b] dark:text-cyan-300">{t('teamMerge.allMine')}</Text>
              </Pressable>
              <Pressable onPress={() => setAll(review, 'remote')} hitSlop={6}>
                <Text className="text-xs text-[#00797b] dark:text-cyan-300">{t('teamMerge.allTheirs')}</Text>
              </Pressable>
            </View>
            {review.map((it) => (
              <ReviewCard key={it.id} item={it} decision={dec(it)} onChange={(d) => setDec(it, d)} gloria={gloria} />
            ))}
          </View>
        ) : null}

        {auto.length > 0 ? (
          <View className="gap-1">
            <Text className="text-xs font-semibold text-gray-600 dark:text-gray-300">
              {t('teamMerge.autoHeader', { count: auto.length })}
            </Text>
            <View className="rounded-xl border border-gray-200 bg-white px-3 dark:border-gray-800 dark:bg-gray-900">
              {auto.map((it) => {
                const on = dec(it).pick !== 'local';
                return <AutoRow key={it.id} item={it} on={on} onToggle={() => setDec(it, { pick: on ? 'local' : 'remote' })} />;
              })}
            </View>
          </View>
        ) : null}

        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('teamMerge.backupNote')}</Text>
      </ScrollView>
      <View className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <Pressable
          onPress={apply}
          disabled={busy}
          accessibilityRole="button"
          className={`items-center rounded-xl py-3 ${busy ? 'bg-gray-400' : 'bg-[#00A2A5] active:bg-[#008284]'}`}
        >
          <Text className="text-base font-semibold text-white">{busy ? t('teamMerge.applying') : t('teamMerge.apply')}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
