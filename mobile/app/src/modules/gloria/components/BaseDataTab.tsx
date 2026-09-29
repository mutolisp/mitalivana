/**
 * The base-data tab (03-screens-flow.md §4e, step 6): the p5m corners first,
 * then one list whose rows open the existing forms in place — measurement
 * points, dates, researchers, summit data, the aspect/slope carry-over,
 * notes and the paper-form scans (all four forms, which used to sit at the
 * foot of two different tabs).
 *
 * The forms themselves are unchanged. A row opens below itself; the rows
 * around it stay grouped in cards, so an open form never sits inside a card.
 */
import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, TextInput, View } from 'react-native';
import { isoDate } from '~/lib/datetime';
import { useThemeColors } from '~/theme/colors';
import { getGloriaSurvey, planTopoFromPrevious, setP5m, updateGloriaSurvey } from '../db';
import { SCAN_FORMS } from '../model/formScans';
import { parseFiles } from '../model/loggers';
import type { Direction } from '../model/units';
import type { SurveyState } from '../useSurvey';
import { FormScans } from './FormScans';
import { PointsForm } from './PointsForm';
import { SummitForm } from './SummitForm';
import { SurveyDates } from './SurveyDates';
import { SurveyResearchers } from './SurveyResearchers';
import { TopoCarry } from './TopoCarry';
import { Btn, Card } from './ui';

type Section = 'points' | 'dates' | 'researchers' | 'summit' | 'topo' | 'notes' | 'scans';

const DIRS: readonly Direction[] = ['E', 'N', 'S', 'W'];

