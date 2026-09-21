/**
 * The preferred-people list, used for both DwC roles.
 *
 * Surveyors (recordedBy) and identifiers (identifiedBy) are two separate lists
 * — the same person is routinely on both — but the screen is the same one:
 * star to mark a default, tap to rename, swipe to delete, long-press ☰ to
 * reorder. `app/surveyors.tsx` and `app/identifiers.tsx` are the two routes.
 *
 * Only the wording differs per role, and it is spelled out as literal `t()`
 * calls rather than a key built from `kind`: a runtime-built key is invisible to
 * `npm run check:i18n`, which is how four keys once shipped missing.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from 'react-native-draggable-flatlist';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { promptText } from '~/components/TextPromptModal';
import { SwipeRow } from '~/components/SwipeRow';
import { useStore } from 'zustand';
import { peopleStore } from '~/stores/surveyors';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import type { PersonKind, Surveyor } from '~/db';

export function PeopleListScreen({ kind }: { kind: PersonKind }) {
  const { t } = useTranslation();
  // `useStore(api, selector)` rather than calling the bound hook held in a
  // variable — see peopleStore's docblock for what the indirect form did.
  const store = peopleStore(kind);
  const items = useStore(store, (s) => s.items);
  const refresh = useStore(store, (s) => s.refresh);
  const add = useStore(store, (s) => s.add);
  const rename = useStore(store, (s) => s.rename);
  const remove = useStore(store, (s) => s.remove);
  const toggleDefault = useStore(store, (s) => s.toggleDefault);
  const reorder = useStore(store, (s) => s.reorder);

  const identifier = kind === 'identifier';
  const labels = identifier
    ? {
        navTitle: t('nav.identifiers'),
        addTitle: t('identifiers.addTitle'),
        create: t('identifiers.create'),
        hint: t('identifiers.hint'),
        empty: t('identifiers.empty'),
      }
    : {
        navTitle: t('nav.surveyors'),
        addTitle: t('surveyors.addTitle'),
        create: t('surveyors.create'),
        hint: t('surveyors.hint'),
        empty: t('surveyors.empty'),
      };

  useFocusEffect(useCallback(() => refresh(), [refresh]));

  const handleAdd = async () => {
    const name = await promptText({
      title: labels.addTitle,
      placeholder: t('surveyors.namePlaceholder'),
      confirmText: labels.create,
      autoCapitalize: 'words',
    });
    if (name?.trim()) add(name);
  };

  const handleRename = async (id: number, current: string) => {
    const name = await promptText({
      title: t('surveyors.renameTitle'),
      defaultValue: current,
      confirmText: t('common.save'),
      autoCapitalize: 'words',
    });
    if (name?.trim()) rename(id, name);
  };

  const renderItem = ({ item, drag, isActive }: RenderItemParams<Surveyor>) => (
    <ScaleDecorator>
      <SwipeRow onDelete={() => remove(item.id)} label={t('common.delete')}>
        <View
          className={`flex-row items-center border-b border-gray-100 bg-white px-4 dark:border-gray-800 dark:bg-gray-900 ${isActive ? 'opacity-90' : ''}`}
        >
          <Pressable
            onPress={() => toggleDefault(item.id, !item.is_default)}
            hitSlop={10}
            className="mr-3 py-3"
          >
            <Ionicons
              name={item.is_default ? 'star' : 'star-outline'}
              size={20}
              color={item.is_default ? '#d97706' : '#9ca3af'}
            />
          </Pressable>
          <Pressable
            onPress={() => handleRename(item.id, item.name)}
            className="flex-1 py-3 active:opacity-60"
          >
            <Text className="text-base text-gray-900 dark:text-gray-100">{item.name}</Text>
          </Pressable>
          {item.is_default ? (
            <Text className="mr-3 text-xs font-medium text-amber-700 dark:text-amber-300">
              {t('surveyors.default')}
            </Text>
          ) : null}
          {/* Drag handle — long-press to pick up and reorder. */}
          <Pressable onLongPress={drag} delayLongPress={120} hitSlop={10} className="py-3 pl-1">
            <Ionicons name="reorder-three" size={24} color="#9ca3af" />
          </Pressable>
        </View>
      </SwipeRow>
    </ScaleDecorator>
  );

  return (
    <SettingsPage
      title={labels.navTitle}
      headerRight={() => <HeaderIconButton icon="add" onPress={handleAdd} label={labels.create} />}
    >
      <View className="border-b border-gray-100 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-950">
        <Text className="text-xs text-gray-500 dark:text-gray-400">{labels.hint}</Text>
      </View>
      <DraggableFlatList
        data={items}
        keyExtractor={(s) => String(s.id)}
        onDragEnd={({ data }) => reorder(data)}
        containerStyle={{ flex: 1 }}
        ListEmptyComponent={
          <View className="px-4 py-16">
            <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
              {labels.empty}
            </Text>
          </View>
        }
        renderItem={renderItem}
      />
    </SettingsPage>
  );
}
