/**
 * ForestGEO census codes, as published in Condit, R. (1998) Tropical Forest
 * Census Plots: Methods and Results from Barro Colorado Island, Panama and a
 * Comparison with Other Plots. Springer-Verlag / R.G. Landes
 * (references/ForestGEO/condit_1998_censusplotsmethodsbook.pdf).
 *
 * - Table 2.2.1 (book p.50, PDF p.61): codes of a first census.
 * - Table 2.5.1 (book p.85, PDF p.96): the recensus adds C, R and the four
 *   death codes, which "can only be used in a recensus".
 *
 * `meaning` is the table's wording verbatim. `level` is this app's rule
 * (docs/planned/Modular_survey.md §8.5): Condit records codes per plant on the
 * main sheet; with every stem tagged they move to the stem, except the death
 * codes, which stay on the whole plant, and M, which the app derives.
 *
 * Pure (no React Native, no i18n): check:stemmap runs it under Node.
 */
export type CensusCodeLevel = 'stem' | 'tree' | 'derived';

export type CensusCode = {
  code: string;
  meaning: string;
  level: CensusCodeLevel;
  /** Only allowed from the second census on (Table 2.5.1). */
  recensusOnly: boolean;
  /** The height of the POM must be entered with the code. */
  needsPomHeight: boolean;
  /** Recorded dead: no DBH is entered. */
  dead: boolean;
  source: string;
};

const T221 = 'Condit 1998, Table 2.2.1 (book p.50, PDF p.61)';
const T251 = 'Condit 1998, Table 2.5.1 (book p.85, PDF p.96)';

const c = (
  code: string,
  meaning: string,
  level: CensusCodeLevel,
  source: string,
  extra: Partial<Pick<CensusCode, 'recensusOnly' | 'needsPomHeight' | 'dead'>> = {},
): CensusCode => ({
  code,
  meaning,
  level,
  recensusOnly: extra.recensusOnly ?? false,
  needsPomHeight: extra.needsPomHeight ?? false,
  dead: extra.dead ?? false,
  source,
});

export const CENSUS_CODES: readonly CensusCode[] = [
  c('B', 'large buttress, requiring ladder to measure', 'stem', T221),
  c('M', 'multiple stems', 'derived', T221),
  c('P', 'any problem requiring further attention', 'stem', T221),
  c('A', 'POM at alternative height, not breast height', 'stem', T221, { needsPomHeight: true }),
  c('I', 'stem irregular where measured', 'stem', T221),
  c('X', 'stem broken below breast height', 'stem', T221),
  c('L', 'stem leaning', 'stem', T221),
  c('Y', 'stem prostrate', 'stem', T221, { needsPomHeight: true }),
  c('Q', 'stem broken above breast height', 'stem', T221),
  c('C', 'POM has changed since prior census', 'stem', T251, { recensusOnly: true }),
  c('R', 'resprout (main stem broken but resprouted since last census)', 'stem', T251, { recensusOnly: true }),
  c('DS', 'dead, stem standing', 'tree', T251, { recensusOnly: true, dead: true }),
  c('DC', 'dead, stem fallen', 'tree', T251, { recensusOnly: true, dead: true }),
  c('DT', 'dead, only tag found', 'tree', T251, { recensusOnly: true, dead: true }),
  c('DN', 'presumed dead, no tag nor stem', 'tree', T251, { recensusOnly: true, dead: true }),
];

const BY_CODE = new Map(CENSUS_CODES.map((k) => [k.code, k]));

export function censusCode(code: string): CensusCode | undefined {
  return BY_CODE.get(code);
}

/** Codes a person may enter at this level (M is never entered: it is derived). */
export function enterableCensusCodes(level: 'stem' | 'tree', firstCensus: boolean): CensusCode[] {
  return CENSUS_CODES.filter((k) => k.level === level && !(firstCensus && k.recensusOnly));
}
