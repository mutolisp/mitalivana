/**
 * Native / non-native status of a taxon in a MIREN region (S2 table B).
 *
 * The rule (Haider et al. 2022, p. 6): species introduced into the country or
 * mountain range after AD 1500 are non-native; when unknown or ambiguous the
 * status is 'unknown' (Road protocol §2.6, p. 6).
 *
 * For a Taiwan region the default comes from TaiCOL `alien_type`, which is a
 * taxon-level claim about Taiwan. `cultured` (a non-native taxon grown in
 * Taiwan) counts as alien here: MIREN asks whether the taxon is native to the
 * region, and a cultivated introduction found in a plot is not. This differs
 * on purpose from DwC establishmentMeans (lib/dwcMultiValue.ts), which blanks
 * `cultured` because it describes the individual. Every default can be
 * overridden per region, with a source.
 */

export type MirenStatus = 'native' | 'alien' | 'unknown';

export function statusFromTaicol(alienType: string | null | undefined): MirenStatus {
  switch (alienType) {
    case 'native':
      return 'native';
    case 'naturalized':
    case 'invasive':
    case 'cultured':
      return 'alien';
    default:
      return 'unknown';
  }
}

/** As written in the submission template's `Species` sheet (Native / Alien)
 *  and the protocol's 'unknown'. S2 table B uses the stored values as is. */
export function templateStatus(s: MirenStatus): string {
  return s === 'native' ? 'Native' : s === 'alien' ? 'Alien' : 'unknown';
}
