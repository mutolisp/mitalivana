/**
 * Unit status colours (03-screens-flow.md §4e). The four states differ in
 * lightness, not just hue, so they stay apart in direct sun and for colour-
 * blind users; 未開始 is an outlined card-coloured box rather than a pale grey
 * fill, which is what used to blur into 進行中's yellow.
 *
 * Built from theme tokens so dark mode gets its own values.
 */
import type { ThemeColors } from '~/theme/colors';
import type { UnitStatus } from './useSurvey';

export type StatusLook = {
  /** Box fill. */
  fill: string;
  /** Text drawn on the fill. */
  onFill: string;
  /** Outline; only 未開始 has one. */
  border: string | null;
  /** The status as coloured text in a list. */
  text: string;
};

export function statusLook(c: ThemeColors, s: UnitStatus): StatusLook {
  switch (s) {
    case 'none':
      return { fill: c.card, onFill: c.ink, border: c.outline, text: c.ink2 };
    case 'progress':
      return { fill: c.acorn, onFill: c.onAcorn, border: null, text: c.acornDeep };
    case 'done':
      return { fill: c.accent, onFill: c.onAccent, border: null, text: c.accent };
    case 'warn':
      return { fill: c.alert, onFill: c.onAccent, border: null, text: c.alert };
  }
}
