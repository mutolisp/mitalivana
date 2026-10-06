/**
 * The fixed plot's environment tab, section by section, as components that
 * take values and hand back a patch (2G): the plot screen feeds them its
 * `plot_surveys` row, a plot-style modular survey feeds them its own values,
 * so both look and behave the same. Moved out of app/plot/[id]/index.tsx
 * without changing what they draw.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';

import { CollapsibleSection } from '~/components/form/Section';
import { LabeledField, LabeledNumField } from '~/components/form/LabeledField';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { Chip } from '~/components/ui/Chip';
import { RecordLocationMap } from '~/components/RecordLocationMap';
import { SurveyTimeFields } from '~/components/SurveyTimeFields';
import { SwipeBlockedArea } from '~/components/SwipeNavigator';
import { Button } from '~/components/ui/Button';
import { CheckboxMark } from '~/components/ui/Checkbox';
import { layerIndexOf, layerLabel, type AbundanceMethod, type FixedLayer, type GeoJSONGeometry, type HeightUnit } from '~/db';
import { errText } from '~/lib/errText';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { useThemeColors } from '~/theme/colors';
import { useModeT } from '~/lib/useUsageMode';

/** The project the record is filed under; italic when uncategorised (id 0). */
export function ProjectRow({ project, onPress }: { project: { id: number; name: string } | null; onPress: () => void }) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      className="mt-3 flex-row items-center rounded-lg border border-gray-200 bg-card px-3 py-3 active:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:active:bg-gray-800"
    >
      <Ionicons name="folder-outline" size={18} color={c.ink2} />
      <View className="ml-2 flex-1">
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('plot.project')}</Text>
        <Text
          className={`text-sm ${project?.id === 0 ? 'italic text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}
          numberOfLines={1}
        >
          {project?.name ?? t('plot.uncategorized')}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={c.ink3} />
    </Pressable>
  );
}

/**
 * The plot centre: GNSS fix (with accuracy and elevation), the same mini-map
 * as the species record sheet to place it by hand, and the boundary drawn on
 * that map (drawing itself is on the map screen).
 */
export function CentreLocationCard({
  lat,
  lng,
  accuracy,
  elevation,
  boundary,
  onCapture,
  onPlace,
  onDrawBoundary,
  required = true,
  mapPreview = false,
}: {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  elevation: number | null;
  boundary: GeoJSONGeometry | null;
  /** The fixed plot needs its centre before species; a survey's template does not (2G-d). */
  required?: boolean;
  onCapture: () => void;
  /** Placed on the map: accuracy null (hand-placed), or what an undo restores. */
  onPlace: (lat: number, lng: number, accuracy: number | null) => void;
  /** Absent: no boundary link (a survey with no boundary of its own). */
  onDrawBoundary?: () => void;
  /** The small map as a still preview that opens full screen (inside a scrolling page). */
  mapPreview?: boolean;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  /** A coordinate exists, however it was obtained. */
  const hasCoord = lat !== null && lng !== null;
  /** A coordinate that came from the GNSS, so it carries an accuracy. A point
   *  placed by hand on the map has none — which is why the two are separate:
   *  gating the readout on `hasGps` would make a hand-placed point look like no
   *  point at all. */
  const hasGps = hasCoord && accuracy !== null;
  return (
    <View className="mt-3 rounded-lg border border-gray-200 bg-card p-3 dark:border-gray-700 dark:bg-gray-900">
      <View className="flex-row items-center">
        <Text className="flex-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          {t('plot.gnssLabel')} {required ? <Text className="text-red-500">*</Text> : null}
        </Text>
        <Button label={hasGps ? t('plot.refetchGnss') : t('plot.fetchGnss')} icon="locate" onPress={onCapture} />
      </View>
      {hasCoord ? (
        <Text selectable className="mt-2 text-sm text-gray-900 dark:text-gray-100">
          {lat?.toFixed(6)}, {lng?.toFixed(6)}
          {'  '}
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {accuracy != null ? `±${accuracy.toFixed(1)} m` : t('plot.manualCoord')}
            {elevation != null ? t('plot.elevSuffix', { m: elevation }) : ''}
          </Text>
        </Text>
      ) : (
        <Text className="mt-2 text-xs text-gray-400 dark:text-gray-500">{required ? t('plot.gnssNotYet') : t('surveyForm.gnssNotYet')}</Text>
      )}
      {/* Same mini-map as the species record sheet — tap or drag to place
          the plot centre when the GNSS fix is unavailable or wrong, and zoom /
          locate / switch basemap to check it against the terrain. It also
          draws the plot boundary: one map for centre and boundary, instead
          of a second native map in its own section below. */}
      <SwipeBlockedArea>
        <RecordLocationMap lat={lat} lng={lng} accuracy={accuracy} area={boundary} onChange={onPlace} preview={mapPreview} />
      </SwipeBlockedArea>
      {onDrawBoundary ? (
        <>
          {/* Drawing stays on the map screen — the only place with vertex
              handles — and comes back via router.replace. */}
          <Pressable
            onPress={onDrawBoundary}
            className="mt-2 flex-row items-center rounded-lg border border-gray-200 px-3 py-2 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
          >
            <Ionicons name="shapes-outline" size={18} color={boundary ? c.accent : c.ink2} />
            <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">
              {boundary ? t('plot.editRange') : t('plot.drawRange')}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={c.ink3} />
          </Pressable>
          <Text className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{t('plot.rangeHint')}</Text>
        </>
      ) : null}
    </View>
  );
}

/** Start / end, typed by hand for old field sheets or set to now (SurveyTimeFields), in a titled box. */
export function SurveyTimeBox({
  title,
  start,
  end,
  readOnly,
  onChange,
}: {
  title: string;
  start: number | null;
  end: number | null;
  readOnly: boolean;
  onChange: (which: 'start' | 'end', ts: number | null) => void;
}) {
  return (
    <View className="mt-3 rounded-lg border border-gray-200 bg-card p-3 dark:border-gray-700 dark:bg-gray-900">
      <Text className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">{title}</Text>
      {/* Locked: plain text, like the checklist and collection time sheets —
          an ⓧ that cannot be pressed looked like it could (Device_test 38-11). */}
      <SurveyTimeFields start={start} end={end} readOnly={readOnly} onChange={onChange} />
    </View>
  );
}

/** Who surveyed: opens the surveyor sheet. */
export function SurveyorRow({ value, onPress }: { value: string | null; onPress: () => void }) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const tm = useModeT();
  return (
    <View className="mb-3">
      <Text className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">{tm('plot.recordedBy')}</Text>
      <Pressable
        onPress={onPress}
        className="flex-row items-center justify-between rounded-lg border border-gray-200 bg-card px-3 py-2.5 active:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:active:bg-gray-800"
      >
        <Text
          className={`flex-1 text-sm ${value ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}
          numberOfLines={1}
        >
          {value || t('plot.assignSurveyor')}
        </Text>
        <Ionicons name="people-outline" size={16} color={c.ink3} />
      </Pressable>
    </View>
  );
}

