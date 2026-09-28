/**
 * Elevation along the route with the planned stops, drawn to scale: x is
 * distance from the start, y is elevation. Labels name the first and last
 * stop, which the chart actually reaches.
 */
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Polyline, Text as SvgText } from 'react-native-svg';
import { useColorScheme as useNwColorScheme } from 'nativewind';
import { topElevation, type ProfilePoint, type Stop } from '../model/planner';

const H = 150;
const PAD = { l: 8, r: 8, t: 14, b: 20 };

export function ProfileChart({ points, along, stops }: { points: ProfilePoint[]; along: number[]; stops: Stop[] }) {
  const [w, setW] = useState(0);
  const dark = useNwColorScheme().colorScheme === 'dark';
  const ink = dark ? '#d1d5db' : '#374151';
  if (points.length < 2) return null;
  const total = along[along.length - 1] || 1;
  let lo = Infinity;
  for (const p of points) if (p.ele < lo) lo = p.ele;
  const hi = topElevation(points);
  const span = hi - lo || 1;
  const x = (d: number) => PAD.l + (d / total) * (w - PAD.l - PAD.r);
  const y = (e: number) => PAD.t + (1 - (e - lo) / span) * (H - PAD.t - PAD.b);
  // Decimate the line to about one point per pixel.
  const step = Math.max(1, Math.floor(points.length / Math.max(1, w)));
  const coords: string[] = [];
  for (let i = 0; i < points.length; i += step) coords.push(`${x(along[i])},${y(points[i].ele)}`);
  coords.push(`${x(along[points.length - 1])},${y(points[points.length - 1].ele)}`);
  const line = coords.join(' ');
  const first = stops[0];
  const last = stops[stops.length - 1];
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: H }}>
      {w > 0 ? (
        <Svg width={w} height={H}>
          <Polyline points={line} fill="none" stroke="#059669" strokeWidth={2} />
          {stops.map((s, i) => (
            <Circle key={i} cx={x(s.along)} cy={y(s.ele)} r={3} fill="#00A2A5" />
          ))}
          {first ? (
            <SvgText x={PAD.l} y={H - 5} fontSize={10} fill={ink}>
              {`01 · ${Math.round(first.ele)} m`}
            </SvgText>
          ) : null}
          {last && stops.length > 1 ? (
            <SvgText x={w - PAD.r} y={PAD.t - 3} fontSize={10} fill={ink} textAnchor="end">
              {`${String(stops.length).padStart(2, '0')} · ${Math.round(last.ele)} m`}
            </SvgText>
          ) : null}
        </Svg>
      ) : null}
    </View>
  );
}
