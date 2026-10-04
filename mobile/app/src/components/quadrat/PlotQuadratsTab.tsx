/**
 * The fixed plot's 「小樣方」 tab (06-plot-quadrats.md §3.2): where the
 * quadrats sit and how far each is, the species they found that the plot list
 * lacks, one row per quadrat, a short summary, and a dock that continues with
 * the first unfinished quadrat.
 *
 * Status colours are GLORIA's (statusLook): not started = outlined card,
 * in progress = acorn, done (locked) = accent, a cover / frequency mismatch =
 * alert. Data is read again whenever the tab regains focus, since the
 * quadrat screen writes behind it.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Button } from '~/components/ui/Button';
import { Chevron } from '~/components/ui/Chevron';
import { ListRow } from '~/components/ui/ListRow';
import { Tag } from '~/components/ui/Tag';
import { layerLabel, listSubplots, type FixedLayer, type PlotSurvey } from '~/db/plots';
import {
  addQuadrat,
  addQuadratTaxaToPlot,
  getQuadratConfig,
  listQuadrats,
  listQuadratSpeciesWithTaxon,
  quadratTaxaNotInPlot,
  type Quadrat,
  type QuadratConfig,
  type QuadratSpeciesWithTaxon,
} from '~/db/quadrats';
import { freqCells, quadratProgress, type QuadratProgress } from '~/lib/quadratProgress';
import { statusLook } from '~/modules/gloria/statusColors';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { LAYOUT_KEY, quadratName, quadratPlace, STATUS_KEY, topEdgeName } from './names';

type Row = { q: Quadrat; species: QuadratSpeciesWithTaxon[]; progress: QuadratProgress };

const speciesName = (s: QuadratSpeciesWithTaxon) => s.common_name_c || s.simple_name || s.taxon_id;

export function PlotQuadratsTab({
  plot,
  locked,
  unlocked,
  refuse,
  onChanged,
  onSettings,
}: {
  plot: PlotSurvey;
  /** The plot is ended and not unlocked: nothing is added here. */
  locked: boolean;
  /** The ended plot is unlocked on the plot screen; the quadrat screen carries it over. */
  unlocked: boolean;
  refuse: () => boolean;
  onChanged: () => void;
  /** Open the environment tab, where the settings live. */
  onSettings: () => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const [rows, setRows] = useState<Row[]>([]);
  const [cfg, setCfg] = useState<QuadratConfig>(() => getQuadratConfig(plot.id));
  const [missing, setMissing] = useState<string[]>([]);
  const subplots = useMemo(() => new Map(listSubplots(plot.id).map((s) => [s.id, s.label])), [plot.id]);

  const load = useCallback(() => {
    const conf = getQuadratConfig(plot.id);
    setCfg(conf);
    setRows(
      listQuadrats(plot.id).map((q) => {
        const species = listQuadratSpeciesWithTaxon(q.id);
        return {
          q,
          species,
          progress: quadratProgress(
            q,
            species.map((s) => ({ ...s, name: speciesName(s) })),
            { cover: conf.recordCover, freq: conf.recordFreq },
          ),
        };
      }),
    );
    setMissing(quadratTaxaNotInPlot(plot.id));
  }, [plot.id]);
  useFocusEffect(load);

  const open = (q: Quadrat) => router.push(`/plot/${plot.id}/quadrat/${q.id}${unlocked ? '?unlocked=1' : ''}` as Href);
  // The herb layer, unless the plot has only a moss layer.
  const layer: FixedLayer = plot.layer_count >= 2 ? 'E2' : 'E1';
  const next = rows.find((r) => r.progress.status !== 'done');
  const place = (q: Quadrat) => quadratPlace(t, q, (id) => subplots.get(id));

  const summary = useMemo(() => {
    const taxa = new Map<string, { name: string; pct: number }>();
    for (const r of rows) {
      const cells = r.q.grid_n * r.q.grid_n;
      for (const s of r.species) {
        const cur = taxa.get(s.taxon_id) ?? { name: speciesName(s), pct: 0 };
        // Mean over all quadrats: a species absent from one counts 0 there.
        cur.pct += (freqCells(s, r.q.freq_mode) / cells) * 100;
        taxa.set(s.taxon_id, cur);
      }
    }
    const vasc = rows.map((r) => r.q.cov_vascular).filter((v): v is number => v != null);
    const top = [...taxa.values()].sort((a, b) => b.pct - a.pct)[0];
    return {
      species: taxa.size,
      vascular: vasc.length ? Math.round((vasc.reduce((a, b) => a + b, 0) / vasc.length) * 10) / 10 : null,
      top: top && top.pct > 0 ? `${top.name} ${Math.round(top.pct / Math.max(1, rows.length))}%` : null,
    };
  }, [rows]);

  return (
    <View className="flex-1">
      <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4">
        {/* Where the quadrats sit in the plot, north up. */}
        <View className="flex-row gap-4 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
          <QuadratDiagram
            items={rows.map((r) => ({ id: r.q.id, label: r.q.label, position: r.q.position, status: r.progress.status }))}
            layout={cfg.layout}
            onOpen={(id) => {
              const q = rows.find((r) => r.q.id === id)?.q;
              if (q) open(q);
            }}
          />
          <View className="flex-1 justify-between">
            <View className="gap-1">
              <Info label={t('plot.quadrats.size')} value={`${fmtM(cfg.sizeM)} × ${fmtM(cfg.sizeM)} m`} />
              <Info label={t('plot.quadrats.gridN')} value={`${cfg.gridN} × ${cfg.gridN}`} />
              <Info label={t('plot.quadrats.topEdge')} value={topEdgeName(t, cfg.topEdge)} />
              <Info label={t('plot.quadrats.layout')} value={t(LAYOUT_KEY[cfg.layout])} />
            </View>
            <Pressable onPress={onSettings} accessibilityRole="button" hitSlop={6} className="mt-2 flex-row items-center self-start active:opacity-60">
              <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{t('plot.quadrats.settings')}</Text>
              <Ionicons name="chevron-forward" size={14} color={c.accent} />
            </Pressable>
          </View>
        </View>

        {missing.length ? (
          <View className="flex-row items-center gap-3 rounded-card bg-acorn-tint px-4 py-3 dark:bg-gray-800">
            <Text className="flex-1 text-sm text-acorn-deep dark:text-acorn">{t('plot.quadrats.notInPlot', { n: missing.length })}</Text>
            <Button
              label={t('plot.quadrats.addToLayer', { layer: layerLabel(layer) })}
              variant="secondary"
              disabled={locked}
              onPress={() => {
                if (refuse()) return;
                const n = addQuadratTaxaToPlot(plot.id, layer);
                toast(t('plot.quadrats.addedToLayer', { n, layer: layerLabel(layer) }));
                onChanged();
                load();
              }}
            />
          </View>
        ) : null}

        <View className="overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
          {rows.map((r, i) => {
            const p = r.progress;
            const meta = [
              t('plot.quadrats.metaSpecies', { n: p.species }),
              cfg.recordCover && p.species > 0 && p.covered === p.species ? t('plot.quadrats.metaCoverDone') : null,
              cfg.recordFreq && p.species > 0 ? t('plot.quadrats.metaFreq', { done: p.withFreq, total: p.species }) : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <ListRow
                key={r.q.id}
                leading={<StatusBadge label={r.q.label} status={p.status} />}
                title={
                  <View className="flex-row flex-wrap items-center gap-1.5">
                    <Text className="text-base font-medium text-ink dark:text-gray-100" numberOfLines={1}>
                      {place(r.q) || r.q.label}
                    </Text>
                    {p.missingFreq ? <Tag kind="alert" label={t('plot.quadrats.missingFreq')} /> : null}
                    {p.missingCover ? <Tag kind="alert" label={t('plot.quadrats.missingCover')} /> : null}
                  </View>
                }
                meta={meta}
                trailing={<Chevron />}
                onPress={() => open(r.q)}
                divider={i < rows.length - 1}
                accessibilityLabel={`${quadratName(t, r.q, (id) => subplots.get(id))}, ${t(STATUS_KEY[p.status])}`}
              />
            );
          })}
        </View>

        <View className="flex-row gap-2 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
          <Stat label={t('plot.quadrats.summarySpecies')} value={String(summary.species)} />
          <Stat label={t('plot.quadrats.summaryVascular')} value={summary.vascular != null ? `${summary.vascular}%` : '—'} />
          <Stat label={t('plot.quadrats.summaryTopFreq')} value={summary.top ?? '—'} />
        </View>
      </ScrollView>

      {!locked ? (
        <View className="flex-row items-center gap-3 border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
          {next ? (
            <View className="flex-1">
              <Button
                size="lg"
                fullWidth
                icon="play"
                label={t('plot.quadrats.continue', { label: quadratName(t, next.q, (id) => subplots.get(id)) })}
                onPress={() => open(next.q)}
              />
            </View>
          ) : (
            <View className="flex-1" />
          )}
          <Pressable
            onPress={() => {
              if (refuse()) return;
              const id = addQuadrat(plot.id);
              onChanged();
              router.push(`/plot/${plot.id}/quadrat/${id}${unlocked ? '?unlocked=1' : ''}` as Href);
            }}
            accessibilityRole="button"
            accessibilityLabel={t('plot.quadrats.add')}
            className="h-14 w-14 items-center justify-center rounded-full bg-accent-600 active:bg-accent-700 dark:bg-accent-500"
          >
            <Ionicons name="add" size={28} color={c.onAccent} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const fmtM = (m: number) => String(Math.round(m * 100) / 100);

/** A quadrat's code on its status colour. */
export function StatusBadge({ label, status, size = 'md' }: { label: string; status: QuadratProgress['status']; size?: 'sm' | 'md' }) {
  const c = useThemeColors();
  const look = statusLook(c, status);
  return (
    <View
      className={`items-center justify-center rounded-md ${size === 'sm' ? 'px-1' : 'px-1.5 py-0.5'}`}
      style={{ backgroundColor: look.fill, borderWidth: look.border ? 1.5 : 0, borderColor: look.border ?? undefined, minWidth: size === 'sm' ? 26 : 34 }}
    >
      <Text className="font-mono text-xs font-bold" style={{ color: look.onFill }}>
        {label}
      </Text>
    </View>
  );
}

export type DiagramItem = { id: number; label: string; position: string | null; status: QuadratProgress['status'] };

/**
 * Plot frame with the quadrats as boxes, north up. Corners + centre use the
 * five named spots, the diagonal runs NW → SE, anything else is laid out in a
 * grid by number. A box opens its quadrat.
 */
export function QuadratDiagram({ items, layout, onOpen }: { items: readonly DiagramItem[]; layout: QuadratConfig['layout']; onOpen: (id: number) => void }) {
  const c = useThemeColors();
  const size = 132;
  const spot = (r: DiagramItem, i: number): [number, number] => {
    const named: Record<string, [number, number]> = { NW: [0.16, 0.16], NE: [0.84, 0.16], C: [0.5, 0.5], SW: [0.16, 0.84], SE: [0.84, 0.84] };
    if (r.position && named[r.position]) return named[r.position];
    if (layout === 'diagonal') {
      const f = (i + 1) / (items.length + 1);
      return [f, f];
    }
    const cols = Math.ceil(Math.sqrt(items.length));
    const lines = Math.ceil(items.length / cols);
    return [((i % cols) + 0.5) / cols, (Math.floor(i / cols) + 0.5) / lines];
  };
  return (
    <View className="items-center">
      <Text className="text-xs font-bold text-ink-2 dark:text-gray-300">N ↑</Text>
      <View style={{ width: size, height: size }} className="mt-1 rounded-sm border-2 border-gray-500 dark:border-gray-400">
        {items.map((r, i) => {
          const [x, y] = spot(r, i);
          const look = statusLook(c, r.status);
          return (
            <Pressable
              key={r.id}
              onPress={() => onOpen(r.id)}
              accessibilityRole="button"
              accessibilityLabel={r.label}
              hitSlop={4}
              className="absolute items-center justify-center rounded-sm"
              style={{
                left: x * (size - 4) - 14,
                top: y * (size - 4) - 11,
                width: 28,
                height: 22,
                backgroundColor: look.fill,
                borderWidth: look.border ? 1.5 : 0,
                borderColor: look.border ?? undefined,
              }}
            >
              <Text className="font-mono text-[10px] font-bold" style={{ color: look.onFill }}>
                {r.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Info({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row">
      <Text className="w-20 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
      <Text className="flex-1 text-xs font-semibold text-ink dark:text-gray-100">{value}</Text>
    </View>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1">
      <Text className="text-xs text-gray-500 dark:text-gray-400">{label}</Text>
      <Text className="mt-0.5 text-base font-bold text-ink dark:text-gray-100" numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}
