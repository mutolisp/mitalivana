/**
 * A tree census export's files (Modular_survey.md §7.4, §9 1D), on the app's
 * connection: the round-trip yml (censusExportCore.ts; JSON, which is YAML), trees / census /
 * stems CSV and a vegan table per census (stemmap/censusTables.ts), and the
 * photos. The zip itself — manifest, README, signing — is bundleExport.ts's
 * (`bundleCensus`), which passes in how to read a photo: this module must not
 * import it (bundleExport imports this one).
 */
import { strToU8 } from 'fflate';
import { getUserDb } from '~/db/init';
import { resolveTaxa } from '~/db/taxonLookup';
import { generateUuid } from '~/db/uuid';
import { toCsv } from '~/modules/gloria/export/sheetRows';
import { buildCensusExport, censusExportText, type CensusExportDoc } from './db/censusExportCore';
import { getFrame, getSurvey } from './db/stemmapCore';
import { censusFolderBase, censusTable, stemsTable, treesTable, veganBasalArea, type Names, type Table } from './stemmap/censusTables';

export type CensusEntry = { name: string; bytes: Uint8Array };

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const clean = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 80) || 'census';

export function censusNames(taxonIds: string[]): Names {
  const found = resolveTaxa(taxonIds);
  return (id) => {
    const f = found.get(id);
    return { scientific: f?.simple_name ?? null, vernacular: f?.common_name_c ?? null };
  };
}

export async function buildCensusEntries(
  surveyId: number,
  opts: {
    includePhotos: boolean;
    /** A photo's bytes, or null when it cannot be read (deleted from the library). */
    readPhoto: (uri: string) => Promise<Uint8Array | null>;
    extOf: (uri: string) => string;
    onPhoto?: (done: number, total: number) => void;
  },
): Promise<{ entries: CensusEntry[]; folderName: string; uuid: string; name: string; trees: number; photos: number; doc: CensusExportDoc }> {
  const c = ctx();
  const s = getSurvey(c, surveyId);
  if (!s) throw new Error(`census ${surveyId} not found`);
  const frame = getFrame(c, s.frame_id)!;
  const doc = buildCensusExport(c, surveyId, (id) => resolveTaxa([id]).get(id)?.simple_name ?? null);
  const names = censusNames(doc.trees.map((t) => String(t.taxon_id)));
  const base = clean(censusFolderBase(doc, s.census_no));
  const entries: CensusEntry[] = [];

  // Photos: named by tree, stem and census, so a person can find them without the yml.
  const tagOf = new Map(doc.trees.map((t) => [String(t.uuid), String(t.tag)]));
  const stemNoOf = new Map(doc.stems.map((st) => [String(st.uuid), Number(st.stem_no)]));
  const all = doc.censuses.flatMap((part) => part.media.map((m) => ({ part, m })));
  let photos = 0;
  for (let i = 0; i < all.length; i++) {
    const { part, m } = all[i];
    const uri = String(m.uri ?? '');
    const stem = m.stem_uuid ? `-${stemNoOf.get(String(m.stem_uuid)) ?? ''}` : '';
    const file = `${clean(`${tagOf.get(String(m.tree_uuid)) ?? 'tree'}${stem}_c${part.survey.census_no}_${String(m.uuid).slice(0, 8)}`)}.${opts.extOf(uri) || 'jpg'}`;
    delete m.uri;
    m.file = file;
    if (!opts.includePhotos) continue;
    opts.onPhoto?.(i, all.length);
    const bytes = await opts.readPhoto(uri);
    if (!bytes) continue;
    entries.push({ name: `${base}/photos/${file}`, bytes });
    photos += 1;
  }

  entries.push({ name: `${base}/${base}.yml`, bytes: strToU8(censusExportText(doc)) });
  const csv = (suffix: string, t: Table) => entries.push({ name: `${base}/${base}_${suffix}.csv`, bytes: strToU8(toCsv(t.header, t.rows)) });
  csv('trees', treesTable(doc, names));
  csv('census', censusTable(doc));
  csv('stems', stemsTable(doc));
  doc.censuses.forEach((part, i) => csv(`vegan_basal_area_census${part.survey.census_no}`, veganBasalArea(doc, i, names)));
  return { entries, folderName: base, uuid: s.uuid, name: `${frame.code} #${s.census_no}`, trees: doc.trees.length, photos, doc };
}
