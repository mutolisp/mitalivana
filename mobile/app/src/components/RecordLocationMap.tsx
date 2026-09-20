/**
 * Inline editable mini-map for a single record's coordinate. Shown under the
 * "locate this species / take GPS" row in both the session record sheet
 * (`SpeciesDetailSheet`) and the plot species modal (`PlotSpeciesValueModal`).
 *
 * - Tap the map to place / relocate the point; drag the red marker to fine-tune.
 *   On the INLINE map, relocating an existing coordinate asks first and then
 *   offers an undo — see `guardedCommit`. The fullscreen editor does neither:
 *   you got there by deliberately tapping Fullscreen to do precise work.
 * - Zoom in/out buttons (animateToRegion by delta) + basemap toggle
 *   (standard / satellite / hybrid).
 * - Expand button opens the same editor full-screen for precise work.
 * - `reference` (plot centre + point-count radius) is drawn as a non-draggable
 *   blue marker + circle for context (used by the plot flow).
 * - `taxon` (optional) enables the iNaturalist observation grid: one toggle
 *   overlays where that species has been observed, answering "is this species
 *   normally found around here?". **Off by default**, because the tiles go over
 *   mobile data. The status line is not optional — an empty grid and "this
 *   species is not here" look identical on screen, which is the one ambiguity
 *   you cannot afford in the field (see the file header of useInatGrid.ts).
 *
 * `onChange` commits the new coordinate immediately (parent persists it without
 * a toast); manual placement carries no GPS accuracy, hence the `null` third
 * argument. Undo passes the previous accuracy back so restoring a GPS-measured
 * fix returns its uncertainty too, not just its latitude and longitude.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapCanvas } from '~/components/map/MapCanvas';
import type { LatLng, MapCamera, MapFeature, RasterOverlay, Region } from '~/components/map/types';
import { useSettings, type MapBasemap } from '~/stores/settings';
import { basemapToMapType, nextBasemap } from '~/lib/basemap';
import {
  BasemapToggle,
  CtrlButton,
  ZOOM_FACTOR,
  centerOn,
  locateMe,
  zoomBy,
} from './MapControls';
import { formatLatLng, parseLatLng } from '~/lib/coords';
import { INAT_GRID_LAYER, tileZoomForRegion } from '~/lib/inatHeatmap';
import {
  useInatGrid,
  type InatGridResolved,
  type InatGridState,
  type InatGridTaxon,
} from '~/lib/useInatGrid';

type Reference = { center?: { lat: number; lng: number } | null; radiusM?: number | null };

type Props = {
  lat: number | null;
  lng: number | null;
  /** Current GPS uncertainty in metres; null when the point was placed by hand.
   *  Needed so an undo can put the measured value back, and so the confirm can
   *  say what is about to be lost. */
  accuracy?: number | null;
  /** Commit a new coordinate (placed by tap or drag). Parent persists quietly.
   *  `accuracy` is null for a hand-placed point and carries the previous
   *  measured value when an undo restores one. */
  onChange: (lat: number, lng: number, accuracy: number | null) => void;
  /** Optional plot context drawn as a faint reference (non-editable). */
  reference?: Reference;
  /** This record's species. Supplying it is what makes the iNaturalist grid
   *  toggle appear. */
  taxon?: InatGridTaxon;
};

const INLINE_HEIGHT = 184;

