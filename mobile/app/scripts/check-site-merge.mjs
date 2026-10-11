#!/usr/bin/env node
/**
 * 快速名錄's header and site sheet (asked 2026-10-07).
 *
 *   1. mergeGeometries (src/lib/siteMerge.ts): several 地理樣區 of one kind
 *      become one Multi* geometry, Multi* inputs flattened, kinds never mixed.
 *   2. Source guards: the site sheet lists existing sites before the draw
 *      buttons and merges a multi-pick; 快速名錄 and the checklist-style survey
 *      keep project · place · time · surveyors in ⋯ (記錄資訊), not in a chip
 *      row; the sort control is one button; zh-TW menus say 地理樣區, never a
 *      bare 樣區 (a plot), for a site.
 *   3. A plot's boundary (樣區範圍) is picked from the area sites — one, or
 *      several merged — or drawn; a plot (or survey with a centre point) with
 *      no centre takes the boundary's (boundaryCentre). Fixed, point-count and
 *      transect plots and the survey centre card all go through the sheet; the
 *      map's draw path binds through the same helpers.
 *
 * Usage: npm run check:site-merge   (exit 1 on violation)
 */
import { readFileSync } from 'node:fs';

const { boundaryCentre, dimensionOf, mergeGeometries } = await import('../src/lib/siteMerge.ts');

const errors = [];
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) errors.push(`${label}: got ${a}, want ${b}`);
};
const ok = (cond, label) => {
  if (!cond) errors.push(label);
};

const sq = (x, y) => [
  [
    [x, y],
    [x + 1, y],
    [x + 1, y + 1],
    [x, y + 1],
    [x, y],
  ],
];
const poly = (x, y) => ({ type: 'Polygon', coordinates: sq(x, y) });

// ── 1. merging ──────────────────────────────────────────────────────────────
{
  const four = mergeGeometries([poly(0, 0), poly(2, 0), poly(0, 2), poly(2, 2)]);
  eq('four subplots → one MultiPolygon', four?.type, 'MultiPolygon');
  eq('four subplots keep every ring', four?.coordinates, [sq(0, 0), sq(2, 0), sq(0, 2), sq(2, 2)]);
  const flat = mergeGeometries([
    poly(0, 0),
    { type: 'MultiPolygon', coordinates: [sq(5, 5), sq(7, 7)] },
  ]);
  eq('a MultiPolygon is flattened in', flat?.coordinates.length, 3);
  eq('one site stays as it is', mergeGeometries([poly(1, 1)]), poly(1, 1));
  eq(
    'points → MultiPoint',
    mergeGeometries([
      { type: 'Point', coordinates: [1, 2] },
      {
        type: 'MultiPoint',
        coordinates: [
          [3, 4],
          [5, 6],
        ],
      },
    ]),
    {
      type: 'MultiPoint',
      coordinates: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    },
  );
  eq(
    'lines → MultiLineString',
    mergeGeometries([
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        type: 'LineString',
        coordinates: [
          [2, 2],
          [3, 3],
        ],
      },
    ])?.type,
    'MultiLineString',
  );
  eq(
    'a point and an area do not merge',
    mergeGeometries([{ type: 'Point', coordinates: [0, 0] }, poly(0, 0)]),
    null,
  );
  eq('nothing to merge', mergeGeometries([]), null);
  eq('dimensions', ['Point', 'MultiLineString', 'Polygon', 'MultiPolygon'].map(dimensionOf), [
    'point',
    'line',
    'area',
    'area',
  ]);
}

// ── 1b. a boundary's centre ─────────────────────────────────────────────────
{
  const four = mergeGeometries([poly(0, 0), poly(2, 0), poly(0, 2), poly(2, 2)]);
  eq('four subplots: centre of the whole block', boundaryCentre(four), { lat: 1.5, lng: 1.5 });
  eq('one square', boundaryCentre(poly(10, 20)), { lat: 20.5, lng: 10.5 });
  eq('a point is its own centre', boundaryCentre({ type: 'Point', coordinates: [121.5, 24.1] }), {
    lat: 24.1,
    lng: 121.5,
  });
  eq('an empty shape has none', boundaryCentre({ type: 'MultiPolygon', coordinates: [] }), null);
}

