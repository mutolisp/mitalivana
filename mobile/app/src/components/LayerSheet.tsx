import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import { useThemeColors } from '~/theme/colors';
import { Radio } from '~/components/ui/Radio';
import { ActionSheetLayer, sheetBack } from '~/components/ActionSheet';

/** One selectable WMTS overlay source (e.g. Academia Sinica, NLSC). */
export type LayerSource = {
  /** Stable key for the tab. */
  key: string;
  /** Tab label. */
  label: string;
  layers: { id: string; title: string }[];
  /** Currently selected layer id for this source ('' = none). */
  selectedId: string;
  opacity: number;
  onSelect: (id: string) => void;
  onOpacityChange: (v: number) => void;
};

type Props = {
  visible: boolean;
  sources: LayerSource[];
  onClose: () => void;
};

/** Bottom-sheet WMTS overlay picker. Supports multiple sources via top tabs;
 *  each source keeps its own selected layer + opacity, so overlays can be
 *  stacked (e.g. an NLSC basemap under a Sinica historical layer). */
export function LayerSheet({ visible, sources, onClose }: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState('');

  const active = sources[tab] ?? sources[0];

  const filtered = useMemo(() => {
    if (!active) return [];
    const q = query.trim();
    if (!q) return active.layers;
    const lq = q.toLowerCase();
    return active.layers.filter((l) => l.title.includes(q) || l.id.toLowerCase().includes(lq));
  }, [active, query]);

  if (!active) return null;

  const selectedTitle =
    active.selectedId &&
    (active.layers.find((l) => l.id === active.selectedId)?.title ?? active.selectedId);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={sheetBack(onClose)}>
      <View className="flex-1">
        <Pressable
          onPress={onClose}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' }}
        />
        <View
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '75%', paddingBottom: insets.bottom }}
          className="rounded-t-2xl bg-card dark:bg-gray-900"
        >
          <View className="items-center pt-2">
            <View className="h-1 w-12 rounded-full bg-gray-300 dark:bg-gray-700" />
          </View>

          <View className="flex-row items-center justify-between border-b border-gray-100 dark:border-gray-800 px-4 py-3">
            <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('layerSheet.title')}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={c.ink2} />
            </Pressable>
          </View>

          {/* Source tabs */}
          {sources.length > 1 ? (
            <View className="flex-row border-b border-gray-100 dark:border-gray-800">
              {sources.map((s, i) => {
                const isActive = i === tab;
                return (
                  <Pressable
                    key={s.key}
                    onPress={() => {
                      setTab(i);
                      setQuery('');
                    }}
                    className={`flex-1 items-center py-2.5 ${isActive ? 'border-b-2 border-accent-500' : ''}`}
                  >
                    <Text
                      className={`text-sm ${isActive ? 'font-semibold text-accent-700 dark:text-accent-300' : 'text-gray-500 dark:text-gray-400'}`}
                    >
                      {s.label}
                      {s.selectedId ? ' ●' : ''}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {active.selectedId ? (
            <View className="border-b border-gray-100 dark:border-gray-800 bg-accent-50 dark:bg-accent-950/40 px-4 py-3">
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 text-xs font-medium text-accent-900 dark:text-accent-100" numberOfLines={1}>
                  {t('layerSheet.current', { title: selectedTitle })}
                </Text>
                <Pressable onPress={() => active.onSelect('')} hitSlop={6} className="ml-2">
                  <Text className="text-xs font-medium text-red-600 dark:text-red-400">{t('common.remove')}</Text>
                </Pressable>
              </View>
              <View className="mt-2 flex-row items-center">
                <Text className="w-12 text-xs text-accent-900 dark:text-accent-100">{t('layerSheet.opacity')}</Text>
                <Slider
                  style={{ flex: 1, height: 30 }}
                  value={active.opacity}
                  minimumValue={0.1}
                  maximumValue={1}
                  step={0.05}
                  minimumTrackTintColor={c.accent}
                  onValueChange={active.onOpacityChange}
                />
                <Text className="w-10 text-right text-xs text-accent-900 dark:text-accent-100">
                  {Math.round(active.opacity * 100)}%
                </Text>
              </View>
            </View>
          ) : null}

          <View className="border-b border-gray-100 dark:border-gray-800 px-3 py-2">
            <View className="flex-row items-center rounded-full bg-gray-100 dark:bg-gray-800 px-3 py-2">
              <Ionicons name="search" size={16} color={c.ink2} />
              <TextInput
                className="ml-2 flex-1 text-sm text-gray-900 dark:text-gray-100"
                placeholder={t('layerSheet.searchPlaceholder', { count: active.layers.length })}
                placeholderTextColor={c.ink3}
                value={query}
                onChangeText={setQuery}
                autoCorrect={false}
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={6}>
                  <Ionicons name="close-circle" size={16} color={c.ink3} />
                </Pressable>
              ) : null}
            </View>
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(l) => l.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const isActive = item.id === active.selectedId;
              return (
                <Pressable
                  onPress={() => active.onSelect(item.id)}
                  className={`flex-row items-center border-b border-gray-100 dark:border-gray-800 px-4 py-2.5 ${isActive ? 'bg-accent-50 dark:bg-accent-950/40' : 'active:bg-gray-50 dark:active:bg-gray-800'}`}
                >
                  <View style={{ marginRight: 10 }}><Radio selected={isActive} /></View>
                  <Text
                    className={`flex-1 text-sm ${isActive ? 'font-medium text-accent-700 dark:text-accent-300' : 'text-gray-800 dark:text-gray-200'}`}
                    numberOfLines={2}
                  >
                    {item.title}
                  </Text>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <View className="px-4 py-8">
                <Text className="text-center text-sm text-gray-500 dark:text-gray-400">{t('layerSheet.noMatch')}</Text>
              </View>
            }
          />
        </View>
      </View>
      <ActionSheetLayer visible={visible} />
    </Modal>
  );
}
