/**
 * `react-native-svg` → DOM SVG. React DOM already takes the camelCase SVG
 * attributes react-native-svg uses (strokeWidth, textAnchor, fontSize…);
 * what changes is `onPress` (→ click) and RN-style `style` objects.
 */
import { createElement, type ReactNode } from 'react';
import { toCss, type StyleProp, type StyleValue } from '../rn/style';

type P = Record<string, unknown> & { children?: ReactNode; onPress?: () => void; style?: StyleProp<StyleValue>; className?: string };

function el(tag: string) {
  return function SvgElement({ onPress, style, pointerEvents, children, ...rest }: P) {
    return createElement(
      tag,
      {
        ...rest,
        style: toCss(style),
        pointerEvents,
        onClick: onPress
          ? (e: Event) => {
              e.stopPropagation();
              onPress();
            }
          : undefined,
        cursor: onPress ? 'pointer' : undefined,
      },
      children,
    );
  };
}

const Svg = el('svg');
export default Svg;
export { Svg };
export const G = el('g');
export const Path = el('path');
export const Rect = el('rect');
export const Circle = el('circle');
export const Ellipse = el('ellipse');
export const Line = el('line');
export const Polygon = el('polygon');
export const Polyline = el('polyline');
export const Text = el('text');
export const TSpan = el('tspan');
export const Defs = el('defs');
export const ClipPath = el('clipPath');
export const LinearGradient = el('linearGradient');
export const Stop = el('stop');
