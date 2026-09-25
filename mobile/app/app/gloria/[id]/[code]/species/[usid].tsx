/**
 * One species in one GLORIA unit: its value (cover / abundance, cf), where it
 * sits in the classification, a way into the identification key for its
 * genus or family when one exists, phenology, and notes.
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getKeysForScope, sourceOfTaxonId, type IdentificationKey } from '~/db';
import { BackHeaderLeft } from '~/lib/goBack';
import { leafPhenologyOptions, parseMultiAttribute, reproductiveOptions, serializeMultiAttribute } from '~/lib/dwcAttributes';
import { useSettings } from '~/stores/settings';
import { getUnitSpecies, removeUnitSpecies, updateUnitSpecies, type UnitSpeciesPatch } from '~/modules/gloria/db';
import { unitTypeOf } from '~/modules/gloria/model/units';
import { displayName } from '~/modules/gloria/useSurvey';
import { Btn, Card, Chip, Label, NumAccessory, NumField } from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';

const ABUNDANCE = ['r!', 'r', 's', 'c', 'd'] as const;

export default function GloriaSpeciesScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; code: string; usid: string }>();
  const usid = Number(params.usid);
  const type = unitTypeOf(String(params.code));
  const [s, setS] = useState(() => getUnitSpecies(usid));
  const reload = useCallback(() => setS(getUnitSpecies(usid)), [usid]);
  useFocusEffect(reload);
  const twOn = useSettings((st) => st.enabled_regions.includes('TW'));

  const keys = useMemo<IdentificationKey[]>(() => {
    if (!s || !twOn || sourceOfTaxonId(s.taxon_id) !== 'taicol') return [];
    const found = [
      ...(s.genus ? getKeysForScope('genus', s.genus) : []),
      ...(s.family ? getKeysForScope('family', s.family) : []),
    ];
    const seen = new Set<number>();
    return found.filter((k) => !seen.has(k.id) && !!seen.add(k.id));
  }, [s, twOn]);

  if (!s) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const patch = (p: UnitSpeciesPatch) => {
    updateUnitSpecies(s.id, p);
    reload();
  };
  const repro = parseMultiAttribute(s.reproductive_condition);
  const leaf = parseMultiAttribute(s.leaf_phenology);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const lineage: Array<[string, string, string]> = [
    ['kingdom', s.kingdom_c, s.kingdom],
    ['phylum', s.phylum_c, s.phylum],
    ['class', s.class_c, s.class],
    ['order', s.order_c, s.order],
    ['family', s.family_c, s.family],
    ['genus', s.genus_c, s.genus],
  ];

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: displayName(s), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <View>
          <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">{displayName(s)}</Text>
          <Text className="text-sm text-gray-600 dark:text-gray-300">
            <Text className="italic">{s.simple_name}</Text> {s.name_author}
          </Text>
          <Text className="mt-0.5 text-xs text-gray-400">{t('gloria.species.inUnit', { code: params.code, serial: s.serial })}</Text>
        </View>

        <Card className="gap-2 p-3">
          {type === 'sas' ? (
            <View className="flex-row items-center">
              <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">{t('gloria.species.abundance')}</Text>
              {ABUNDANCE.map((a) => (
                <Pressable
                  key={a}
                  onPress={() => patch({ abundance: s.abundance === a ? null : a })}
                  className={`ml-1 w-8 items-center rounded-md border py-1.5 ${s.abundance === a ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'}`}
                >
                  <Text className={`text-xs ${s.abundance === a ? 'font-bold text-white' : 'text-gray-600 dark:text-gray-300'}`}>{a}</Text>
                </Pressable>
              ))}
            </View>
          ) : type === 'quadrat' ? (
            <View className="flex-row items-center">
              <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">{t('gloria.species.cover')}</Text>
              <NumField value={s.cover_pct} onCommit={(v) => patch({ cover_pct: v })} range={RANGES.percent} accessibilityLabel={t('gloria.species.cover')} />
            </View>
          ) : null}
          <View className="flex-row items-center">
            <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">{t('gloria.species.cf')}</Text>
            {([null, 'g', 's', 't'] as const).map((c) => (
              <Pressable
                key={c ?? '-'}
                onPress={() => patch({ cf: c })}
                className={`ml-1 w-9 items-center rounded-md border py-1.5 ${s.cf === c ? 'border-amber-500 bg-amber-500' : 'border-gray-300 dark:border-gray-700'}`}
              >
                <Text className={`text-xs ${s.cf === c ? 'font-bold text-white' : 'text-gray-600 dark:text-gray-300'}`}>{c ?? '—'}</Text>
              </Pressable>
            ))}
          </View>
          <Text className="text-xs text-gray-400">{t('gloria.species.cfHint')}</Text>
        </Card>

        <Label>{t('gloria.species.lineage')}</Label>
        <Card className="p-3">
          {lineage.filter(([, , sci]) => sci).map(([rank, zh, sci]) => (
            <View key={rank} className="flex-row py-0.5">
              <Text className="w-16 text-xs text-gray-400">{t(`gloria.rank.${rank}`)}</Text>
              <Text className="flex-1 text-xs text-gray-900 dark:text-gray-100">
                {zh ? `${zh} ` : ''}
                <Text className={rank === 'genus' ? 'italic' : ''}>{sci}</Text>
              </Text>
            </View>
          ))}
        </Card>
        {keys.length ? (
          <View className="flex-row flex-wrap gap-2">
            {keys.map((k) => (
              <Btn key={k.id} small label={t('gloria.species.openKey', { name: k.scope_cname || k.scope_name })} onPress={() => router.push(`/key/${k.id}` as Href)} />
            ))}
          </View>
        ) : null}

        <Label>{t('gloria.species.repro')}</Label>
        <View className="flex-row flex-wrap">
          {reproductiveOptions().map((o) => (
            <Chip key={o.value} label={o.label} on={repro.includes(o.value)} onPress={() => patch({ reproductive_condition: serializeMultiAttribute(toggle(repro, o.value)) })} />
          ))}
        </View>
        <Label>{t('gloria.species.leaf')}</Label>
        <View className="flex-row flex-wrap">
          {leafPhenologyOptions().map((o) => (
            <Chip key={o.value} label={o.label} on={leaf.includes(o.value)} onPress={() => patch({ leaf_phenology: serializeMultiAttribute(toggle(leaf, o.value)) })} />
          ))}
        </View>

        <Label>{t('gloria.species.notes')}</Label>
        <TextInput
          defaultValue={s.comments ?? ''}
          onEndEditing={(e) => patch({ comments: e.nativeEvent.text.trim() || null })}
          placeholder={t('gloria.species.notesPlaceholder')}
          multiline
          className="min-h-[80px] rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          placeholderTextColor="#9ca3af"
        />
        <View className="mt-2">
          <Btn
            label={t('gloria.unit.remove')}
            onPress={() => {
              removeUnitSpecies(s.id);
              router.back();
            }}
          />
        </View>
      </ScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}
