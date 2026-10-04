/**
 * Where a plot-style survey's species tabs add and list (2G-d): the fixed
 * plot's subplot button, here over every unit by its path, or outside every
 * unit. A sheet, not a chip strip: a survey can hold many units.
 */
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { DropdownChevron } from '~/components/ui/Chevron';
import type { SurveyForm } from './useSurveyForm';
import type { UnitPick } from './viewState';

export function scopeLabel(t: (k: string) => string, data: SurveyForm, scope: UnitPick): string {
  return typeof scope === 'number' ? (data.units.find((u) => u.unit.id === scope)?.path ?? '') : t('surveyForm.outsideUnits');
}

export function UnitScopeButton({ data, scope, onScope }: { data: SurveyForm; scope: UnitPick; onScope: (next: UnitPick) => void }) {
  const { t } = useTranslation();
  const pick = async () => {
    const options: { id: UnitPick; label: string }[] = [...data.units.map((u) => ({ id: u.unit.id as UnitPick, label: u.path })), { id: 'none', label: t('surveyForm.outsideUnits') }];
    const idx = await showActionSheet({
      title: t('plotSpecies.subplot'),
      options: options.map((o) => {
        const n = data.occurrences.filter((x) => !x.via_interaction && (x.unit_id ?? null) === (typeof o.id === 'number' ? o.id : null)).length;
        return { label: o.label, description: n > 0 ? t('plotStats.sppCount', { count: n }) : undefined, selected: o.id === scope };
      }),
    });
    if (idx >= 0 && idx < options.length) onScope(options[idx].id);
  };
  return (
    <Pressable
      onPress={() => void pick()}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('plotSpecies.subplot')}
      className="ml-3 flex-row items-center rounded-full bg-gray-100 px-2.5 py-1 active:bg-gray-200 dark:bg-gray-800 dark:active:bg-gray-700"
    >
      <Text className="text-[11px] font-medium text-gray-700 dark:text-gray-300" numberOfLines={1} style={{ maxWidth: 72 }}>
        {scopeLabel(t, data, scope)}
      </Text>
      <View style={{ marginLeft: 2 }}>
        <DropdownChevron />
      </View>
    </Pressable>
  );
}