export function BaseDataTab({
  state,
  reload,
  onHelp,
  onPointImport,
}: {
  state: SurveyState;
  reload: () => void;
  onHelp: (d: Direction) => void;
  onPointImport: () => void;
}) {
  const { t } = useTranslation();
  const tc = useThemeColors();
  const { survey, summit } = state;
  const filled = state.points.filter((p) => p.distance_m != null).length;
  // Nothing measured yet: the points are what this tab is opened for.
  const [open, setOpen] = useState<Section | null>(() => (filled === 0 ? 'points' : null));
  const prevMocy = survey.prev_survey_id != null ? (getGloriaSurvey(survey.prev_survey_id)?.mocy ?? null) : null;
  const topo = planTopoFromPrevious(survey.id);
  const scanCount = SCAN_FORMS.reduce((n, f) => n + parseFiles(survey[f.column]).length, 0);
  const firstNote = survey.notes?.split('\n')[0] ?? '';

  const rows: Array<{ key: Section; title: string; value?: string; detail?: string; body: () => ReactNode }> = [
    {
      key: 'points',
      title: t('gloria.base.points'),
      value: `${filled} / ${state.points.length}`,
      detail: prevMocy != null ? t('gloria.base.pointsCarried', { mocy: prevMocy }) : undefined,
      body: () => (
        <>
          <Btn label={t('gloria.pointImport.button')} onPress={onPointImport} />
          <PointsForm state={state} reload={reload} onHelp={onHelp} />
        </>
      ),
    },
    {
      key: 'dates',
      title: t('gloria.dates.title'),
      value: [isoDate(survey.start_ts), survey.stop_ts ? isoDate(survey.stop_ts) : null]
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .join(' – '),
      body: () => <SurveyDates state={state} reload={reload} />,
    },
    {
      key: 'researchers',
      title: t('gloria.new.surveyors'),
      detail: survey.recorded_by || t('gloria.times.byNone'),
      body: () => <SurveyResearchers state={state} reload={reload} />,
    },
    {
      key: 'summit',
      title: t('gloria.summit.title'),
      detail: [
        summit.decimal_latitude != null && summit.decimal_longitude != null ? t('gloria.base.hasCoords') : null,
        summit.elevation_m != null ? `${summit.elevation_m} m` : null,
        summit.veg_zone,
      ]
        .filter(Boolean)
        .join(' · ') || t('gloria.base.summitDetail'),
      body: () => <SummitForm state={state} reload={reload} />,
    },
    // Only for surveys created before new ones carried aspect and slope by themselves.
    ...(topo
      ? [
          {
            key: 'topo' as const,
            title: t('gloria.topo.carry', { mocy: topo.prev.mocy }),
            body: () => <TopoCarry state={state} reload={reload} />,
          },
        ]
      : []),
    {
      key: 'notes',
      title: t('gloria.notes.title'),
      detail: firstNote || t('gloria.base.empty'),
      body: () => (
        // Form 1 COMMENTS; exported as the comments column of sheet 01_.
        <TextInput
          key={`notes-${survey.id}`}
          defaultValue={survey.notes ?? ''}
          onEndEditing={(e) => {
            const v = e.nativeEvent.text.trim() || null;
            if (v !== survey.notes) {
              updateGloriaSurvey(survey.id, { notes: v });
              reload();
            }
          }}
          placeholder={t('gloria.notes.placeholder')}
          placeholderTextColor={tc.ink3}
          multiline
          accessibilityLabel={t('gloria.notes.title')}
          className="min-h-[96px] rounded-xl border border-line bg-card p-2.5 text-sm text-ink dark:border-line-dark dark:bg-card-dark dark:text-gray-100"
          style={{ textAlignVertical: 'top' }}
        />
      ),
    },
    {
      key: 'scans',
      title: t('gloria.base.scans'),
      value: scanCount ? String(scanCount) : undefined,
      detail: 'Form 1 · 2 · 3 · 6-S',
      body: () => (
        <>
          {SCAN_FORMS.map((f) => (
            <FormScans key={f.form} state={state} reload={reload} form={f.form} />
          ))}
        </>
      ),
    },
  ];

  // Consecutive closed rows share a card; the open row gets its own, with
  // its form below it.
  const blocks: Array<{ rows: typeof rows; open: boolean }> = [];
  for (const r of rows) {
    const isOpen = r.key === open;
    const last = blocks[blocks.length - 1];
    if (!isOpen && last && !last.open) last.rows.push(r);
    else blocks.push({ rows: [r], open: isOpen });
  }

  const header = (r: (typeof rows)[number], k: number) => {
    const isOpen = r.key === open;
    return (
      <Pressable
        key={r.key}
        onPress={() => setOpen(isOpen ? null : r.key)}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        className={`flex-row items-center px-3.5 py-2.5 active:bg-gray-100 dark:active:bg-gray-800 ${k ? 'border-t border-line dark:border-line-dark' : ''}`}
        style={{ minHeight: 52 }}
      >
        <View className="flex-1 pr-2">
          <Text className="text-base font-medium text-ink dark:text-gray-100">{r.title}</Text>
          {r.detail ? (
            <Text numberOfLines={1} className="text-xs text-gray-500 dark:text-gray-400">
              {r.detail}
            </Text>
          ) : null}
        </View>
        {r.value ? (
          <Text className="mr-1.5 text-sm text-gray-600 dark:text-gray-300" style={{ fontVariant: ['tabular-nums'] }}>
            {r.value}
          </Text>
        ) : null}
        <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={16} color={tc.ink3} />
      </Pressable>
    );
  };

  return (
    <>
      {/* p5m corners on top: every 3×3 m cluster is laid out from it. */}
      <Card>
        <Text className="px-3.5 pt-3 text-xs font-bold text-gray-500 dark:text-gray-400" style={{ letterSpacing: 0.96 }}>
          {t('gloria.base.p5mTitle')}
        </Text>
        <View className="px-2 pb-2 pt-1">
          {DIRS.map((d) => {
            const cur = state.p5m[d];
            return (
              <View
                key={d}
                className={`flex-row items-center rounded-lg px-1.5 py-1 ${cur ? '' : 'bg-alert-tint dark:bg-alert-dark-tint'}`}
              >
                <Text className="w-8 font-mono text-base font-bold text-ink dark:text-gray-100">{d}</Text>
                <Text className={`flex-1 text-xs ${cur ? 'text-gray-500 dark:text-gray-400' : 'text-alert dark:text-alert-dark'}`}>
                  {cur ? `p5m ${d}${cur}` : t('gloria.base.p5mUnset')}
                </Text>
                <View className="flex-row rounded-lg border border-line p-0.5 dark:border-line-dark">
                  {(['11', '31'] as const).map((c) => {
                    const on = cur === c;
                    return (
                      <Pressable
                        key={c}
                        onPress={() => {
                          setP5m(survey.id, d, c);
                          reload();
                        }}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={`p5m ${d}${c}`}
                        className={`items-center justify-center rounded-md px-4 ${on ? 'bg-accent-600 dark:bg-accent-400' : ''}`}
                        style={{ minHeight: 36 }}
                      >
                        <Text className={`font-mono text-sm font-bold ${on ? 'text-white dark:text-gray-950' : 'text-ink dark:text-gray-100'}`}>
                          {c}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      </Card>

      {blocks.map((b) =>
        b.open ? (
          <View key={b.rows[0].key} className="gap-3">
            <Card>{header(b.rows[0], 0)}</Card>
            {b.rows[0].body()}
          </View>
        ) : (
          <Card key={b.rows[0].key}>{b.rows.map((r, k) => header(r, k))}</Card>
        ),
      )}
    </>
  );
}
