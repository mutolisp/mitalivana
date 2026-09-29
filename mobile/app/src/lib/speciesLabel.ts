/**
 * Short species labels for tight places (chips, the cell list) — pure.
 *
 * A species with a vernacular name goes by it; one without goes by its
 * scientific name, whose genus is cut to an initial when there is an epithet
 * after it ("Yushania niitakayamensis" → "Y. niitakayamensis"). A bare genus,
 * "Carex sp." and hybrids keep their full form: an initial would leave nothing
 * readable.
 */

/** Tokens that may follow a genus and are not an epithet. */
const NOT_EPITHET = /^(var\.|subsp\.|ssp\.|f\.|fo\.|×|x|sp\.|spp\.|cf\.|aff\.)$/;

export function shortSciName(sci: string): string {
  const w = sci.trim().split(/\s+/);
  if (w.length < 2 || !/^[A-Z][a-z-]+$/.test(w[0]) || NOT_EPITHET.test(w[1]) || !/^[a-z]/.test(w[1])) return sci.trim();
  return `${w[0][0]}. ${w.slice(1).join(' ')}`;
}

/** Vernacular name, else the shortened scientific name, else `fallback`; the qualifier (a morphospecies label) after it. */
export function compactSpeciesLabel(s: { cname: string | null; sci: string | null; qualifier?: string | null; fallback: string }): string {
  const base = s.cname || (s.sci ? shortSciName(s.sci) : s.fallback);
  return s.qualifier ? `${base} ${s.qualifier}` : base;
}
