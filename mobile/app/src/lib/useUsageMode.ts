/**
 * The React side of src/lib/usageMode.ts: the mode in effect, capability
 * checks, switching modes, and mode-specific wording.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { USAGE_MODES_OFFERED, fieldLabel, settleRecordTypeDefault, vis, type Cap, type UsageMode, type Vis } from '~/lib/usageMode';
import { useSettings, type AnalysisFormat } from '~/stores/settings';

const effective = (mode: UsageMode | null): UsageMode => (USAGE_MODES_OFFERED ? (mode ?? 'pro') : 'pro');

/** The mode in effect: pro until one is chosen, and always pro while the choice is not offered. */
export function useUsageMode(): UsageMode {
  return effective(useSettings((s) => s.usage_mode));
}

/** Same as useUsageMode, for code outside React (flows, handlers). */
export function currentUsageMode(): UsageMode {
  return effective(useSettings.getState().usage_mode);
}

export function useVis(cap: Cap): Vis {
  return vis(useUsageMode(), cap);
}

export function useShows(cap: Cap): boolean {
  return useVis(cap) !== 'hide';
}

/**
 * Switch modes: the first-launch choice and the settings card both come here.
 * Also settles ＋'s default to one the new mode offers.
 */
export function applyUsageMode(mode: UsageMode): void {
  const s = useSettings.getState();
  s.set('usage_mode', mode);
  const settled = settleRecordTypeDefault(mode, s.record_type_default);
  if (settled !== s.record_type_default) s.set('record_type_default', settled);
}

/**
 * t() that prefers the mode's own wording: in volunteer mode `tm('plot.tabEnv')`
 * reads `plot.tabEnv_vol` when the locale has it and `plot.tabEnv` otherwise
 * (i18next context), and a field label loses its Darwin Core term
 * (`fieldLabel`): 「數量 (organismQuantity)」 reads 「數量」. Use it for labels
 * and mode wording only. Name the result `tm`: check:i18n reads `tm('…')`
 * keys the same way it reads `t('…')`.
 */
export function useModeT(): (key: string, options?: Record<string, unknown>) => string {
  const { t } = useTranslation();
  const mode = useUsageMode();
  return useCallback(
    (key: string, options?: Record<string, unknown>) =>
      mode === 'pro' ? String(t(key, options)) : fieldLabel(String(t(key, { ...options, context: mode })), mode),
    [t, mode],
  );
}

const NO_FORMATS: AnalysisFormat[] = [];

/**
 * The analysis exports (vegan, JUICE, DwC-A) chosen in the settings, or none
 * where the mode hides that choice: a volunteer could not turn off what was
 * picked in pro mode, yet got the files (code review L61).
 */
export function useAnalysisFormats(): AnalysisFormat[] {
  const formats = useSettings((s) => s.export_analysis_formats);
  const showsChoice = vis(useUsageMode(), 'exportAnalysis') === 'show';
  return showsChoice ? formats : NO_FORMATS;
}
