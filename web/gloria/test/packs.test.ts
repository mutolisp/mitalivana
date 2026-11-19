/**
 * Country packs on the web: a GBIF SPECIES_LIST zip imports into
 * regionpacks.db, the GLORIA species search finds its plants, a species used
 * in a survey gets its own copy in user.db (export carries the g… id), and
 * the pack survives a restart through its IndexedDB snapshot.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { closeDbs, getUserDb, initDb } from '../src/host/dbInit';
import { bootPacks } from '../src/host/packsHost';
import { importPackFile } from '../src/gbif/packs';
import { closePacksDb, createPack, listPacks } from '~/db/regionpacks';
import { searchWithFuzzyFallback } from '~/db/fuzzy';
import { GLORIA_SEARCH_GROUPS } from '~/modules/gloria/useSurvey';
import { addUnitSpecies, createGloriaSurvey, listUnits, loadGloriaDoc, upsertSummit } from '~/modules/gloria/db';

const HEADER = ['taxonKey', 'scientificName', 'acceptedTaxonKey', 'acceptedScientificName', 'numberOfOccurrences', 'taxonRank', 'taxonomicStatus', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus'];
const row = (key: number, sci: string, phylum: string, cls: string, family: string, genus: string) =>
  [key, sci, key, sci, 12, 'SPECIES', 'ACCEPTED', 'Plantae', phylum, cls, 'X', family, genus].join('\t');
const TSV = [
  HEADER.join('\t'),
  row(5284884, 'Saxifraga oppositifolia L.', 'Tracheophyta', 'Magnoliopsida', 'Saxifragaceae', 'Saxifraga'),
  row(2687463, 'Polytrichum alpinum Hedw.', 'Bryophyta', 'Polytrichopsida', 'Polytrichaceae', 'Polytrichum'),
  [9, 'Saxifragaceae', 9, 'Saxifragaceae', 1, 'FAMILY', 'ACCEPTED', 'Plantae', 'Tracheophyta', '', '', '', ''].join('\t'),
].join('\n');
const ZIP = zipSync({ '0001234-251119000000000.csv': strToU8(TSV) });

describe('country packs', () => {
  beforeAll(async () => {
    closeDbs();
    closePacksDb();
    await initDb();
    await bootPacks();
  });

  it('imports a species list zip (species rows only) and the GLORIA search finds it', async () => {
    const pack = createPack('AT', []);
    expect(await importPackFile(pack.id, ZIP)).toBe(2);
    expect(listPacks()[0]).toMatchObject({ status: 'ready', species_count: 2 });
    const hits = searchWithFuzzyFallback({ q: 'Saxifraga opp', groups: GLORIA_SEARCH_GROUPS });
    expect(hits.map((h) => h.taxon_id)).toContain('g5284884');
    // Vascular plants only: the moss is in the pack but not in GLORIA's search.
    expect(searchWithFuzzyFallback({ q: 'Polytrichum', groups: GLORIA_SEARCH_GROUPS }).map((h) => h.taxon_id)).not.toContain('g2687463');
  });

  it('copies a used pack species into user.db, so the export carries it', () => {
    const id = createGloriaSurvey({ summitId: upsertSummit({ country: 'AT', target_region: 'HSW', summit: 'GHK' }), recorded_by: 'A' });
    addUnitSpecies(listUnits(id).find((u) => u.code === 'N11')!.id, 'g5284884');
    const ext = getUserDb().executeSync(`SELECT simple_name FROM external_taxa WHERE taxon_id = 'g5284884'`).rows[0] as { simple_name?: string } | undefined;
    expect(ext?.simple_name).toBe('Saxifraga oppositifolia');
    expect(loadGloriaDoc(id)!.taxa.map((t) => t.taxon_id)).toContain('g5284884');
  });

  it('keeps the pack after a restart', async () => {
    const flusher = await bootPacks(); // same names as at start-up; flush the open database
    flusher.schedule();
    await flusher.flushNow();
    closePacksDb();
    await bootPacks();
    expect(listPacks().map((p) => [p.country_code, p.species_count])).toEqual([['AT', 2]]);
  });
});
