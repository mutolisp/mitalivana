/**
 * The MapLibre vector engine.
 *
 * One of two implementations of the same neutral interface alongside
 * `RNMapsCanvas`, and the two **cannot be mixed in one screen** — they are
 * different native views, so the choice is per canvas.
 *
 * A few deliberate differences from the native engine, all of them forced by the
 * two models:
 *
 * - **Features are drawn as GeoJSON layers, not one native view each.** POIs cap
 *   at 300 per query (`POI_LIMIT`), and 300 view annotations on MapLibre are
 *   slow. `<Marker>` is used only for custom content like cluster bubbles, of
 *   which there are single digits.
 * - **Ordinary markers are drawn as dots, not pins.** MapLibre has no built-in
 *   pin icon; a pin would mean shipping a sprite. Dots also read better among
 *   dense POIs — a conscious trade.
 * - **`circle` is in metres and has to be turned into a polygon** (see
 *   `geodesicCircle`). MapLibre's `circle-radius` is in screen pixels and grows
 *   with zoom, which is the wrong semantics.
 * - **zIndex is expressed as array order.** MapLibre has no per-feature zIndex;
 *   layer order is draw order, so features are sorted by zIndex and then
 *   grouped.
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

/** Only these layers take part in tap hit-testing. */
const HIT_LAYERS = ['feat-marker', 'feat-line', 'feat-polygon-fill', 'feat-circle-fill'];

/** Hit-test tolerance in screen pixels. A thin line is nearly impossible to hit
 *  with a single point. */
const HIT_SLOP = 12;
/** Metres the device must move before the user-location puck updates. */
const USER_LOCATION_MIN_DISPLACEMENT_M = 5;

type Marker_ = Extract<MapFeature, { kind: 'marker' }>;

/** Sort position for an unspecified zIndex. The neutral type deliberately gives
 *  "unspecified" a meaning, so this is only treated as 0 while sorting and never
 *  written back to the feature. */
const zOf = (f: MapFeature) => f.zIndex ?? 0;

/**
 * Short, stable token for one tile URL, so a source's React key changes exactly
 * when its tiles do. A hash rather than the URL itself: the URL carries query
 * strings and braces, and the token ends up inside MapLibre layer ids.
 */
function templateToken(urlTemplate: string): string {
  let h = 0;
  for (let i = 0; i < urlTemplate.length; i += 1) {
    h = (Math.imul(h, 31) + urlTemplate.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

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

  // Sorted by zIndex, then grouped. The sort is stable, so equal zIndexes keep
  // their original mount order — which is exactly what the native engine does.
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
                  // A GeoJSON ring must be closed; the neutral type does not ask callers to do
    // that.
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
    // Ask whether a feature was hit first, and only then treat it as a tap on empty
      // space. This matches the native engine, where a feature's own onPress
    // takes precedence over the map's onPress.
    try {
      const hit = await mapRef.current?.queryRenderedFeatures(
        // PixelPointBounds is nested [[left,top],[right,bottom]], not a flat 4-tuple
        // (the package's JSDoc example is wrong; the type definition is right).
        [
          [px - HIT_SLOP, py - HIT_SLOP],
          [px + HIT_SLOP, py + HIT_SLOP],
        ],
        { layers: HIT_LAYERS },
      );
      // Top-down, take the first one with a handler
      for (const g of hit ?? []) {
        const id = g.properties?.id;
        const f = typeof id === 'string' ? byId.get(id) : undefined;
        if (f && 'onPress' in f && f.onPress) {
          f.onPress();
          return;
        }
      }
    } catch {
      // If the query fails, fall back to treating it as a tap on empty space rather
        // than losing the tap entirely
    }
    onPress?.({ latitude: lngLat[1], longitude: lngLat[0] });
  };

  return (
    <MapLibreMap
      ref={mapRef}
      style={style}
      mapStyle={vectorStyle ?? ''}
      compass={showsCompass}
      // North must stay visible in the field, so the compass does not fade out when
        // facing north (MapLibre hides it by default, like Apple and Google, but
      // that is meant for city navigation). Tapping it turns back to true north.
      compassHiddenFacingNorth={false}
      compassPosition={compassInset ?? { top: 8, right: 8 }}
      // MapLibre has a built-in scale bar, but **do not enable it** — the app's
      // MapScaleBar is a sibling of the canvas and is drawn for both engines
        // (map.tsx), so enabling this would produce two. showsScale on the native
      // engine is the one iOS shows briefly during a zoom, which is different
        // semantics anyway.
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

      {/* Raster overlays (WMTS, the iNaturalist grid). MapLibre has real layer
          ordering, so it does not need the native side's overlayGeneration hack
          that remounts overlays to push them to the top.

          The URL is part of the key because a MapLibre source is built ONCE:
          `MLRNSource.addToMap` calls `makeSource()` when the source is added and
          nothing rebuilds it afterwards, so a later `tiles` prop just sets a
          field on the view (android .../sources/MLRNSource.kt:83,
          tilesources/rastersource/MLRNRasterSource.kt). Keying on the id alone
          therefore leaves the previous layer's tiles on screen — the previous
          WMTS layer, or another species' observations. */}
      {(rasterOverlays ?? []).map((o) => {
        const key = `${o.id}-${templateToken(o.urlTemplate)}`;
        return (
          <RasterSource
            key={key}
            id={`ovl-${key}`}
            tiles={[o.urlTemplate]}
            tileSize={256}
            maxzoom={o.maxZoom}
          >
            <Layer
              id={`ovl-${key}-layer`}
              type="raster"
              paint={{ 'raster-opacity': o.opacity }}
            />
          </RasterSource>
        );
      })}

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

      {/* minDisplacement > 0 also drops MapLibre's compass-heading events,
          which otherwise re-render the puck many times a second. */}
      {showsUserLocation ? <UserLocation minDisplacement={USER_LOCATION_MIN_DISPLACEMENT_M} /> : null}
      {children}
    </MapLibreMap>
  );
});
