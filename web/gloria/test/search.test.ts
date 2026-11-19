/**
 * The mobile search stack (search.ts + fuzzy.ts) on the web species subset:
 * exact Chinese name first, scientific name, synonym → accepted name, a typo
 * through the fuzzy index. Needs `make web-species` (public/data).
 */
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDbs, initDb } from '../src/host/dbInit';
import { mountSpeciesDb } from '../src/host/datasetsHost';
import { searchWithFuzzyFallback } from '~/db/fuzzy';
import { GLORIA_SEARCH_GROUPS } from '~/modules/gloria/useSurvey';

const dataDir = path.resolve(__dirname, '../public/data');
const gz = readdirSync(dataDir).find((f) => f.startsWith('tw-taicol-') && f.endsWith('.db.gz'));

describe.skipIf(!gz)('species search on the web subset', () => {
  beforeAll(async () => {
    closeDbs();
    await initDb();
    mountSpeciesDb('tw-taicol', new Uint8Array(gunzipSync(readFileSync(path.join(dataDir, gz!)))), 'test');
  });

  const search = (q: string) => searchWithFuzzyFallback({ q, groups: GLORIA_SEARCH_GROUPS });

  it('puts the exact common name first', () => {
    // In TaiCOL 玉山圓柏 is an alternative name of 香青 (Juniperus squamata);
    // an exact alternative-name match still ranks above 玉山卷柏 etc.
    const r = search('玉山圓柏');
    expect(r[0].name).toBe('Juniperus squamata');
    expect(r[0].taxon_id).toBe('t0054132');
    expect(r[0].cname).toBe('玉山圓柏(香青)');
  });

  it('finds by scientific name', () => {
    const r = search('Juniperus squamata');
    expect(r[0].name).toBe('Juniperus squamata');
  });

  it('swaps 台/臺', () => {
    const a = search('臺灣冷杉').map((x) => x.taxon_id);
    const b = search('台灣冷杉').map((x) => x.taxon_id);
    expect(a.length).toBeGreaterThan(0);
    expect(b[0]).toBe(a[0]);
  });

  it('falls back to the fuzzy index for a one-character typo', () => {
    // The fuzzy index covers primary common names (臺灣冷杉 → Abies kawakamii).
    const r = search('臺灣冷衫');
    expect(r.some((x) => x.name === 'Abies kawakamii')).toBe(true);
  });
});
