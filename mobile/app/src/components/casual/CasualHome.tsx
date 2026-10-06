/**
 * 我的觀察 — the records tab in casual mode (design 18c). Named observations
 * (the daily checklists' records) and pending ones (待鑑定) together, by day,
 * newest first; filters 全部 / 待鑑定 / 未上傳, and a card that leads through
 * the pending ones one by one. A row opens 這是什麼？ (app/observe.tsx).
 * The ⋯ switches between rows and two-column photo cards (`records_layout`,
 * shared with the pro records tab: it is the same tab).
 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, SectionList, Text, TextInput, View } from 'react-native';

import { MenuButton, showMenu } from '~/components/OverflowMenu';
import { ScientificName } from '~/components/ScientificName';
import { KINGDOM_ICON } from '~/components/casual/kingdomIcon';
import { Chip } from '~/components/ui/Chip';
import {
  groupByDay,
  listDailyRecords,
  listPending,
  parsePhotoPaths,
  resolveTaxa,
  type PendingKingdom,
} from '~/db';
import { safeAppFileUri } from '~/lib/appFiles';
import { clockTime, dayTitle } from '~/lib/casualFormat';
import { useTabBarInset } from '~/lib/tabBarLayout';
import { useSettings, type RecordsLayout } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

type Base = { key: string; observed_at: number; photos: string[]; audio: string[]; note: string };
type Named = Base & {
  kind: 'record';
  id: number;
  session_id: number;
  cname: string;
  name: string;
  rank: string;
  kingdom: string;
  uploaded: boolean;
};
type Pending = Base & { kind: 'pending'; id: number; kingdom: PendingKingdom; uploaded: boolean };
type Item = Named | Pending;
type Filter = 'all' | 'pending' | 'notUploaded';
/** One list row, or one row of up to two cards. */
type Cell = { key: string; items: Item[] };

function loadItems(): Item[] {
  const records = listDailyRecords();
  const taxa = resolveTaxa([...new Set(records.map((r) => r.taxon_id))]);
  const named: Item[] = records.map((r) => {
    const tx = taxa.get(r.taxon_id);
    return {
      kind: 'record',
      key: `r${r.id}`,
      id: r.id,
      session_id: r.session_id,
      observed_at: r.observed_at,
      photos: parsePhotoPaths(r.photo_paths),
      audio: parsePhotoPaths(r.audio_paths),
      note: r.notes ?? '',
      cname: tx?.common_name_c ?? '',
      name: tx?.simple_name ?? r.taxon_id,
      rank: tx?.rank ?? '',
      kingdom: tx?.kingdom ?? '',
      uploaded: r.inat_uploaded_at != null,
    };
  });
  const pending: Item[] = listPending().map((p) => ({
    kind: 'pending',
    key: `p${p.id}`,
    id: p.id,
    observed_at: p.observed_at,
    photos: parsePhotoPaths(p.photo_paths),
    audio: parsePhotoPaths(p.audio_paths),
    note: p.note ?? '',
    kingdom: p.kingdom,
    uploaded: p.inat_uploaded_at != null,
  }));
  return [...named, ...pending];
}

/** Not on iNaturalist yet, and could be: iNaturalist takes an observation with a photo or a sound. */
const uploadable = (it: Item) =>
  it.kind === 'record' && !it.uploaded && it.photos.length + it.audio.length > 0;
const keep = (it: Item, f: Filter) =>
  f === 'all' || (f === 'pending' ? it.kind === 'pending' : uploadable(it));