// ── 2. source guards ────────────────────────────────────────────────────────
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const sheet = src('src/components/SiteAssignSheet.tsx');
  ok(
    sheet.indexOf('<ScrollView') < sheet.indexOf("onCreateNew('Point')"),
    'site sheet: existing sites listed before the draw buttons',
  );
  ok(
    /mergeGeometries\(ordered\.map\(\(x\) => parseGeometry\(x\)\)\)/.test(sheet) &&
      /onAssign\(id\)/.test(sheet),
    'site sheet: a multi-pick is merged into a new site and assigned',
  );
  ok(
    /dimensionOf\(s\.geometry_type\) !== pickedDim/.test(sheet),
    'site sheet: other kinds are blocked once one is picked',
  );
  for (const f of ['app/session/[id].tsx', 'src/survey/form/ChecklistSurveyScreen.tsx']) {
    const s = src(f);
    ok(
      !s.includes('ContextStrip') && !s.includes('ContextChip'),
      `${f}: no chip row above the list`,
    );
    ok(
      /info=\{recordInfo\}/.test(s) && /badge=\{!projectSet \|\|/.test(s),
      `${f}: 記錄資訊 in ⋯ with a dot for what is unset`,
    );
    ok(
      /track=\{tracking \? t\('session\.trackBadge'/.test(s),
      `${f}: a recording track shows under the title`,
    );
  }
  // 3. the boundary
  ok(
    /boundary \? listSites\(\)\.filter\(\(x\) => dimensionOf\(x\.geometry_type\) === 'area'\)/.test(sheet),
    'boundary sheet: only area sites are offered',
  );
  const plot = src('app/plot/[id]/index.tsx');
  ok(
    /<SiteAssignSheet\s+boundary[\s\S]*?setPlotBoundary\(plot\.id, siteId\)/.test(plot),
    'plot: the boundary sheet binds through setPlotBoundary',
  );
  ok(
    /onDrawBoundary=\{[^}]*openBoundary/.test(plot) &&
      (plot.match(/<PlotBoundarySection plot=\{plot\} onEdit=\{openBoundary\} \/>/g) ?? []).length === 2,
    'plot: the centre card and the transect boundary both open the sheet',
  );
  ok(
    (plot.match(/map\?draw=Polygon&plot=/g) ?? []).length === 1,
    'plot: drawing is reached only through drawBoundary',
  );
  const group = src('src/survey/form/SurveyGroupViews.tsx');
  ok(
    /onDrawBoundary=\{openBoundary\}/.test(group) &&
      /<SiteAssignSheet\s+boundary[\s\S]*?setSurveyBoundary\(id, siteId\)/.test(group),
    'survey centre card: the boundary sheet binds through setSurveyBoundary',
  );
  const map = src('app/(tabs)/map.tsx');
  ok(
    /setPlotBoundary\(plot\.id, siteId\)/.test(map) &&
      /setSurveyBoundary\(survey\.id, siteId\)/.test(map) &&
      !/updatePlotSurvey\(plot\.id, \{ site_id/.test(map),
    'map: a drawn boundary binds through the same helpers',
  );
  const plotsDb = src('src/db/plots.ts');
  ok(
    /export function setPlotBoundary[\s\S]*?requiresStaticGps\(plot\)[\s\S]*?coord_uncertainty_m: null/.test(plotsDb),
    'setPlotBoundary: only a plot that needs a centre takes one, hand-placed',
  );
  const surveysDb = src('src/survey/db/surveys.ts');
  ok(
    /export const setSurveyBoundary[\s\S]*?c\.type === 'centre'[\s\S]*?accuracy: null/.test(surveysDb),
    'setSurveyBoundary: only a template with a centre point takes one, hand-placed',
  );
  const sort = src('src/components/RecordSortControls.tsx');
  ok((sort.match(/<Pressable/g) ?? []).length === 1, 'sort: one button');
  const zh = JSON.parse(src('src/i18n/locales/zh-TW.json'));
  for (const k of [
    'assignOrCreateSite',
    'assignSiteCurrent',
    'createPointSiteFromGnss',
    'spatialMenuTitle',
    'locateNoSite',
    'pointSiteCreated',
    'siteAssigned',
    'siteUnassigned',
  ]) {
    ok(zh.session[k].includes('地理樣區'), `zh-TW session.${k} says 地理樣區: ${zh.session[k]}`);
  }
}

if (errors.length) {
  console.error(`✗ site-merge: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  '✓ site-merge: sites of one kind merge into one; site sheet lists first; plot boundary picked or drawn, empty centre filled; checklist header info in ⋯; one sort button',
);