/** The ground-cover fractions that must add up to 100%. `total_cover_pct` is
 *  NOT one of them — that field lives in 基本資料 and means vegetation cover
 *  overall, not a share of the ground surface. */
export const COVER_KEYS = [
  'vascular_cover_pct',
  'bryophyte_cover_pct',
  'lichen_cover_pct',
  'litter_cover_pct',
  'rock_cover_pct',
  'gravel_cover_pct',
  'bareland_cover_pct',
] as const;
type CoverKey = (typeof COVER_KEYS)[number];

/** 進階 (environment) fields, in the order the plot screen shows them. */
export const ENV_FIELDS = ['elevation_m', 'slope_deg', 'aspect_deg', 'terrain_position', ...COVER_KEYS] as const;
export type EnvField = (typeof ENV_FIELDS)[number];
export type EnvValues = Partial<Record<Exclude<EnvField, 'terrain_position'>, number | null>> & {
  terrain_position?: string | null;
  /** 開闊度 (a survey template's environment, 2G-f). */
  openness_pct?: number | null;
  openness_grade?: string | null;
};

const COVER_LABEL: Record<CoverKey, string> = {
  vascular_cover_pct: 'plot.vascularCover',
  bryophyte_cover_pct: 'plot.bryophyteCover',
  lichen_cover_pct: 'plot.lichenCover',
  litter_cover_pct: 'plot.litterCover',
  rock_cover_pct: 'plot.rockCover',
  gravel_cover_pct: 'plot.gravelCover',
  bareland_cover_pct: 'plot.bareCover',
};

