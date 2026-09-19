/**
 * 地圖畫布 —— 依引擎分派到實作。
 *
 * app 之上的程式碼只認 `src/components/map/types.ts` 的中性型別，不再 import
 * 任何地圖 library。這是為了讓 MapLibre 向量引擎能以**加法**加入，而不是把
 * react-native-maps 換掉：兩者是不同的原生 view，不能在同一畫面混用，但可以
 * 整個 canvas 二選一。
 *
 * 沒有給 `vectorStyle` 就算指定 `engine="vector"` 也會退回 native —— 向量引擎
 * 沒有樣式就是一片空白，退回去至少還有地圖可看。
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
