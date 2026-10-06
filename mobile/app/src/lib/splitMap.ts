/**
 * The split map's remembered layout (SplitMapView): map beside the list or
 * above it, how much of the screen the map takes either way, whether the list
 * is folded away, and which screens have the map open. Kept per usage mode in
 * the setting `split_map` (docs/planned/UI_modes_impl.md M3), so a volunteer's
 * wide map does not follow a pro user's narrow one.
 *
 * Pure, for scripts/check-along-track.mjs.
 */
import type { UsageMode } from './usageMode';

/** Where the map can be switched on: the quick checklist, a transect or point count. */
export type SplitScreen = 'session' | 'plot';

/** 'row': map on the left, list on the right; 'column': map above the list. */
export type SplitAxis = 'row' | 'column';

export type SplitLayout = {
  axis: SplitAxis;
  /** Map width as a share of the screen ('row'). */
  ratio: number;
  /** Map height as a share of the view ('column'). Kept apart from `ratio`, so
   *  switching back and forth returns each to where it was. */
  ratioV: number;
  /** The list folded away: to a tab on the right edge ('row'), or down to its
   *  heading ('column'). */
  collapsed: boolean;
  /** The map is switched on, per screen. */
  open: Partial<Record<SplitScreen, boolean>>;
};

export type SplitMapSetting = Partial<Record<UsageMode, SplitLayout>>;

/** A tap on the divider steps through these (design 18j: 215, 150 and 262 of 390 pt). */
export const SPLIT_PRESETS = [0.55, 0.38, 0.67] as const;
export const SPLIT_MIN = 0.36;
export const SPLIT_MAX = 0.67;

/** The same for the map's height above the list. The low end still leaves
 *  room for the map's own buttons (the basemap and locate column, 記在這裡). */
export const SPLIT_PRESETS_V = [0.5, 0.36, 0.65] as const;
export const SPLIT_MIN_V = 0.34;
export const SPLIT_MAX_V = 0.7;

export const DEFAULT_LAYOUT: SplitLayout = {
  axis: 'row',
  ratio: SPLIT_PRESETS[0],
  ratioV: SPLIT_PRESETS_V[0],
  collapsed: false,
  open: {},
};

export function splitBounds(axis: SplitAxis): { min: number; max: number; presets: readonly number[] } {
  return axis === 'column'
    ? { min: SPLIT_MIN_V, max: SPLIT_MAX_V, presets: SPLIT_PRESETS_V }
    : { min: SPLIT_MIN, max: SPLIT_MAX, presets: SPLIT_PRESETS };
}

export function clampRatio(r: number, axis: SplitAxis = 'row'): number {
  const { min, max, presets } = splitBounds(axis);
  if (!Number.isFinite(r)) return presets[0];
  return Math.max(min, Math.min(max, r));
}

/** The next preset after `r`; from a dragged size, the one after the nearest. */
export function nextPreset(r: number, axis: SplitAxis = 'row'): number {
  const { presets } = splitBounds(axis);
  let near = 0;
  for (let i = 1; i < presets.length; i++) {
    if (Math.abs(presets[i] - r) < Math.abs(presets[near] - r)) near = i;
  }
  return presets[(near + 1) % presets.length];
}

export function layoutFor(setting: SplitMapSetting, mode: UsageMode): SplitLayout {
  const l = setting[mode];
  if (!l) return DEFAULT_LAYOUT;
  return {
    axis: l.axis === 'column' ? 'column' : 'row',
    ratio: clampRatio(l.ratio),
    ratioV: clampRatio(l.ratioV, 'column'),
    collapsed: !!l.collapsed,
    open: l.open ?? {},
  };
}

/** Read the stored setting, dropping anything malformed. */
export function parseSplitMap(raw: string | null | undefined): SplitMapSetting {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: SplitMapSetting = {};
    for (const mode of ['pro', 'vol', 'casual'] as const) {
      const l = parsed[mode];
      if (!l || typeof l !== 'object') continue;
      const open: SplitLayout['open'] = {};
      if (l.open && typeof l.open === 'object') {
        for (const s of ['session', 'plot'] as const) if (typeof l.open[s] === 'boolean') open[s] = l.open[s];
      }
      out[mode] = {
        axis: l.axis === 'column' ? 'column' : 'row',
        ratio: clampRatio(typeof l.ratio === 'number' ? l.ratio : DEFAULT_LAYOUT.ratio),
        ratioV: clampRatio(typeof l.ratioV === 'number' ? l.ratioV : DEFAULT_LAYOUT.ratioV, 'column'),
        collapsed: l.collapsed === true,
        open,
      };
    }
    return out;
  } catch {
    return {};
  }
}