const num = (v: number | null | undefined) => (typeof v === 'number' ? v : null);

/**
 * 進階: elevation, slope, aspect, terrain position and the ground covers with
 * their running total. `fields`: the subset to show (all on a fixed plot).
 */
export function EnvAdvancedSection({
  values,
  onPatch,
  fields = ENV_FIELDS,
  title,
  defaultExpanded,
  openness,
  alert,
}: {
  values: EnvValues;
  onPatch: (patch: EnvValues) => void;
  fields?: readonly EnvField[];
  /**
   * 開闊度 (a survey template's environment, 2G-f): sky openness in %, or one
   * of the template's grades when it gives them. Left out on a fixed plot.
   */
  openness?: { grades: readonly { code: string; label: string }[] | null };
  /** A survey template's own name for its environment component (調查資料 page). */
  title?: string;
  /** Open from the start where the page is only about these values (調查資料). */
  defaultExpanded?: boolean;
  /** Under the title: 必填未填 of a survey template's component (2G-e). */
  alert?: string;
}) {
  const { t } = useTranslation();
  const tm = useModeT();
  const shown = new Set(fields);
  const covers = COVER_KEYS.filter((k) => shown.has(k));

  /**
   * Save one ground-cover fraction, then fill in the last blank one if this
   * completes the other six — 維管束 65 + 岩石 5 + 碎石 3 + 裸露 2 + 苔蘚 10 +
   * 地衣 10 leaves 枯落物 = 5.
   *
   * The auto-fill deliberately never targets the field just edited: otherwise
   * clearing a value to retype it would immediately restore the old number and
   * you could never change it.
   */
  const patchCover = (key: CoverKey, value: number | null, done = true) => {
    const next: EnvValues = { ...values, [key]: value };
    const blanks = covers.filter((k) => next[k] == null);
    // Not on a half-typed number: the last blank would keep a remainder of it (LabeledField `done`).
    if (done && blanks.length === 1 && blanks[0] !== key) {
      const filled = covers.filter((k) => k !== blanks[0]).reduce((sum, k) => sum + (num(next[k]) ?? 0), 0);
      // Only when there is actually room left; an over-100 total is a data
      // problem for the user to resolve, not something to paper over.
      const remainder = Math.round((100 - filled) * 100) / 100;
      if (remainder >= 0) {
        onPatch({ [key]: value, [blanks[0]]: remainder });
        return;
      }
    }
    onPatch({ [key]: value });
  };

  const coverTotal = covers.reduce((sum, k) => sum + (num(values[k]) ?? 0), 0);
  const coverFilled = covers.filter((k) => values[k] != null).length;
  const coverRounded = Math.round(coverTotal * 100) / 100;

  return (
    <CollapsibleSection title={title ?? t('plot.advanced')} defaultExpanded={defaultExpanded}>
      {alert ? <Text className="pb-2 text-xs font-semibold text-alert dark:text-alert-dark">{alert}</Text> : null}
      {shown.has('elevation_m') ? (
        <LabeledNumField label={tm('plot.elevation')} suffix="m" value={num(values.elevation_m)} onSave={(n) => onPatch({ elevation_m: n })} />
      ) : null}
      {shown.has('slope_deg') ? (
        <LabeledNumField label={tm('plot.slope')} suffix="°" value={num(values.slope_deg)} min={0} max={90} onSave={(n) => onPatch({ slope_deg: n })} />
      ) : null}
      {shown.has('aspect_deg') ? (
        <LabeledNumField label={tm('plot.aspect')} suffix="°" value={num(values.aspect_deg)} min={0} max={359} onSave={(n) => onPatch({ aspect_deg: n })} />
      ) : null}
      {openness ? (
        openness.grades ? (
          <View className="mb-3 gap-1">
            <Text className="text-xs font-medium text-gray-600 dark:text-gray-400">{t('surveyForm.env.openness')}</Text>
            <View className="flex-row flex-wrap gap-2">
              {openness.grades.map((g) => (
                <Chip key={g.code} label={g.label} selected={values.openness_grade === g.code} onPress={() => onPatch({ openness_grade: values.openness_grade === g.code ? null : g.code })} />
              ))}
            </View>
          </View>
        ) : (
          <LabeledNumField label={t('surveyForm.env.opennessPct')} suffix="%" value={num(values.openness_pct)} min={0} max={100} onSave={(n) => onPatch({ openness_pct: n })} />
        )
      ) : null}
      {shown.has('terrain_position') ? (
        <LabeledField
          label={tm('plot.terrainPosition')}
          value={typeof values.terrain_position === 'string' ? values.terrain_position : ''}
          placeholder="ridge / upper / mid / lower / valley / plain"
          onSave={(v) => onPatch({ terrain_position: v || null })}
        />
      ) : null}
      {covers.map((k) => (
        <LabeledNumField
          key={k}
          label={t(COVER_LABEL[k])}
          suffix="%"
          value={num(values[k])}
          min={0}
          max={100}
          onSave={(n, done) => patchCover(k, n, done)}
        />
      ))}
      {/* Running total for the ground-cover fractions. Warn rather than
          block: in the field you rarely enter them in an order that keeps the
          running sum valid, and a hard gate would fight the auto-fill. */}
      {covers.length ? (
        <View className="px-4 pb-3 pt-1">
          <Text
            className={`text-xs ${
              coverFilled < covers.length
                ? 'text-gray-500 dark:text-gray-400'
                : coverRounded === 100
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-500'
            }`}
          >
            {coverFilled < covers.length
              ? t('plot.coverPartial', { filled: coverFilled, total: covers.length, sum: coverRounded })
              : coverRounded === 100
                ? t('plot.coverOk')
                : t('plot.coverMismatch', { sum: coverRounded })}
          </Text>
        </View>
      ) : null}
    </CollapsibleSection>
  );
}

