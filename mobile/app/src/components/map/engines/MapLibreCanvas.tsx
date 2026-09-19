/**
 * MapLibre 向量引擎。
 *
 * 與 `RNMapsCanvas` 是同一個中性介面的兩個實作，**不能在同一畫面混用** ——
 * 兩者是不同的原生 view，所以整個 canvas 二選一。
 *
 * 幾個刻意與 native 引擎不同的地方，都是兩邊模型差異造成的：
 *
 * - **圖徵走 GeoJSON 圖層而不是逐個原生 view。** POI 一次最多 300 個
 *   （`POI_LIMIT`），在 MapLibre 上掛 300 個 view annotation 會很慢。只有
 *   cluster 泡泡那種自繪內容才用 `<Marker>`，數量是個位數。
 * - **一般 marker 畫成圓點而不是 pin。** MapLibre 沒有內建 pin 圖示，要 pin
 *   得自己上 sprite。圓點在密集 POI 下反而更好讀，這是有意識的取捨。
 * - **`circle` 是公尺，要自己算成多邊形**（見 `geodesicCircle`）。MapLibre 的
 *   `circle-radius` 是螢幕像素，縮放時會跟著變大，語意不對。
 * - **zIndex 用陣列順序表達。** MapLibre 沒有 per-feature 的 zIndex，圖層順序
 *   就是繪製順序，所以圖徵先照 zIndex 排序再分組。
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  RasterSource,
  UserLocation,
  type CameraRef,
  type MapRef,
  type PressEvent,
  type PressEventWithFeatures,
} from '@maplibre/maplibre-react-native';
import type { NativeSyntheticEvent } from 'react-native';

import { geodesicCircle } from '../geodesicCircle';
import type { MapCamera, MapCanvasProps, MapFeature, Region } from '../types';

/** 這些圖層才參與點擊命中測試。 */
const HIT_LAYERS = ['feat-marker', 'feat-line', 'feat-polygon-fill', 'feat-circle-fill'];

/** 點擊命中的容錯半徑（螢幕像素）。細線用一個點去打幾乎打不到。 */
const HIT_SLOP = 12;

type Marker_ = Extract<MapFeature, { kind: 'marker' }>;

/** zIndex 未指定時的排序位置。中性型別刻意讓「未指定」有語意，這裡只在
 *  排序時當成 0，不會寫回圖徵。 */
const zOf = (f: MapFeature) => f.zIndex ?? 0;

function featureCollection(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features };
}

