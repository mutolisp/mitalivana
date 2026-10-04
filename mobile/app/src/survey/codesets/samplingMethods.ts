/**
 * The built-in survey methods a Method component (調查法, 2G-f) offers, from
 * the Ministry of Environment's 植物生態評估技術規範 and 動物生態評估技術規範
 * (115 年版; the letter of 2026-04-22, 環部保字第1151022260號, in force from
 * 2026-12-01). Both name 調查方法 among the fields every survey hands in
 * (植物 表5-2, PDF p.34; 動物 表4-2, p.79). The PDFs were downloaded from the
 * EIA document system's 技術規範 area and every Chinese name below checked
 * against their text (2026-10-04); `page` is the PDF page (p.1 is the letter).
 *
 * `zh` is the regulation's own name, except 樣線（沿線採集記錄）: the plant
 * regulation says 「樣線方式」 and describes it (p.6–7), it has no name of its
 * own. `en` is what DwC samplingProtocol gets (decided 2026-10-04: English
 * there, Chinese in survey.csv); `enFrom: 'regulation'` where the regulation
 * gives that English itself, `'translated'` where it is the app's.
 *
 * A method may ask for a size (DwC sampleSizeValue / sampleSizeUnit: an area
 * from width × length, a length, a duration) and an effort (samplingEffort,
 * e.g. "1000 camera-hours").
 *
 * Pure: check:survey-core runs it under Node.
 */
export type MethodGroup = 'vegetation' | 'birds' | 'mammals' | 'herps' | 'insects' | 'general';
export type MethodSize = 'area' | 'length' | 'duration';

export type SamplingMethod = {
  key: string;
  group: MethodGroup;
  zh: string;
  en: string;
  enFrom: 'regulation' | 'translated';
  /** The regulation and PDF page(s) the name was checked on. */
  source: { doc: 'plant' | 'animal'; page: number };
  size?: MethodSize;
  /** The effort's unit, in English as samplingEffort writes it. */
  effort?: string;
};

export const METHOD_GROUPS: readonly MethodGroup[] = ['vegetation', 'birds', 'mammals', 'herps', 'insects', 'general'];

export const SAMPLING_METHODS: readonly SamplingMethod[] = [
  { key: 'plot_survey', group: 'vegetation', zh: '樣區調查', en: 'plot survey', enFrom: 'translated', source: { doc: 'plant', page: 34 }, size: 'area' },
  { key: 'inventory', group: 'vegetation', zh: '名錄調查', en: 'inventory', enFrom: 'translated', source: { doc: 'plant', page: 34 } },
  { key: 'line_survey', group: 'vegetation', zh: '樣線（沿線採集記錄）', en: 'line survey', enFrom: 'translated', source: { doc: 'plant', page: 6 }, size: 'length' },
  { key: 'point_count', group: 'birds', zh: '定點計數法（圓圈法）', en: 'point count', enFrom: 'translated', source: { doc: 'animal', page: 22 }, size: 'duration' },
  { key: 'flock_count', group: 'birds', zh: '群集計數法', en: 'flock count', enFrom: 'translated', source: { doc: 'animal', page: 23 } },
  { key: 'camera_trap', group: 'mammals', zh: '紅外線自動相機', en: 'camera trap', enFrom: 'translated', source: { doc: 'animal', page: 15 }, effort: 'camera-hours' },
  { key: 'live_trap', group: 'mammals', zh: '捕捉器捕捉法', en: 'live trapping', enFrom: 'translated', source: { doc: 'animal', page: 18 }, effort: 'trap-nights' },
  { key: 'mist_net', group: 'mammals', zh: '網具陷阱（霧網、豎琴網）', en: 'mist net / harp trap', enFrom: 'regulation', source: { doc: 'animal', page: 17 }, effort: 'net-hours' },
  { key: 'visual_encounter', group: 'herps', zh: '目視遇測法', en: 'visual encounter surveys', enFrom: 'regulation', source: { doc: 'animal', page: 33 }, effort: 'person-hours' },
  { key: 'audio_strip', group: 'herps', zh: '鳴叫計數法', en: 'audio strip transects', enFrom: 'regulation', source: { doc: 'animal', page: 33 }, size: 'length' },
  { key: 'quadrat_sampling', group: 'herps', zh: '方塊取樣法', en: 'quadrat sampling', enFrom: 'regulation', source: { doc: 'animal', page: 34 }, size: 'area' },
  { key: 'pollard_walk', group: 'insects', zh: '穿越線法（Pollard Walk）', en: 'Pollard walk', enFrom: 'regulation', source: { doc: 'animal', page: 38 }, size: 'length' },
  { key: 'light_trap', group: 'insects', zh: '燈光誘引法', en: 'light trapping', enFrom: 'translated', source: { doc: 'animal', page: 42 }, effort: 'trap-hours' },
  { key: 'pitfall_trap', group: 'insects', zh: '掉落式陷阱法', en: 'pitfall trap', enFrom: 'regulation', source: { doc: 'animal', page: 17 }, effort: 'trap-days' },
  { key: 'line_transect', group: 'general', zh: '穿越線法', en: 'line transect', enFrom: 'regulation', source: { doc: 'animal', page: 12 }, size: 'length' },
  { key: 'road_survey', group: 'general', zh: '道路調查法', en: 'road survey', enFrom: 'translated', source: { doc: 'animal', page: 34 }, size: 'length' },
  { key: 'acoustic_recording', group: 'general', zh: '自動錄音法', en: 'autonomous acoustic recording', enFrom: 'translated', source: { doc: 'animal', page: 25 }, effort: 'recorder-hours' },
  { key: 'interview', group: 'general', zh: '訪問調查', en: 'interview survey', enFrom: 'translated', source: { doc: 'animal', page: 27 } },
];

