/**
 * A permanent plot's unit layout (fw_frame_units, Modular_survey.md §5.5):
 * the subplots and quadrats every plot-style survey on it starts with. A unit
 * a survey used keeps its code, parent and level and cannot be deleted, only
 * retired (new surveys leave it out; older ones still point at it). The label
 * can always change. Units added during a survey join the layout by
 * themselves; this screen is for laying one out beforehand and retiring.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { promptText } from '~/components/TextPromptModal';
import { Button } from '~/components/ui/Button';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { labelText } from '~/survey/components/editors/shared';
import { getFrame } from '~/survey/db/stemmap';
import { snapshotOf } from '~/survey/db/surveyCore';
import { addFrameUnit, deleteFrameUnit, frameUnitUsed, listFrameUnits, listSurveys, setFrameUnitRetired, updateFrameUnit } from '~/survey/db/surveys';
import { formErrorText } from '~/survey/form/text';
import { unitRows } from '~/survey/form/units';
import { userTemplates } from '~/survey/builder/drafts';
import { SURVEY_FORMS_OFFERED } from '~/survey/templates/samples';
import type { UnitLevel } from '~/survey/template/types';

function load(frameId: number) {
  const frame = getFrame(frameId);
  if (!frame) return null;
  // Unit levels as the templates used on this plot name them, then the user's plot templates, top first.
  const levels: UnitLevel[] = [];
  const templates = [...listSurveys({ frameId }).map((s) => snapshotOf(s)), ...(SURVEY_FORMS_OFFERED ? userTemplates().filter((x) => x.style === 'plot') : [])];
  for (const tpl of templates) for (const u of tpl.units ?? []) if (!levels.some((l) => l.key === u.key)) levels.push(u);
  const all = listFrameUnits(frameId, { includeRetired: true });
  for (const u of all) if (!levels.some((l) => l.key === u.level_key)) levels.push({ key: u.level_key, label: { text: u.level_key } });
  const rows = unitRows(
    levels.map((l) => l.key),
    all.map((u) => ({ ...u, sort: 0 })),
  ).map((r) => ({ ...r, used: frameUnitUsed(r.unit.id) }));
  return { frame, levels, rows };
}

export default function FrameUnitsScreen() {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const toast = useToast((s) => s.show);
  const frameId = Number(useLocalSearchParams<{ id: string }>().id);
  const [data, setData] = useState(() => load(frameId));
  const reload = useCallback(() => setData(load(frameId)), [frameId]);
  useFocusEffect(reload);
  if (!data) return null;
  const levelName = (key: string) => labelText(t, i18n.language, data.levels.find((l) => l.key === key)?.label, key);

  const run = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      toast(formErrorText(t, e));
    }
    reload();
  };

  const menu = async (r: (typeof data.rows)[number]) => {
    const u = r.unit;
    const items: { label: string; destructive?: boolean; go: () => Promise<void> | void }[] = [
      {
        label: t('surveyForm.unit.label'),
        go: async () => {
          const v = await promptText({ title: t('surveyForm.unit.label'), defaultValue: u.label ?? '', allowEmpty: true });
          if (v != null) run(() => updateFrameUnit(u.id, { label: v.trim() || null }));
        },
      },
      ...(!r.used
        ? [
            {
              label: t('surveyForm.unit.code'),
              go: async () => {
                const v = await promptText({ title: t('surveyForm.unit.code'), defaultValue: u.code, autoCapitalize: 'characters' });
                if (v?.trim()) run(() => updateFrameUnit(u.id, { code: v.trim() }));
              },
            },
          ]
        : []),
      { label: u.retired_at == null ? t('surveyForm.frame.retire') : t('surveyForm.frame.unretire'), go: () => run(() => setFrameUnitRetired(u.id, u.retired_at == null)) },
      ...(!r.used ? [{ label: t('common.delete'), destructive: true, go: () => run(() => deleteFrameUnit(u.id)) }] : []),
    ];
    const idx = await showActionSheet({
      title: r.path,
      message: r.used ? t('surveyForm.frame.usedNote') : undefined,
      options: items.map((x) => ({ label: x.label, destructive: x.destructive })),
      cancelLabel: t('common.cancel'),
    });
    await items[idx]?.go();
  };

  const add = async () => {
    if (!data.levels.length) {
      toast(t('surveyForm.frame.noLevels'));
      return;
    }
    const li = await showActionSheet({
      title: t('surveyForm.frame.addUnit'),
      options: data.levels.map((l) => ({ label: levelName(l.key) })),
      cancelLabel: t('common.cancel'),
    });
    const level = data.levels[li];
    if (!level) return;
    let parentId: number | null = null;
    if (li > 0) {
      const parents = data.rows.filter((r) => r.unit.level_key === data.levels[li - 1].key && r.unit.retired_at == null);
      const pi = await showActionSheet({
        title: t('surveyForm.frame.pickParent', { level: levelName(data.levels[li - 1].key) }),
        options: [{ label: t('surveyForm.frame.noParent') }, ...parents.map((p) => ({ label: p.path }))],
        cancelLabel: t('common.cancel'),
      });
      if (pi < 0 || pi > parents.length) return;
      parentId = pi === 0 ? null : parents[pi - 1].unit.id;
    }
    const code = await promptText({ title: t('surveyForm.unit.addTitle', { level: levelName(level.key) }), message: t('surveyForm.unit.codeMsg'), autoCapitalize: 'characters' });
    if (!code?.trim()) return;
    const input = { levelKey: level.key, code: code.trim(), parentId };
    run(() => void addFrameUnit(frameId, input));
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('surveyForm.frame.unitsTitle', { code: data.frame.code }), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-2 p-4 pb-10">
        <Text className="text-sm leading-5 text-ink-2 dark:text-gray-300">{t('surveyForm.frame.unitsDesc')}</Text>
        {data.rows.map((r) => (
          <Pressable
            key={r.unit.id}
            onPress={() => void menu(r)}
            accessibilityRole="button"
            style={{ marginLeft: r.depth * 20 }}
            className={`flex-row items-center gap-2 rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark ${r.unit.retired_at != null ? 'opacity-60' : ''}`}
          >
            <View className="flex-1">
              <Text className="font-mono text-base font-bold text-ink dark:text-gray-100">{r.path}</Text>
              <Text className="mt-0.5 text-xs text-ink-3 dark:text-gray-400">
                {[levelName(r.unit.level_key), r.unit.label, r.unit.retired_at != null ? t('surveyForm.frame.retired') : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {r.used ? <Ionicons name="lock-closed-outline" size={16} color={c.ink3} accessibilityLabel={t('surveyForm.frame.usedNote')} /> : null}
          </Pressable>
        ))}
        <Button label={t('surveyForm.frame.addUnit')} icon="add" variant="secondary" onPress={() => void add()} />
      </ScrollView>
    </SafeAreaView>
  );
}
