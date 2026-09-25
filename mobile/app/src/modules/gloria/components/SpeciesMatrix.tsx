/**
 * Summit species table (after the GLORIA database's species view): one row per
 * taxon, a column per unit for the chosen method. Current survey only — the
 * resurvey is blind (manual Box 4.5), so no previous values appear.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { popcount } from '../model/grid';
import { QUADRAT_CODES, SAS_CODES, SQUARE_CODES } from '../model/units';
import { displayName, type SurveySpecies, type SurveyState } from '../useSurvey';
import { Seg } from './ui';

type Method = 'quadrat' | 'sas' | 'square';

function cell(s: SurveySpecies, m: Method): string {
  if (m === 'sas') return s.abundance ?? '•';
  if (m === 'square') return String(s.point_hits != null ? popcount(s.point_hits) : (s.legacy_hits ?? '•'));
  const parts = [s.cover_pct != null ? String(s.cover_pct) : '—'];
  if (s.freq_cells != null) parts.push(`f${popcount(s.freq_cells)}`);
  else if (s.freq_count != null) parts.push(`f${s.freq_count}`);
  return parts.join(' ');
}

export function SpeciesMatrix({ state, onUnit }: { state: SurveyState; onUnit: (code: string) => void }) {
  const { t } = useTranslation();
  const [m, setM] = useState<Method>('quadrat');
  const codes = m === 'quadrat' ? QUADRAT_CODES : m === 'sas' ? SAS_CODES : SQUARE_CODES;
  const rows = useMemo(() => {
    const byTaxon = new Map<number, { name: string; sci: string; cells: Map<string, SurveySpecies> }>();
    for (const s of state.species) {
      if (!codes.includes(s.unit_code)) continue;
      const r = byTaxon.get(s.gloria_taxon_id) ?? { name: displayName(s), sci: s.simple_name, cells: new Map() };
      r.cells.set(s.unit_code, s);
      byTaxon.set(s.gloria_taxon_id, r);
    }
    return [...byTaxon.values()].sort((a, b) => b.cells.size - a.cells.size || a.name.localeCompare(b.name));
  }, [state.species, codes]);

  return (
    <View className="gap-3">
      <Seg
        value={m}
        onChange={setM}
        options={[
          { value: 'quadrat', label: t('gloria.matrix.quadrats') },
          { value: 'sas', label: t('gloria.matrix.sas') },
          { value: 'square', label: t('gloria.matrix.squares') },
        ]}
      />
      <Text className="text-xs text-gray-500 dark:text-gray-400">
        {m === 'quadrat' ? t('gloria.matrix.quadratHint') : m === 'sas' ? t('gloria.matrix.sasHint') : t('gloria.matrix.squareHint')}
      </Text>
      {rows.length === 0 ? (
        <Text className="py-6 text-center text-sm text-gray-400">{t('gloria.matrix.empty')}</Text>
      ) : (
        <ScrollView horizontal>
          <View>
            <View className="flex-row border-b border-gray-200 dark:border-gray-800">
              <Text className="w-32 py-1.5 text-[11px] font-semibold text-gray-500">{t('gloria.matrix.species')}</Text>
              <Text className="w-10 py-1.5 text-right text-[11px] font-semibold text-gray-500">n</Text>
              {codes.map((c) => (
                <Pressable key={c} onPress={() => onUnit(c)} className="w-12 py-1.5">
                  <Text className="text-right text-[11px] font-semibold text-[#00797b] dark:text-cyan-300">{c}</Text>
                </Pressable>
              ))}
            </View>
            {rows.map((r) => (
              <View key={r.name + r.sci} className="flex-row border-b border-gray-100 dark:border-gray-800">
                <View className="w-32 py-1.5 pr-1">
                  <Text className="text-xs text-gray-900 dark:text-gray-100" numberOfLines={1}>{r.name}</Text>
                  <Text className="text-[10px] italic text-gray-500" numberOfLines={1}>{r.sci}</Text>
                </View>
                <Text className="w-10 py-1.5 text-right text-xs text-gray-700 dark:text-gray-300" style={{ fontVariant: ['tabular-nums'] }}>
                  {r.cells.size}
                </Text>
                {codes.map((c) => {
                  const s = r.cells.get(c);
                  return (
                    <Text key={c} className="w-12 py-1.5 text-right text-xs text-gray-900 dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
                      {s ? cell(s, m) : ''}
                    </Text>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
