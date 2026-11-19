/**
 * `expo-image` Image. `webmedia:` URIs (photos in IndexedDB) are turned into
 * object URLs first; anything else is used as given.
 */
import { useEffect, useState } from 'react';
import { toCss, type StyleProp, type StyleValue } from '../rn/style';
import { isWebMediaUri } from './appFiles';
import { mediaObjectUrl } from './mediaStore';

type Source = string | { uri?: string | null } | null | undefined;

export function Image(p: {
  source?: Source;
  className?: string;
  style?: StyleProp<StyleValue>;
  contentFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  accessibilityLabel?: string;
  alt?: string;
  transition?: number;
  recyclingKey?: string;
  cachePolicy?: string;
  placeholder?: unknown;
  onLoad?: () => void;
  onError?: () => void;
}) {
  const raw = typeof p.source === 'string' ? p.source : (p.source?.uri ?? null);
  const [src, setSrc] = useState<string | null>(raw && !isWebMediaUri(raw) ? raw : null);
  useEffect(() => {
    let live = true;
    if (!raw) setSrc(null);
    else if (isWebMediaUri(raw)) void mediaObjectUrl(raw).then((u) => live && setSrc(u));
    else setSrc(raw);
    return () => {
      live = false;
    };
  }, [raw]);
  if (!src) return <span className={['rn-view', p.className].filter(Boolean).join(' ')} style={toCss(p.style)} />;
  return (
    <img
      src={src}
      alt={p.alt ?? p.accessibilityLabel ?? ''}
      className={['rn-image', p.className].filter(Boolean).join(' ')}
      style={{ objectFit: p.contentFit ?? 'cover', ...toCss(p.style) }}
      onLoad={p.onLoad}
      onError={p.onError}
    />
  );
}
