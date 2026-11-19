/**
 * React Native style objects → DOM inline styles.
 *
 * Covers what the shared components use: nested style arrays and falsy
 * entries, the RN-only shorthands (paddingHorizontal…), `transform` arrays,
 * and unitless numbers (React DOM adds px where needed). Shadow / elevation /
 * tint props have no DOM equivalent here and are dropped.
 */
import type { CSSProperties } from 'react';

export type StyleValue = Record<string, unknown>;
export type StyleProp<T = StyleValue> = T | null | undefined | false | 0 | '' | ReadonlyArray<StyleProp<T>>;

export function flatten(style: StyleProp<StyleValue>): StyleValue {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map((s) => flatten(s as StyleProp<StyleValue>)));
  return style as StyleValue;
}

const DROP = new Set([
  'shadowColor', 'shadowOffset', 'shadowOpacity', 'shadowRadius', 'elevation', 'tintColor', 'includeFontPadding',
  'textAlignVertical', 'overlayColor', 'resizeMode',
]);

const px = (v: unknown) => (typeof v === 'number' ? `${v}px` : String(v));

function transformCss(t: unknown): string | undefined {
  if (!Array.isArray(t)) return typeof t === 'string' ? t : undefined;
  return t
    .map((o: Record<string, unknown>) => {
      const [k, v] = Object.entries(o)[0] ?? [];
      if (!k) return '';
      if (/^(translate[XY]?)$/.test(k)) return `${k}(${px(v)})`;
      if (/^(rotate|rotate[XYZ]|skew[XY])$/.test(k)) return `${k}(${typeof v === 'number' ? `${v}deg` : v})`;
      return `${k}(${v})`;
    })
    .join(' ');
}

export function toCss(style: StyleProp<StyleValue>): CSSProperties | undefined {
  const s = flatten(style);
  const keys = Object.keys(s);
  if (keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = s[k];
    if (v == null || DROP.has(k)) continue;
    switch (k) {
      case 'paddingHorizontal':
        out.paddingLeft = v;
        out.paddingRight = v;
        break;
      case 'paddingVertical':
        out.paddingTop = v;
        out.paddingBottom = v;
        break;
      case 'marginHorizontal':
        out.marginLeft = v;
        out.marginRight = v;
        break;
      case 'marginVertical':
        out.marginTop = v;
        out.marginBottom = v;
        break;
      case 'transform':
        out.transform = transformCss(v);
        break;
      case 'lineHeight':
        // RN: pixels. DOM: a bare number is a multiple of the font size.
        out.lineHeight = typeof v === 'number' ? `${v}px` : v;
        break;
      case 'fontVariant':
        out.fontVariantNumeric = Array.isArray(v) ? v.join(' ') : v;
        break;
      case 'borderStyle':
        out.borderStyle = v;
        break;
      case 'flex': {
        // RN's `flex` is not CSS's: 0 = sized by content, neither grows nor
        // shrinks (CSS `flex: 0` is basis 0, which collapses the view);
        // n > 0 = grow n from a zero basis; -1 = shrink only. Explicit
        // flexGrow / flexShrink / flexBasis in the same style still win.
        const n = Number(v);
        const [grow, shrink, basis] = n > 0 ? [n, 1, '0%'] : n === 0 ? [0, 0, 'auto'] : [0, 1, 'auto'];
        if (s.flexGrow == null) out.flexGrow = grow;
        if (s.flexShrink == null) out.flexShrink = shrink;
        if (s.flexBasis == null) out.flexBasis = basis;
        break;
      }
      default:
        out[k] = v;
    }
  }
  // RN borders are solid by default when a width is set.
  if (Object.keys(out).some((k) => /^border(Top|Right|Bottom|Left)?Width$/.test(k)) && out.borderStyle == null) {
    out.borderStyle = 'solid';
  }
  return out as CSSProperties;
}

export const StyleSheet = {
  create<T extends Record<string, StyleValue>>(styles: T): T {
    return styles;
  },
  flatten,
  hairlineWidth: 1,
  absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as StyleValue,
  absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as StyleValue,
  compose(a: StyleProp<StyleValue>, b: StyleProp<StyleValue>) {
    return [a, b];
  },
};
