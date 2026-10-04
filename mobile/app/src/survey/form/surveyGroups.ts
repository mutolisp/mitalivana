/**
 * 調查資料 in four fixed groups (2G-f; canvas 16f–16l, decided 2026-10-04),
 * the survey's components sorted by type: 基本資料 (environment, choices,
 * photos, comments, the rest, and the surveyors), 時間資料 (start and end),
 * 空間資料 (the centre point, the 地理樣區 and the track: modules since
 * 2026-10-04, shown only when the template has one), 調查法 (the Method
 * component, when the template has one). A
 * plot's survey-level Structure is its 分層 on the environment tab, in no
 * group. Both survey styles use them: the checklist style from its 調查資料
 * chip, the plot style on its environment tab.
 *
 * Pure: check:survey-core runs it under Node.
 */
import { isEmpty, requiredByAuthor } from '../componentRules';
import { methodKey } from '../codesets/samplingMethods';
import { SPATIAL_TYPES, type ComponentValues } from '../registry';
import type { ComponentInstance, SurveyTemplate } from '../template/types';
import { surveyModules } from './moduleMap';

export type GroupKey = 'basic' | 'time' | 'space' | 'method';
export type SurveyGroup = { key: GroupKey; components: ComponentInstance[] };

/** The groups a survey of this template shows, in order. */
export function surveyGroups(t: SurveyTemplate): SurveyGroup[] {
  const m = surveyModules(t);
  const method = m.data.filter((c) => c.type === 'method');
  const spatial = (type: string) => (SPATIAL_TYPES as readonly string[]).includes(type);
  const space = SPATIAL_TYPES.flatMap((type) => m.data.filter((c) => c.type === type));
  return [
    { key: 'basic', components: m.data.filter((c) => c.type !== 'method' && !spatial(c.type) && !(t.style === 'plot' && c.type === 'structure')) },
    { key: 'time', components: m.timestamp ? [m.timestamp] : [] },
    ...(space.length ? [{ key: 'space' as const, components: space }] : []),
    ...(method.length ? [{ key: 'method' as const, components: method }] : []),
  ];
}

/** What every survey has besides its components (the survey row). */
export type SurveyFacts = {
  investigators: string | null;
  start_ts: number | null;
  stop_ts: number | null;
  lat: number | null;
  site_id: number | null;
  track_geojson: string | null;
};

const holds = (v: ComponentValues | undefined) => Object.values(v ?? {}).some((x) => !isEmpty(x));

/** Whether the survey holds a 空間資料 module's value (they live on the survey row). */
const spaceHeld = (type: string, s: SurveyFacts) => (type === 'centre' ? s.lat != null : type === 'site' ? s.site_id != null : !!s.track_geojson);

export type GroupStatus = { filled: number; total: number; missing: number };

/**
 * How much of a group is filled: 基本資料 its components with something in
 * them and the surveyors, 時間資料 the start and the end, 空間資料 the point,
 * the place and the track the template has, 調查法 a method chosen (or fixed
 * by the template).
 * `missing`: its components the author made 必填 that hold nothing (2G-e).
 */
export function groupStatus(g: SurveyGroup, values: Readonly<Record<string, ComponentValues>>, s: SurveyFacts): GroupStatus {
  const empty = (c: ComponentInstance) =>
    c.type === 'method' ? methodKey(values[c.key] ?? {}, c.params) == null : g.key === 'space' ? !spaceHeld(c.type, s) : !holds(values[c.key]);
  const missing = g.components.filter((c) => requiredByAuthor(c) && empty(c)).length;
  switch (g.key) {
    case 'basic':
      return { filled: g.components.filter((c) => holds(values[c.key])).length + (s.investigators ? 1 : 0), total: g.components.length + 1, missing };
    case 'time':
      return { filled: (s.start_ts != null ? 1 : 0) + (s.stop_ts != null ? 1 : 0), total: 2, missing };
    case 'space':
      return { filled: g.components.filter((c) => spaceHeld(c.type, s)).length, total: g.components.length, missing };
    case 'method':
      return { filled: g.components.filter((c) => methodKey(values[c.key] ?? {}, c.params) != null).length, total: g.components.length, missing };
  }
}

/** The 調查資料 chip's count: every group together. */
export function surveyDataStatus(t: SurveyTemplate, values: Readonly<Record<string, ComponentValues>>, s: SurveyFacts): GroupStatus {
  return surveyGroups(t)
    .map((g) => groupStatus(g, values, s))
    .reduce((a, b) => ({ filled: a.filled + b.filled, total: a.total + b.total, missing: a.missing + b.missing }), { filled: 0, total: 0, missing: 0 });
}