export const METHOD_KEYS = SAMPLING_METHODS.map((m) => m.key);
/** A method the template does not list: its name typed by the surveyor. */
export const CUSTOM_METHOD = 'custom';

/** The units each size takes, as DwC sampleSizeUnit writes them (the export's existing 'm²'). */
export const SIZE_UNITS: Readonly<Record<MethodSize, readonly string[]>> = {
  area: ['m²'],
  length: ['m', 'km'],
  duration: ['min', 'h'],
};

export const methodOf = (key: unknown): SamplingMethod | undefined => SAMPLING_METHODS.find((m) => m.key === key);

type Values = Readonly<Record<string, unknown>>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The method recorded, else the one the template fixes. */
export function methodKey(values: Values, params: Values): string | null {
  return text(values.protocol) ?? text(params.fixed);
}

/**
 * A Method component's values as the survey event's DwC terms: the method's
 * English name (a custom one as typed), its size and effort. Empty strings /
 * nulls where nothing was recorded.
 */
export function methodDwc(
  values: Values,
  params: Values,
): { samplingProtocol: string; sampleSizeValue: number | null; sampleSizeUnit: string; samplingEffort: string; description: string } {
  const key = methodKey(values, params);
  const m = methodOf(key);
  const name = key === CUSTOM_METHOD ? (text(values.protocol_name) ?? '') : (m?.en ?? '');
  const w = num(values.width_m);
  const l = num(values.length_m);
  const area = w != null && l != null ? Math.round(w * l * 10000) / 10000 : null;
  const size = num(values.size_value);
  const unit = text(values.size_unit);
  // An area from width × length; a length or duration as typed, with its unit.
  const [sampleSizeValue, sampleSizeUnit] = area != null ? [area, 'm²'] : size != null && unit ? [size, unit] : [null, ''];
  const effort = num(values.effort_value);
  const effortUnit = text(values.effort_unit) ?? m?.effort ?? null;
  return {
    samplingProtocol: name,
    sampleSizeValue,
    sampleSizeUnit,
    samplingEffort: effort != null && effortUnit ? `${effort} ${effortUnit}` : '',
    description: text(values.description) ?? '',
  };
}

/** The Chinese name (survey.csv): the regulation's, or a custom one as typed. */
export function methodZh(values: Values, params: Values): string {
  const key = methodKey(values, params);
  return key === CUSTOM_METHOD ? (text(values.protocol_name) ?? '') : (methodOf(key)?.zh ?? '');
}
