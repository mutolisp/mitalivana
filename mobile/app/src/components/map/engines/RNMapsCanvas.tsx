/**
 * The `react-native-maps` engine.
 *
 * This layer is the `<MapView>` usage from four screens moved across verbatim —
 * **behaviour must match the pre-refactor code item for item**, including zIndex
 * ordering, overlay mount order, and the `tracksViewChanges` lifecycle of
 * cluster bubbles.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, {
  Circle,
  Marker,
  Polygon,
  Polyline,
  PROVIDER_DEFAULT,
  UrlTile,
  type MapType,
} from 'react-native-maps';

import { NORTH_ARROW_SIZE, type MapCamera, type MapCanvasProps, type MapFeature } from '../types';
import { useThemeColors } from '~/theme/colors';

/** Space under the Apple logo and legal notice once moved, close to MapKit's own margin. */
const ATTRIBUTION_GAP = 6;

/**
 * North arrow.
 *
 * Drawn here rather than left to `showsCompass`, for the same reason
 * `MapScaleBar` is drawn by hand: the platform ornament is not the thing the
 * field needs. Apple's and Google's compasses appear only while the map is
 * turned away from north and fade out again once it is north-up — sensible for
 * city navigation, useless for someone orienting a map against the terrain, who
 * needs to know which way north is BEFORE deciding whether the map is turned.
 * The MapLibre engine already says so explicitly with
 * `compassHiddenFacingNorth={false}`; this is the same rule for the native one.
 *
 * `heading` is the map's bearing in degrees clockwise from north, so the needle
 * counter-rotates by it. Tapping turns the map back to true north, which is what
 * both platform compasses do.
 */
function NorthArrow({
  heading,
  inset,
  onPress,
}: {
  heading: number;
  inset?: { bottom: number; right: number };
  onPress: () => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('map.compass')}
      hitSlop={6}
      style={{
        position: 'absolute',
        right: inset?.right ?? 8,
        bottom: inset?.bottom ?? 8,
        // Shared with map.tsx, which stacks the locate button on top of this.
        width: NORTH_ARROW_SIZE,
        height: NORTH_ARROW_SIZE,
      }}
      className="items-center justify-center rounded-full bg-card/95 shadow-md dark:bg-gray-900/95"
    >
      <View className="items-center" style={{ transform: [{ rotate: `${-heading}deg` }] }}>
        {/* Border triangle: RN has no polygon primitive, and an icon font glyph
            cannot be split into a red north half and a grey south half. */}
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: 5,
            borderRightWidth: 5,
            borderBottomWidth: 9,
            borderLeftColor: 'transparent',
            borderRightColor: 'transparent',
            borderBottomColor: c.alert,
          }}
        />
        <Text className="mt-0.5 text-[9px] font-bold text-gray-700 dark:text-gray-200">N</Text>
      </View>
    </Pressable>
  );
}

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
    compassInset,
    attributionInset,
    showsScale,
    showsMyLocationButton,
    toolbarEnabled,
    overlayGeneration,
    onMapReady,
    onRegionChangeComplete,
    onPress,
    gestures = true,
    style,
    children,
  },
  ref,
) {
  const mapRef = useRef<MapView>(null);
  useImperativeHandle(ref, () => ({
    animateToRegion: (region, ms) => mapRef.current?.animateToRegion(region, ms),
  }));

  const [heading, setHeading] = useState(0);

  // react-native-maps 1.27 on Android rebuilds its GoogleMap when the view is
  // attached again (a tab coming back into view) and fires onMapReady again,
  // but does not re-apply mapType (MapView.java onAttachedToWindow →
  // onMapReady), so the map comes back standard while the prop still says
  // satellite. A changed prop is what reaches native, so render 'standard' —
  // what the rebuilt map already shows — for one commit, then the real type.
  // Apple Maps fires onMapReady once (AIRMapManager hasStartedRendering).
  const readyBefore = useRef(false);
  const [resendType, setResendType] = useState(false);
  useEffect(() => {
    if (resendType) setResendType(false);
  }, [resendType]);

  /** The bearing is only on the camera, which is an async native read, so it is
   *  taken once per gesture rather than per frame — the same cadence as the
   *  scale bar and clustering. */
  const readHeading = useCallback(() => {
    mapRef.current
      ?.getCamera()
      .then((cam) => {
        const h = Number(cam?.heading);
        if (Number.isFinite(h)) setHeading(h);
      })
      .catch(() => {
        // getCamera rejects outside the new architecture. Leaving the needle
        // where it was is the honest failure: it is still pointing at the north
        // of the last reading, and the alternative — snapping it to 0 — would
        // claim the map is north-up when it may not be.
      });
  }, []);

  const map = (
    <MapView
      ref={mapRef}
      provider={PROVIDER_DEFAULT}
      style={showsCompass ? StyleSheet.absoluteFill : style}
      initialRegion={initialRegion}
      mapType={(resendType ? 'standard' : mapType) as MapType}
      // Logo and legal notice clear of what is drawn over the map's bottom.
      // Apple Maps moves each on its own (AIRMap re-applies them on every
      // layout; a 0 side is left where MapKit put it). Google's logo moves only
      // with the map's padding, and Google then reports regions for the padded
      // part while initialRegion is fitted to the whole view: bottom padding
      // alone made the map tab's saved region creep north on every launch.
      // The same padding at the top keeps that part centred and as wide as the
      // view, so a saved region comes back at the same centre and zoom.
      appleLogoInsets={attributionInset ? { top: 0, right: 0, bottom: attributionInset + ATTRIBUTION_GAP, left: 0 } : undefined}
      legalLabelInsets={attributionInset ? { top: 0, right: 0, bottom: attributionInset + ATTRIBUTION_GAP, left: 0 } : undefined}
      mapPadding={
        attributionInset && Platform.OS === 'android'
          ? { top: attributionInset, right: 0, bottom: attributionInset, left: 0 }
          : undefined
      }
      // The platform compass is replaced by NorthArrow, never shown alongside
      // it: two compasses in two corners is worse than either.
      showsCompass={false}
      showsScale={showsScale}
      showsUserLocation={showsUserLocation}
      showsMyLocationButton={showsMyLocationButton}
      toolbarEnabled={toolbarEnabled}
      scrollEnabled={gestures}
      zoomEnabled={gestures}
      pitchEnabled={gestures}
      rotateEnabled={gestures}
      onMapReady={() => {
        if (readyBefore.current && mapType && mapType !== 'standard') setResendType(true);
        readyBefore.current = true;
        if (showsCompass) readHeading();
        onMapReady?.();
      }}
      onRegionChangeComplete={(region) => {
        if (showsCompass) readHeading();
        onRegionChangeComplete?.(region);
      }}
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

  // Wrapped only when there is an arrow to put on top: every other screen keeps
  // the view tree it had, `style` (rounded corners, fixed heights) included.
  if (!showsCompass) return map;
  return (
    <View style={style}>
      {map}
      <NorthArrow
        heading={heading}
        inset={compassInset}
        onPress={() => {
          mapRef.current?.animateCamera({ heading: 0 }, { duration: 300 });
          // The camera read fires on the region change the animation causes, but
          // an animation that changes only the bearing may not report one, so
          // the needle is put where it was asked to go.
          setHeading(0);
        }}
      />
    </View>
  );
});