export const MapLibreCanvas = forwardRef<MapCamera, MapCanvasProps>(function MapLibreCanvas(
  {
    initialRegion,
    features,
    rasterOverlays,
    vectorStyle,
    showsUserLocation,
    showsCompass,
    compassInset,
    onMapReady,
    onRegionChangeComplete,
    onPress,
    style,
    children,
  },
  ref,
) {
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);

  useImperativeHandle(ref, () => ({
    animateToRegion: (region: Region, ms: number) =>
      cameraRef.current?.fitBounds(
        [
          region.longitude - region.longitudeDelta / 2,
          region.latitude - region.latitudeDelta / 2,
          region.longitude + region.longitudeDelta / 2,
          region.latitude + region.latitudeDelta / 2,
        ],
        { duration: ms },
      ),
  }));

  // 依 zIndex 排序後分組。sort 是穩定的，同 zIndex 維持原本的掛載順序 ——
  // 那正是 native 引擎的行為。
  const sorted = useMemo(() => [...features].sort((a, b) => zOf(a) - zOf(b)), [features]);

  const { markers, custom, lines, polygons, circles, byId } = useMemo(() => {
    const markers: GeoJSON.Feature[] = [];
    const custom: Marker_[] = [];
    const lines: GeoJSON.Feature[] = [];
    const polygons: GeoJSON.Feature[] = [];
    const circles: GeoJSON.Feature[] = [];
    const byId = new Map<string, MapFeature>();

    for (const f of sorted) {
      byId.set(f.id, f);
      switch (f.kind) {
        case 'marker':
          if (f.render) {
            custom.push(f);
            break;
          }
          markers.push({
            type: 'Feature',
            id: f.id,
            geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
            properties: { id: f.id, color: f.color ?? '#e11d48', opacity: f.opacity ?? 1 },
          });
          break;
        case 'line':
          lines.push({
            type: 'Feature',
            id: f.id,
            geometry: {
              type: 'LineString',
              coordinates: f.coords.map((c) => [c.longitude, c.latitude]),
            },
            properties: { id: f.id, color: f.color, width: f.width },
          });
          break;
        case 'polygon':
          polygons.push({
            type: 'Feature',
            id: f.id,
            geometry: {
              type: 'Polygon',
              coordinates: [
                (() => {
                  const ring = f.coords.map((c): [number, number] => [c.longitude, c.latitude]);
                  // GeoJSON 的環必須閉合；中性型別不要求呼叫端補這一點。
                  const first = ring[0];
                  const last = ring[ring.length - 1];
                  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
                    ring.push(first);
                  }
                  return ring;
                })(),
              ],
            },
            properties: { id: f.id, stroke: f.stroke, fill: f.fill, width: f.width },
          });
          break;
        case 'circle':
          circles.push({
            type: 'Feature',
            id: f.id,
            geometry: {
              type: 'Polygon',
              coordinates: [geodesicCircle(f.lat, f.lng, f.radiusM)],
            },
            properties: { id: f.id, stroke: f.stroke, fill: f.fill, width: f.width },
          });
          break;
      }
    }
    return { markers, custom, lines, polygons, circles, byId };
  }, [sorted]);

  const handlePress = async (
    event: NativeSyntheticEvent<PressEvent> | NativeSyntheticEvent<PressEventWithFeatures>,
  ) => {
    const { lngLat, point } = event.nativeEvent;
    const [px, py] = point;
    // 先問有沒有打到圖徵；沒有才當成點空白處。這對應 native 引擎「圖徵自己的
    // onPress 優先於地圖的 onPress」的行為。
    try {
      const hit = await mapRef.current?.queryRenderedFeatures(
        // PixelPointBounds 是巢狀的 [[left,top],[right,bottom]]，不是扁平四元組
        // （套件 JSDoc 的範例寫錯了，型別定義才是對的）。
        [
          [px - HIT_SLOP, py - HIT_SLOP],
          [px + HIT_SLOP, py + HIT_SLOP],
        ],
        { layers: HIT_LAYERS },
      );
      // 由上而下取第一個有 handler 的
      for (const g of hit ?? []) {
        const id = g.properties?.id;
        const f = typeof id === 'string' ? byId.get(id) : undefined;
        if (f && 'onPress' in f && f.onPress) {
          f.onPress();
          return;
        }
      }
    } catch {
      // 查詢失敗就退回當成點空白處，不要讓點擊整個失效
    }
    onPress?.({ latitude: lngLat[1], longitude: lngLat[0] });
  };

  return (
    <MapLibreMap
      ref={mapRef}
      style={style}
      mapStyle={vectorStyle ?? ''}
      compass={showsCompass}
      // 野外需要隨時看得到北方，所以朝北時也不要淡出（MapLibre 預設會藏起來，
      // 和 Apple/Google 的行為一樣，但那是給市區導航用的）。點一下會轉回正北。
      compassHiddenFacingNorth={false}
      compassPosition={compassInset ?? { top: 8, right: 8 }}
      // MapLibre 有內建比例尺，但**不要開** —— app 的 MapScaleBar 是 canvas 的
      // 兄弟節點、兩個引擎都會畫（map.tsx），開了會變成兩條。showsScale 在
      // native 引擎是 iOS 縮放時才短暫出現的那條，語意本來就不同。
      scaleBar={false}
      attribution
      logo={false}
      onDidFinishLoadingMap={onMapReady}
      onRegionDidChange={(e) => {
        const [west, south, east, north] = e.nativeEvent.bounds;
        onRegionChangeComplete?.({
          latitude: (north + south) / 2,
          longitude: (east + west) / 2,
          latitudeDelta: Math.abs(north - south),
          longitudeDelta: Math.abs(east - west),
        });
      }}
      onPress={handlePress}
    >
      <Camera
        ref={cameraRef}
        initialViewState={{
          bounds: [
            initialRegion.longitude - initialRegion.longitudeDelta / 2,
            initialRegion.latitude - initialRegion.latitudeDelta / 2,
            initialRegion.longitude + initialRegion.longitudeDelta / 2,
            initialRegion.latitude + initialRegion.latitudeDelta / 2,
          ],
        }}
      />

      {/* WMTS 疊圖。MapLibre 有真正的圖層順序，所以不需要 native 端那個
          靠重新掛載把疊圖推到最上層的 overlayGeneration hack。 */}
      {(rasterOverlays ?? []).map((o) => (
        <RasterSource
          key={o.id}
          id={`ovl-${o.id}`}
          tiles={[o.urlTemplate]}
          tileSize={256}
          maxzoom={o.maxZoom}
        >
          <Layer
            id={`ovl-${o.id}-layer`}
            type="raster"
            paint={{ 'raster-opacity': o.opacity }}
          />
        </RasterSource>
      ))}

      {polygons.length > 0 && (
        <GeoJSONSource id="src-polygon" data={featureCollection(polygons)}>
          <Layer
            id="feat-polygon-fill"
            type="fill"
            paint={{ 'fill-color': ['get', 'fill'] }}
          />
          <Layer
            id="feat-polygon-line"
            type="line"
            paint={{ 'line-color': ['get', 'stroke'], 'line-width': ['get', 'width'] }}
          />
        </GeoJSONSource>
      )}

      {circles.length > 0 && (
        <GeoJSONSource id="src-circle" data={featureCollection(circles)}>
          <Layer id="feat-circle-fill" type="fill" paint={{ 'fill-color': ['get', 'fill'] }} />
          <Layer
            id="feat-circle-line"
            type="line"
            paint={{ 'line-color': ['get', 'stroke'], 'line-width': ['get', 'width'] }}
          />
        </GeoJSONSource>
      )}

      {lines.length > 0 && (
        <GeoJSONSource id="src-line" data={featureCollection(lines)} lineMetrics>
          <Layer
            id="feat-line"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] }}
          />
        </GeoJSONSource>
      )}

      {markers.length > 0 && (
        <GeoJSONSource id="src-marker" data={featureCollection(markers)}>
          <Layer
            id="feat-marker"
            type="circle"
            paint={{
              'circle-radius': 6,
              'circle-color': ['get', 'color'],
              'circle-opacity': ['get', 'opacity'],
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#ffffff',
            }}
          />
        </GeoJSONSource>
      )}

      {/* 自繪內容（cluster 泡泡）才用原生 view annotation。MapLibre 不需要
          native 引擎那個 tracksViewChanges 的生命週期 —— 它不是把 view
          擷取成圖片，而是真的疊一個 RN view。 */}
      {custom.map((f) => (
        <Marker
          key={f.id}
          id={f.id}
          lngLat={[f.lng, f.lat]}
          // 中性介面的 anchor 是 {x,y} 比例，MapLibre 只收九宮格字串。
          // cluster 泡泡用的是置中，其餘維持預設。
          anchor={f.anchor && f.anchor.x === 0.5 && f.anchor.y === 0.5 ? 'center' : undefined}
          onPress={f.onPress ? () => f.onPress?.() : undefined}
        >
          <>{f.render?.()}</>
        </Marker>
      ))}

      {showsUserLocation ? <UserLocation /> : null}
      {children}
    </MapLibreMap>
  );
});
