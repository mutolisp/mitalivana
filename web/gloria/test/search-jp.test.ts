/**
 * The Japanese checklist (YList subset) on the web: once installed and its
 * region turned on, the GLORIA species search finds wamei and scientific
 * names, with YList ids ('y…'). Needs `make web-species` (public/data).
 */
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDbs, initDb } from '../src/host/dbInit';
import { mountSpeciesDb } from '../src/host/datasetsHost';
import { enableRegion } from '../src/host/speciesInstall';
import { searchWithFuzzyFallback } from '~/db/fuzzy';
import { getEnabledRegions } from '~/db/regions';
import { useSettings } from '~/stores/settings';
import { GLORIA_SEARCH_GROUPS } from '~/modules/gloria/useSurvey';

const dataDir = path.resolve(__dirname, '../public/data');
const files = readdirSync(dataDir);
const jp = files.find((f) => f.startsWith('jp-ylist-') && f.endsWith('.db.gz'));
const tw = files.find((f) => f.startsWith('tw-taicol-') && f.endsWith('.db.gz'));
const load = (f: string) => new Uint8Array(gunzipSync(readFileSync(path.join(dataDir, f))));
const search = (q: string) => searchWithFuzzyFallback({ q, groups: GLORIA_SEARCH_GROUPS });

describe.skipIf(!jp || !tw)('species search with the Japanese checklist', () => {
  beforeAll(async () => {
    closeDbs();
    await initDb();
    useSettings.getState().load();
  });

  it('is not searched until its region is on', () => {
    mountSpeciesDb('jp-ylist', load(jp!), 'test');
    expect(search('ハイマツ').some((r) => r.taxon_id.startsWith('y'))).toBe(false);
  });

  it('finds wamei and scientific names once installed and turned on', () => {
    enableRegion('JP');
    expect(getEnabledRegions()).toContain('JP');
    const r = search('ハイマツ');
    expect(r[0].name).toBe('Pinus pumila');
    expect(r[0].taxon_id.startsWith('y')).toBe(true);
    expect(search('Dicentra peregrina')[0].name).toBe('Dicentra peregrina');
  });

  it('keeps Taiwan working when both are installed (Taiwan mounted second)', () => {
    mountSpeciesDb('tw-taicol', load(tw!), 'test');
    expect(search('臺灣冷杉')[0].name).toBe('Abies kawakamii');
    // The Japanese database was opened before Taiwan was mounted and is still usable.
    expect(search('ハイマツ')[0].name).toBe('Pinus pumila');
  });
});
