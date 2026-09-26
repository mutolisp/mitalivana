/**
 * A QR code drawn with react-native-svg from qrcode-generator's module
 * matrix — both pure JS, so no camera or native QR module is needed. Always
 * dark on white with a quiet zone, whatever the theme: scanners expect it.
 */
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

const QUIET = 4;

export function QrCode({ value, size }: { value: string; size: number }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
    return { n: count + QUIET * 2, d: path };
  }, [value]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} accessibilityRole="image">
      <Rect x={0} y={0} width={n} height={n} fill="#ffffff" />
      <Path d={d} fill="#000000" />
    </Svg>
  );
}
