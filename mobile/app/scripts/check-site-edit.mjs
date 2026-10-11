#!/usr/bin/env node
/**
 * Editing a 地理樣區's shape on the map tab (asked 2026-10-07).
 *
 *   1. src/lib/siteEdit.ts: parts in draw order, a ring edited open and saved
 *      closed with its holes, a part removed (one left → the single type),
 *      insert points on every edge, the merged names used for the parts.
 *   2. Source guards: the site sheet on the map offers 編輯形狀 and 編輯資訊;
 *      the part being edited is not drawn twice; a shared site warns how many
 *      records use it before the shape is saved; insert handles are drawn.
 *
 * Usage: npm run check:site-edit   (exit 1 on violation)
 */
import { readFileSync } from 'node:fs';

const { editableParts, replacePart, removePart, edgeMidpoints, partNames, MIN_VERTICES } =
  await import('../src/lib/siteEdit.ts');

const errors = [];
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) errors.push(`${label}: got ${a}, want ${b}`);
};
const ok = (cond, label) => {
  if (!cond) errors.push(label);
};

const ring = (x, y) => [
  [x, y],
  [x + 1, y],
  [x + 1, y + 1],
  [x, y + 1],
  [x, y],
];
const hole = [
  [0.2, 0.2],
  [0.4, 0.2],
  [0.4, 0.4],
  [0.2, 0.2],
];

// ── 1. geometry ─────────────────────────────────────────────────────────────
{
  const poly = { type: 'Polygon', coordinates: [ring(0, 0), hole] };
  const parts = editableParts(poly);
  eq(
    'a polygon is one area part',
    parts.map((p) => p.kind),
    ['area'],
  );
  eq('its ring is edited open', parts[0].vertices.length, 4);

  const moved = replacePart(poly, 0, [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]);
  eq('saved ring is closed', moved.coordinates[0].at(-1), [0, 0]);
  eq('holes are kept', moved.coordinates[1], hole);

  const multi = { type: 'MultiPolygon', coordinates: [[ring(0, 0)], [ring(5, 0)], [ring(0, 5)]] };
  eq(
    'MultiPolygon parts in draw order',
    editableParts(multi).map((p) => p.vertices[0]),
    [
      [0, 0],
      [5, 0],
      [0, 5],
    ],
  );
  const one = replacePart(multi, 1, [
    [5, 0],
    [7, 0],
    [7, 2],
  ]);
  eq(
    'only the edited part changes',
    [one.coordinates[0], one.coordinates[2]],
    [[ring(0, 0)], [ring(0, 5)]],
  );
  eq('the edited part is a closed triangle', one.coordinates[1][0].length, 4);

  eq('removing a part of three', removePart(multi, 0)?.coordinates.length, 2);
  eq(
    'one part left is a Polygon',
    removePart({ type: 'MultiPolygon', coordinates: [[ring(0, 0)], [ring(5, 0)]] }, 0),
    {
      type: 'Polygon',
      coordinates: [ring(5, 0)],
    },
  );
  eq('a single Polygon has no part to remove', removePart(poly, 0), null);
  eq(
    'MultiLineString down to a LineString',
    removePart(
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
          ],
        ],
      },
      1,
    )?.type,
    'LineString',
  );

  const sq = ring(0, 0).slice(0, -1);
  eq('a ring has an insert point on each of its edges', edgeMidpoints(sq, true).length, 4);
  eq('the closing edge too', edgeMidpoints(sq, true).at(-1), { insertAt: 4, at: [0, 0.5] });
  eq('a line has one fewer', edgeMidpoints(sq, false).length, 3);
  eq('minimums', [MIN_VERTICES.point, MIN_VERTICES.line, MIN_VERTICES.area], [1, 2, 3]);

  eq('merged names name the parts', partNames('P1-S1、P1-S2、P1-S3', '、', 3), [
    'P1-S1',
    'P1-S2',
    'P1-S3',
  ]);
  eq('a name that does not split per part', partNames('Fushan plot', '、', 3), null);
}

// ── 2. source guards ────────────────────────────────────────────────────────
{
  const map = readFileSync(new URL('../app/(tabs)/map.tsx', import.meta.url), 'utf8');
  ok(
    /t\('map\.editShape'\)/.test(map) && /t\('map\.editSiteInfo'\)/.test(map),
    'map: the site sheet offers 編輯形狀 and 編輯資訊',
  );
  ok(
    /const editing = !!editSite && s\.id === editSite\.site\.id && i === editSite\.part;/.test(
      map,
    ) &&
      /fill: editing \? 'transparent' : fill/.test(map) &&
      /stroke: editing \? 'transparent' : stroke/.test(map),
    'map: the part being edited is not drawn twice (kept mounted, invisible)',
  );
  ok(
    /const records = countSiteRecords\(editSite\.site\.id\);[\s\S]{0,300}records >= 2 \? t\('map\.saveShapeShared'/.test(
      map,
    ) &&
      /const records = countSiteRecords\(site\.id\);[\s\S]{0,300}records >= 2 \? t\('map\.saveShapeShared'/.test(
        map,
      ),
    'map: saving a shape or deleting a part of a shared site says how many records use it',
  );
  ok(/edgeMidpoints\(/.test(map), 'map: insert handles between vertices');
  ok(/MIN_VERTICES\[editSite\.kind\]/.test(map), 'map: a part keeps its minimum vertices');
}

if (errors.length) {
  console.error(`✗ site-edit: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  '✓ site-edit: parts edited one at a time, rings closed with holes kept, parts removable, insert handles, shared sites warned',
);
