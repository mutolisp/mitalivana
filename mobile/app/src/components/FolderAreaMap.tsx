/**
 * Read-only preview of a stored geometry, with an edit hand-off.
 *
 * Two callers: the area a favourite checklist was built from (a list of species
 * is hard to trust without knowing where it came from — "why these species?" is
 * otherwise unanswerable a week later), and a plot boundary. The labels are
 * props so the component says the right thing in both places.
 *
 * Controls match `RecordLocationMap` (zoom / locate / basemap / expand) and
 * come from the same module, so the mini-maps behave identically. Editing the
 * shape is NOT done here: drawing already works on the map screen, and it is
 * the only place with the vertex handles for it — `onEdit` hands over there.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { Alert, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapCanvas } from '~/components/map/MapCanvas';
import type { MapCamera, Region } from '~/components/map/types';
import { geometryBounds, geometryToPrimitives, type GeoJSONGeometry, type RenderPrimitive } from '~/db';
import { basemapToMapType, nextBasemap } from '~/lib/basemap';
import { useSettings, type MapBasemap } from '~/stores/settings';
import {
  BasemapToggle,
  CtrlButton,
  ZOOM_FACTOR,
  locateMe,
  zoomBy,
} from './MapControls';
import { useThemeColors } from '~/theme/colors';

const INLINE_HEIGHT = 160;

type Props = {
  /** GeoJSON of the stored geometry; empty when there is none yet. */
  areaGeoJson: string;
  /** 'inat' | 'gbif' | '' — which service produced the list. Favourite
   *  checklists only. */
  source?: string;
  onEdit: () => void;
  /** Footer caption. Defaults to the favourite-checklist wording. */
  title?: string;
  /** Empty-state button. Defaults to the favourite-checklist wording. */
  emptyLabel?: string;
  /** Edit link. Defaults to the favourite-checklist wording. */
  editLabel?: string;
};

