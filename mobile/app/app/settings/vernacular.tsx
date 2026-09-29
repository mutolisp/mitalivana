/**
 * Vernacular languages — which common names a species shows, and in what order.
 *
 * A language is offered once its checklist is enabled and downloaded (TaiCOL →
 * zh-TW, YList → ja; see VERNACULAR_LANGS). Ticked languages are joined with
 * " / " in the order listed here, the first being the primary name; at most
 * three, at least one. The setting only changes what is shown (screens and
 * exports) — search still matches every enabled checklist's names.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { clearSearchResultCache } from '~/components/SearchBox';
import { Section } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { clearTaxonomyCache } from '~/db';
import { getEnabledRegions } from '~/db/regions';
import { MAX_VERNACULAR_LANGS, VERNACULAR_LANGS } from '~/db/mergeScope';
import { useSettings, type VernacularLang } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';
import { SelectMark } from '~/components/ui/SelectMark';

const LABEL: Record<VernacularLang, { name: string; source: string }> = {
  'zh-TW': { name: 'vernacular.zhTW', source: 'vernacular.zhTWSource' },
  ja: { name: 'vernacular.ja', source: 'vernacular.jaSource' },
};

export default function VernacularScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const langs = useSettings((s) => s.vernacular_langs);
  const setSetting = useSettings((s) => s.set);
  // Enabled ∩ downloaded; re-read on focus, the region page may have changed it.
  const [regions, setRegions] = useState(() => getEnabledRegions());
  useFocusEffect(useCallback(() => setRegions(getEnabledRegions()), []));

  const available = VERNACULAR_LANGS.filter((v) => regions.includes(v.region)).map((v) => v.lang);
  const chosen = langs.filter((l) => available.includes(l));
  const rest = available.filter((l) => !chosen.includes(l));

  const save = (next: VernacularLang[]) => {
    // Languages whose checklist is off right now stay in the setting, after the
    // visible ones, so switching the checklist back on restores them.
    const hidden = langs.filter((l) => !available.includes(l));
    setSetting('vernacular_langs', [...next, ...hidden].slice(0, MAX_VERNACULAR_LANGS));
    clearSearchResultCache();
    clearTaxonomyCache();
  };
  const toggle = (lang: VernacularLang) => {
    if (chosen.includes(lang)) {
      if (chosen.length === 1) return Alert.alert(t('vernacular.keepOne'));
      return save(chosen.filter((l) => l !== lang));
    }
    if (langs.length >= MAX_VERNACULAR_LANGS) return Alert.alert(t('vernacular.max', { n: MAX_VERNACULAR_LANGS }));
    save([...chosen, lang]);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...chosen];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save(next);
  };

  const row = (lang: VernacularLang, i: number | null) => {
    const on = i != null;
    return (
      <View key={lang} className="flex-row items-center border-b border-gray-100 bg-card px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <Pressable
          onPress={() => toggle(lang)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: on }}
          accessibilityLabel={t(LABEL[lang].name)}
          className="flex-1 flex-row items-center"
        >
          <SelectMark state={on ? 'on' : 'off'} />
          <View className="ml-3 flex-1">
            <Text className="text-base text-gray-900 dark:text-gray-100">
              {on && chosen.length > 1 ? `${i + 1}. ` : ''}
              {t(LABEL[lang].name)}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400">{t(LABEL[lang].source)}</Text>
          </View>
        </Pressable>
        {on && chosen.length > 1 ? (
          <View className="flex-row">
            <Pressable onPress={() => move(i, -1)} disabled={i === 0} hitSlop={6} accessibilityLabel={t('vernacular.moveUp')} className="p-1.5">
              {/* Disabled fades, keeping its colour (05-controls.md §2.5). */}
              <Ionicons name="arrow-up" size={20} color={c.ink2} style={{ opacity: i === 0 ? 0.35 : 1 }} />
            </Pressable>
            <Pressable onPress={() => move(i, 1)} disabled={i === chosen.length - 1} hitSlop={6} accessibilityLabel={t('vernacular.moveDown')} className="p-1.5">
              <Ionicons name="arrow-down" size={20} color={c.ink2} style={{ opacity: i === chosen.length - 1 ? 0.35 : 1 }} />
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <SettingsPage>
      <ScrollView contentContainerClassName="pb-8">
        <Text className="px-4 pt-4 text-sm text-gray-600 dark:text-gray-300">{t('vernacular.hint', { n: MAX_VERNACULAR_LANGS })}</Text>
        <Section title={t('vernacular.order')}>
          {chosen.map((l, i) => row(l, i))}
          {rest.map((l) => row(l, null))}
        </Section>
        {available.length < 2 ? (
          <Text className="px-4 pt-3 text-xs text-gray-500 dark:text-gray-400">{t('vernacular.onlyOne', { page: t('settings.regionPacks') })}</Text>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
