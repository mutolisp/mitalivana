/**
 * The environment tab's 「1 × 1 m 小樣方」 block (06-plot-quadrats.md §3.1):
 * switch the module on, how many quadrats and where, their size / grid / top
 * edge, what is recorded in them, and whether the previous survey's species
 * are offered.
 *
 * Every change goes through src/db/quadrats.ts, which applies it to the
 * quadrats that can take it: lowering the count removes only empty quadrats,
 * and size / grid / top edge only reach quadrats that hold nothing yet.
 */
import { useTranslation } from 'react-i18next';
import { Alert, Text, View } from 'react-native';
import { SelectRow, SwitchRow } from '~/components/settings/rows';
import { CountStepper } from '~/components/ui/CountStepper';
import {
  changeQuadratConfig,
  changeQuadratLayout,
  enableQuadrats,
  getQuadratConfig,
  listQuadrats,
  MAX_GRID_N,
  MAX_QUADRATS,
  MIN_GRID_N,
  quadratHasData,
  gridChangeable,
  plotFreqChangeable,
  QuadratError,
  setQuadratCount,
  type Quadrat,
  type QuadratLayout,
  type TopEdge,
} from '~/db/quadrats';
import { listSubplots, type PlotSurvey } from '~/db/plots';
import { NumField, Seg } from '~/modules/gloria/components/ui';
import { useToast } from '~/stores/toast';
import { LAYOUT_KEY, topEdgeName } from './names';

const LAYOUTS: QuadratLayout[] = ['cornersCenter', 'perSubplot', 'diagonal', 'custom'];
const EDGES: TopEdge[] = ['N', 'E', 'S', 'W', 'upslope'];

/** Quadrat labels for a message: "Q4、Q5". */
const labels = (qs: Quadrat[]) => qs.map((q) => q.label).join('、');

/**
 * What the block shows, read from the DB. `stamp` (the plot's updated_at,
 * which every quadrat write bumps) is only there to change: the React
 * Compiler memoises a call on its arguments, and a read keyed on the plot id
 * alone would never run again.
 */
function readSettings(plotId: number, stamp: number) {
  void stamp;
  const quadrats = listQuadrats(plotId);
  return {
    cfg: getQuadratConfig(plotId),
    quadrats,
    subplotCount: listSubplots(plotId).length,
    anyData: quadrats.some((q) => quadratHasData(q.id)),
    gridFree: gridChangeable(plotId),
    freqFree: plotFreqChangeable(plotId),
  };
}