export function CasualHome() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const tabBarInset = useTabBarInset();
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const layout = useSettings((s) => s.records_layout);

  useFocusEffect(
    useCallback(() => {
      setItems(loadItems());
    }, []),
  );

  const counts = useMemo(
    () => ({
      all: items.length,
      pending: items.filter((it) => it.kind === 'pending').length,
      notUploaded: items.filter((it) => keep(it, 'notUploaded')).length,
    }),
    [items],
  );

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = items.filter(
      (it) =>
        keep(it, filter) &&
        (!q ||
          it.note.toLowerCase().includes(q) ||
          (it.kind === 'record'
            ? it.cname.toLowerCase().includes(q) || it.name.toLowerCase().includes(q)
            : t(`casual.kingdom.${it.kingdom}`).toLowerCase().includes(q))),
    );
    const per = layout === 'card' ? 2 : 1;
    return groupByDay(shown).map((d) => {
      const data: Cell[] = [];
      for (let i = 0; i < d.items.length; i += per) {
        const cell = d.items.slice(i, i + per);
        data.push({ key: cell.map((it) => it.key).join('+'), items: cell });
      }
      return { key: d.day, title: dayTitle(d.items[0].observed_at), count: d.items.length, data };
    });
  }, [items, filter, query, t, layout]);

  const openMore = (anchor: RefObject<View | null>) =>
    showMenu(anchor, () => [
      {
        items: [
          {
            kind: 'segmented',
            id: 'layout',
            label: t('menu.layout'),
            value: useSettings.getState().records_layout,
            options: [
              { value: 'list', icon: 'list', label: t('records.layoutToList') },
              { value: 'card', icon: 'grid-outline', label: t('records.layoutToCard') },
            ],
            onChange: (v) => useSettings.getState().set('records_layout', v as RecordsLayout),
          },
        ],
      },
    ]);

  const firstPending = items.find((it): it is Pending => it.kind === 'pending');
  const open = (it: Item) =>
    router.push(
      (it.kind === 'record'
        ? `/observe?record=${it.id}&session=${it.session_id}`
        : `/observe?pending=${it.id}`) as Href,
    );

  const header = (
    <View>
      {/* Starter tasks go here in casual mode, beside the pending card (Q7,
          docs/planned/UI_modes.md); their content is not designed yet. */}
      {filter === 'all' && firstPending && !query ? (
        <Pressable
          onPress={() => router.push(`/observe?pending=${firstPending.id}&next=1` as Href)}
          accessibilityRole="button"
          className="mb-3 flex-row items-center gap-3 rounded-card bg-acorn-tint px-3.5 py-3 active:opacity-80 dark:bg-gray-800"
        >
          <View className="h-10 w-10 items-center justify-center rounded-full bg-card dark:bg-card-dark">
            <Text className="text-xl font-bold text-acorn-deep dark:text-acorn">?</Text>
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-bold text-gray-900 dark:text-gray-100">
              {t('casual.nudgeTitle', { count: counts.pending })}
            </Text>
            <Text className="text-[13px] text-gray-600 dark:text-gray-400">
              {t('casual.nudgeBody')}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={c.cupule} />
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1 bg-paper dark:bg-paper-dark">
      <View className="bg-card px-4 pb-3 pt-4 dark:bg-gray-900">
        <View className="flex-row items-center gap-2">
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            className="flex-1 text-3xl font-bold text-gray-900 dark:text-gray-100"
          >
            {t('casual.homeTitle')}
          </Text>
          <MenuButton onOpen={openMore} />
        </View>
        <View
          className="mt-3 flex-row items-center rounded-full border border-line bg-card px-4 dark:border-line-dark dark:bg-card-dark"
          style={{ minHeight: 44 }}
        >
          <Ionicons name="search" size={18} color={c.ink3} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('casual.searchMine')}
            placeholderTextColor={c.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={t('casual.searchMine')}
            className="ml-2 flex-1 py-2 text-base text-gray-900 dark:text-gray-100"
          />
          {query ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={12}
              accessibilityLabel={t('common.clear')}
            >
              <Ionicons name="close-circle" size={18} color={c.ink3} />
            </Pressable>
          ) : null}
        </View>
        <View accessibilityRole="tablist" className="mt-3 flex-row gap-2">
          <Chip
            label={t('casual.filterAll')}
            count={counts.all}
            selected={filter === 'all'}
            onPress={() => setFilter('all')}
          />
          <Chip
            label={t('casual.filterPending')}
            count={counts.pending}
            selected={filter === 'pending'}
            onPress={() => setFilter('pending')}
          />
          <Chip
            label={t('casual.filterNotUploaded')}
            count={counts.notUploaded}
            selected={filter === 'notUploaded'}
            onPress={() => setFilter('notUploaded')}
          />
        </View>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(it) => it.key}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: tabBarInset + 16,
        }}
        renderSectionHeader={({ section }) => (
          <View className="flex-row items-baseline gap-2 px-0.5 pb-1.5 pt-2">
            <Text className="text-[15px] font-bold text-gray-900 dark:text-gray-100">
              {section.title}
            </Text>
            <Text className="text-[13px] text-gray-500 dark:text-gray-400">
              {t('casual.dayCount', { count: section.count })}
            </Text>
          </View>
        )}
        renderItem={({ item: cell, index, section }) =>
          layout === 'card' ? (
            <View className="mb-3 flex-row gap-3">
              {cell.items.map((it) => (
                <Card key={it.key} item={it} onPress={() => open(it)} />
              ))}
              {cell.items.length < 2 ? <View className="flex-1" /> : null}
            </View>
          ) : (
            <Row
              item={cell.items[0]}
              first={index === 0}
              last={index === section.data.length - 1}
              onPress={() => open(cell.items[0])}
            />
          )
        }
        ListEmptyComponent={
          <View className="items-center px-6 pt-16">
            <Ionicons name="camera-outline" size={48} color={c.ink3} />
            <Text className="mt-3 text-center text-base text-gray-600 dark:text-gray-400">
              {items.length === 0 ? t('casual.empty') : t('casual.emptyFiltered')}
            </Text>
          </View>
        }
      />
    </View>
  );
}

