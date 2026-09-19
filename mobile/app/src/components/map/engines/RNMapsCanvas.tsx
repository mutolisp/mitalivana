/**
 * `react-native-maps` 引擎。
 *
 * 這一層是把原本散在四個畫面裡的 `<MapView>` 用法原封不動搬過來 ——
 * **行為必須與重構前逐項相同**，包含 zIndex 層序、疊圖掛載順序、
 * cluster 泡泡的 `tracksViewChanges` 生命週期。
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
 * Cluster 的自繪 marker。
 *
 * `tracksViewChanges` 起始為 true，等 view 完成 layout 後關掉（一開始就 false
 * 會畫出空白 marker）。原本用計時器，但每個泡泡四分之一秒的逐幀重擷取 ——
 * 乘上取消編輯時同時掛載的所有泡泡 —— 久到看起來像當機。
 *
 * `renderKey` 變動時要重新打開：cluster 的 key 只含格子座標，marker 會**跨 pan
 * 保持掛載**（那正是重點），所以內容變了要重新擷取而不是 remount。
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
      {/* 一幀之後關掉擷取，不是固定延遲：那時擷取已經完成，等更久只是燒幀。 */}
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
        // key 綁 overlayGeneration：切底圖時強制重新掛載，讓疊圖重新加到
        // 離線圖磚之上（iOS 的先後順序只看加入順序）。
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
