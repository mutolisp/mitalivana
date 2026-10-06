/**
 * The map half of the split view (design 18j / 18k / 18m): the walked track in
 * tappable stretches, a pin per located record, the device's position, and for
 * a point count the counting circle.
 *
 * - Top left, a status pill: the track's length with its pause / resume button,
 *   or for a point count the radius and whether you stand inside it.
 * - Top right, centre on where you are.
 * - Bottom, 「記在這裡」 (not on a point count): the caller turns the docked
 *   search into "add at the current position".
 * - Tapping a stretch narrows the list to what was recorded along it
 *   (src/lib/alongTrack.ts); tapping a pin picks that record. A picked record
 *   from the list moves the map to its pin.
 *
 * The basemap follows the map tab's choice, including the offline vector map —
 * in the field there is often no signal.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';

import { CtrlButton, centerOn, locateMe } from '~/components/MapControls';
import type { Stretch } from '~/lib/alongTrack';
import { basemapToMapType } from '~/lib/basemap';
import type { TrackSegment } from '~/lib/track';
import { VECTOR_STYLE_URL, vectorStyleUri } from '~/lib/vectormap';
import { useVectorInstall } from '~/lib/vectormapInstall';
import { useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';
import { MAP_DATA } from '~/theme/mapColors';
import { MapCanvas } from './MapCanvas';
import type { MapCamera, MapFeature, Region } from './types';

export type FieldMapPoint = { id: number; lat: number; lng: number; glyph: string };

export type FieldMapStatus =
  | { kind: 'track'; recording: boolean; lengthM: number; onToggle?: () => void }
  | { kind: 'circle'; lat: number; lng: number; radiusM: number };

const toRad = (d: number) => (d * Math.PI) / 180;
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A region around everything there is to show, or null when there is nothing. */
function fitRegion(coords: { lat: number; lng: number }[], padM = 0): Region | null {
  if (coords.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of coords) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const padLat = padM / 111_195;
  const padLng = padM / (111_195 * Math.cos(toRad((minLat + maxLat) / 2)));
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat + 2 * padLat) * 1.3, 0.002),
    longitudeDelta: Math.max((maxLng - minLng + 2 * padLng) * 1.3, 0.002),
  };
}

