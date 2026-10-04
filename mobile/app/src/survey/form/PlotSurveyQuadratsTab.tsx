/**
 * The quadrat tab of a plot-style survey (2G-d4): its second unit level drawn
 * as the fixed plot's 「小樣方」 tab (src/components/quadrat/PlotQuadratsTab.tsx)
 * — where they sit and how far each is, the species they found that the plot
 * list lacks, one row per quadrat, a short summary, and a dock that continues
 * with the first unfinished one or adds the next.
 *
 * What the template records there (quadratModel.ts): a cover per species when
 * its Abundance takes percentages, the occurrences' Frequency, the ground
 * covers its Environment asks for on that level. A quadrat is done when it is
 * marked so (v89 done_at). The grid, its top edge and the method are the
 * template's, so there are no settings here. A new quadrat is Q1, Q2 …, put
 * in the subplot asked for.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { STATUS_KEY, topEdgeName } from '~/components/quadrat/names';
import { Info, QuadratDiagram, StatusBadge, Stat } from '~/components/quadrat/PlotQuadratsTab';
import { Button } from '~/components/ui/Button';
import { Chevron } from '~/components/ui/Chevron';
import { ListRow } from '~/components/ui/ListRow';
import { Tag } from '~/components/ui/Tag';
import { layerLabel, type FixedLayer } from '~/db';
import { withTransaction } from '~/db/init';
import { freqCells, quadratProgress, type QuadratProgress } from '~/lib/quadratProgress';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import type { UnitRow } from '~/survey/db/surveyCore';
import { addOccurrence, addUnit, readComponent } from '~/survey/db/surveys';
import type { ComponentValues } from '~/survey/registry';
import { layerCountOf } from './checks';
import { formComponents } from './occurrenceForm';
import { nextUnitCode } from './plotStyle';
import { coverOf, herbLayer, quadratLike, quadratSetup, taxaNotInPlotList } from './quadratModel';
import { formErrorText, levelLabel } from './text';
import type { OccurrenceView, SurveyForm } from './useSurveyForm';

export type QuadratRow = { unit: UnitRow; species: OccurrenceView[]; env: ComponentValues; progress: QuadratProgress };

export const speciesName = (o: Pick<OccurrenceView, 'common_name_c' | 'simple_name' | 'taxon_id'>) => o.common_name_c || o.simple_name || o.taxon_id;

/** The second-level units in walking order, each with its species, its ground covers and where it stands. */
export function quadratRows(data: SurveyForm): QuadratRow[] {
  const setup = quadratSetup(data.template);
  if (!setup) return [];
  return data.units
    .filter((u) => u.unit.level_key === setup.level)
    .map(({ unit }) => {
      const species = data.occurrences.filter((o) => o.unit_id === unit.id && !o.via_interaction);
      const env = setup.env ? readComponent({ kind: 'unit', id: unit.id }, setup.env.key) : {};
      const progress = quadratProgress(
        quadratLike(unit.done_at != null, setup.mode, env),
        species.map((o) => ({ name: speciesName(o), cover_pct: coverOf(o), freq_cells: o.freq_cells, freq_count: o.freq_count })),
        { cover: setup.recordCover, freq: !!setup.freq },
      );
      return { unit, species, env, progress };
    });
}

/** "Q3 S1": the code, then its name, else the subplot it sits in. */
export function quadratTitle(unit: UnitRow, units: SurveyForm['units']): string {
  const parent = unit.parent_id == null ? undefined : units.find((u) => u.unit.id === unit.parent_id)?.unit;
  const place = unit.label || (parent ? (parent.label ?? parent.code) : '');
  return place ? `${unit.code} ${place}` : unit.code;
}

/** The species a quadrat adds to: the herb layer when the template has layers. */
export function quadratLayer(data: SurveyForm): FixedLayer | null {
  const stratified = formComponents(data.template, 'occurrence').some((x) => x.type === 'structure');
  return stratified ? herbLayer(layerCountOf(data.template, data.surveyValues) ?? 4) : null;
}

