/**
 * MIREN plot codes — pure, so check:miren can test them.
 *
 * Road (Road protocol §2.5.2, p. 4): `Region.Road.Site.Plot`, e.g.
 * `MTN.BP.06.2`; region three letters, road two, site 01–20 with the leading
 * 0, plot 1–3. A site moved after a disturbance gets an `a` on the plot code
 * (§2.5.3, p. 5): `MTN.BP.06.2a`.
 *
 * Trail (Trail protocol (2) a–c and (3) q, p. 5): region two letters, trail
 * two, transect 01–20 (lowest first), plot 1–4 (1 = the optional 2×50 m
 * trailside plot, 2–4 = the 2×10 m T).
 *
 * The GBIF MIREN dataset (doi:10.15468/zd44yg) writes
 * `MIREN_ETH-MIREN_survey01-AU.AT.18.01.Collgran`: two-letter regions, road
 * codes that can be digits (`CN.01`), two-digit plots, a species abbreviation
 * last, and in two records a trailing dot; sites run 00–25. `parseGbifCatalogNumber` reads
 * that shape; it is only a test fixture, the app never imports GBIF records.
 */

export type RouteKind = 'road' | 'trail';

export type PlotCodeParts = {
  region: string;
  route: string;
  site: number;
  plot: number;
  /** '' or 'a' (relocated site). */
  suffix: '' | 'a';
};

export type CodeError = 'format' | 'region' | 'route' | 'site-range' | 'plot-range';

export const REGION_CODE_LENGTH: Record<RouteKind, number> = { road: 3, trail: 2 };
export const PLOT_NUMBERS: Record<RouteKind, readonly number[]> = { road: [1, 2, 3], trail: [1, 2, 3, 4] };
/** Road: 20 sites (§2.3). Trail: 20 is the protocol's number, but trails
 *  sampled every 50 m of elevation can need more (Liedtke et al. 2020 had up
 *  to 24), so trail allows the full two digits. */
export const MAX_SITE: Record<RouteKind, number> = { road: 20, trail: 99 };

export function validRegionCode(kind: RouteKind, code: string): boolean {
  return new RegExp(`^[A-Z]{${REGION_CODE_LENGTH[kind]}}$`).test(code);
}

export function validRouteCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatPlotCode(p: PlotCodeParts): string {
  return `${p.region}.${p.route}.${pad2(p.site)}.${p.plot}${p.suffix}`;
}

/** The site part alone (`MTN.BP.06`), for photo names and headings. */
export function formatSiteCode(region: string, route: string, site: number, suffix: '' | 'a' = ''): string {
  return `${region}.${route}.${pad2(site)}${suffix}`;
}

/** Reads a code the app writes. Strict: what `formatPlotCode` produces for
 *  `kind`, nothing else. */
export function parsePlotCode(
  kind: RouteKind,
  code: string,
): { ok: true; parts: PlotCodeParts } | { ok: false; error: CodeError } {
  const m = /^([A-Z]+)\.([A-Z]+)\.(\d{2})\.(\d)(a?)$/.exec(code.trim());
  if (!m) return { ok: false, error: 'format' };
  const [, region, route, siteStr, plotStr, suffix] = m;
  if (!validRegionCode(kind, region)) return { ok: false, error: 'region' };
  if (!validRouteCode(route)) return { ok: false, error: 'route' };
  const site = Number(siteStr);
  if (site < 1 || site > MAX_SITE[kind]) return { ok: false, error: 'site-range' };
  const plot = Number(plotStr);
  if (!PLOT_NUMBERS[kind].includes(plot)) return { ok: false, error: 'plot-range' };
  return { ok: true, parts: { region, route, site, plot, suffix: suffix as '' | 'a' } };
}

export type GbifCode = {
  region: string;
  route: string;
  site: number;
  plot: number;
  species: string;
  /** The record ended in an extra '.' (two records in the 2026-09-27 download). */
  trailingDot: boolean;
};

const GBIF_PREFIX = 'MIREN_ETH-MIREN_survey01-';

export function parseGbifCatalogNumber(s: string): { ok: true; code: GbifCode } | { ok: false; error: CodeError } {
  if (!s.startsWith(GBIF_PREFIX)) return { ok: false, error: 'format' };
  let rest = s.slice(GBIF_PREFIX.length);
  const trailingDot = rest.endsWith('.');
  if (trailingDot) rest = rest.slice(0, -1);
  const m = /^([A-Z]{2})\.([A-Z]{2}|\d{2})\.(\d{2})\.(\d{2})\.([A-Za-z]+)$/.exec(rest);
  if (!m) return { ok: false, error: 'format' };
  const [, region, route, siteStr, plotStr, species] = m;
  // Read as published: the download has sites 00 (CH.BE, CH.LA) and up to 25,
  // outside the protocol's 01–20, so no site range check here.
  const site = Number(siteStr);
  const plot = Number(plotStr);
  if (plot < 1 || plot > 3) return { ok: false, error: 'plot-range' };
  return { ok: true, code: { region, route, site, plot, species, trailingDot } };
}