export function QuadratSettings({ plot, onUpdated }: { plot: Pick<PlotSurvey, 'id' | 'updated_at'>; onUpdated: () => void }) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const plotId = plot.id;
  const { cfg, quadrats, subplotCount, anyData, gridFree, freqFree } = readSettings(plot.id, plot.updated_at);
  /** A grid change refused because data exists: say why. */
  const setGrid = (patch: Parameters<typeof changeQuadratConfig>[1]) => {
    try {
      setCfg(patch);
    } catch (e) {
      if (!(e instanceof QuadratError)) throw e;
      toast(t('plot.quadrats.gridLockedHint'));
    }
  };

  const done = (kept: Quadrat[] = []) => {
    if (kept.length) Alert.alert(t('plot.quadrats.title'), t('plot.quadrats.keptHasData', { labels: labels(kept) }));
    onUpdated();
  };
  const setCfg = (patch: Parameters<typeof changeQuadratConfig>[1]) => {
    const kept = changeQuadratConfig(plotId, patch);
    if (kept > 0) toast(t('plot.quadrats.geometryKept', { n: kept }));
    onUpdated();
  };
  const sizeChoice = cfg.sizeM === 1 ? '1' : cfg.sizeM === 2 ? '2' : 'custom';

  return (
    <View className="overflow-hidden rounded-card bg-card dark:bg-card-dark">
      {/* (1) Frequency over the whole plot: a 「頻度」 tab on the plot. */}
      <SwitchRow
        label={t('plot.quadrats.freqTitle')}
        description={t('plot.quadrats.freqDesc')}
        value={cfg.freqEnabled}
        onChange={(on) => setCfg({ freqEnabled: on })}
      />
      {cfg.freqEnabled ? (
        <>
          <Row label={t('plot.quadrats.gridN')}>
            {freqFree ? (
              <CountStepper
                value={cfg.freqGridN}
                min={MIN_GRID_N}
                accessibilityName={t('plot.quadrats.gridN')}
                onChange={(n) => setGrid({ freqGridN: Math.min(MAX_GRID_N, n ?? MIN_GRID_N) })}
              />
            ) : (
              <Text className="text-base font-semibold text-ink dark:text-gray-100">{`${cfg.freqGridN} × ${cfg.freqGridN}`}</Text>
            )}
          </Row>
          <SelectRow
            label={t('plot.quadrats.topEdge')}
            value={cfg.freqTopEdge}
            options={EDGES.map((e) => ({ value: e, label: topEdgeName(t, e) }))}
            onChange={(e) => (freqFree ? setCfg({ freqTopEdge: e }) : toast(t('plot.quadrats.gridLockedHint')))}
          />
          {!freqFree ? <Note text={t('plot.quadrats.gridLockedHint')} /> : null}
        </>
      ) : null}
      {/* (2) 1×1 m quadrats: a 「小樣方」 tab. */}
      <SwitchRow
        label={t('plot.quadrats.title')}
        description={t('plot.quadrats.desc')}
        value={cfg.enabled}
        onChange={(on) => {
          enableQuadrats(plotId, on);
          onUpdated();
        }}
      />
      {cfg.enabled ? (
        <>
          <Row label={t('plot.quadrats.count')}>
            <CountStepper
              value={quadrats.length}
              min={1}
              accessibilityName={t('plot.quadrats.count')}
              onChange={(n) => done(setQuadratCount(plotId, Math.min(MAX_QUADRATS, n ?? 1)))}
            />
          </Row>
          <SelectRow
            label={t('plot.quadrats.layout')}
            value={cfg.layout}
            options={LAYOUTS.map((l) => ({ value: l, label: t(LAYOUT_KEY[l]) }))}
            onChange={(l) => done(changeQuadratLayout(plotId, l))}
          />
          {cfg.layout === 'perSubplot' && subplotCount === 0 ? (
            <Note text={t('plot.quadrats.perSubplotNone')} />
          ) : null}
          <Row label={t('plot.quadrats.size')}>
            <View className="w-44">
              <Seg
                value={sizeChoice}
                onChange={(v) => {
                  if (v === '1' || v === '2') setCfg({ sizeM: Number(v) });
                  // 自訂 keeps the current side until a length is typed.
                  else if (sizeChoice !== 'custom') setCfg({ sizeM: 0.5 });
                }}
                options={[
                  { value: '1', label: '1×1 m' },
                  { value: '2', label: '2×2 m' },
                  { value: 'custom', label: t('plot.quadrats.sizeCustom') },
                ]}
              />
            </View>
          </Row>
          {sizeChoice === 'custom' ? (
            <Row label={t('plot.quadrats.sideLength')}>
              <NumField
                value={cfg.sizeM}
                range={{ min: 0.01, max: 100, unit: 'm' }}
                accessibilityLabel={t('plot.quadrats.sideLength')}
                onCommit={(v) => v != null && v > 0 && setCfg({ sizeM: v })}
              />
            </Row>
          ) : null}
          <Row label={t('plot.quadrats.gridN')}>
            {/* One grid for the whole plot; fixed once any quadrat has frequency data. */}
            {gridFree ? (
              <CountStepper
                value={cfg.gridN}
                min={MIN_GRID_N}
                accessibilityName={t('plot.quadrats.gridN')}
                onChange={(n) => setGrid({ gridN: Math.min(MAX_GRID_N, n ?? MIN_GRID_N) })}
              />
            ) : (
              <Text className="text-base font-semibold text-ink dark:text-gray-100">{`${cfg.gridN} × ${cfg.gridN}`}</Text>
            )}
          </Row>
          {!gridFree ? <Note text={t('plot.quadrats.gridLockedHint')} /> : null}
          <SelectRow
            label={t('plot.quadrats.topEdge')}
            value={cfg.topEdge}
            options={EDGES.map((e) => ({ value: e, label: topEdgeName(t, e) }))}
            onChange={(e) => setCfg({ topEdge: e })}
          />
          {anyData ? <Note text={t('plot.quadrats.lockedEditHint')} /> : null}

          <Text className="px-4 pb-1 pt-3 text-xs font-bold uppercase text-gray-500 dark:text-gray-400" style={{ letterSpacing: 0.96 }}>
            {t('plot.quadrats.recordItems')}
          </Text>
          <SwitchRow
            label={t('plot.quadrats.recordCover')}
            value={cfg.recordCover}
            onChange={(v) => setCfg({ recordCover: v })}
          />
          <SwitchRow
            label={t('plot.quadrats.recordFreq', { n: cfg.gridN })}
            value={cfg.recordFreq}
            onChange={(v) => setCfg({ recordFreq: v })}
          />
          <SwitchRow
            label={t('plot.quadrats.recordSurface')}
            value={cfg.recordSurface}
            onChange={(v) => setCfg({ recordSurface: v })}
          />
          <SwitchRow
            label={t('plot.quadrats.carryPrevious')}
            description={t('plot.quadrats.carryPreviousDesc')}
            value={cfg.carryPrevious}
            onChange={(v) => setCfg({ carryPrevious: v })}
          />
        </>
      ) : null}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="flex-row items-center justify-between border-b border-gray-100 bg-card px-4 py-2 dark:border-gray-800 dark:bg-gray-900" style={{ minHeight: 52 }}>
      <Text className="flex-1 pr-3 text-base text-gray-900 dark:text-gray-100">{label}</Text>
      {children}
    </View>
  );
}

function Note({ text }: { text: string }) {
  return <Text className="border-b border-gray-100 px-4 py-2 text-xs text-acorn-deep dark:border-gray-800 dark:text-acorn">{text}</Text>;
}
