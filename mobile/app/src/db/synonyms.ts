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

  // 同義名是 TaiCOL 的資料結構（一個 taxon_id 多列名字）；YList 把同義和名放在
  // `alternative_name_c` 欄位，沒有對應的列。所以這裡只查臺灣名錄模組——以前
  // 靠「查 taicol_names 剛好 0 列」達成的效果，現在寫明白。
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
