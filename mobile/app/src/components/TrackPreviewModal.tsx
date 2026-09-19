/**
 * Full-screen modal that previews a transect track's MultiLineString segments.
 *
 * Uses the engine-neutral <MapCanvas>; fits bounds around all points; draws each segment
 * as its own polyline so paused-then-resumed segments are visually distinct.
 */
import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapCanvas } from '~/components/map/MapCanvas';
import type { LatLng, Region } from '~/components/map/types';
import { trackLengthMeters, type TrackSegment } from '~/db';

type Props = {
  visible: boolean;
  segments: TrackSegment[];
  title: string;
  onClose: () => void;
};

const SEGMENT_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#2563eb', '#9333ea'];

export function TrackPreviewModal({ visible, segments, title, onClose }: Props) {
  const { t } = useTranslation();
  // SafeAreaView's edges don't propagate inside a sibling <Modal> on iOS;
  // pull the inset value directly and apply paddingTop manually.
  const insets = useSafeAreaInsets();
  const region = useMemo<Region | null>(() => {
    let minLat = Infinity,
      maxLat = -Infinity,
      minLng = Infinity,
      maxLng = -Infinity,
      n = 0;
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
    const latitudeDelta = Math.max((maxLat - minLat) * 1.4, 0.001);
    const longitudeDelta = Math.max((maxLng - minLng) * 1.4, 0.001);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta,
      longitudeDelta,
    };
  }, [segments]);

  const lengthM = trackLengthMeters(segments);
  const lengthStr = lengthM > 1000 ? `${(lengthM / 1000).toFixed(2)} km` : `${lengthM.toFixed(0)} m`;
  const totalPoints = segments.reduce((n, s) => n + s.length, 0);

  // Start / end points (across the whole track, not per-segment)
  const startPt: LatLng | null = (() => {
    for (const seg of segments) {
      if (seg.length > 0) {
        const [lng, lat] = seg[0];
        return { latitude: lat, longitude: lng };
      }
    }
    return null;
  })();
  const endPt: LatLng | null = (() => {
    for (let si = segments.length - 1; si >= 0; si--) {
      const seg = segments[si];
      if (seg.length > 0) {
        const [lng, lat] = seg[seg.length - 1];
        return { latitude: lat, longitude: lng };
      }
    }
    return null;
  })();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center justify-between px-4 py-3">
          <Pressable onPress={onClose} hitSlop={16} className="p-2">
            <Ionicons name="close" size={28} color="white" />
          </Pressable>
          <View className="flex-1 items-center">
            <Text className="text-base font-semibold text-white" numberOfLines={1}>
              {title}
            </Text>
            <Text className="text-xs text-gray-300">
              {t('transect.summary', { count: segments.length, points: totalPoints, length: lengthStr })}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </View>
        <View className="flex-1">
          {region ? (
            <MapCanvas
              style={{ flex: 1 }}
              initialRegion={region}
              mapType="standard"
              showsUserLocation
              features={[
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
                ...(startPt
                  ? [
                      {
                        kind: 'marker' as const,
                        id: 'start',
                        lat: startPt.latitude,
                        lng: startPt.longitude,
                        color: 'green',
                        title: t('track.startPoint'),
                      },
                    ]
                  : []),
                ...(endPt
                  ? [
                      {
                        kind: 'marker' as const,
                        id: 'end',
                        lat: endPt.latitude,
                        lng: endPt.longitude,
                        color: 'red',
                        title: t('track.endPoint'),
                      },
                    ]
                  : []),
              ]}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <Text className="text-sm text-gray-300">{t('track.noData')}</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
