/**
 * Plot-type glyphs Ionicons has nothing for, drawn in one style (round-capped
 * strokes, solid points) and sized and coloured like an Ionicons glyph.
 *
 *   TransectIcon    穿越線 — a winding line between a start and an end point
 *   PointCountIcon  定點計數 — a point and the radius counted around it
 */
import Svg, { Circle, Path } from 'react-native-svg';

export function TransectIcon({ size = 24, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M5.5 18 C 9 18, 9.5 13, 12 12.5 S 15 7, 18.5 6"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={5.5} cy={18} r={2.9} fill={color} />
      <Circle cx={18.5} cy={6} r={2.9} fill={color} />
    </Svg>
  );
}

export function PointCountIcon({ size = 24, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* The counting radius: dashed, since it is a boundary, not a thing. */}
      <Circle cx={12} cy={12} r={8.6} stroke={color} strokeWidth={2} strokeDasharray="3 2.6" fill="none" />
      <Path d="M12 12 L 18 6" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
      <Circle cx={12} cy={12} r={2.9} fill={color} />
    </Svg>
  );
}