export function FolderAreaMap({
  areaGeoJson,
  source = '',
  onEdit,
  title,
  emptyLabel,
  editLabel,
}: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const storedBasemap = useSettings((s) => s.map_view.basemap);
  const [basemap, setBasemap] = useState<MapBasemap>(
    // Neither vector nor terrain is in BASEMAP_CYCLE: using one as the initial
    // value would make nextBasemap restart from index 0. A mini-map shows a single
    // point or polygon, where contour lines do not help.
    storedBasemap === 'terrain' || storedBasemap === 'vector' ? 'standard' : storedBasemap,
  );
  const [fullscreen, setFullscreen] = useState(false);

  const parsed = useMemo(() => {
    if (!areaGeoJson) return null;
    try {
      return JSON.parse(areaGeoJson) as GeoJSONGeometry;
    } catch {
      // A malformed area must not take the whole list down with it.
      return null;
    }
  }, [areaGeoJson]);

  // Every geometry type, not just polygons: a plot boundary may legitimately be
  // the Point or LineString the user drew earlier, and treating those as "no
  // geometry" would show the empty state over data that exists.
  const prims = useMemo(() => (parsed ? geometryToPrimitives(parsed) : []), [parsed]);
  const region = useMemo(() => (parsed ? geometryBounds(parsed) : null), [parsed]);

  if (!parsed || !region || prims.length === 0) {
    return (
      <Pressable
        onPress={onEdit}
        className="mx-4 mb-2 mt-3 flex-row items-center justify-center rounded-xl border border-dashed border-gray-300 py-3 active:bg-gray-100 dark:border-gray-700 dark:active:bg-gray-800"
      >
        <Ionicons name="map-outline" size={16} color={c.ink2} />
        <Text className="ml-2 text-sm text-gray-600 dark:text-gray-400">
          {emptyLabel ?? t('favorites.setArea')}
        </Text>
      </Pressable>
    );
  }

  return (
    <View className="mx-4 mb-2 mt-3 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
      <AreaMap
        prims={prims}
        region={region}
        basemap={basemap}
        onCycleBasemap={() => setBasemap((b) => nextBasemap(b))}
        height={INLINE_HEIGHT}
        onExpand={() => setFullscreen(true)}
      />
      <View className="flex-row items-center justify-between bg-card px-3 py-2 dark:bg-gray-900">
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          {source
            ? t('favorites.areaFrom', { source: source.toUpperCase() })
            : (title ?? t('favorites.area'))}
        </Text>
        <Pressable onPress={onEdit} hitSlop={8} className="flex-row items-center active:opacity-70">
          <Ionicons name="create-outline" size={14} color={c.accent} />
          <Text className="ml-1 text-xs font-medium text-accent-600 dark:text-accent-400">
            {editLabel ?? t('favorites.editArea')}
          </Text>
        </Pressable>
      </View>

      <Modal visible={fullscreen} animationType="slide" onRequestClose={() => setFullscreen(false)}>
        {/* SafeAreaView reports 0 insets inside a Modal (separate view
            hierarchy, no provider) — apply the top inset by hand. */}
        <View className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
          <View className="flex-row items-center justify-between px-4 py-3">
            <Text className="text-base font-semibold text-white">
              {title ?? t('favorites.area')}
            </Text>
            <Pressable onPress={() => setFullscreen(false)} hitSlop={12} className="px-3 py-1.5">
              <Text className="text-base font-semibold text-accent-400">{t('common.done')}</Text>
            </Pressable>
          </View>
          {/* Mounted only while open. A map view that is not on screen still
              holds MapKit resources, and this component lives inside a
              scrolling list where several can exist at once. */}
          {fullscreen ? (
            <AreaMap
              prims={prims}
              region={region}
              basemap={basemap}
              onCycleBasemap={() => setBasemap((b) => nextBasemap(b))}
            />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

function AreaMap({
  prims,
  region,
  basemap,
  onCycleBasemap,
  height,
  onExpand,
}: {
  prims: RenderPrimitive[];
  region: Region;
  basemap: MapBasemap;
  onCycleBasemap: () => void;
  /** Fixed height inline; fills its parent when omitted (fullscreen). */
  height?: number;
  onExpand?: () => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const mapRef = useRef<MapCamera>(null);
  const regionRef = useRef<Region>(region);

  return (
    <View style={height != null ? { height } : { flex: 1 }}>
      <MapCanvas
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={region}
        mapType={basemapToMapType(basemap)}
        onRegionChangeComplete={(r) => {
          regionRef.current = r;
        }}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        features={prims.map((prim, i) =>
          prim.kind === 'point'
            ? {
                kind: 'marker' as const,
                id: String(i),
                lat: prim.latitude,
                lng: prim.longitude,
                color: c.accent,
              }
            : prim.kind === 'line'
              ? {
                  kind: 'line' as const,
                  id: String(i),
                  coords: prim.coords,
                  color: c.accent,
                  width: 3,
                }
              : {
                  kind: 'polygon' as const,
                  id: String(i),
                  coords: prim.coords,
                  stroke: c.accent,
                  fill: 'rgba(5,150,105,0.12)',
                  width: 2,
                },
        )}
      />

      <View className="absolute left-1.5 top-1.5">
        <BasemapToggle basemap={basemap} onPress={onCycleBasemap} />
      </View>

      <View className="absolute right-1.5 top-1.5 gap-1.5">
        {onExpand ? (
          <CtrlButton icon="expand-outline" onPress={onExpand} label={t('locMap.expand')} />
        ) : null}
        <CtrlButton
          icon="add"
          onPress={() => zoomBy(mapRef, regionRef, 1 / ZOOM_FACTOR)}
          label={t('locMap.zoomIn')}
        />
        <CtrlButton
          icon="remove"
          onPress={() => zoomBy(mapRef, regionRef, ZOOM_FACTOR)}
          label={t('locMap.zoomOut')}
        />
        <CtrlButton
          icon="locate"
          onPress={() =>
            locateMe(mapRef, regionRef, () => Alert.alert(t('gnss.permTitle'), t('gnss.permMsg')))
          }
          label={t('locMap.locateMe')}
        />
        <CtrlButton
          icon="scan-outline"
          onPress={() => mapRef.current?.animateToRegion(region, 300)}
          label={t('favorites.fitArea')}
        />
      </View>
    </View>
  );
}
