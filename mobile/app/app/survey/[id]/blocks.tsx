/**
 * A census's sync blocks and who works on which (Modular_survey.md §5.4,
 * §7.9; 1C-b). Claims are a hint to the team, not a lock (decided
 * 2026-10-01): tap a block to claim or release it for this phone's group;
 * it goes out with the next 同步, and editing a tree in a block another group
 * claims asks first. The grid is drawn as the plot lies: north (the last
 * row of blocks) at the top.
 */
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isoStamp } from '~/lib/datetime';
import { BackHeaderLeft } from '~/lib/goBack';
import { blockStates, setMyClaim, type BlockState } from '~/survey/censusSync';

export default function CensusBlocksScreen() {
  const { t } = useTranslation();
  const surveyId = Number(useLocalSearchParams<{ id: string }>().id);
  const [states, setStates] = useState<BlockState[] | null>(null);
  const load = useCallback(() => setStates(blockStates(surveyId)), [surveyId]);
  useFocusEffect(load);

  const toggle = (b: BlockState) => {
    setMyClaim(surveyId, b.block, !b.mine);
    load();
  };

  const maxBc = Math.max(0, ...(states ?? []).map((b) => b.bc));
  const maxBr = Math.max(0, ...(states ?? []).map((b) => b.br));
  const at = (bc: number, br: number) => states?.find((b) => b.bc === bc && b.br === br);

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('survey.sync.blocks'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4">
        <Text className="text-xs leading-5 text-ink-2 dark:text-gray-400">{states ? t('survey.sync.claimsHint') : t('survey.sync.blocksUndecided')}</Text>
        {states ? (
          <ScrollView horizontal contentContainerClassName="gap-2">
            <View className="gap-2">
              {Array.from({ length: maxBr + 1 }, (_, i) => maxBr - i).map((br) => (
                <View key={br} className="flex-row gap-2">
                  {Array.from({ length: maxBc + 1 }, (_, bc) => {
                    const b = at(bc, br);
                    if (!b) return <View key={bc} className="w-28" />;
                    return (
                      <Pressable
                        key={bc}
                        onPress={() => toggle(b)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: b.mine }}
                        accessibilityLabel={t('survey.sync.blockA11y', { label: b.label })}
                        className={`min-h-[84px] w-28 gap-1 rounded-xl border p-2 ${
                          b.mine ? 'border-accent-600 bg-accent-tint dark:border-accent-400 dark:bg-accent-950' : b.others.length ? 'border-acorn bg-acorn-tint dark:bg-gray-800' : 'border-line bg-card dark:border-line-dark dark:bg-card-dark'
                        }`}
                      >
                        <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs font-bold text-ink dark:text-gray-100">
                          {b.label}
                        </Text>
                        <Text className="text-[11px] text-ink-2 dark:text-gray-300" numberOfLines={2}>
                          {[b.mine ? t('survey.sync.claimMine') : null, ...b.others].filter(Boolean).join('、') || t('survey.sync.claimNone')}
                        </Text>
                        <Text className="text-[10px] text-ink-3 dark:text-gray-400" numberOfLines={1}>
                          {b.unsent ? t('survey.sync.unsent') : b.syncedAt ? isoStamp(b.syncedAt).slice(5, 16) : ''}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
