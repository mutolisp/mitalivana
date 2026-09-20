/**
 * The map canvas — dispatches to an engine implementation.
 *
 * Everything above this only knows the neutral types in
 * `src/components/map/types.ts` and imports no map library. That is what let
 * the MapLibre vector engine be **added** rather than swapped in for
 * react-native-maps: the two are different native views and cannot be mixed in
 * one screen, but the canvas as a whole can be either.
 *
 * Without a `vectorStyle`, even `engine="vector"` falls back to native — the
 * vector engine with no style is a blank screen, and falling back at least
 * leaves a map to look at.
 */
import { forwardRef } from 'react';

import { MapLibreCanvas } from './engines/MapLibreCanvas';
import { RNMapsCanvas } from './engines/RNMapsCanvas';
import type { MapCamera, MapCanvasProps } from './types';

export const MapCanvas = forwardRef<MapCamera, MapCanvasProps>(function MapCanvas(props, ref) {
  if (props.engine === 'vector' && props.vectorStyle) {
    return <MapLibreCanvas ref={ref} {...props} />;
  }
  return <RNMapsCanvas ref={ref} {...props} />;
});

export type { MapCamera, MapCanvasProps } from './types';
