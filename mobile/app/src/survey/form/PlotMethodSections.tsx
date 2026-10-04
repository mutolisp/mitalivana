/**
 * A plot-style survey's 分層 and 小區, as the fixed plot draws them, in its
 * 調查法 group (moved from the end of the environment tab on 2026-10-04, when
 * the builder's cards took the same four groups):
 *
 *   - the survey's Structure as the fixed plot's 分層 section: layer count,
 *     and each layer's cover, height and default unit;
 *   - the template's first unit level as its 小區 section (count, names, one
 *     size or each its own — on a permanent plot the layout's size), with
 *     「其他欄位 ›」 to the unit page when the template asks more of a 小區.
 */
import { useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { LayerSectionView, SubplotSectionView, type LayerPatch, type SubplotValues } from '~/components/plot/EnvSections';
import { getActiveLayers, MAX_LAYER_COUNT, type AbundanceMethod } from '~/db';
import { withTransaction } from '~/db/init';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useToast } from '~/stores/toast';
import type { ComponentOwner, UnitRow } from '~/survey/db/surveyCore';
import { addUnit, deleteUnit, getFrameUnit, listUnits, updateFrameUnit, updateUnit, writeComponent } from '~/survey/db/surveys';
import type { ComponentValues, FieldValue } from '~/survey/registry';
import type { ComponentInstance } from '~/survey/template/types';
import { layerCountOf } from './checks';
import { formComponents } from './occurrenceForm';
import { layerRows, nextUnitCode } from './plotStyle';
import { formErrorText } from './text';
import { unitRows } from './units';
import type { SurveyForm } from './useSurveyForm';

type Props = { data: SurveyForm; edit: RecordEditing; onChanged: () => void };

/** The survey's Structure as the fixed plot's 分層. */
export function PlotLayerSection({ data, edit, onChanged, component: c }: Props & { component: ComponentInstance }) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const owner: ComponentOwner = { kind: 'survey', id: data.survey.id };
  const v = data.surveyValues[c.key] ?? {};
  const count = layerCountOf(data.template, data.surveyValues) ?? 4;
  const methods = (Array.isArray(c.params.methods) ? c.params.methods : []) as AbundanceMethod[];

  /** One edit: refused while locked; a value the store refuses is told. */
  const write = (run: () => void) => {
    if (edit.refuse()) return;
    try {
      run();
    } catch (e) {
      toast(formErrorText(t, e));
    }
    onChanged();
  };

  return (
    <LayerSectionView
      layerCount={count}
      maxLayers={MAX_LAYER_COUNT}
      activeLayers={getActiveLayers(count)}
      layers={layerRows(v, count)}
      methods={methods}
      onLayerCount={(n) => write(() => writeComponent(owner, c.key, { layer_count: n }))}
      onPatchLayer={(idx, fields: LayerPatch) =>
        write(() => writeComponent(owner, c.key, Object.fromEntries(Object.entries(fields).map(([f, x]) => [f, { [idx]: x as FieldValue }])) as ComponentValues))
      }
    />
  );
}

/** The unit level `level` as the fixed plot's 小區: on a permanent plot each takes the layout's size. */
export function PlotSubplotSection({ data, edit, onChanged, level }: Props & { level: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { template } = data;
  const id = data.survey.id;
  const subplots = data.units.filter((u) => u.unit.level_key === level);
  // What the template records on a subplot beyond its layers (the species tab's) is on the unit page.
  const subplotFields = formComponents(template, { unit: level }).some((c) => c.type !== 'structure');

  const toRows = (list: readonly { unit: UnitRow }[]): SubplotValues[] =>
    list.map(({ unit }, i) => {
      const fu = unit.frame_unit_id != null ? getFrameUnit(unit.frame_unit_id) : null;
      return { id: unit.id, idx: i + 1, label: unit.label ?? unit.code, width_m: unit.width_m ?? fu?.width_m ?? null, length_m: unit.length_m ?? fu?.length_m ?? null };
    });
  const subplotRows = toRows(subplots);

  return (
    <SubplotSectionView
      subplots={subplotRows}
      setCount={(n) => {
        if (edit.refuse()) return subplotRows;
        try {
          withTransaction(() => {
            const codes = subplots.map((u) => u.unit.code);
            for (let k = subplots.length; k < n; k++) {
              const code = nextUnitCode(codes);
              codes.push(code);
              addUnit(id, { levelKey: level, code, label: code, sort: k });
            }
            // Fewer: the last ones go; their species move up, as on the fixed plot.
            for (const { unit } of subplots.slice(n).reverse()) deleteUnit(unit.id);
          });
        } catch (e) {
          toast(formErrorText(t, e));
        }
        // The rows as they now are: new ones take the shared size (the view's uniform mode).
        return toRows(unitRows(data.levelKeys, listUnits(id)).filter((u) => u.unit.level_key === level));
      }}
      update={(unitId, fields) => {
        const u = subplots.find((x) => x.unit.id === unitId)?.unit;
        if (!u || edit.refuse()) return;
        const size = {
          ...(fields.width_m !== undefined ? { widthM: fields.width_m } : {}),
          ...(fields.length_m !== undefined ? { lengthM: fields.length_m } : {}),
        };
        try {
          if (fields.label !== undefined) updateUnit(unitId, { label: fields.label || null });
          // On a permanent plot the size is the layout's, fixed once a survey used it (refused then).
          if (Object.keys(size).length) {
            if (u.frame_unit_id != null) updateFrameUnit(u.frame_unit_id, size);
            else updateUnit(unitId, size);
          }
        } catch (e) {
          toast(formErrorText(t, e));
        }
      }}
      onChanged={onChanged}
      onOpen={subplotFields ? (unitId) => router.push(`/survey/form/unit/${unitId}${edit.unlocked ? '?unlocked=1' : ''}` as Href) : undefined}
      openLabel={t('surveyForm.quadrat.unitFields')}
    />
  );
}
