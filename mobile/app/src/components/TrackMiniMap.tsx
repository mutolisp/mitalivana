/**
 * Inline live preview of a track: each recorded segment as its own coloured
 * line (so a paused-then-resumed track shows its pieces), start and end
 * markers, framed around everything recorded so far.
 *
 * While `follow` is on (the track is recording) the camera re-frames as new
 * points arrive, so the whole transect stays in view without touching the map.
 * Renders nothing until there is at least one point — there is nothing to
 * frame, and the control above already says "not started".
 *
 * Replaces the full-screen TrackPreviewModal, which needed a button press to
 * see the same thing.
 *
 * `preview` (調查資料, asked 2026-10-04): the small map takes no touch — a
 * swipe over it scrolls the page — and a tap opens it full screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionSheetLayer, sheetBack } from '~/components/ActionSheet';
import { CtrlButton } from '~/components/MapControls';
import { MapCanvas } from '~/components/map/MapCanvas';
import type { MapCamera, MapFeature, Region } from '~/components/map/types';
import type { TrackSegment } from '~/db';

const SEGMENT_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#2563eb', '#9333ea'];
/** Same height as the inline record-location map, so the two read as one kind. */
const HEIGHT = 184;

function fitRegion(segments: TrackSegment[]): Region | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let n = 0;
  for (const seg of segments) {
    for (const [lng, lat] of seg) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      n++;
    }
  }
  if (n === 0) return null;
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.001),
    longitudeDelta: Math.max((maxLng - minLng) * 1.4, 0.001),
  };
}

export function TrackMiniMap({ segments, follow, preview = false }: { segments: TrackSegment[]; follow: boolean; preview?: boolean }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [full, setFull] = useState(false);
  const mapRef = useRef<MapCamera>(null);
  const region = useMemo(() => fitRegion(segments), [segments]);
  const pointCount = segments.reduce((n, s) => n + s.length, 0);

  useEffect(() => {
    if (follow && region) mapRef.current?.animateToRegion(region, 300);
    // Re-frame per new point, not per new array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, pointCount]);

  if (!region) return null;

  const first = segments.find((s) => s.length > 0)?.[0];
  const lastSeg = [...segments].reverse().find((s) => s.length > 0);
  const last = lastSeg?.[lastSeg.length - 1];

  const features: MapFeature[] = [
    ...segments.flatMap((seg, i) =>
      seg.length >= 2
        ? [
            {
              kind: 'line' as const,
              id: `seg-${i}`,
              coords: seg.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
              color: SEGMENT_COLORS[i % SEGMENT_COLORS.length]!,
              width: 4,
            },
          ]
        : [],
    ),
    ...(first
      ? [{ kind: 'marker' as const, id: 'start', lat: first[1], lng: first[0], color: 'green', title: t('track.startPoint') }]
      : []),
    ...(last
      ? [{ kind: 'marker' as const, id: 'end', lat: last[1], lng: last[0], color: 'red', title: t('track.endPoint') }]
      : []),
  ];

  const map = (gestures: boolean) => (
    <MapCanvas
      ref={gestures === !preview ? mapRef : undefined}
      style={{ flex: 1 }}
      initialRegion={region}
      mapType="standard"
      showsUserLocation
      showsMyLocationButton={false}
      toolbarEnabled={false}
      features={features}
      gestures={gestures}
    />
  );

  if (!preview) {
    return (
      <View className="mt-3 overflow-hidden rounded-lg" style={{ height: HEIGHT }}>
        {map(true)}
      </View>
    );
  }
  return (
    <View className="mt-3 overflow-hidden rounded-lg" style={{ height: HEIGHT }}>
      {/* No touch reaches the native map, so it cannot hold the page's scroll. */}
      <View pointerEvents="none" style={{ flex: 1 }}>
        {map(false)}
      </View>
      <Pressable onPress={() => setFull(true)} accessibilityRole="button" accessibilityLabel={t('locMap.expand')} className="absolute inset-0 items-end p-1.5">
        <CtrlButton icon="expand-outline" onPress={() => setFull(true)} label={t('locMap.expand')} />
      </Pressable>
      <Modal visible={full} animationType="slide" onRequestClose={sheetBack(() => setFull(false))}>
        {/* Inside a Modal the safe-area provider reports 0: the top inset by hand. */}
        <View className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
          <View className="flex-row items-center justify-between px-4 py-3">
            <Text className="text-base font-semibold text-white">{t('surveyForm.track')}</Text>
            <Pressable onPress={() => setFull(false)} hitSlop={12} className="px-3 py-1.5">
              <Text className="text-base font-semibold text-accent-400">{t('common.done')}</Text>
            </Pressable>
          </View>
          {/* Mounted only while open: a hidden map still holds native resources. */}
          {full ? <View style={{ flex: 1, paddingBottom: insets.bottom }}>{map(true)}</View> : null}
        </View>
        <ActionSheetLayer visible={full} />
      </Modal>
    </View>
  );
}