type TFn = ReturnType<typeof useTranslation>['t'];

/** A row's photo: the full row height, this wide. */
const ROW_PHOTO_WIDTH = 80;

/** 「3 張照片」, 「照片」, 「錄音」, or nothing. */
function mediaLabel(item: Item, t: TFn): string | null {
  return item.photos.length > 1
    ? t('casual.photosN', { count: item.photos.length })
    : item.photos.length === 1
      ? t('casual.photo')
      : item.audio.length > 0
        ? t('casual.audio')
        : null;
}

/** What stands in for a photo: a recording, else the kingdom (a leaf when it is none of the three). */
function placeholderIcon(item: Item): keyof typeof Ionicons.glyphMap {
  if (item.audio.length) return 'mic-outline';
  return KINGDOM_ICON[item.kingdom as PendingKingdom] ?? 'leaf-outline';
}

function Row({
  item,
  first,
  last,
  onPress,
}: {
  item: Item;
  first: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const photo = item.photos[0] ? safeAppFileUri(item.photos[0]) : null;
  const media = mediaLabel(item, t);
  const meta = [clockTime(item.observed_at)];
  if (item.kind === 'record') {
    if (media) meta.push(media);
    if (uploadable(item)) meta.push(t('casual.notUploaded'));
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={`flex-row items-center gap-3 overflow-hidden border-x border-t border-line bg-card px-3 py-2.5 active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800 ${
        first ? 'rounded-t-card' : ''
      } ${last ? 'mb-2 rounded-b-card border-b' : ''}`}
    >
      {/* The photo (or the icon standing in for it) runs the row's full
          height from its left edge; the negative margins undo the padding. */}
      <View
        className="-my-2.5 -ml-3 items-center justify-center bg-accent-tint dark:bg-accent-950/40"
        style={{ width: ROW_PHOTO_WIDTH, alignSelf: 'stretch', minHeight: 72 }}
      >
        {photo ? (
          <Image
            source={{ uri: photo }}
            // Absolute: the text sets the row's height, not the picture's own size.
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
            contentFit="cover"
          />
        ) : (
          <Ionicons name={placeholderIcon(item)} size={26} color={c.accent} />
        )}
      </View>
      <View className="min-w-0 flex-1">
        {item.kind === 'record' ? (
          <>
            {item.cname ? (
              <Text
                numberOfLines={1}
                className="text-base font-medium text-gray-900 dark:text-gray-100"
              >
                {item.cname}
              </Text>
            ) : null}
            <ScientificName
              name={item.name}
              rank={item.rank}
              kingdom={item.kingdom}
              numberOfLines={1}
              className="text-sm text-gray-700 dark:text-gray-300"
            />
          </>
        ) : (
          <View className="flex-row items-center gap-1.5">
            <View className="rounded-full bg-acorn-tint px-2 dark:bg-gray-800">
              <Text className="text-xs font-bold text-acorn-deep dark:text-acorn">
                {t('casual.pendingBadge')}
              </Text>
            </View>
            <Text numberOfLines={1} className="flex-1 text-[15px] text-gray-700 dark:text-gray-300">
              {[t(`casual.kingdom.${item.kingdom}`), media].filter(Boolean).join(' · ')}
            </Text>
          </View>
        )}
        <Text numberOfLines={1} className="text-xs text-gray-500 dark:text-gray-400">
          {meta.join(' · ')}
        </Text>
      </View>
      {item.uploaded ? (
        <View
          accessibilityLabel={t('casual.uploaded')}
          className="h-7 w-7 items-center justify-center rounded-full bg-accent-tint dark:bg-accent-950/40"
        >
          <Ionicons name="checkmark" size={16} color={c.accent} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Card view: the photo first, square, then the name and the time. */
function Card({ item, onPress }: { item: Item; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const photo = item.photos[0] ? safeAppFileUri(item.photos[0]) : null;
  const meta = [clockTime(item.observed_at)];
  const media = mediaLabel(item, t);
  if (media && item.photos.length !== 1) meta.push(media);
  if (uploadable(item)) meta.push(t('casual.notUploaded'));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-1 overflow-hidden rounded-card border border-line bg-card active:opacity-80 dark:border-line-dark dark:bg-card-dark"
    >
      <View
        className="items-center justify-center bg-accent-tint dark:bg-accent-950/40"
        style={{ width: '100%', aspectRatio: 1 }}
      >
        {photo ? (
          <Image
            source={{ uri: photo }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
          />
        ) : (
          <Ionicons name={placeholderIcon(item)} size={40} color={c.accent} />
        )}
        {item.uploaded ? (
          <View
            accessibilityLabel={t('casual.uploaded')}
            className="absolute right-2 top-2 h-7 w-7 items-center justify-center rounded-full bg-card dark:bg-card-dark"
          >
            <Ionicons name="checkmark" size={16} color={c.accent} />
          </View>
        ) : null}
      </View>
      <View className="px-2.5 pb-2.5 pt-2">
        {item.kind === 'record' ? (
          <>
            {item.cname ? (
              <Text
                numberOfLines={1}
                className="text-[15px] font-medium text-gray-900 dark:text-gray-100"
              >
                {item.cname}
              </Text>
            ) : null}
            <ScientificName
              name={item.name}
              rank={item.rank}
              kingdom={item.kingdom}
              numberOfLines={1}
              className={
                item.cname
                  ? 'text-xs text-gray-700 dark:text-gray-300'
                  : 'text-[15px] text-gray-900 dark:text-gray-100'
              }
            />
          </>
        ) : (
          <View className="flex-row items-center gap-1.5">
            <View className="rounded-full bg-acorn-tint px-2 dark:bg-gray-800">
              <Text className="text-xs font-bold text-acorn-deep dark:text-acorn">
                {t('casual.pendingBadge')}
              </Text>
            </View>
            <Text numberOfLines={1} className="flex-1 text-sm text-gray-700 dark:text-gray-300">
              {t(`casual.kingdom.${item.kingdom}`)}
            </Text>
          </View>
        )}
        <Text numberOfLines={1} className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {meta.join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}
