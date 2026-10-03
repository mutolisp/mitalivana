/**
 * A survey's interactions (2F; canvas 14c): by type, each as stored (subject
 * → object, ↔ both ways), or one type as a matrix — subjects (A) by rows,
 * objects (B) by columns, the times added up (a row without a count is one).
 * Species are told apart by their names, so the same species in two units is
 * one row. Read again whenever the screen comes back into view.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Pressable, ScrollView, Text, View } from 'react-native';
import { Seg } from '~/components/form/Segmented';
import { Chip } from '~/components/ui/Chip';
import { FormCard } from '~/survey/components/FormBits';
import { interactionTypes, type InteractionListRow } from '~/survey/db/interactionCore';
import { listInteractions, listOccurrences, listUnits } from '~/survey/db/surveys';
import { typeLabel } from '~/survey/form/interactionText';
import { unitPath } from '~/survey/form/units';
import { occurrenceTitle, withNames, type Named } from '~/survey/form/useSurveyForm';
import type { OccurrenceRow } from '~/survey/db/surveyCore';
import type { SurveyTemplate } from '~/survey/template/types';
import { interactionHref } from './InteractionCard';
import { OccurrenceName } from './NameText';

type Loaded = { rows: InteractionListRow[]; occ: Map<number, Named<OccurrenceRow>>; places: Map<number, string> };

function load(surveyId: number, plot: boolean): Loaded {
  const units = plot ? listUnits(surveyId) : [];
  return {
    rows: listInteractions(surveyId),
    occ: new Map(withNames(listOccurrences(surveyId)).map((o) => [o.id, o])),
    places: new Map(units.map((u) => [u.id, unitPath(units, u.id)])),
  };
}

export function InteractionSummary({ surveyId, template, unlocked }: { surveyId: number; template: SurveyTemplate; unlocked: boolean }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const lang = i18n.language;
  const [data, setData] = useState<Loaded>(() => load(surveyId, template.style === 'plot'));
  useFocusEffect(useCallback(() => setData(load(surveyId, template.style === 'plot')), [surveyId, template.style]));
  const [mode, setMode] = useState<'type' | 'matrix'>('type');
  const types = interactionTypes(template);
  const used = types.filter((ty) => data.rows.some((r) => r.type_code === ty.code));
  const [matrixType, setMatrixType] = useState<string | null>(null);
  const shownType = used.find((x) => x.code === matrixType) ?? used[0];
  /** A species is told apart by its name (as written: label, or common and scientific). */
  const name = (occ: number) => {
    const o = data.occ.get(occ);
    return o ? occurrenceTitle(o) : '?';
  };
  /** The name as shown: the scientific part in italics where its rank asks. */
  const shown = (occ: number, bold?: boolean) => {
    const o = data.occ.get(occ);
    return o ? <OccurrenceName o={o} bold={bold} /> : '?';
  };

  if (!data.rows.length) {
    return (
      <View className="p-4">
        <Text className="text-sm leading-5 text-ink-3 dark:text-gray-400">{t('survey.interaction.empty')}</Text>
      </View>
    );
  }

  const matrix = (() => {
    if (!shownType) return null;
    const mine = data.rows.filter((r) => r.type_code === shownType.code);
    // One occurrence per name stands for it in the headers.
    const firstOf = new Map<string, number>();
    for (const r of mine) for (const occ of [r.subject_occurrence_id, r.object_occurrence_id]) if (!firstOf.has(name(occ))) firstOf.set(name(occ), occ);
    const rowsOf = [...new Set(mine.map((r) => name(r.subject_occurrence_id)))].sort((x, y) => x.localeCompare(y, lang));
    const cols = [...new Set(mine.map((r) => name(r.object_occurrence_id)))].sort((x, y) => x.localeCompare(y, lang));
    const cell = new Map<string, number>();
    for (const r of mine) {
      const k = `${name(r.subject_occurrence_id)}\u0000${name(r.object_occurrence_id)}`;
      cell.set(k, (cell.get(k) ?? 0) + (r.count ?? 1));
    }
    return { rowsOf, cols, firstOf, at: (a: string, b: string) => cell.get(`${a}\u0000${b}`) ?? 0 };
  })();

  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
      <Seg
        value={mode}
        options={[
          { value: 'type' as const, label: t('survey.interaction.byType') },
          { value: 'matrix' as const, label: t('survey.interaction.matrix') },
        ]}
        onChange={setMode}
      />
      {mode === 'type'
        ? used.map((ty) => {
            const mine = data.rows.filter((r) => r.type_code === ty.code);
            return (
              <FormCard key={ty.code} title={`${typeLabel(t, lang, ty, ty.code)} · ${t('survey.interaction.count', { count: mine.length })}`}>
                {mine.map((r) => (
                  <Pressable
                    key={r.id}
                    onPress={() => {
                      Keyboard.dismiss();
                      router.push(interactionHref(r.id, r.subject_occurrence_id, unlocked));
                    }}
                    accessibilityRole="button"
                    className="flex-row items-center gap-2 border-t border-line pt-2 active:opacity-70 dark:border-line-dark"
                    style={{ minHeight: 44 }}
                  >
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-ink dark:text-gray-100">
                        {shown(r.subject_occurrence_id, true)}
                        {` ${r.mutual ? '↔' : '→'} `}
                        {shown(r.object_occurrence_id, true)}
                      </Text>
                      {r.unit_id != null ? <Text className="font-mono text-xs text-ink-3 dark:text-gray-400">{data.places.get(r.unit_id) ?? ''}</Text> : null}
                    </View>
                    {r.count != null ? <Text className="font-mono text-sm font-bold text-ink-2 dark:text-gray-300">×{r.count}</Text> : null}
                  </Pressable>
                ))}
              </FormCard>
            );
          })
        : null}
      {mode === 'matrix' && matrix && shownType ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            {used.map((ty) => (
              <Chip key={ty.code} label={typeLabel(t, lang, ty, ty.code)} selected={ty.code === shownType.code} onPress={() => setMatrixType(ty.code)} />
            ))}
          </View>
          <Text className="text-xs leading-4 text-ink-2 dark:text-gray-300">{t('survey.interaction.matrixDesc', { type: typeLabel(t, lang, shownType, shownType.code) })}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View className="rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
              <View className="flex-row border-b border-line dark:border-line-dark">
                <View style={{ width: 120 }} />
                {matrix.cols.map((col) => (
                  <Text key={col} className="px-2 py-2 text-center text-xs font-bold text-ink-2 dark:text-gray-300" style={{ width: 88 }} numberOfLines={3}>
                    {shown(matrix.firstOf.get(col)!, true)}
                  </Text>
                ))}
              </View>
              {matrix.rowsOf.map((row) => (
                <View key={row} className="flex-row items-center border-b border-line dark:border-line-dark">
                  <Text className="px-2 py-2 text-xs font-bold text-ink dark:text-gray-100" style={{ width: 120 }} numberOfLines={2}>
                    {shown(matrix.firstOf.get(row)!, true)}
                  </Text>
                  {matrix.cols.map((col) => {
                    const n = matrix.at(row, col);
                    return (
                      <Text key={col} className={`py-2 text-center font-mono text-sm ${n ? 'font-bold text-ink dark:text-gray-100' : 'text-ink-3 dark:text-gray-500'}`} style={{ width: 88 }}>
                        {n ? String(n) : '·'}
                      </Text>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}
    </ScrollView>
  );
}