export function PlotSurveyQuadratsTab({ data, edit, onChanged }: { data: SurveyForm; edit: RecordEditing; onChanged: () => void }) {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { survey, template } = data;
  const rows = useMemo(() => quadratRows(data), [data]);
  const setup = useMemo(() => quadratSetup(template), [template]);
  const missing = useMemo(() => taxaNotInPlotList(data.units.map((u) => u.unit), data.occurrences, data.levelKeys), [data]);
  const summary = useMemo(() => {
    const cells = setup ? setup.n * setup.n : 1;
    const taxa = new Map<string, { name: string; pct: number }>();
    for (const r of rows) {
      for (const o of r.species) {
        const cur = taxa.get(o.taxon_id) ?? { name: speciesName(o), pct: 0 };
        // Mean over all quadrats: a species absent from one counts 0 there.
        cur.pct += (freqCells(o, setup?.mode ?? 'cells') / cells) * 100;
        taxa.set(o.taxon_id, cur);
      }
    }
    const vasc = rows.map((r) => r.env.vascular_cover_pct).filter((v): v is number => typeof v === 'number');
    const top = [...taxa.values()].sort((a, b) => b.pct - a.pct)[0];
    return {
      species: taxa.size,
      vascular: vasc.length ? Math.round((vasc.reduce((a, b) => a + b, 0) / vasc.length) * 10) / 10 : null,
      top: top && top.pct > 0 ? `${top.name} ${Math.round(top.pct / Math.max(1, rows.length))}%` : null,
    };
  }, [rows, setup]);
  if (!setup) return null;

  const suffix = edit.unlocked ? '?unlocked=1' : '';
  const open = (id: number) => router.push(`/survey/form/${survey.id}/quadrat/${id}${suffix}` as Href);
  const next = rows.find((r) => r.progress.status !== 'done');
  const layer = quadratLayer(data);
  const subplotLevel = data.levelKeys[0];
  const subplots = data.units.filter((u) => u.unit.level_key === subplotLevel).map((u) => u.unit);

  const addMissing = () => {
    if (edit.refuse()) return;
    try {
      withTransaction(() => {
        for (const m of missing) addOccurrence(survey.id, { taxon_id: m.taxon_id, unit_id: m.parentId, layer });
      });
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    toast(t('plot.quadrats.addedToLayer', { n: missing.length, layer: layer ? layerLabel(layer) : '' }));
    onChanged();
  };

  const addQuadrat = async () => {
    if (edit.refuse()) return;
    const code = nextUnitCode(
      rows.map((r) => r.unit.code),
      'Q',
    );
    let parentId: number | null = subplots.length === 1 ? subplots[0].id : null;
    if (subplots.length > 1) {
      const i = await showActionSheet({
        title: t('surveyForm.quadrat.addWhere', { code, level: levelLabel(t, i18n.language, template, subplotLevel) }),
        options: subplots.map((s) => ({
          label: s.label && s.label !== s.code ? `${s.code} ${s.label}` : s.code,
          description:
            rows
              .filter((r) => r.unit.parent_id === s.id)
              .map((r) => r.unit.code)
              .join('、') || undefined,
        })),
      });
      if (i < 0) return;
      parentId = subplots[i].id;
    }
    let id: number;
    try {
      id = addUnit(survey.id, { levelKey: setup.level, code, parentId, sort: rows.length });
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    onChanged();
    open(id);
  };

  return (
    <View className="flex-1">
      <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4">
        {/* Where the quadrats sit, by number (the template places none). */}
        <View className="flex-row gap-4 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
          <QuadratDiagram items={rows.map((r) => ({ id: r.unit.id, label: r.unit.code, position: null, status: r.progress.status }))} layout="custom" onOpen={open} />
          <View className="flex-1 gap-1">
            <Info label={t('plot.quadrats.count')} value={String(rows.length)} />
            {setup.freq ? (
              <>
                <Info label={t('plot.quadrats.gridN')} value={`${setup.n} × ${setup.n}`} />
                <Info label={t('plot.quadrats.topEdge')} value={topEdgeName(t, setup.topEdge)} />
              </>
            ) : null}
          </View>
        </View>

        {missing.length ? (
          <View className="flex-row items-center gap-3 rounded-card bg-acorn-tint px-4 py-3 dark:bg-gray-800">
            <Text className="flex-1 text-sm text-acorn-deep dark:text-acorn">{t('plot.quadrats.notInPlot', { n: missing.length })}</Text>
            <Button
              label={layer ? t('plot.quadrats.addToLayer', { layer: layerLabel(layer) }) : t('common.add')}
              variant="secondary"
              disabled={edit.locked}
              onPress={addMissing}
            />
          </View>
        ) : null}

        {rows.length ? (
          <View className="overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
            {rows.map((r, i) => {
              const p = r.progress;
              const meta = [
                t('plot.quadrats.metaSpecies', { n: p.species }),
                setup.recordCover && p.species > 0 && p.covered === p.species ? t('plot.quadrats.metaCoverDone') : null,
                setup.freq && p.species > 0 ? t('plot.quadrats.metaFreq', { done: p.withFreq, total: p.species }) : null,
              ]
                .filter(Boolean)
                .join(' · ');
              const title = quadratTitle(r.unit, data.units);
              return (
                <ListRow
                  key={r.unit.id}
                  leading={<StatusBadge label={r.unit.code} status={p.status} />}
                  title={
                    <View className="flex-row flex-wrap items-center gap-1.5">
                      <Text className="text-base font-medium text-ink dark:text-gray-100" numberOfLines={1}>
                        {title.slice(r.unit.code.length).trim() || r.unit.code}
                      </Text>
                      {p.missingFreq ? <Tag kind="alert" label={t('plot.quadrats.missingFreq')} /> : null}
                      {p.missingCover ? <Tag kind="alert" label={t('plot.quadrats.missingCover')} /> : null}
                    </View>
                  }
                  meta={meta}
                  trailing={<Chevron />}
                  onPress={() => open(r.unit.id)}
                  divider={i < rows.length - 1}
                  accessibilityLabel={`${title}, ${t(STATUS_KEY[p.status])}`}
                />
              );
            })}
          </View>
        ) : (
          <Text className="text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.unit.empty')}</Text>
        )}

        {rows.length ? (
          <View className="flex-row gap-2 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
            <Stat label={t('plot.quadrats.summarySpecies')} value={String(summary.species)} />
            <Stat label={t('plot.quadrats.summaryVascular')} value={summary.vascular != null ? `${summary.vascular}%` : '—'} />
            <Stat label={t('plot.quadrats.summaryTopFreq')} value={summary.top ?? '—'} />
          </View>
        ) : null}
      </ScrollView>

      {!edit.locked ? (
        <View className="flex-row items-center gap-3 border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
          {next ? (
            <View className="flex-1">
              <Button size="lg" fullWidth icon="play" label={t('plot.quadrats.continue', { label: quadratTitle(next.unit, data.units) })} onPress={() => open(next.unit.id)} />
            </View>
          ) : (
            <View className="flex-1" />
          )}
          <Pressable
            onPress={() => void addQuadrat()}
            accessibilityRole="button"
            accessibilityLabel={t('surveyForm.unit.addTitle', { level: levelLabel(t, i18n.language, template, setup.level) })}
            className="h-14 w-14 items-center justify-center rounded-full bg-accent-600 active:bg-accent-700 dark:bg-accent-500"
          >
            <Ionicons name="add" size={28} color={c.onAccent} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
