/**
 * The `react-native-maps` engine.
 *
 * This layer is the `<MapView>` usage from four screens moved across verbatim —
 * **behaviour must match the pre-refactor code item for item**, including zIndex
 * ordering, overlay mount order, and the `tracksViewChanges` lifecycle of
 * cluster bubbles.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View } from 'react-native';
import MapView, {
  Circle,
  Marker,
  Polygon,
  Polyline,
  PROVIDER_DEFAULT,
  UrlTile,
  type MapType,
} from 'react-native-maps';

import type { MapCamera, MapCanvasProps, MapFeature } from '../types';

/**
 * A cluster's custom-drawn marker.
 *
 * `tracksViewChanges` starts true and is turned off once the view has laid out
 * (starting false draws a blank marker). It used to be a timer, but a quarter of
 * a second of per-frame re-capture per bubble — multiplied by every bubble
 * mounted at once when a drawing is cancelled — was long enough to look like a
 * freeze.
 *
 * It must be turned back on when `renderKey` changes: a cluster's key holds only
 * the cell coordinates, so markers **stay mounted across a pan** (which is the
 * whole point), and changed content has to be re-captured rather than remounted.
 */
function CustomMarker({ feature }: { feature: Extract<MapFeature, { kind: 'marker' }> }) {
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
  }, [feature.renderKey, feature.lat, feature.lng]);

  return (
    <Marker
      coordinate={{ latitude: feature.lat, longitude: feature.lng }}
      anchor={feature.anchor}
      tracksViewChanges={tracks}
      zIndex={feature.zIndex}
      onPress={feature.onPress}
    >
      {/* Stop capturing after one frame rather than on a fixed delay: by then the
       capture is done, and waiting longer only burns frames. */}
      <View onLayout={() => requestAnimationFrame(() => setTracks(false))}>
        {feature.render?.()}
      </View>
    </Marker>
  );
}

function renderFeature(f: MapFeature) {
  switch (f.kind) {
    case 'marker':
      if (f.render) return <CustomMarker key={f.id} feature={f} />;
      return (
        <Marker
          key={f.id}
          identifier={f.id}
          coordinate={{ latitude: f.lat, longitude: f.lng }}
          title={f.title}
          description={f.description}
          pinColor={f.color}
          opacity={f.opacity}
          anchor={f.anchor}
          zIndex={f.zIndex}
          tappable={f.tappable}
          draggable={f.draggable}
          onPress={f.onPress}
          onDragEnd={
            f.onDragEnd ? (e) => f.onDragEnd?.(e.nativeEvent.coordinate) : undefined
          }
        />
      );
    case 'line':
      return (
        <Polyline
          key={f.id}
          coordinates={f.coords}
          strokeColor={f.color}
          strokeWidth={f.width}
          zIndex={f.zIndex}
          tappable={f.onPress != null}
          onPress={f.onPress}
        />
      );
    case 'polygon':
      return (
        <Polygon
          key={f.id}
          coordinates={f.coords}
          strokeColor={f.stroke}
          fillColor={f.fill}
          strokeWidth={f.width}
          zIndex={f.zIndex}
          tappable={f.onPress != null}
          onPress={f.onPress}
        />
      );
    case 'circle':
      return (
        <Circle
          key={f.id}
          center={{ latitude: f.lat, longitude: f.lng }}
          radius={f.radiusM}
          strokeColor={f.stroke}
          fillColor={f.fill}
          strokeWidth={f.width}
          zIndex={f.zIndex}
        />
      );
  }
}

export const RNMapsCanvas = forwardRef<MapCamera, MapCanvasProps>(function RNMapsCanvas(
  {
    initialRegion,
    mapType,
    features,
    rasterOverlays,
    showsUserLocation,
    showsCompass,
    showsScale,
    showsMyLocationButton,
    toolbarEnabled,
    overlayGeneration,
    onMapReady,
    onRegionChangeComplete,
    onPress,
    style,
    children,
  },
  ref,
) {
  const mapRef = useRef<MapView>(null);
  useImperativeHandle(ref, () => ({
    animateToRegion: (region, ms) => mapRef.current?.animateToRegion(region, ms),
  }));

  return (
    <MapView
      ref={mapRef}
      provider={PROVIDER_DEFAULT}
      style={style}
      initialRegion={initialRegion}
      mapType={mapType as MapType}
      showsCompass={showsCompass}
      showsScale={showsScale}
      showsUserLocation={showsUserLocation}
      showsMyLocationButton={showsMyLocationButton}
      toolbarEnabled={toolbarEnabled}
      onMapReady={onMapReady}
      onRegionChangeComplete={onRegionChangeComplete}
      onPress={onPress ? (e) => onPress(e.nativeEvent.coordinate) : undefined}
    >
      {(rasterOverlays ?? []).map((o) => (
        // The key is tied to overlayGeneration: changing the basemap forces a remount
        // so overlays are re-added above the offline tiles (on iOS ordering follows
          // insertion order alone).
        <UrlTile
          key={`${o.id}-${overlayGeneration ?? ''}`}
          urlTemplate={o.urlTemplate}
          opacity={o.opacity}
          zIndex={o.zIndex}
          maximumZ={o.maxZoom}
        />
      ))}

      {features.map(renderFeature)}
      {children}
    </MapView>
  );
});
