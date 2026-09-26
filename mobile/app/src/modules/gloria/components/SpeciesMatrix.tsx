/**
 * Summit species table (after the GLORIA database's species view): one row per
 * taxon, a column per unit for the chosen method. Current survey only — the
 * resurvey is blind (manual Box 4.5), so no previous values appear.
 *
 * Each cell is a heatmap: it shows one value and is shaded by another, so two
 * measures read at a glance —
 *   - 1×1 m: cover % shaded by frequency (red), or frequency shaded by cover
 *     (blue), switchable;
 *   - SAS: the abundance class, shaded by it (r! lightest … d darkest);
 *   - 10×10 m: the point hits, shaded by the cover they give (hits / 4 %).
 * The species column stays put while the unit columns scroll sideways.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { popcount } from '../model/grid';
import { QUADRAT_CODES, SAS_CODES, SQUARE_CODES } from '../model/units';
import { coverFromHits } from '../model/walk';
import { displayName, type SurveySpecies, type SurveyState } from '../useSurvey';
import { Seg } from './ui';

type Method = 'quadrat' | 'sas' | 'square';
type QuadratShow = 'cover' | 'freq';

const ROW_H = 38;
const CELL_W = 48;
const NAME_W = 128;
const N_W = 28;

/** RGB of each heat scale; the shade is its alpha. */
const RED = '220,38,38';
const BLUE = '37,99,235';
const TEAL = '0,162,165';
const GREEN = '5,150,105';
const ABUNDANCE_LEVEL: Record<string, number> = { 'r!': 0.2, r: 0.4, s: 0.6, c: 0.8, d: 1 };

function frequencyOf(s: SurveySpecies): number | null {
  if (s.freq_cells != null) return popcount(s.freq_cells);
  return s.freq_count ?? null;
}
function hitsOf(s: SurveySpecies): number | null {
  return s.point_hits != null ? popcount(s.point_hits) : (s.legacy_hits ?? null);
}

type Cell = { text: string; heat: number | null; rgb: string };

/**
 * What a cell shows and how strongly it is shaded (0–1, null = no shade).
 * Cover is shaded on a square-root scale: most covers are a few percent, and
 * on a straight scale they would all look blank.
 */
function cellOf(s: SurveySpecies, m: Method, show: QuadratShow): Cell {
  if (m === 'sas') {
    return { text: s.abundance ?? '•', heat: s.abundance ? (ABUNDANCE_LEVEL[s.abundance] ?? null) : null, rgb: TEAL };
  }
  if (m === 'square') {
    const n = hitsOf(s);
    return { text: n != null ? String(n) : '•', heat: n != null ? Math.sqrt(coverFromHits(n, 400) / 100) : null, rgb: GREEN };
  }
  const cover = s.cover_pct;
  const freq = frequencyOf(s);
  if (show === 'cover') {
    return { text: cover != null ? String(cover) : '—', heat: freq != null ? freq / 100 : null, rgb: RED };
  }
  return { text: freq != null ? String(freq) : '—', heat: cover != null ? Math.sqrt(cover / 100) : null, rgb: BLUE };
}

function HeatCell({ cell }: { cell: Cell | null }) {
  const a = cell?.heat != null ? Math.max(0.06, Math.min(1, cell.heat)) * 0.85 : 0;
  return (
    <View
      style={{ width: CELL_W, height: ROW_H, backgroundColor: a > 0 ? `rgba(${cell!.rgb},${a})` : undefined }}
      // Borders inside the fixed height, like the frozen column's rows, so both sides line up.
      className="items-end justify-center border-b border-l border-gray-100 pr-1.5 dark:border-gray-800"
    >
      {cell ? (
        <Text
          className={`text-xs ${a > 0.5 ? 'font-semibold text-white' : 'text-gray-900 dark:text-gray-100'}`}
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {cell.text}
        </Text>
      ) : null}
    </View>
  );
}

