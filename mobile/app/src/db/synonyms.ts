import { datasetForTaxonId, getDatasetDb } from './datasets';

export type Synonym = {
  scientificName: string;
  authorship: string;
  status: string;
  source: 'TaiCOL';
  commonName: string;
};

export function getSynonyms(taxonId: string): Synonym[] {
  if (!taxonId) return [];

  // Synonyms are a TaiCOL data structure (several name rows per taxon_id); YList
  // puts synonyms and Japanese names in the `alternative_name_c` column with no
// rows of their own. So this queries the Taiwan checklist module only — what
  // used to fall out of "taicol_names happens to return 0 rows" is now explicit.
  const spec = datasetForTaxonId(taxonId);
  if (spec?.id !== 'tw-taicol') return [];
  const db = getDatasetDb('tw-taicol');
  if (!db) return [];
  const res = db.executeSync(
    `SELECT simple_name, name_author, usage_status, common_name_c
     FROM taicol_names
     WHERE taxon_id = ?
     ORDER BY (usage_status != 'accepted'), simple_name`,
    [taxonId],
  );

  return ((res.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    scientificName: (row.simple_name as string) ?? '',
    authorship: (row.name_author as string) ?? '',
    status: (row.usage_status as string) ?? '',
    source: 'TaiCOL' as const,
    commonName: (row.common_name_c as string) ?? '',
  }));
}
