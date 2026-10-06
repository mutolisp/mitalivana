/**
 * The split map's remembered layout (SplitMapView): how wide the map is, whether
 * the list is folded away, and which screens have the map open. Kept per usage
 * mode in the setting `split_map` (docs/planned/UI_modes_impl.md M3), so a
 * volunteer's wide map does not follow a pro user's narrow one.
 *
 * Pure, for scripts/check-along-track.mjs.
 */
import type { UsageMode } from './usageMode';

/** Where the map can be switched on: the quick checklist, a transect or point count. */
export type SplitScreen = 'session' | 'plot';

export type SplitLayout = {
  /** Map width as a share of the screen. */
  ratio: number;
  /** The list folded to the right-edge tab. */
  collapsed: boolean;
  /** The map is switched on, per screen. */
  open: Partial<Record<SplitScreen, boolean>>;
};

export type SplitMapSetting = Partial<Record<UsageMode, SplitLayout>>;

/** A tap on the divider steps through these (design 18j: 215, 150 and 262 of 390 pt). */
export const SPLIT_PRESETS = [0.55, 0.38, 0.67] as const;
export const SPLIT_MIN = 0.36;
export const SPLIT_MAX = 0.67;

export const DEFAULT_LAYOUT: SplitLayout = { ratio: SPLIT_PRESETS[0], collapsed: false, open: {} };

export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_LAYOUT.ratio;
  return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, r));
}

/** The next preset after `r`; from a dragged width, the one after the nearest. */
export function nextPreset(r: number): number {
  let near = 0;
  for (let i = 1; i < SPLIT_PRESETS.length; i++) {
    if (Math.abs(SPLIT_PRESETS[i] - r) < Math.abs(SPLIT_PRESETS[near] - r)) near = i;
  }
  return SPLIT_PRESETS[(near + 1) % SPLIT_PRESETS.length];
}

export function layoutFor(setting: SplitMapSetting, mode: UsageMode): SplitLayout {
  const l = setting[mode];
  if (!l) return DEFAULT_LAYOUT;
  return { ratio: clampRatio(l.ratio), collapsed: !!l.collapsed, open: l.open ?? {} };
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
        ratio: clampRatio(typeof l.ratio === 'number' ? l.ratio : DEFAULT_LAYOUT.ratio),
        collapsed: l.collapsed === true,
        open,
      };
    }
    return out;
  } catch {
    return {};
  }
}