function Legend({ rgb, left, right, label }: { rgb: string; left: string; right: string; label: string }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Text className="text-[11px] text-gray-500 dark:text-gray-400">{label}</Text>
      <Text className="text-[11px] text-gray-500 dark:text-gray-400">{left}</Text>
      {[0.1, 0.3, 0.5, 0.7, 0.9].map((h) => (
        <View key={h} style={{ width: 14, height: 10, backgroundColor: `rgba(${rgb},${h * 0.85})` }} />
      ))}
      <Text className="text-[11px] text-gray-500 dark:text-gray-400">{right}</Text>
    </View>
  );
}

export function SpeciesMatrix({ state, onUnit }: { state: SurveyState; onUnit: (code: string) => void }) {
  const { t } = useTranslation();
  const [m, setM] = useState<Method>('quadrat');
  const [show, setShow] = useState<QuadratShow>('cover');
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

  const headerCell = 'h-8 justify-center border-b border-gray-200 dark:border-gray-800';
  const rowLine = 'border-b border-gray-100 dark:border-gray-800';

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
      {m === 'quadrat' ? (
        <Seg
          value={show}
          onChange={setShow}
          options={[
            { value: 'cover', label: t('gloria.matrix.showCover') },
            { value: 'freq', label: t('gloria.matrix.showFreq') },
          ]}
        />
      ) : null}
      <Text className="text-xs text-gray-500 dark:text-gray-400">
        {m === 'quadrat' ? t('gloria.matrix.quadratHint') : m === 'sas' ? t('gloria.matrix.sasHint') : t('gloria.matrix.squareHint')}
      </Text>
      {m === 'quadrat' ? (
        show === 'cover' ? (
          <Legend rgb={RED} label={t('gloria.matrix.shadeFreq')} left="0" right="100" />
        ) : (
          <Legend rgb={BLUE} label={t('gloria.matrix.shadeCover')} left="0" right="100%" />
        )
      ) : m === 'sas' ? (
        <Legend rgb={TEAL} label={t('gloria.matrix.shadeAbundance')} left="r!" right="d" />
      ) : (
        <Legend rgb={GREEN} label={t('gloria.matrix.shadeHits')} left="0" right="100%" />
      )}
      {rows.length === 0 ? (
        <Text className="py-6 text-center text-sm text-gray-400">{t('gloria.matrix.empty')}</Text>
      ) : (
        // Frozen species column + a sideways-scrolling block of unit columns;
        // every row has the same fixed height on both sides so they line up.
        <View className="flex-row">
          <View style={{ width: NAME_W + N_W }} className="border-r border-gray-200 dark:border-gray-700">
            <View className={`flex-row ${headerCell}`}>
              <Text style={{ width: NAME_W }} className="text-[11px] font-semibold text-gray-500">
                {t('gloria.matrix.species')}
              </Text>
              <Text style={{ width: N_W }} className="pr-1 text-right text-[11px] font-semibold text-gray-500">
                n
              </Text>
            </View>
            {rows.map((r) => (
              <View key={r.name + r.sci} style={{ height: ROW_H }} className={`flex-row items-center ${rowLine}`}>
                <View style={{ width: NAME_W }} className="pr-1">
                  <Text className="text-xs text-gray-900 dark:text-gray-100" numberOfLines={1}>
                    {r.name}
                  </Text>
                  <Text className="text-[10px] italic text-gray-500" numberOfLines={1}>
                    {r.sci}
                  </Text>
                </View>
                <Text
                  style={{ width: N_W, fontVariant: ['tabular-nums'] }}
                  className="pr-1 text-right text-xs text-gray-700 dark:text-gray-300"
                >
                  {r.cells.size}
                </Text>
              </View>
            ))}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
              <View className={`flex-row ${headerCell}`}>
                {codes.map((c) => (
                  <Pressable key={c} onPress={() => onUnit(c)} style={{ width: CELL_W }} className="pr-1.5">
                    <Text className="text-right text-[11px] font-semibold text-[#00797b] dark:text-cyan-300">{c}</Text>
                  </Pressable>
                ))}
              </View>
              {rows.map((r) => (
                <View key={r.name + r.sci} className="flex-row">
                  {codes.map((c) => {
                    const s = r.cells.get(c);
                    return <HeatCell key={c} cell={s ? cellOf(s, m, show) : null} />;
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}
