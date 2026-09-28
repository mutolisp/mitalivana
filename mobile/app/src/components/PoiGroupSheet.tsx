/**
 * Category switches for the mountain landmarks.
 *
 * Deliberately **not folded into `LayerSheet`**: that one is built for 220 NLSC
 * layers and 87 Academia Sinica WMTS layers as "single-select + search +
 * opacity", with a `selectedId: string` contract. POIs are 7 groups and
 * multi-select, and forcing them together would complicate both call sites.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { POI_GROUPS } from '~/db/rudypoi';
import { useThemeColors } from '~/theme/colors';

const ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  peaks: 'triangle-outline',
  marks: 'pin-outline',
  signs: 'trail-sign-outline',
  huts: 'home-outline',
  water: 'water-outline',
  scenic: 'eye-outline',
  trees: 'leaf-outline',
};

type Props = {
  visible: boolean;
  enabled: string[];
  available: boolean;
  onToggle: (key: string) => void;
  onClose: () => void;
};

export function PoiGroupSheet({ visible, enabled, available, onToggle, onClose }: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/40" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 12 }}
        className="rounded-t-2xl bg-card dark:bg-gray-900"
      >
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('poi.title')}
          </Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={22} color={c.ink2} />
          </Pressable>
        </View>

        {!available ? (
          <Text className="px-4 pb-4 text-sm text-gray-500 dark:text-gray-400">
            {t('poi.none')}
          </Text>
        ) : (
          <>
            {POI_GROUPS.map((g) => {
              const on = enabled.includes(g.key);
              return (
                <Pressable
                  key={g.key}
                  onPress={() => onToggle(g.key)}
                  className="flex-row items-center gap-3 border-t border-gray-100 px-4 py-3 active:bg-gray-50 dark:border-gray-800 dark:active:bg-gray-800"
                >
                  <Ionicons
                    name={ICON[g.key] ?? 'ellipse-outline'}
                    size={20}
                    color={on ? c.accent : c.ink3}
                  />
                  <Text
                    className={
                      on
                        ? 'flex-1 text-gray-900 dark:text-gray-100'
                        : 'flex-1 text-gray-500 dark:text-gray-400'
                    }
                  >
                    {t(g.labelKey)}
                  </Text>
                  {on ? <Ionicons name="checkmark" size={20} color={c.accent} /> : null}
                </Pressable>
              );
            })}
            <Text className="px-4 pt-3 text-xs text-gray-400 dark:text-gray-500">
              {t('poi.source')}
            </Text>
          </>
        )}
      </View>
    </Modal>
  );
}
