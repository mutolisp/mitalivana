import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text } from 'react-native';
import { useFavorites } from '~/stores/favorites';

/**
 * 加入／移除常用 for a record's taxon — what the species lists' old long-press
 * menus offered, now in the detail views. No toast: those views are Modals and
 * the root-hosted toast would render behind them; the heart filling in is the
 * feedback.
 */
export function FavoriteToggle({ taxonId }: { taxonId: string }) {
  const { t } = useTranslation();
  const favorited = useFavorites((s) => s.ids.has(taxonId));
  return (
    <Pressable
      onPress={() =>
        favorited
          ? useFavorites.getState().remove(taxonId)
          : useFavorites.getState().addById(taxonId)
      }
      hitSlop={6}
      className="mt-2 flex-row items-center self-start active:opacity-70"
    >
      <Ionicons name={favorited ? 'heart' : 'heart-outline'} size={14} color="#d97706" />
      <Text className="ml-1 text-xs font-medium text-amber-700 dark:text-amber-300">
        {favorited ? t('species.inFavorites') : t('favorites.add')}
      </Text>
    </Pressable>
  );
}
