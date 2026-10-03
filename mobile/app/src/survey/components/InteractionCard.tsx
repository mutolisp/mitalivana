/**
 * An occurrence's interactions (2F; canvas 14b): every one it takes part in,
 * whichever side it was recorded from, read from this occurrence (→ it does,
 * ← done to it, ↔ both), and the way to record another. Read again whenever
 * the screen comes back into view (the interaction screen writes behind it).
 *
 * A sealed blind occurrence still takes new interactions once the blind phase
 * is closed (decided 2026-10-03): only a locked survey turns this read-only.
 *
 * The keyboard is closed before opening one: this screen's abundance field
 * may hold it open, and arriving with it open latches the next screen's
 * docked search at the keyboard's height (found on an iPhone, 2026-10-03).
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { Button } from '~/components/ui/Button';
import { isoTime } from '~/lib/datetime';
import { useThemeColors } from '~/theme/colors';
import { componentLabel } from '~/survey/components/editors/ComponentEditor';
import { FormCard } from '~/survey/components/FormBits';
import { interactionTypes, type InteractionListRow } from '~/survey/db/interactionCore';
import { listInteractions, listOccurrences } from '~/survey/db/surveys';
import { ARROW, seenLine, slot } from '~/survey/form/interactionText';
import { occurrenceTitle, withNames, type Named } from '~/survey/form/useSurveyForm';
import type { OccurrenceRow } from '~/survey/db/surveyCore';
import { OccurrenceName, withSlots } from './NameText';
import type { ComponentInstance, SurveyTemplate } from '~/survey/template/types';

type Loaded = { rows: InteractionListRow[]; occ: Map<number, Named<OccurrenceRow>> };

function load(surveyId: number, occurrenceId: number): Loaded {
  const rows = listInteractions(surveyId, { occurrenceId });
  const occ = new Map(withNames(listOccurrences(surveyId)).map((o) => [o.id, o]));
  return { rows, occ };
}

export const interactionHref = (id: number | 'new', from: number, unlocked: boolean) =>
  `/survey/form/interaction/${id}?from=${from}${unlocked ? '&unlocked=1' : ''}` as Href;

export function InteractionCard({
  surveyId,
  occurrenceId,
  instance,
  template,
  locked,
  unlocked,
  refuse,
}: {
  surveyId: number;
  occurrenceId: number;
  instance: ComponentInstance;
  template: SurveyTemplate;
  locked: boolean;
  unlocked: boolean;
  refuse: () => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useThemeColors();
  const router = useRouter();
  const [data, setData] = useState<Loaded>(() => load(surveyId, occurrenceId));
  useFocusEffect(useCallback(() => setData(load(surveyId, occurrenceId)), [surveyId, occurrenceId]));
  const types = new Map(interactionTypes(template).map((x) => [x.code, x]));
  const open = (id: number | 'new') => {
    if (locked && id === 'new') return refuse();
    Keyboard.dismiss();
    router.push(interactionHref(id, occurrenceId, unlocked));
  };

  return (
    <FormCard title={componentLabel(t, i18n.language, instance)} right={<Text className="text-xs text-ink-3 dark:text-gray-400">{t('survey.interaction.count', { count: data.rows.length })}</Text>}>
      {data.rows.map((r) => {
        const partner = data.occ.get(r.subject_occurrence_id === occurrenceId ? r.object_occurrence_id : r.subject_occurrence_id);
        const ty = types.get(r.type_code);
        const line = seenLine(t, i18n.language, ty, r, occurrenceId, slot('partner'));
        const said = seenLine(t, i18n.language, ty, r, occurrenceId, partner ? occurrenceTitle(partner) : '?').text;
        const meta = [isoTime(r.observed_at), r.photos ? t('survey.interaction.photos', { count: r.photos }) : null].filter(Boolean).join(' · ');
        return (
          <Pressable
            key={r.id}
            onPress={() => open(r.id)}
            accessibilityRole="button"
            accessibilityLabel={`${ARROW[line.direction]} ${said}`}
            className="flex-row items-center gap-2.5 border-t border-line pt-2 active:opacity-70 dark:border-line-dark"
            style={{ minHeight: 48 }}
          >
            <Text className={`w-6 text-center text-lg font-bold ${line.direction === 'backward' ? 'text-acorn-deep dark:text-acorn' : 'text-accent-700 dark:text-accent-300'}`}>
              {ARROW[line.direction]}
            </Text>
            <View className="flex-1">
              <Text className="text-base font-semibold text-ink dark:text-gray-100">{withSlots(line.text, { partner: partner ? <OccurrenceName o={partner} bold /> : '?' })}</Text>
              <Text className="text-xs text-ink-3 dark:text-gray-400">{meta}</Text>
            </View>
            {r.count != null ? <Text className="font-mono text-sm font-bold text-ink-2 dark:text-gray-300">×{r.count}</Text> : null}
            <Ionicons name="chevron-forward" size={18} color={c.ink3} />
          </Pressable>
        );
      })}
      {data.rows.length ? <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('survey.interaction.bothPages')}</Text> : null}
      {!locked ? <Button label={t('survey.interaction.add')} icon="add" variant="secondary" onPress={() => open('new')} /> : null}
    </FormCard>
  );
}