function lengthText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function FieldMap({
  track,
  stretches,
  pickedStretch,
  onPickStretch,
  points,
  dimmed,
  picked,
  onPick,
  callout,
  status,
  onRecordHere,
  recordHereOn = false,
}: {
  track: TrackSegment[];
  stretches: Stretch[];
  pickedStretch: number | null;
  onPickStretch?: (index: number | null) => void;
  points: FieldMapPoint[];
  /** Pins outside the stretch being shown. */
  dimmed?: ReadonlySet<number>;
  picked: number | null;
  onPick: (id: number | null) => void;
  /** The picked record, in words. */
  callout?: { title: string; meta: string } | null;
  status: FieldMapStatus | null;
  onRecordHere?: () => void;
  recordHereOn?: boolean;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const mapRef = useRef<MapCamera>(null);

  // Basemap: the map tab's, offline vector map included.
  const basemap = useSettings((s) => s.map_view.basemap);
  const fallback = useSettings((s) => s.map_view);
  const vectorInstalled = useVectorInstall((s) => s.installed);
  const vectorReady = useVectorInstall((s) => s.ready);
  const vectorStyleRev = useVectorInstall((s) => s.styleRev);
  const vectorOn = basemap === 'vector';
  const vectorStyle = vectorOn ? (vectorReady && vectorInstalled ? vectorStyleUri() : VECTOR_STYLE_URL) : undefined;

  const circle = status?.kind === 'circle' ? status : null;
  const coords = [
    ...track.flatMap((s) => s.map(([lng, lat]) => ({ lat, lng }))),
    ...points.map((p) => ({ lat: p.lat, lng: p.lng })),
    ...(circle ? [{ lat: circle.lat, lng: circle.lng }] : []),
  ];
  const hasData = coords.length > 0;
  const initialRegion = useMemo<Region>(
    () =>
      fitRegion(coords, circle ? circle.radiusM : 30) ?? {
        latitude: fallback.latitude,
        longitude: fallback.longitude,
        latitudeDelta: Math.min(fallback.latitudeDelta, 0.02),
        longitudeDelta: Math.min(fallback.longitudeDelta, 0.02),
      },
    // The first frame only; afterwards the user owns the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const regionRef = useRef<Region>(initialRegion);

  // Opened with nothing to show (a new transect): start where you stand, not
  // where the map tab was last left, and frame the first point once it comes.
  const framed = useRef(hasData);
  useEffect(() => {
    if (framed.current) return;
    let gone = false;
    void (async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted || gone || framed.current) return;
      const pos = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
      if (!pos || gone || framed.current) return;
      mapRef.current?.animateToRegion(
        { latitude: pos.coords.latitude, longitude: pos.coords.longitude, latitudeDelta: 0.006, longitudeDelta: 0.006 },
        300,
      );
    })();
    return () => {
      gone = true;
    };
  }, []);
  useEffect(() => {
    if (framed.current || !hasData) return;
    framed.current = true;
    const r = fitRegion(coords, circle ? circle.radiusM : 30);
    if (r) mapRef.current?.animateToRegion({ ...r, latitudeDelta: Math.max(r.latitudeDelta, 0.006), longitudeDelta: Math.max(r.longitudeDelta, 0.006) }, 300);
    // Once, when the first thing to show appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasData]);

  // A record picked in the list: bring its pin into view, keeping the zoom.
  useEffect(() => {
    if (picked == null) return;
    const p = points.find((x) => x.id === picked);
    if (p) centerOn(mapRef, regionRef, p.lat, p.lng);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  // A stretch picked: frame it.
  useEffect(() => {
    if (pickedStretch == null) return;
    const s = stretches[pickedStretch];
    const r = s ? fitRegion(s.parts.flatMap((part) => part.map(([lng, lat]) => ({ lat, lng }))), 40) : null;
    if (r) mapRef.current?.animateToRegion(r, 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedStretch]);

  // Point count: where you stand against the circle. Only while this map is
  // shown, and never asking for permission (the plot's own locate does that).
  const [here, setHere] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  useEffect(() => {
    if (!circle) return;
    let sub: Location.LocationSubscription | null = null;
    let gone = false;
    void (async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted || gone) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 3, timeInterval: 5000 },
        (pos) => setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null }),
      );
      if (gone) sub.remove();
    })();
    return () => {
      gone = true;
      sub?.remove();
    };
  }, [circle?.lat, circle?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const features: MapFeature[] = [
    ...(circle
      ? [
          {
            kind: 'circle' as const,
            id: 'count-circle',
            lat: circle.lat,
            lng: circle.lng,
            radiusM: circle.radiusM,
            stroke: MAP_DATA.circle,
            fill: MAP_DATA.circleFill,
            width: 2,
          },
          {
            kind: 'marker' as const,
            id: 'count-point',
            lat: circle.lat,
            lng: circle.lng,
            anchor: { x: 0.5, y: 0.5 },
            tappable: false,
            renderKey: 'count-point',
            render: () => (
              <View
                style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: MAP_DATA.pinRing, backgroundColor: MAP_DATA.countPoint }}
              />
            ),
          },
        ]
      : []),
    // The track: stretches when there are any, else the raw segments.
    ...(stretches.length > 0
      ? stretches.flatMap((s) =>
          s.parts
            .filter((part) => part.length >= 2)
            .map((part, j) => ({
              kind: 'line' as const,
              id: `stretch-${s.index}-${j}`,
              coords: part.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
              color: pickedStretch === s.index ? MAP_DATA.trackPicked : s.index % 2 === 0 ? MAP_DATA.track : MAP_DATA.trackAlt,
              width: pickedStretch === s.index ? 8 : 6,
              zIndex: 1,
              onPress: onPickStretch ? () => onPickStretch(pickedStretch === s.index ? null : s.index) : undefined,
            })),
        )
      : track
          .filter((part) => part.length >= 2)
          .map((part, j) => ({
            kind: 'line' as const,
            id: `track-${j}`,
            coords: part.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
            color: MAP_DATA.track,
            width: 5,
            zIndex: 1,
          }))),
    ...points.map((p) => {
      const on = p.id === picked;
      const dim = dimmed?.has(p.id) ?? false;
      const d = on ? 30 : 24;
      return {
        kind: 'marker' as const,
        id: `rec-${p.id}`,
        lat: p.lat,
        lng: p.lng,
        anchor: { x: 0.5, y: 0.5 },
        zIndex: on ? 3 : 2,
        onPress: () => onPick(on ? null : p.id),
        renderKey: `${on ? 1 : 0}${dim ? 1 : 0}${p.glyph}`,
        render: () => (
          <View
            style={{
              width: d,
              height: d,
              borderRadius: d / 2,
              borderWidth: on ? 4 : 2,
              borderColor: MAP_DATA.pinRing,
              backgroundColor: dim ? MAP_DATA.pinDim : MAP_DATA.pin,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {p.glyph ? <Text style={{ color: MAP_DATA.pinRing, fontSize: 12, fontWeight: '700' }}>{p.glyph}</Text> : null}
          </View>
        ),
      };
    }),
  ];

  let pill: { dot: string; text: string; action?: { icon: 'pause' | 'play'; label: string; onPress: () => void } } | null = null;
  if (status?.kind === 'track') {
    pill = {
      dot: status.recording ? MAP_DATA.recording : MAP_DATA.paused,
      text: t(status.recording ? 'splitMap.trackOn' : 'splitMap.trackOff', { length: lengthText(status.lengthM) }),
      action: status.onToggle
        ? {
            icon: status.recording ? 'pause' : 'play',
            label: t(status.recording ? 'transect.pause' : 'transect.resume'),
            onPress: status.onToggle,
          }
        : undefined,
    };
  } else if (circle) {
    const off = here ? distanceM(here.lat, here.lng, circle.lat, circle.lng) : null;
    const where =
      off == null
        ? t('splitMap.circleNoFix')
        : off <= circle.radiusM
          ? t('splitMap.inside', { accuracy: here?.accuracy != null ? Math.round(here.accuracy) : '–' })
          : t('splitMap.outside', { distance: Math.round(off - circle.radiusM) });
    pill = {
      dot: off != null && off <= circle.radiusM ? MAP_DATA.inside : MAP_DATA.outside,
      // Where you stand first: on a narrow map the end of the line is cut off.
      text: `${where} · ${t('splitMap.radius', { radius: circle.radiusM })}`,
    };
  }

  return (
    <View style={{ flex: 1 }}>
      <MapCanvas
        // The vector style is read only at mount.
        key={`split-${vectorOn ? vectorStyleRev : 'native'}`}
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={initialRegion}
        engine={vectorOn ? 'vector' : 'native'}
        vectorStyle={vectorStyle}
        mapType={basemapToMapType(basemap)}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        onRegionChangeComplete={(r) => {
          regionRef.current = r;
        }}
        onPress={() => {
          if (picked != null) onPick(null);
        }}
        features={features}
      />

      {pill ? (
        <View className="absolute left-2 top-2 flex-row" style={{ right: 52 }} pointerEvents="box-none">
          <View
            className="flex-row items-center gap-1.5 rounded-full border border-line bg-card/95 py-1 pl-2.5 pr-1 dark:border-line-dark dark:bg-card-dark/95"
            // Shrinks with a narrow map instead of running under the locate button.
            style={{ minHeight: 36, flexShrink: 1 }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pill.dot }} />
            <Text className="flex-shrink text-xs font-bold text-gray-900 dark:text-gray-100" numberOfLines={1}>
              {pill.text}
            </Text>
            {pill.action ? (
              <Pressable
                onPress={pill.action.onPress}
                accessibilityRole="button"
                accessibilityLabel={pill.action.label}
                hitSlop={6}
                className="h-7 w-7 items-center justify-center rounded-full bg-disc active:opacity-70 dark:bg-disc-dark"
              >
                <Ionicons name={pill.action.icon} size={14} color={c.ink} />
              </Pressable>
            ) : (
              <View style={{ width: 4 }} />
            )}
          </View>
        </View>
      ) : null}

      <View className="absolute right-2 top-2">
        <CtrlButton
          icon="locate"
          label={t('locMap.locateMe')}
          onPress={() => void locateMe(mapRef, regionRef, () => Alert.alert(t('gnss.permTitle'), t('gnss.permMsg')))}
        />
      </View>

      {callout ? (
        <View className="absolute left-2 right-2 rounded-xl border border-line bg-card px-3 py-1.5 dark:border-line-dark dark:bg-card-dark" style={{ top: pill ? 50 : 8 }} pointerEvents="none">
          <Text className="text-sm font-bold text-gray-900 dark:text-gray-100" numberOfLines={1}>
            {callout.title}
          </Text>
          <Text className="text-xs text-gray-600 dark:text-gray-400" numberOfLines={1}>
            {callout.meta}
          </Text>
        </View>
      ) : null}

      {onRecordHere ? (
        <View className="absolute bottom-3 left-0 right-0 items-center" pointerEvents="box-none">
          <Pressable
            onPress={onRecordHere}
            accessibilityRole="button"
            accessibilityState={{ selected: recordHereOn }}
            className={`flex-row items-center gap-1.5 rounded-full px-4 active:opacity-80 ${recordHereOn ? 'bg-accent-600 dark:bg-accent-500' : 'bg-acorn'}`}
            style={{ minHeight: 44 }}
          >
            <Ionicons name={recordHereOn ? 'location' : 'add'} size={18} color={recordHereOn ? c.onAccent : c.onAcorn} />
            <Text className={`text-[15px] font-bold ${recordHereOn ? 'text-white dark:text-gray-950' : 'text-gray-900'}`}>
              {t('splitMap.recordHere')}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
