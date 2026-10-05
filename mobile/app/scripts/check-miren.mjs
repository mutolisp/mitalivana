/**
 * MIREN module — pure model rules (src/modules/miren/model).
 *
 * What each block protects:
 *   - plot codes: road 3-letter / trail 2-letter regions, site 0-padding,
 *     relocation suffix `a`, plot ranges (Road §2.5.2, §2.5.3; Trail (2)(3))
 *   - GBIF catalogNumber reading, incl. the two records with a trailing dot
 *   - scales: road cover 1–8, trail cover 0–8, abundance 1–3 / 0–3, and which
 *     plot records what (trail plot 1 = presence only)
 *   - planning: 19 equal elevation bands → 20 road sites, first crossings in
 *     route order, trail contours / distances, trail spacing warnings
 *   - region morphospecies names (Acacia MTN1 …) numbered across the region
 *   - TaiCOL alien_type → native / alien / unknown
 *   - plot warnings; recheck candidates and completeness
 *
 * Fixtures: plot codes from references/MIREN/DATA_22_example.xlsx and one
 * catalogNumber per region.road from the GBIF download 0009513-260921141020460
 * (MIREN survey, doi:10.15468/zd44yg, CC BY-NC 4.0). references/ is not in git,
 * so the samples are inline; when the download is present locally, all its
 * records are read as well.
 *
 * Run: npm run check:miren
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  formatPlotCode, formatSiteCode, parsePlotCode, parseGbifCatalogNumber, validRegionCode, validRouteCode,
} from '../src/modules/miren/model/codes.ts';
import { ROAD_COVER, TRAIL_COVER, ROAD_ABUNDANCE, TRAIL_ABUNDANCE, plotMeasures, inScale, classLabel } from '../src/modules/miren/model/scales.ts';
import {
  targetElevations, planRoadSites, planTrailByElevation, planTrailByDistance, checkTrailSpacing, orientUphill, segmentMeters, clearanceOk,
  profileFromGeometries, profileToGeoJson, profileFromGeoJson,
} from '../src/modules/miren/model/planner.ts';
import { morphoName, nextRegionNumber, isMorphoName, LIFE_FORMS } from '../src/modules/miren/model/morpho.ts';
import { statusFromTaicol, templateStatus } from '../src/modules/miren/model/status.ts';
import { checkPlot, checkSitePriority, additionalDataOk } from '../src/modules/miren/model/validate.ts';
import { recheckCandidates, recheckComplete, taxonKey, foundAfterRecheck, newSpeciesPhase } from '../src/modules/miren/model/compare.ts';
import { currentSites, planSurveyPlots, plotState, nextPlot } from '../src/modules/miren/model/survey.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};
const ok = (label, cond) => eq(label, !!cond, true);
const near = (label, got, want, tol) => ok(`${label} (${got} ≈ ${want})`, Math.abs(got - want) <= tol);
const kinds = (issues) => issues.map((i) => i.kind);

// ── plot codes ────────────────────────────────────────────────────────────
{
  eq('format road code', formatPlotCode({ region: 'MTN', route: 'BP', site: 6, plot: 2, suffix: '' }), 'MTN.BP.06.2');
  eq('format relocated code', formatPlotCode({ region: 'MTN', route: 'BP', site: 6, plot: 2, suffix: 'a' }), 'MTN.BP.06.2a');
  eq('format site code', formatSiteCode('AU', 'BP', 1), 'AU.BP.01');
  eq('parse relocated', parsePlotCode('road', 'MTN.BP.06.2a'), { ok: true, parts: { region: 'MTN', route: 'BP', site: 6, plot: 2, suffix: 'a' } });
  eq('road region must be 3 letters', parsePlotCode('road', 'AU.BP.06.2'), { ok: false, error: 'region' });
  eq('trail region must be 2 letters', parsePlotCode('trail', 'MTN.BP.06.2'), { ok: false, error: 'region' });
  eq('road has no plot 4', parsePlotCode('road', 'MTN.BP.06.4'), { ok: false, error: 'plot-range' });
  eq('trail has plot 4', parsePlotCode('trail', 'AU.BP.06.4').ok, true);
  eq('road has no site 21', parsePlotCode('road', 'MTN.BP.21.1'), { ok: false, error: 'site-range' });
  eq('site 00 is not a road site', parsePlotCode('road', 'MTN.BP.00.1'), { ok: false, error: 'site-range' });
  eq('site needs its leading 0', parsePlotCode('road', 'MTN.BP.6.2'), { ok: false, error: 'format' });
  eq('region and route codes', [validRegionCode('road', 'AUN'), validRegionCode('road', 'aun'), validRegionCode('trail', 'AU'), validRouteCode('AK'), validRouteCode('01')], [true, false, true, true, false]);

  // DATA_22_example.xlsx, sheet TransectAndPlotInformation, column Plot code.
  const template = ['AUN.AK.01.1', 'AUN.AK.01.3', 'AUN.AK.07.1', 'AUN.AK.07.3', 'AUN.AK.08.1', 'AUN.AK.08.3', 'AUN.AK.09.1', 'AUN.AK.09.3', 'AUN.AK.10.1', 'AUN.AK.10.3', 'AUN.AK.11.1', 'AUN.AK.11.3', 'AUN.AK.12.1', 'AUN.AK.16.1', 'AUN.AK.16.3', 'AUN.AK.17.1', 'AUN.AK.17.3', 'AUN.AK.18.1'];
  const back = template.map((c) => {
    const r = parsePlotCode('road', c);
    return r.ok ? formatPlotCode(r.parts) : `ERR ${r.error}`;
  });
  eq('template plot codes round-trip (18)', back, template);
}

// ── GBIF catalogNumber ────────────────────────────────────────────────────
{
  eq('GBIF code', parseGbifCatalogNumber('MIREN_ETH-MIREN_survey01-AU.AT.18.01.Collgran'),
    { ok: true, code: { region: 'AU', route: 'AT', site: 18, plot: 1, species: 'Collgran', trailingDot: false } });
  eq('GBIF numeric road code', parseGbifCatalogNumber('MIREN_ETH-MIREN_survey01-CN.02.01.01.Washfili').ok && parseGbifCatalogNumber('MIREN_ETH-MIREN_survey01-CN.02.01.01.Washfili').code.route, '02');
  eq('GBIF trailing dot is read and flagged', parseGbifCatalogNumber('MIREN_ETH-MIREN_survey01-CN.01.06.01.Oxalpes.').code?.trailingDot, true);
  eq('GBIF site 00 read as published', parseGbifCatalogNumber('MIREN_ETH-MIREN_survey01-CH.BE.00.01.Veropers').code?.site, 0);
  eq('GBIF wrong prefix', parseGbifCatalogNumber('AU.AT.18.01.Collgran'), { ok: false, error: 'format' });
  eq('GBIF missing species part', parseGbifCatalogNumber('MIREN_ETH-MIREN_survey01-AU.AT.18.01'), { ok: false, error: 'format' });
  const samples = [
    'CN.01.01.01.Zygofont', 'HI.HH.03.01.Panimaxi', 'AU.AT.18.01.Collgran', 'AU.AK.01.01.Vulpbrom', 'AU.AS.01.01.Vulpbrom',
    'CH.BE.00.01.Veropers', 'CH.BR.10.01.Veropers', 'CH.LA.00.01.Veropers', 'CN.02.01.01.Washfili', 'CN.03.06.01.Vitivini',
    'CS.CH.01.01.Vulpmyur', 'CS.LA.11.01.Vulpmyur', 'CS.LO.10.01.Veroserp', 'HI.MK.11.01.Wahlmarg', 'HI.PL.11.01.Vulpbrom',
    'HI.VV.10.01.Vulpmyur', 'OR.MS.13.01.Vulpmyur', 'CC.LP.02.01.Verbthap', 'CC.PT.04.01.Verbthap', 'CC.VN.02.01.Verbthap',
    'MT.BP.03.01.Verbthap', 'MT.CP.10.01.Verbthap', 'OR.FL.03.01.Verbthap', 'OR.MH.11.01.Verbthap', 'CH.SI.19.01.Trifhybr',
    'MT.WW.01.01.Trifhybr', 'CN.01.06.01.Oxalpes.', 'CN.02.01.01.Oxalpes.',
  ].map((s) => `MIREN_ETH-MIREN_survey01-${s}`);
  eq('GBIF samples: one per region.road (26) + two trailing dots all read', samples.filter((s) => !parseGbifCatalogNumber(s).ok), []);

  const occ = fileURLToPath(new URL('../../../references/MIREN/0009513-260921141020460/occurrence.txt', import.meta.url));
  if (existsSync(occ)) {
    const lines = readFileSync(occ, 'utf8').split('\n').filter(Boolean);
    const col = lines[0].split('\t').indexOf('catalogNumber');
    const all = lines.slice(1).map((l) => l.split('\t')[col]);
    const failed = all.filter((s) => !parseGbifCatalogNumber(s).ok);
    eq('GBIF download: 3,761 records', all.length, 3761);
    eq('GBIF download: every catalogNumber read', failed.slice(0, 5), []);
    eq('GBIF download: exactly two with a trailing dot', all.filter((s) => parseGbifCatalogNumber(s).code?.trailingDot).length, 2);
    eq('GBIF download: roadside plots only', [...new Set(all.map((s) => parseGbifCatalogNumber(s).code?.plot))], [1]);
  } else {
    console.log('  (GBIF download not present locally; full-file check skipped, inline samples still ran)');
  }
}

// ── scales ────────────────────────────────────────────────────────────────
{
  eq('road cover classes 1–8', ROAD_COVER.map((c) => c.value), [1, 2, 3, 4, 5, 6, 7, 8]);
  eq('road cover labels (§2.5.2.2)', ROAD_COVER.map((c) => c.label), ['<0.1', '0.1–1', '2–5', '6–10', '11–25', '26–50', '51–75', '76–100']);
  eq('trail cover classes 0–8', TRAIL_COVER.map((c) => c.value), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  eq('trail cover labels ((4) 3)', TRAIL_COVER.map((c) => c.label), ['0', '1', '1–5', '5–25', '25–50', '50–75', '75–95', '95–99', '99–100']);
  eq('abundance', [ROAD_ABUNDANCE.map((c) => c.value), TRAIL_ABUNDANCE.map((c) => c.value)], [[1, 2, 3], [0, 1, 2, 3]]);
  eq('road plots take cover + abundance', [1, 2, 3].map((n) => plotMeasures('road', n).mode), ['cover-abundance', 'cover-abundance', 'cover-abundance']);
  eq('trail plot 1 (2×50 m) is presence only', [1, 2, 3, 4].map((n) => plotMeasures('trail', n).mode), ['presence', 'cover-abundance', 'cover-abundance', 'cover-abundance']);
  const t2 = plotMeasures('trail', 2);
  eq('trail plots use the trail scales', [t2.cover === TRAIL_COVER, t2.abundance === TRAIL_ABUNDANCE], [true, true]);
  eq('0 is not a road cover class', [inScale(ROAD_COVER, 0), inScale(TRAIL_COVER, 0), inScale(ROAD_COVER, null)], [false, true, false]);
  eq('chip label', [classLabel(ROAD_COVER[2]), classLabel(ROAD_ABUNDANCE[2], '')], ['3 · 2–5%', '3 · >100']);
}

// ── planning ──────────────────────────────────────────────────────────────
{
  const t = targetElevations(980, 1840);
  eq('20 targets, 19 equal bands', [t.length, t[0], t[19]], [20, 980, 1840]);
  near('band width', t[1] - t[0], 860 / 19, 1e-9);

  // A straight road north, 980 → 1840 m, one point per 0.001° (≈ 111 m).
  const straight = Array.from({ length: 101 }, (_, i) => ({ lng: 121, lat: 24 + i * 0.001, ele: 980 + i * 8.6 }));
  near('segment ≈ 111 m', segmentMeters(straight[0], straight[1]), 111.2, 0.5);
  const sites = planRoadSites(straight);
  eq('20 road sites, none missing', [sites.length, sites.filter((s) => !s).length], [20, 0]);
  eq('site 01 at the bottom, 20 at the top', [sites[0].ele, Math.round(sites[19].ele)], [980, 1840]);
  ok('sites climb in route order', sites.every((s, i) => i === 0 || s.along > sites[i - 1].along));
  eq('a track recorded top-down is planned from the bottom', planRoadSites([...straight].reverse())[0].ele, 980);
  eq('orientUphill keeps an uphill profile', orientUphill(straight)[0].ele, 980);

  // Up, down into a valley, up again: each site is the first crossing after
  // the previous one, so the order along the road holds.
  const dip = [
    { lng: 121, lat: 24.0, ele: 1000 }, { lng: 121, lat: 24.01, ele: 1400 },
    { lng: 121, lat: 24.02, ele: 1100 }, { lng: 121, lat: 24.03, ele: 1950 },
  ];
  const dipSites = planRoadSites(dip);
  ok('dip: sites stay in route order', dipSites.every((s, i) => i === 0 || s.along >= dipSites[i - 1].along));
  eq('dip: the 1050 m site is on the first climb', dipSites[1].lat < 24.01, true);

  const bands = planTrailByElevation(straight.map((p) => ({ ...p, ele: p.ele + 32 })), 50);
  eq('trail contours: multiples of 50 above the head (1012 m) up to the top', [bands[0].ele, bands[bands.length - 1].ele, bands.length], [1050, 1850, 17]);
  const byDist = planTrailByDistance(straight, 500);
  eq('trail every 500 m from the head', [byDist[0].along, byDist[1].along, byDist.length], [0, 500, 23]);

  eq('spacing: too few', kinds(checkTrailSpacing([{ ele: 0, along: 0 }, { ele: 60, along: 50 }])), ['too-few']);
  const spaced = Array.from({ length: 10 }, (_, i) => ({ ele: i * 50, along: i * 20 }));
  eq('spacing: 50 m of elevation is enough', checkTrailSpacing(spaced), []);
  const flat = Array.from({ length: 10 }, (_, i) => ({ ele: 1000, along: i * 100 }));
  eq('spacing: 100 m of distance is enough on the flat', checkTrailSpacing(flat), []);
  const close = [...spaced];
  close[5] = { ele: close[4].ele + 20, along: close[4].along + 60 };
  eq('spacing: both gaps short → warned', checkTrailSpacing(close).filter((i) => i.kind === 'too-close').map((i) => i.index), [5]);
  eq('clearance ≥ 100 m', [clearanceOk(76), clearanceOk(100), clearanceOk(null)], [false, true, null]);

  // Imported tracks: the longest line, elevations required, round-trip on the route.
  const pts3 = [[121, 24, 1000], [121, 24.001, 1010], [121, 24.002, 1020]];
  eq('profile: longest line, with elevations', profileFromGeometries([{ type: 'LineString', coordinates: [[0, 0, 1], [0, 1, 2]] }, { type: 'LineString', coordinates: pts3 }]).points?.length, 3);
  eq('profile: MultiLineString joined', profileFromGeometries([{ type: 'MultiLineString', coordinates: [pts3.slice(0, 2), pts3.slice(2)] }]).points?.length, 3);
  eq('profile: no elevation refused', profileFromGeometries([{ type: 'LineString', coordinates: [[121, 24], [121, 24.1]] }]), { ok: false, error: 'no-elevation' });
  eq('profile: points only refused', profileFromGeometries([{ type: 'Point', coordinates: [121, 24, 5] }]), { ok: false, error: 'no-line' });
  eq('profile stored on the route round-trips', profileFromGeoJson(profileToGeoJson(straight)).length, straight.length);
  eq('profile: bad stored value', profileFromGeoJson('{'), []);
}

// ── morphospecies names ───────────────────────────────────────────────────
{
  eq('first name in a region', morphoName('Acacia', 'MTN', []), 'Acacia MTN1');
  eq('numbered across the region, any base', morphoName('Asteraceae', 'MTN', ['Acacia MTN1']), 'Asteraceae MTN2');
  eq('life form below family', morphoName('shrub', 'ORE', ['Carex ORE2', 'Acacia MTN5']), 'shrub ORE3');
  eq('other regions do not count', nextRegionNumber(['Acacia MTN4', 'Poa ORE1'], 'ORE'), 2);
  eq('recognised', [isMorphoName('Acacia MTN1', 'MTN'), isMorphoName('Acacia dealbata', 'MTN')], [true, false]);
  eq('life forms (§2.5.2.1)', LIFE_FORMS, ['graminoid', 'herb', 'fern', 'vine', 'shrub', 'tree']);
}

// ── native / alien ────────────────────────────────────────────────────────
{
  eq('TaiCOL alien_type', ['native', 'naturalized', 'invasive', 'cultured', '', null].map(statusFromTaicol), ['native', 'alien', 'alien', 'alien', 'unknown', 'unknown']);
  eq('template wording', ['native', 'alien', 'unknown'].map(templateStatus), ['Native', 'Alien', 'unknown']);
}

// ── plot warnings ─────────────────────────────────────────────────────────
{
  const plot = { plotNo: 1, sampled: true, lat: 24.1, lon: 121.2, elev: 1795, date: '2027-01-18', observers: 'km, gw', treeCoverPct: 35, bareGroundPct: 12, litterPct: 20, additionalData: 'grazing_cattle' };
  eq('complete road plot', checkPlot('road', plot, [{ coverClass: 3, abundanceClass: 2 }]), []);
  eq('missing location / date / observers',
    kinds(checkPlot('road', { ...plot, elev: null, date: '2027/01/18', observers: ' ' }, [])), ['missing-location', 'missing-date', 'missing-observers']);
  eq('percent out of range', checkPlot('road', { ...plot, litterPct: 120 }, []), [{ kind: 'percent-range', field: 'litterPct' }]);
  eq('additional data: underscores, ≤ 50', [additionalDataOk('grazing_cattle'), additionalDataOk('grazing cattle'), additionalDataOk('x'.repeat(51)), additionalDataOk(null)], [true, false, false, true]);
  eq('species needs both cover and abundance', checkPlot('road', plot, [{ coverClass: 3, abundanceClass: null }, { coverClass: 0, abundanceClass: 1 }]).map((i) => i.index), [0, 1]);
  eq('trail plot 1 needs neither', checkPlot('trail', plot, [{ coverClass: null, abundanceClass: null }]), []);
  eq('unsampled plot has no warnings', checkPlot('road', { ...plot, sampled: false, lat: null }, []), []);
  eq('road priority plots 1 and 3', [checkSitePriority('road', [1, 2]), checkSitePriority('road', [1, 3]), checkSitePriority('road', []), checkSitePriority('trail', [2])].map((x) => x.map((i) => i.plotNo)), [[3], [], [], []]);
}

// ── recheck ───────────────────────────────────────────────────────────────
{
  const prev = [
    { taxonId: 't1', verbatim: null }, { taxonId: 't2', verbatim: null },
    { taxonId: 'g1', verbatim: 'Acacia MTN1' }, { taxonId: 'g1', verbatim: 'Acacia MTN2' }, { taxonId: 't2', verbatim: '' },
  ];
  const cur = [{ taxonId: 't1', verbatim: '' }, { taxonId: 'g1', verbatim: 'Acacia MTN1' }];
  const cand = recheckCandidates(prev, cur);
  eq('candidates: missing ones, once, empty label = no label', cand.map(taxonKey), [taxonKey({ taxonId: 't2', verbatim: null }), taxonKey({ taxonId: 'g1', verbatim: 'Acacia MTN2' })]);
  eq('first survey: nothing to recheck, complete', [recheckCandidates([], cur).length, recheckComplete([], [])], [0, true]);
  eq('incomplete until every candidate is answered', recheckComplete(cand, [{ key: taxonKey(cand[0]), outcome: 'found' }]), false);
  eq('re-identification must name the new taxon',
    recheckComplete(cand, [{ key: taxonKey(cand[0]), outcome: 'not_found' }, { key: taxonKey(cand[1]), outcome: 'reidentified', newTaxon: null }]), false);
  eq('complete',
    recheckComplete(cand, [{ key: taxonKey(cand[0]), outcome: 'not_found' }, { key: taxonKey(cand[1]), outcome: 'reidentified', newTaxon: { taxonId: 's9', verbatim: null } }]), true);
  eq('Found after recheck column', [foundAfterRecheck('blind'), foundAfterRecheck('recheck')], [0, 1]);
  // Reopened after the previous list was shown: what is added then is a recheck find (code review M19).
  eq(
    'phase of a new species: blind, recheck after the close, recheck after a reopen that followed the previous list',
    [
      newSpeciesPhase({ blind_closed_at: null, blind_reopened_at: null }),
      newSpeciesPhase({ blind_closed_at: 1, blind_reopened_at: null }),
      newSpeciesPhase({ blind_closed_at: null, blind_reopened_at: 5 }),
    ],
    ['blind', 'recheck', 'recheck'],
  );
}

// ── new survey: plots and what is carried ─────────────────────────────────
{
  const sites = [{ id: 1, site_no: 1, suffix: '' }, { id: 2, site_no: 2, suffix: '' }, { id: 3, site_no: 2, suffix: 'a' }];
  eq('relocated site replaces the original', currentSites(sites).map((s) => s.id), [1, 3]);
  const road = planSurveyPlots('road', sites, []);
  eq('road: 3 plots per current site, all sampled', road.map((p) => [p.site_id, p.plot_no, p.sampled]), [[1, 1, 1], [1, 2, 1], [1, 3, 1], [3, 1, 1], [3, 2, 1], [3, 3, 1]]);
  const prev = [
    { site_id: 1, plot_no: 1, sampled: 1, lat: 24.1, lon: 121.2, elev: 980, protected_area: 1 },
    { site_id: 2, plot_no: 1, sampled: 1, lat: 24.2, lon: 121.3, elev: 1025, protected_area: 0 },
  ];
  const carried = planSurveyPlots('road', sites, prev);
  eq('position and PA carried by site id', [carried[0].lat, carried[0].elev, carried[0].protected_area], [24.1, 980, 1]);
  eq('nothing carried to a relocated site', [carried[3].site_id, carried[3].lat], [3, null]);
  ok('never species or values', Object.keys(carried[0]).every((k) => ['site_id', 'plot_no', 'sampled', 'lat', 'lon', 'elev', 'protected_area'].includes(k)));
  const trail = planSurveyPlots('trail', [sites[0]], []);
  eq('trail: 4 plots, optional 2×50 m plot 1 starts not sampled', trail.map((p) => [p.plot_no, p.sampled]), [[1, 0], [2, 1], [3, 1], [4, 1]]);
  eq('trail plot 1 sampled again when it was last time', planSurveyPlots('trail', [sites[0]], [{ ...prev[0] }])[0].sampled, 1);
  const pl = (o) => ({ sampled: 1, start_ts: null, species_count: 0, blind_closed_at: null, compared_at: null, site_no: 1, plot_no: 1, ...o });
  eq('plot states', [pl({ sampled: 0 }), pl({}), pl({ species_count: 2 }), pl({ start_ts: 5 }), pl({ blind_closed_at: 6 }), pl({ blind_closed_at: 6, compared_at: 7 })].map(plotState),
    ['skip', 'todo', 'blind', 'blind', 'recheck', 'done']);
  const ps = [pl({ site_no: 2, plot_no: 1 }), pl({ site_no: 1, plot_no: 2 }), pl({ site_no: 1, plot_no: 1, compared_at: 1, blind_closed_at: 1 }), pl({ site_no: 1, plot_no: 3, sampled: 0 })];
  eq('next plot: lowest site first, skipping done and unsampled', [nextPlot(ps).site_no, nextPlot(ps).plot_no], [1, 2]);
  eq('next plot from the top', [nextPlot(ps, true).site_no, nextPlot(ps, true).plot_no], [2, 1]);
  eq('nothing left', nextPlot([ps[2], ps[3]]), null);
}

if (failures) {
  console.error(`check:miren — ${failures} failure(s)`);
  process.exit(1);
}
console.log('check:miren — all rules hold');