export function RecordLocationMap({ lat, lng, accuracy = null, onChange, reference, taxon }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const mapView = useSettings((s) => s.map_view);
  const undoSeconds = useSettings((s) => s.undo_duration);
  const [basemap, setBasemap] = useState<MapBasemap>(
    // Neither vector nor terrain is in BASEMAP_CYCLE: using one as the initial
    // value would make nextBasemap restart from index 0. A mini-map shows a single
    // point or polygon, where contour lines do not help.
    mapView.basemap === 'terrain' || mapView.basemap === 'vector' ? 'standard' : mapView.basemap,
  );
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * Typed-coordinate entry, rendered INLINE rather than through `promptText`.
   *
   * `promptText` is a Modal hosted at the navigation root. Opening it from
   * inside another Modal — which is where this map lives in the specimen,
   * species and plot-species sheets — makes iOS dismiss that sheet to present
   * it: you tapped "enter coordinates" on a specimen and were thrown back to
   * the trip list. An inline row is in the same view tree as everything else
   * here, so there is no second Modal and nothing to dismiss.
   */
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryText, setEntryText] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);

  /**
   * The coordinate the user just committed, shown immediately.
   *
   * Placing a point is direct manipulation: it must appear at once, not after a
   * round trip through the parent's persist-and-refetch. That round trip is
   * usually fine for a tap, but a typed coordinate commits while the prompt's
   * Modal is still dismissing, and the parent's re-render did not reach the
   * screen until it was left and re-entered — the point simply did not show up.
   *
   * Props win the moment they change: whatever the parent settles on is the
   * truth, this only covers the gap.
   */
  const [pending, setPending] = useState<{ lat: number; lng: number } | null>(null);
  const propKey = `${lat},${lng}`;
  const lastPropKey = useRef(propKey);
  useEffect(() => {
    if (lastPropKey.current === propKey) return;
    lastPropKey.current = propKey;
    setPending(null);
  }, [propKey]);

  const commit = (nextLat: number, nextLng: number, nextAccuracy: number | null = null) => {
    setPending({ lat: nextLat, lng: nextLng });
    onChange(nextLat, nextLng, nextAccuracy);
  };

  /**
   * The coordinate a confirmed move replaced, offered back as an inline undo.
   *
   * Inline, not a toast, for the same reason the coordinate entry above is
   * inline: `ToastHost` is an absolutely-positioned View at the navigation
   * root, and three of this component's four call sites (the session, specimen
   * and plot-species sheets) are RN Modals, which iOS presents in their own
   * window — a root-level banner renders behind them. The undo would have been
   * invisible exactly where the risk lives.
   */
  const [undoPoint, setUndoPoint] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const offerUndo = (prev: { lat: number; lng: number; accuracy: number | null }) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoPoint(prev);
    undoTimer.current = setTimeout(() => setUndoPoint(null), undoSeconds * 1000);
  };

  /**
   * Tap/drag on the INLINE map, where the finger is often just scrolling the
   * sheet. Placing the first point is free — there is nothing to lose. Moving
   * an existing one is destructive and silent (the parent persists with no
   * toast), and a GPS fix overwritten by hand loses its measured uncertainty as
   * well as its position, which no later edit can recover. So that case
   * confirms first, then leaves an undo behind.
   *
   * `Alert` rather than an inline confirm: it is a native UIAlertController, so
   * unlike an RN Modal it does present above the sheets this map lives in.
   */
  const guardedCommit = (nextLat: number, nextLng: number) => {
    if (lat == null || lng == null) {
      commit(nextLat, nextLng);
      return;
    }
    const prev = { lat, lng, accuracy };
    Alert.alert(
      t('locMap.moveConfirmTitle'),
      accuracy != null
        ? t('locMap.moveConfirmGps', { m: Math.round(accuracy) })
        : t('locMap.moveConfirmManual'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('locMap.move'),
          onPress: () => {
            commit(nextLat, nextLng);
            offerUndo(prev);
          },
        },
      ],
    );
  };

  const undoMove = () => {
    if (!undoPoint) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    commit(undoPoint.lat, undoPoint.lng, undoPoint.accuracy);
    setUndoPoint(null);
  };

  const shownLat = pending?.lat ?? lat;
  const shownLng = pending?.lng ?? lng;

  const openEntry = () => {
    setEntryText(shownLat != null && shownLng != null ? formatLatLng(shownLat, shownLng) : '');
    setEntryError(null);
    setEntryOpen(true);
  };

  const submitEntry = () => {
    const parsed = parseLatLng(entryText);
    if (!parsed.ok) {
      // Inline, not an Alert: the message belongs next to the field the user is
      // still editing, and it says which of the two rules was broken.
      setEntryError(parsed.reason === 'range' ? t('locMap.enterRange') : t('locMap.enterFormat'));
      return;
    }
    setEntryOpen(false);
    setEntryError(null);
    commit(parsed.lat, parsed.lng);
  };

  const hasPoint = shownLat != null && shownLng != null;
  // Point-centred when a coordinate exists; otherwise the user's last map view
  // (clamped tighter than the all-Taiwan default so tapping to place is usable).
  const initialRegion: Region = hasPoint
    ? { latitude: shownLat, longitude: shownLng, latitudeDelta: 0.006, longitudeDelta: 0.006 }
    : {
        latitude: mapView.latitude,
        longitude: mapView.longitude,
        latitudeDelta: Math.min(mapView.latitudeDelta, 0.08),
        longitudeDelta: Math.min(mapView.longitudeDelta, 0.08),
      };

  const cycleBasemap = () => setBasemap((b) => nextBasemap(b));

  // iNat 觀察網格圖。關著的時候 useInatGrid 一個請求都不會送。
  const gridOn = useSettings((s) => s.inat_grid_overlay);
  const setSetting = useSettings((s) => s.set);
  // Cell size follows the zoom this map opens at. It is not re-read while the
  // user pinches: the mini-map holds one record's coordinate, so it always sits
  // deep in the coarsened band anyway (0.006° across a phone is about z16), and
  // re-deriving it per gesture would only churn the tile URL.
  const inatZoom = tileZoomForRegion(initialRegion.longitudeDelta, windowWidth);
  const {
    state: inatState,
    tileUrl: inatTileUrl,
    resolved: inatResolved,
  } = useInatGrid(taxon, gridOn, inatZoom);
  const inatOverlays: RasterOverlay[] | undefined = inatTileUrl
    ? [{ ...INAT_GRID_LAYER, urlTemplate: inatTileUrl }]
    : undefined;

  return (
    <View className="mt-2">
      <EditableMap
        lat={shownLat}
        lng={shownLng}
        initialRegion={initialRegion}
        onChange={guardedCommit}
        reference={reference}
        basemap={basemap}
        onCycleBasemap={cycleBasemap}
        onType={openEntry}
        rounded
        onExpand={() => setFullscreen(true)}
        rasterOverlays={inatOverlays}
        inat={taxon ? { on: gridOn, toggle: () => setSetting('inat_grid_overlay', !gridOn) } : undefined}
      />
      {taxon ? (
        <InatStatusLine state={inatState} on={gridOn} resolved={inatResolved} asked={taxon.name} />
      ) : null}
      {entryOpen ? (
        <View className="mt-2 rounded-lg border border-gray-300 p-2 dark:border-gray-600">
          <Text className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">
            {t('locMap.enterMsg')}
          </Text>
          <TextInput
            value={entryText}
            onChangeText={(v) => {
              setEntryText(v);
              setEntryError(null);
            }}
            placeholder="25.123456, 121.654321"
            placeholderTextColor="#9ca3af"
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submitEntry}
            className="rounded-md bg-gray-100 px-2 py-1.5 text-sm text-gray-900 dark:bg-gray-800 dark:text-gray-100"
          />
          {entryError ? (
            <Text className="mt-1 text-[11px] text-red-600 dark:text-red-400">{entryError}</Text>
          ) : null}
          <View className="mt-2 flex-row justify-end gap-4">
            <Pressable onPress={() => setEntryOpen(false)} hitSlop={8}>
              <Text className="text-sm text-gray-500 dark:text-gray-400">{t('common.cancel')}</Text>
            </Pressable>
            <Pressable onPress={submitEntry} hitSlop={8}>
              <Text className="text-sm font-medium text-blue-600 dark:text-blue-400">
                {t('common.ok')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Text className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
          {hasPoint ? t('locMap.dragHint') : t('locMap.tapToPlace')}
        </Text>
      )}

      {undoPoint ? (
        <View className="mt-2 flex-row items-center rounded-lg bg-gray-900 px-3 py-2 dark:bg-gray-800">
          <Text className="flex-1 text-xs text-white">{t('locMap.moved')}</Text>
          <Pressable onPress={undoMove} hitSlop={8}>
            <Text className="text-xs font-semibold text-blue-300">{t('locMap.undo')}</Text>
          </Pressable>
        </View>
      ) : null}

      <Modal visible={fullscreen} animationType="slide" onRequestClose={() => setFullscreen(false)}>
        {/* SafeAreaView from the context lib reports 0 insets inside a Modal
            (separate view hierarchy, no provider) — apply the top inset by hand. */}
        <View className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
          <View className="flex-row items-center justify-between px-4 py-3">
            <Text className="text-base font-semibold text-white">{t('locMap.fullscreenTitle')}</Text>
            <Pressable onPress={() => setFullscreen(false)} hitSlop={12} className="px-3 py-1.5">
              <Text className="text-base font-semibold text-blue-400">{t('common.done')}</Text>
            </Pressable>
          </View>
          {/* Mounted only while open — a hidden MapView still holds MapKit
              resources, and this component is now used on the plot screen too,
              where several maps can be alive at once. */}
          {entryOpen ? (
            <View className="border-b border-gray-800 px-4 pb-3">
              <TextInput
                value={entryText}
                onChangeText={(v) => {
                  setEntryText(v);
                  setEntryError(null);
                }}
                placeholder="25.123456, 121.654321"
                placeholderTextColor="#6b7280"
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={submitEntry}
                className="rounded-md bg-gray-800 px-3 py-2 text-base text-white"
              />
              {entryError ? (
                <Text className="mt-1 text-xs text-red-400">{entryError}</Text>
              ) : null}
              <View className="mt-2 flex-row justify-end gap-4">
                <Pressable onPress={() => setEntryOpen(false)} hitSlop={8}>
                  <Text className="text-sm text-gray-400">{t('common.cancel')}</Text>
                </Pressable>
                <Pressable onPress={submitEntry} hitSlop={8}>
                  <Text className="text-sm font-medium text-blue-400">{t('common.ok')}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {fullscreen ? (
            <EditableMap
              lat={shownLat}
              lng={shownLng}
              initialRegion={initialRegion}
              onChange={commit}
              reference={reference}
              basemap={basemap}
              onCycleBasemap={cycleBasemap}
              onType={openEntry}
              rasterOverlays={inatOverlays}
              inat={
                taxon
                  ? { on: gridOn, toggle: () => setSetting('inat_grid_overlay', !gridOn) }
                  : undefined
              }
            />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

function EditableMap({
  lat,
  lng,
  initialRegion,
  onChange,
  reference,
  basemap,
  onCycleBasemap,
  onType,
  rounded,
  onExpand,
  rasterOverlays,
  inat,
}: {
  lat: number | null;
  lng: number | null;
  initialRegion: Region;
  onChange: (lat: number, lng: number) => void;
  reference?: Reference;
  basemap: MapBasemap;
  onCycleBasemap: () => void;
  onType: () => void;
  rounded?: boolean;
  onExpand?: () => void;
  rasterOverlays?: RasterOverlay[];
  /** 給了才畫 iNat 切換鈕。`undefined` = 這張地圖沒有物種脈絡。 */
  inat?: { on: boolean; toggle: () => void };
}) {
  const { t } = useTranslation();
  const mapRef = useRef<MapCamera>(null);
  const regionRef = useRef<Region>(initialRegion);
  // Last coordinate this map itself committed — lets us tell our own tap/drag
  // (don't recenter) apart from an external set (GPS row → recenter).
  const lastCommittedRef = useRef<string | null>(
    lat != null && lng != null ? `${lat},${lng}` : null,
  );

  const recenter = (latitude: number, longitude: number) =>
    centerOn(mapRef, regionRef, latitude, longitude);

  // When the coordinate changes from outside (e.g. the "點選 GPS" row), follow
  // it. Skipped for our own tap/drag, whose value we stamped in `place`.
  useEffect(() => {
    if (lat == null || lng == null) return;
    const k = `${lat},${lng}`;
    if (lastCommittedRef.current === k) return;
    lastCommittedRef.current = k;
    recenter(lat, lng);
  }, [lat, lng]);

  const zoom = (factor: number) => zoomBy(mapRef, regionRef, factor);

  const handleLocate = () =>
    locateMe(mapRef, regionRef, () => Alert.alert(t('gps.permTitle'), t('gps.permMsg')));

  const place = (c: LatLng) => {
    lastCommittedRef.current = `${c.latitude},${c.longitude}`;
    onChange(c.latitude, c.longitude);
  };

  const hasPoint = lat != null && lng != null;

  return (
    <View
      className={
        rounded
          ? 'overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700'
          : 'flex-1'
      }
      style={rounded ? { height: INLINE_HEIGHT } : undefined}
    >
      <MapCanvas
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={initialRegion}
        mapType={basemapToMapType(basemap)}
        onRegionChangeComplete={(r) => {
          regionRef.current = r;
        }}
        onPress={place}
        rasterOverlays={rasterOverlays}
        overlayGeneration={basemap}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        features={[
          ...(reference?.center && reference.radiusM
            ? [
                {
                  kind: 'circle' as const,
                  id: 'ref-radius',
                  lat: reference.center.lat,
                  lng: reference.center.lng,
                  radiusM: reference.radiusM,
                  stroke: '#2563eb',
                  fill: 'rgba(37,99,235,0.10)',
                  width: 1,
                },
              ]
            : []),
          ...(reference?.center
            ? [
                {
                  kind: 'marker' as const,
                  id: 'ref-center',
                  lat: reference.center.lat,
                  lng: reference.center.lng,
                  color: 'blue',
                  opacity: 0.55,
                  tappable: false,
                },
              ]
            : []),
          ...(hasPoint
            ? [
                {
                  kind: 'marker' as const,
                  id: 'point',
                  lat: lat as number,
                  lng: lng as number,
                  color: 'red',
                  anchor: { x: 0.5, y: 1 },
                  draggable: true,
                  onDragEnd: place,
                },
              ]
            : []),
        ] satisfies MapFeature[]}
      />

      {/* 圖層控制（左上）。iNat 疊圖放這裡而不是右欄：184px 高的地圖右側已經排了
          五個鈕，第六個會被裁掉；而且「要顯示什麼」與底圖切換本來就是同一類。 */}
      <View className="absolute left-1.5 top-1.5 gap-1.5">
        <BasemapToggle basemap={basemap} onPress={onCycleBasemap} />
        {inat ? (
          <View className="self-start">
            <CtrlButton
              icon={inat.on ? 'grid' : 'grid-outline'}
              onPress={inat.toggle}
              label={t('inatGrid.toggle')}
            />
          </View>
        ) : null}
      </View>

      {/* Zoom + expand controls (top-right) */}
      <View className="absolute right-1.5 top-1.5 gap-1.5">
        {onExpand ? (
          <CtrlButton icon="expand-outline" onPress={onExpand} label={t('locMap.expand')} />
        ) : null}
        <CtrlButton icon="add" onPress={() => zoom(1 / ZOOM_FACTOR)} label={t('locMap.zoomIn')} />
        <CtrlButton icon="remove" onPress={() => zoom(ZOOM_FACTOR)} label={t('locMap.zoomOut')} />
        <CtrlButton icon="locate" onPress={handleLocate} label={t('locMap.locateMe')} />
        <CtrlButton icon="keypad-outline" onPress={onType} label={t('locMap.enterTitle')} />
      </View>
    </View>
  );
}

/**
 * iNat 網格圖的狀態行。
 *
 * **不可以省略。** 一張沒有資料的網格圖與一張「這個物種在這裡沒有紀錄」的網格圖
 * 在螢幕上完全一樣，而兩者的意義天差地遠——`src/lib/inat.ts` 的檔頭把這件事寫成
 * 一條規則：野外 app 絕不可以在沒有運作時看起來像在運作。所以離線、查無此物種、
 * 沒有觀察，三種都各自明講。
 *
 * 版權與「受威脅物種座標經模糊化」一起放在這裡：iNat 會刻意模糊受威脅物種的位置，
 * 不講的話這張圖對保育類的判讀會產生誤導。
 */
function InatStatusLine({
  state,
  on,
  resolved,
  asked,
}: {
  state: InatGridState;
  on: boolean;
  /** What the layer resolved to; null while loading or when nothing matched. */
  resolved: InatGridResolved | null;
  /** The name this record is filed under, i.e. what was looked up. */
  asked: string;
}) {
  const { t } = useTranslation();
  // 關著就不說話——按鈕本身就是它的開關指示，沒必要再佔一行。
  if (!on || state.kind === 'idle') return null;

  if (state.kind === 'loading') {
    return (
      <View className="mt-1 flex-row items-center gap-1.5">
        <ActivityIndicator size="small" />
        <Text className="text-[11px] text-gray-400 dark:text-gray-500">
          {t('inatGrid.checking')}
        </Text>
      </View>
    );
  }

  const body =
    state.kind === 'wild'
      ? t('inatGrid.wild', { count: state.count })
      : state.kind === 'captiveOnly'
        ? t('inatGrid.captiveOnly', { count: state.count })
        : state.kind === 'empty'
          ? t('inatGrid.empty')
          : state.kind === 'unknown'
            ? t('inatGrid.unknown')
            : state.kind === 'offline'
              ? t('inatGrid.offline')
              : state.message;
  const warn = state.kind !== 'wild' && state.kind !== 'captiveOnly';

  return (
    <View className="mt-1">
      <Text
        className={
          warn
            ? 'text-[11px] text-amber-700 dark:text-amber-400'
            : 'text-[11px] text-gray-500 dark:text-gray-400'
        }
      >
        {body}
      </Text>
      {/* iNaturalist resolves synonyms itself: asking for Cyathea lepifera
          answers with Sphaeropteris lepifera. The tiles are then that OTHER
          name's observations, which the user has to be told — silently drawing
          one name's data under another name's heading is the same illusion the
          states above exist to prevent. */}
      {resolved && resolved.via === 'synonym' && resolved.inatName !== asked ? (
        <Text className="text-[10px] text-gray-500 dark:text-gray-400">
          {t('inatGrid.viaSynonym', { name: resolved.inatName })}
        </Text>
      ) : null}
      {state.kind === 'wild' || state.kind === 'captiveOnly' ? (
        <Text className="text-[10px] text-gray-400 dark:text-gray-500">
          {t('inatGrid.attribution')}
        </Text>
      ) : null}
    </View>
  );
}
