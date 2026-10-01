/**
 * ForestGEO tree mortality and damage protocol (the Annual Mortality Surveys),
 * Arellano, Zuleta & Davies, Version: January 6, 2021
 * (references/ForestGEO/08_tree_morality_damage/english_ams_fieldwork_protocol_2021-feb-01.pdf).
 * Page numbers are the PDF's. Every variable is assessed per stem (p.1), and
 * "?" means "I can't tell in 30 seconds without binoculars" (p.3).
 *
 * Each variable is its own field: the same letter means different things in
 * different variables (S is standing in Mode, strangler in Liana and slope
 * failure in Comments), so codes are never pooled into one list
 * (docs/planned/Modular_survey.md §8.5).
 *
 * Pure (no React Native, no i18n): check:stemmap runs it under Node.
 */
export type AmsChoice = { code: string; meaning: string };

export type AmsVariable =
  | { field: string; kind: 'single' | 'multi'; choices: readonly AmsChoice[]; page: string }
  | { field: string; kind: 'number'; unit: string; min?: number; max?: number; special?: readonly string[]; page: string }
  | { field: string; kind: 'flag'; page: string };

export const AMS_UNSURE = '?';

export const AMS_VARIABLES: readonly AmsVariable[] = [
  {
    field: 'survival_status',
    kind: 'single',
    page: 'p.3',
    choices: [
      { code: 'OK', meaning: 'alive, standing complete main axis, living tissue base to tip, ≥90% of crown remaining' },
      { code: 'A', meaning: 'stem alive, which necessarily implies individual alive' },
      { code: 'D', meaning: 'dead individual, which necessarily implies dead stem(s)' },
      { code: 'X', meaning: 'stem entirely dead above ground in a living individual' },
      { code: 'NF', meaning: 'stem not found and tag not found' },
    ],
  },
  {
    // B and U may be combined; B and S may not (p.4).
    field: 'mode',
    kind: 'multi',
    page: 'p.4',
    choices: [
      { code: 'S', meaning: 'standing' },
      { code: 'B', meaning: 'broken' },
      { code: 'U', meaning: 'uprooted' },
    ],
  },
  { field: 'living_length_m', kind: 'number', unit: 'm', min: 0, special: ['<POM'], page: 'p.6' },
  { field: 'remaining_crown_pct', kind: 'number', unit: '%', min: 0, max: 100, special: ['NA'], page: 'p.6' },
  {
    field: 'crown_illumination',
    kind: 'single',
    page: 'p.7',
    choices: [
      { code: '5', meaning: 'leaves completely exposed to vertical and lateral light' },
      { code: '4', meaning: 'full overhead light, ≥90% of the crown projection exposed' },
      { code: '3', meaning: 'some overhead light, 10–90%' },
      { code: '2', meaning: 'lateral light, <10% overhead' },
      { code: '1', meaning: 'no direct light' },
    ],
  },
  { field: 'leaning_deg', kind: 'number', unit: '°', min: 0, page: 'p.7' },
  {
    field: 'liana',
    kind: 'multi',
    page: 'p.7',
    choices: [
      { code: 'L', meaning: 'liana (s.l.) covering >50% of the crown' },
      { code: 'S', meaning: 'liana or strangler limiting diameter growth of the main axis' },
    ],
  },
  { field: 'fungi', kind: 'flag', page: 'p.7' },
  ...(['wounded_main_axis', 'canker', 'rotting_trunk'] as const).map(
    (field): AmsVariable => ({
      field,
      kind: 'single',
      page: 'p.8',
      choices: [
        { code: '1', meaning: 'small, smaller in area than DBH × DBH' },
        { code: '2', meaning: 'large, greater than DBH × DBH' },
        { code: '3', meaning: 'massive, >50% of the basal area or of the living length' },
      ],
    }),
  ),
  { field: 'leaves_pct', kind: 'number', unit: '%', min: 0, max: 100, page: 'p.9' },
  { field: 'leaf_damage', kind: 'flag', page: 'p.9' },
  {
    // "Each site/study can develop its own codes" (p.9): a template may extend this list.
    field: 'comment_codes',
    kind: 'multi',
    page: 'p.9',
    choices: [
      { code: 'L', meaning: 'lightning' },
      { code: 'G', meaning: 'gaps' },
      { code: 'F', meaning: 'fire' },
      { code: 'H', meaning: 'hollow trunk' },
      { code: 'HB', meaning: 'hollow base of the stem' },
      { code: 'R', meaning: 'root damage' },
      { code: 'S', meaning: 'slope failure' },
      { code: 'W', meaning: 'wind-throw' },
    ],
  },
];

export type AmsSurvival = 'OK' | 'A' | 'D' | 'X' | 'NF' | typeof AMS_UNSURE;

/** Mode codes that cannot be combined (p.4: "B" and "S" are not compatible). */
export function amsModeConflict(mode: readonly string[]): boolean {
  return mode.includes('S') && mode.includes('B');
}