export type LayerValues = {
  layer_index: number;
  cover_pct: number | null;
  height_cm: number | null;
  height_unit: HeightUnit | null;
  method: AbundanceMethod | null;
};
export type LayerPatch = { cover_pct?: number | null; height_cm?: number | null; height_unit?: HeightUnit; method?: AbundanceMethod };

/** 分層: the number of layers (E1…), and each layer's cover, height and default abundance unit. */
export function LayerSectionView({
  layerCount,
  maxLayers,
  activeLayers,
  layers,
  onLayerCount,
  onPatchLayer,
  methods = ['percent', 'BB', 'DBH'],
}: {
  layerCount: number;
  maxLayers: number;
  /** The layer keys in use (getActiveLayers(layerCount)). */
  activeLayers: readonly string[];
  layers: readonly LayerValues[];
  onLayerCount: (n: number) => void;
  onPatchLayer: (layerIdx: number, fields: LayerPatch) => void;
  /** The default abundance units offered (a survey template's own); all three when omitted. */
  methods?: readonly AbundanceMethod[];
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  // +/- icons sit on a dark button in dark mode — use a bright glyph there.
  const stepIcon = c.ink;
  return (
    <CollapsibleSection title={t('plot.layerSection')}>
      <View className="mb-3 rounded-lg border border-gray-200 bg-card px-3 py-3 dark:border-gray-700 dark:bg-gray-900">
        <Text className="text-xs font-medium text-gray-600 dark:text-gray-400">{t('plot.layerCount')}</Text>
        <View className="mt-2 flex-row items-center">
          <Pressable
            onPress={() => layerCount > 1 && onLayerCount(layerCount - 1)}
            disabled={layerCount <= 1}
            className={`h-9 w-9 items-center justify-center rounded-full ${layerCount <= 1 ? 'bg-gray-100 dark:bg-gray-800' : 'bg-gray-200 active:bg-gray-300 dark:bg-gray-700 dark:active:bg-gray-600'}`}
          >
            <Ionicons name="remove" size={18} color={layerCount <= 1 ? c.ink3 : stepIcon} />
          </Pressable>
          <Text className="mx-4 min-w-[24px] text-center text-lg font-semibold text-gray-900 dark:text-gray-100">{layerCount}</Text>
          <Pressable
            onPress={() => layerCount < maxLayers && onLayerCount(layerCount + 1)}
            disabled={layerCount >= maxLayers}
            className={`h-9 w-9 items-center justify-center rounded-full ${layerCount >= maxLayers ? 'bg-gray-100 dark:bg-gray-800' : 'bg-gray-200 active:bg-gray-300 dark:bg-gray-700 dark:active:bg-gray-600'}`}
          >
            <Ionicons name="add" size={18} color={layerCount >= maxLayers ? c.ink3 : stepIcon} />
          </Pressable>
        </View>
        {/* Own line, not squeezed into the stepper row: the hint names all six
            layers and was being clipped mid-string there. */}
        <Text className="mt-2 text-[11px] leading-4 text-gray-500 dark:text-gray-400">{t('plot.layerHint', { max: maxLayers })}</Text>
      </View>
      <Text className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">{t('plot.layerDesc')}</Text>
      {activeLayers.map((layerKey) => {
        const idx = layerIndexOf(layerKey as FixedLayer);
        const row = layers.find((l) => l.layer_index === idx) ?? null;
        const unit: HeightUnit = row?.height_unit ?? 'cm';
        const display = row?.height_cm == null ? null : unit === 'm' ? row.height_cm / 100 : row.height_cm;
        return (
          <View key={layerKey} className="mb-2 rounded-lg border border-gray-200 bg-card px-3 py-3 dark:border-gray-700 dark:bg-gray-900">
            <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{layerLabel(layerKey as FixedLayer)}</Text>
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <LabeledNumField label="Cover" suffix="%" value={row?.cover_pct ?? null} min={0} max={100} onSave={(n) => onPatchLayer(idx, { cover_pct: n })} />
              </View>
              <View className="flex-1">
                <LabeledNumField
                  label="Height"
                  suffix={unit}
                  value={display}
                  onSave={(n) => onPatchLayer(idx, { height_cm: n == null ? null : unit === 'm' ? n * 100 : n })}
                />
                <View className="-mt-1 flex-row gap-1">
                  {(['cm', 'm'] as HeightUnit[]).map((u) => {
                    const on = unit === u;
                    return (
                      <Pressable
                        key={u}
                        onPress={() => onPatchLayer(idx, { height_unit: u })}
                        className={`rounded px-2 py-0.5 ${on ? 'bg-emerald-500' : 'bg-gray-100 dark:bg-gray-800'}`}
                      >
                        <Text className={`text-[11px] font-medium ${on ? 'text-white' : 'text-gray-600 dark:text-gray-300'}`}>{u}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </View>
            <Text className="mt-1 text-xs font-medium text-gray-600 dark:text-gray-400">{t('plot.defaultAbundanceUnit')}</Text>
            <View className="mt-1 flex-row gap-2">
              {(['percent', 'BB', 'DBH'] as AbundanceMethod[]).filter((m) => methods.includes(m)).map((m) => {
                const on = row?.method === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => onPatchLayer(idx, { method: m })}
                    className={`rounded-full px-3 py-1.5 ${on ? 'bg-emerald-500' : 'bg-gray-100 dark:bg-gray-800'}`}
                  >
                    <Text className={`text-xs font-medium ${on ? 'text-white' : 'text-gray-700 dark:text-gray-300'}`}>
                      {m === 'BB' ? 'Braun-Blanquet' : m === 'percent' ? t('plot.percentUnit') : 'DBH'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
    </CollapsibleSection>
  );
}

export type SubplotValues = { id: number; idx: number; label: string; width_m: number | null; length_m: number | null };
export type SubplotPatch = { label?: string; width_m?: number | null; length_m?: number | null };

/**
 * 小區: how many, all of one size or each its own, and their names. The
 * caller owns the rows: `setCount` changes the number and returns the rows
 * as they now are, `update` writes one row, `onChanged` re-reads. `onOpen`
 * adds a link under each one (a survey whose template records more there).
 */
export function SubplotSectionView({
  subplots,
  setCount,
  update,
  onChanged,
  onOpen,
  openLabel,
}: {
  subplots: readonly SubplotValues[];
  setCount: (n: number) => readonly SubplotValues[];
  update: (id: number, fields: SubplotPatch) => void;
  onChanged: () => void;
  onOpen?: (id: number) => void;
  openLabel?: string;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();

  // +/- icons sit on a dark button in dark mode — use a bright glyph there.
  const stepIcon = c.ink;

  // Subplots of one size: with this on, one width / length pair applies to all of them.
  const [uniform, setUniform] = useState(true);
  // One-time init from existing data: default ON unless subplots already differ.
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current || subplots.length === 0) return;
    syncedRef.current = true;
    const { width_m: w, length_m: l } = subplots[0];
    setUniform(subplots.every((s) => s.width_m === w && s.length_m === l));
  }, [subplots]);

  /** Write the same width/length to every subplot. */
  const applyUniform = (fields: { width_m?: number | null; length_m?: number | null }) => {
    for (const s of subplots) update(s.id, fields);
    onChanged();
  };

  const count = subplots.length;
  const changeCount = (n: number) => {
    if (n < 0) return;
    const fresh = setCount(n);
    // In uniform mode, newly-added subplots inherit the shared size.
    if (uniform && fresh.length > 0) {
      const { width_m: w, length_m: l } = fresh[0];
      for (const s of fresh) update(s.id, { width_m: w, length_m: l });
    }
    onChanged();
  };

  const toggleUniform = () => {
    const next = !uniform;
    setUniform(next);
    // Turning ON: propagate the first subplot's size to all so they match.
    if (next && subplots.length > 0) {
      applyUniform({ width_m: subplots[0].width_m, length_m: subplots[0].length_m });
    }
  };

  const first = subplots[0];

  return (
    <CollapsibleSection title={t('plot.subplots')}>
      <Text className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">{t('plot.subplotsDesc')}</Text>
      <View className="mb-3 flex-row items-center">
        <Pressable
          onPress={() => changeCount(count - 1)}
          disabled={count <= 0}
          className={`h-9 w-9 items-center justify-center rounded-full ${count <= 0 ? 'bg-gray-100 dark:bg-gray-800' : 'bg-gray-200 active:bg-gray-300 dark:bg-gray-700 dark:active:bg-gray-600'}`}
        >
          <Ionicons name="remove" size={18} color={count <= 0 ? c.ink3 : stepIcon} />
        </Pressable>
        <Text className="mx-4 min-w-[24px] text-center text-lg font-semibold text-gray-900 dark:text-gray-100">{count}</Text>
        <Pressable
          onPress={() => changeCount(count + 1)}
          className="h-9 w-9 items-center justify-center rounded-full bg-gray-200 active:bg-gray-300 dark:bg-gray-700 dark:active:bg-gray-600"
        >
          <Ionicons name="add" size={18} color={stepIcon} />
        </Pressable>
        <Text className="ml-3 text-[11px] text-gray-500 dark:text-gray-400">{t('plot.subplotCount')}</Text>
      </View>

      {count > 0 ? (
        <Pressable onPress={toggleUniform} className="mb-2 flex-row items-center" hitSlop={6}>
          <CheckboxMark checked={uniform} />
          <Text className="ml-2 text-sm text-gray-800 dark:text-gray-200">{t('plot.subplotUniform')}</Text>
        </Pressable>
      ) : null}

      {/* Uniform mode: one shared 寬/長 pair applied to all subplots. */}
      {uniform && count > 0 ? (
        <View className="mb-2 rounded-lg border border-gray-200 bg-card px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
          <Text className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">{t('plot.subplotSharedSize')}</Text>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <LabeledNumField label={t('plot.width')} value={first?.width_m ?? null} onSave={(n) => applyUniform({ width_m: n })} />
            </View>
            <View className="flex-1">
              <LabeledNumField label={t('plot.length')} value={first?.length_m ?? null} onSave={(n) => applyUniform({ length_m: n })} />
            </View>
          </View>
        </View>
      ) : null}

      {subplots.map((s) => (
        <View key={s.id} className="mb-2 rounded-lg border border-gray-200 bg-card px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
          <LabeledField
            label={t('plot.subplotName', { idx: s.idx })}
            value={s.label}
            onSave={(v) => {
              update(s.id, { label: v });
              onChanged();
            }}
          />
          {/* Per-subplot 寬/長 only when sizes are independent. */}
          {!uniform ? (
            <View className="flex-row gap-3">
              <View className="flex-1">
                <LabeledNumField
                  label={t('plot.width')}
                  value={s.width_m}
                  onSave={(n) => {
                    update(s.id, { width_m: n });
                    onChanged();
                  }}
                />
              </View>
              <View className="flex-1">
                <LabeledNumField
                  label={t('plot.length')}
                  value={s.length_m}
                  onSave={(n) => {
                    update(s.id, { length_m: n });
                    onChanged();
                  }}
                />
              </View>
            </View>
          ) : null}
          {onOpen ? (
            <Pressable onPress={() => onOpen(s.id)} accessibilityRole="button" hitSlop={6} className="mt-1 flex-row items-center self-start py-1 active:opacity-60">
              <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{openLabel}</Text>
              <Ionicons name="chevron-forward" size={14} color={c.accent} />
            </Pressable>
          ) : null}
        </View>
      ))}
    </CollapsibleSection>
  );
}

/** 環境照片: take or pick, view, remove. `hint` names how the files will be named on export. */
export function EnvPhotoSectionView({
  photos,
  hint,
  title,
  alert,
  onAppend,
  onRemove,
}: {
  photos: readonly string[];
  /** Omit for none (a survey's photos have no naming rule to state). */
  hint?: string;
  /** A survey template's own name for its photos component (調查資料 page). */
  title?: string;
  /** Under the title: 必填未填 of a survey template's component (2G-e). */
  alert?: string;
  onAppend: (uris: string[]) => void;
  onRemove: (uri: string) => void;
}) {
  const { t } = useTranslation();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const append = (uris: string[]) => {
    if (uris.length === 0) return;
    onAppend(uris);
  };
  const handleTake = async () => {
    try {
      const uri = await captureEnvPhoto();
      if (uri) append([uri]);
    } catch (e) {
      Alert.alert(t('plot.takePhotoFail'), errText(e));
    }
  };
  const handlePick = async () => {
    try {
      const uris = await pickPhotos();
      append(uris);
    } catch (e) {
      Alert.alert(t('plot.pickPhotoFail'), errText(e));
    }
  };

  return (
    <View className="px-4 py-3">
      <View className="mb-2 flex-row items-center">
        <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title ?? t('plot.envPhotos')}</Text>
        {photos.length > 0 ? <Text className="ml-2 text-xs text-gray-500 dark:text-gray-400">({photos.length})</Text> : null}
      </View>
      {alert ? <Text className="mb-2 text-xs font-semibold text-alert dark:text-alert-dark">{alert}</Text> : null}
      {hint ? <Text className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">{hint}</Text> : null}
      <PhotoGrid photos={[...photos]} onAdd={handleTake} onPickLibrary={handlePick} onView={(idx) => setViewerIndex(idx)} onRemove={onRemove} />
      <PhotoViewerModal photos={[...photos]} index={viewerIndex} onClose={() => setViewerIndex(null)} />
    </View>
  );
}
