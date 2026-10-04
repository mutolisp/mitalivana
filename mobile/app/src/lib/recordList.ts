/**
 * 快速名錄's list: its sort orders and its group chips, shared with a
 * checklist-style survey drawn with the same screen (2G-c).
 */
import type { RecordWithTaxon } from '~/db';
import type { RecordSort, SortDirection } from '~/stores/settings';

export function sortRecords(
  rs: RecordWithTaxon[],
  order: RecordSort,
  direction: SortDirection,
): RecordWithTaxon[] {
  const cmp = (a: string, b: string) => a.localeCompare(b);
  const arr = [...rs];
  const sorted = (() => {
    switch (order) {
      case 'cname':
        return arr.sort((a, b) =>
          cmp(a.common_name_c || a.simple_name, b.common_name_c || b.simple_name),
        );
      case 'name':
        return arr.sort((a, b) => cmp(a.simple_name, b.simple_name));
      case 'family':
        return arr.sort((a, b) => {
          const f = cmp(a.family || '', b.family || '');
          if (f !== 0) return f;
          return cmp(a.simple_name, b.simple_name);
        });
      case 'observed':
      default:
        return arr.sort((a, b) => a.observed_at - b.observed_at);
    }
  })();
  return direction === 'desc' ? sorted.reverse() : sorted;
}

export const HIGH_LEVEL_GROUPS: Array<{
  key: string;
  field: 'kingdom' | 'phylum' | 'class' | 'order';
  value: string;
}> = [
  { key: 'plantae', field: 'kingdom', value: 'Plantae' },
  { key: 'aves', field: 'class', value: 'Aves' },
  { key: 'mammalia', field: 'class', value: 'Mammalia' },
  { key: 'reptilia', field: 'class', value: 'Reptilia' },
  { key: 'amphibia', field: 'class', value: 'Amphibia' },
  { key: 'insecta', field: 'class', value: 'Insecta' },
  { key: 'fish', field: 'class', value: 'Actinopterygii' },
  { key: 'fungi', field: 'kingdom', value: 'Fungi' },
];
