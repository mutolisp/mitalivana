/**
 * `Ionicons` from @expo/vector-icons, drawn from the generated SVG table
 * (scripts/gen-icons.mjs). The SVGs are the package's own files: trusted,
 * fixed at build time, colored by currentColor.
 */
import type { CSSProperties } from 'react';
import { ICONS } from './icons.generated';
import { toCss, type StyleProp, type StyleValue } from './style';

export type IoniconName = string;

export function Ionicons(p: { name: IoniconName; size?: number; color?: string; style?: StyleProp<StyleValue>; className?: string; accessibilityLabel?: string }) {
  const svg = ICONS[p.name];
  if (!svg && import.meta.env.DEV) console.warn(`[icons] missing "${p.name}" — run node scripts/gen-icons.mjs`);
  const size = p.size ?? 24;
  const style: CSSProperties = { width: size, height: size, color: p.color, ...toCss(p.style) };
  return (
    <span
      className={['rn-icon', p.className].filter(Boolean).join(' ')}
      style={style}
      role={p.accessibilityLabel ? 'img' : undefined}
      aria-label={p.accessibilityLabel}
      aria-hidden={p.accessibilityLabel ? undefined : true}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

// `@expo/vector-icons` exports more families; only Ionicons is used.
Ionicons.glyphMap = ICONS;
