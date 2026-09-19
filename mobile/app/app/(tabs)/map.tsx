import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import MapView, {
  Circle,
  Marker,
  Polygon,
  Polyline,
  PROVIDER_DEFAULT,
  UrlTile,
  type LatLng,
  type MapType,
  type Region,
} from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LayerSheet } from '~/components/LayerSheet';
import { SINICA_LAYERS } from '~/lib/sinicaLayers';
import { NLSC_LAYERS } from '~/lib/nlscLayers';
import { SaveSiteModal } from '~/components/SaveSiteModal';
import { GeoImportModal } from '~/components/GeoImportModal';
import { AreaSpeciesModal } from '~/components/AreaSpeciesModal';
import type { BBox } from '~/lib/inat';
import wellknown from 'wellknown';
import { useFavorites } from '~/stores/favorites';
import {
  createSite,
  deleteSite,
  countSiteReferences,
  geometryBounds,
  getPlotSurvey,
  getSite,
  geometryToPrimitives,
  listPlotSurveysWithMeta,
  listSessionRecords,
  listSessions,
  listSites,
  parseGeometry,
  parseTrackSegments,
  updatePlotSurvey,
  updateSite,
  setFavoriteFolderArea,
  updateSession,
  usesTrack,
  writePlotTrack,
  type PlotSurvey,
  type PlotSurveyWithMeta,
  type RecordWithTaxon,
  type Site,
  type SessionWithStats,
  type SiteWithProject,
} from '~/db';
import { useActiveSession } from '~/stores/activeSession';
import { isRecordingTarget } from '~/lib/trackRecorder';
import { MapFeatureCard, type MapFeatureInfo } from '~/components/MapFeatureCard';
import {
  clusterPoints,
  clusterRegion,
  clusterSplits,
  type ClusterPoint,
  type PointCluster,
} from '~/lib/mapCluster';
import { SITE_TYPE_LABEL } from '~/lib/siteLabels';
import { rudyAttribution, rudyTileCachePath } from '~/lib/rudymap';
import { useRudyInstall } from '~/lib/rudymapInstall';
import { useTabBarInset } from '~/lib/tabBarLayout';
import { useSettings, type MapBasemap } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { ACTION_FILL } from '~/lib/colors';

/** What a cluster member stands for, so a bubble can list its records. */
type ClusterFeature =
  | { kind: 'plot'; plot: PlotSurveyWithMeta }
  | { kind: 'session'; session: SessionWithStats }
  | { kind: 'site'; site: SiteWithProject };

const BASEMAP_OPTIONS: Array<{
  value: MapBasemap;
  labelKey: string;
  icon: keyof typeof Ionicons.glyphMap;
  mapType: MapType;
}> = [
  { value: 'standard', labelKey: 'map.basemapStandard', icon: 'map-outline', mapType: 'standard' },
  {
    value: 'satellite',
    labelKey: 'map.basemapSatellite',
    icon: 'globe-outline',
    mapType: 'satellite',
  },
  { value: 'hybrid', labelKey: 'map.basemapHybrid', icon: 'layers-outline', mapType: 'hybrid' },
  {
    value: 'terrain',
    labelKey: 'map.basemapTerrain',
    icon: 'trail-sign-outline',
    mapType: 'terrain',
  },
  // 魯地圖離線圖磚。mapType 是 standard 而不是 none：圖磚包不含海域與 z7 以下，
  // 那些地方要露出原生底圖。只有圖磚包裝好時才會出現在選單裡。
  {
    value: 'rudy',
    labelKey: 'map.basemapRudy',
    icon: 'navigate-outline',
    mapType: 'standard',
  },
];

/** 10 年。等同「永不過期」，但不是 0 —— 0 會走 AIRMapUrlTileCachedOverlay.m:133
 *  那條每讀一張磚就改檔案 mtime 的路徑，對幾 GB 的唯讀圖磚包是白費 I/O。 */
const RUDY_TILE_CACHE_MAX_AGE = 315_360_000;

const SINICA_TILE_URL =
  'https://gis.sinica.edu.tw/tileserver/file-exists.php?img={LAYER}-png-{z}-{x}-{y}';
// NLSC WMTS RESTful — note the WMTS tile order is z/y/x (TileMatrix/Row/Col).
const NLSC_TILE_URL =
  'https://wmts.nlsc.gov.tw/wmts/{LAYER}/default/GoogleMapsCompatible/{z}/{y}/{x}';


/** Deliberately not one of the record colours: a bubble is not a 樣區 or a
 *  名錄, it is a stand-in for several of them. */
const CLUSTER_COLOR = '#4f46e5';
const SITE_COLOR = '#2563eb';
const SITE_FILL = 'rgba(37, 99, 235, 0.18)';
const DRAW_COLOR = '#dc2626';

/** Species-query overlay, kept visually distinct from the red site-drawing
 *  colour so it is obvious the queried shape is not the shape being drawn. */
const AREA_COLOR = '#059669';
const AREA_FILL = 'rgba(5,150,105,0.12)';

/** Axis-aligned bounds of the drawn points.
 *
 *  iNaturalist has no polygon parameter — only swlat/swlng + nelat/nelng or a
 *  radius — so a hand-drawn shape is queried as its bounding box. The map draws
 *  that box (see AREA_COLOR) and the modal says so in words, because silently
 *  querying a larger area than the user outlined would make the resulting
 *  species list quietly wrong. */
/**
 * Smallest span a query area may have, in degrees (~110 m).
 *
 * Tapping the same spot twice gives a box of zero width and height. That is not
 * a small query, it is a broken one: GBIF rejects it (`Too few distinct points
 * in geometry component`) and iNaturalist returns nothing at all. Widening it
 * to something a survey could plausibly mean is better than either.
 */
const MIN_SPAN_DEG = 0.001;

function bboxOf(pts: LatLng[]): BBox {
  const lats = pts.map((p) => p.latitude);
  const lngs = pts.map((p) => p.longitude);
  const span = (lo: number, hi: number): [number, number] => {
    if (hi - lo >= MIN_SPAN_DEG) return [lo, hi];
    const mid = (lo + hi) / 2;
    return [mid - MIN_SPAN_DEG / 2, mid + MIN_SPAN_DEG / 2];
  };
  const [swLat, neLat] = span(Math.min(...lats), Math.max(...lats));
  const [swLng, neLng] = span(Math.min(...lngs), Math.max(...lngs));
  return { swLat, swLng, neLat, neLng };
}

/**
 * The shape to query, as a closed GeoJSON Polygon that is ALWAYS valid.
 *
 * Two taps mean "this rectangle" — the toolbar says two points is enough,
 * because iNaturalist only ever uses the bounding box. Sending those two taps
 * to GBIF as a polygon produces a zero-area sliver, which it rejects with
 * `Too few distinct points in geometry component`. A ring that crosses itself
 * is rejected too (`Self-intersection at or near point …`).
 *
 * Both cases fall back to the bounding box rather than refusing. Refusing was
 * the first attempt and it dead-ends the user: they tap Done, get a toast, and
 * are left in drawing mode with no way forward except undoing vertex by vertex.
 * The bounding box is a valid answer, it is already drawn on the map, and
 * `simplified` lets the caller say plainly that it was used.
 */
function polygonOf(pts: LatLng[]): {
  polygon: { type: 'Polygon'; coordinates: [number, number][][] };
  simplified: boolean;
} {
  const distinct: [number, number][] = [];
  for (const p of pts) {
    const c: [number, number] = [p.longitude, p.latitude];
    if (!distinct.some((d) => d[0] === c[0] && d[1] === c[1])) distinct.push(c);
  }
  const boxRing = () =>
    bboxCorners(bboxOf(pts)).map((p) => [p.longitude, p.latitude] as [number, number]);
  const close = (r: [number, number][]) => {
    const first = r[0];
    const last = r[r.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) r.push(first);
    return r;
  };

  if (distinct.length < 3) {
    return { polygon: { type: 'Polygon', coordinates: [close(boxRing())] }, simplified: true };
  }
  const drawn = close([...distinct]);
  if (ringSelfIntersects(drawn)) {
    return { polygon: { type: 'Polygon', coordinates: [close(boxRing())] }, simplified: true };
  }
  return { polygon: { type: 'Polygon', coordinates: [drawn] }, simplified: false };
}

/** Do two segments properly cross? Shared endpoints do not count. */
function segmentsCross(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/**
 * Does the closed ring cross itself?
 *
 * GBIF rejects a self-intersecting polygon outright (`Self-intersection at or
 * near point …`), and tapping out a shape that crosses itself is easy to do by
 * accident. Checking here means the user is told while they can still fix it,
 * instead of after a failed request. O(n²) is fine: these rings are tapped by
 * hand, so n is small.
 */
function ringSelfIntersects(ring: [number, number][]): boolean {
  const n = ring.length - 1; // last point repeats the first
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

/**
 * The visible map area as a bounding box.
 *
 * `Region` is a centre plus full-width deltas, so each edge is half a delta
 * from the centre. This is the "search what I'm looking at" path: no drawing,
 * and the result is a rectangle, which both sources accept as-is.
 */
function bboxOfRegion(r: Region): BBox {
  return {
    swLat: r.latitude - r.latitudeDelta / 2,
    swLng: r.longitude - r.longitudeDelta / 2,
    neLat: r.latitude + r.latitudeDelta / 2,
    neLng: r.longitude + r.longitudeDelta / 2,
  };
}

/** bbox → the four corners react-native-maps needs to draw it. */
function bboxCorners(b: BBox): LatLng[] {
  return [
    { latitude: b.swLat, longitude: b.swLng },
    { latitude: b.swLat, longitude: b.neLng },
    { latitude: b.neLat, longitude: b.neLng },
    { latitude: b.neLat, longitude: b.swLng },
  ];
}
const DRAW_FILL = 'rgba(220, 38, 38, 0.18)';
// Plot survey overlay (distinct from site-blue / draw-red).
const PLOT_COLOR = '#7c3aed'; // violet — done plots
const PLOT_ACTIVE_COLOR = '#db2777'; // magenta — the single active plot
const PLOT_FILL = 'rgba(124, 58, 237, 0.15)'; // point_count radius circle
// Session (名錄) overlay.
const SESSION_COLOR = '#0891b2'; // cyan — done sessions
const SESSION_ACTIVE_COLOR = '#10b981'; // green — the active session

/** Soft cap above which editing a track segment warns about map jank. */
const TRACK_EDIT_WARN_POINTS = 200;

const PLOT_TYPE_LABEL: Record<string, string> = {
  fixed: 'map.plotFixed',
  transect: 'map.plotTransect',
  point_count: 'map.plotPointCount',
};

function basemapToMapType(b: MapBasemap): MapType {
  return BASEMAP_OPTIONS.find((o) => o.value === b)?.mapType ?? 'standard';
}

function basemapMeta(b: MapBasemap): (typeof BASEMAP_OPTIONS)[number] {
  return BASEMAP_OPTIONS.find((o) => o.value === b) ?? BASEMAP_OPTIONS[0];
}

export default function MapScreen() {
  const { t, i18n } = useTranslation();
  const initial = useSettings((s) => s.map_view);
  const setSetting = useSettings((s) => s.set);
  const settingsLoaded = useSettings((s) => s.loaded);
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const toast = useToast((s) => s.show);
  const router = useRouter();
  const params = useLocalSearchParams<{
    draw?: string;
    session?: string;
    favoriteArea?: string;
    site?: string;
    plot?: string;
  }>();
  /** When set, after saving the next drawn site we bind it to this session and bounce back. */
  const handoffSessionId = useRef<number | null>(null);
  /** Same for a 樣區 boundary: the plot to bind to, plus its current boundary
   *  (non-null = redrawing an existing one, which updates that row in place). */
  const [plotHandoff, setPlotHandoff] = useState<{ plot: PlotSurvey; site: Site | null } | null>(
    null,
  );
  const activeSession = useActiveSession((s) => s.session);
  const [activeRecords, setActiveRecords] = useState<RecordWithTaxon[]>([]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [layersSheetOpen, setLayersSheetOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [currentBasemap, setCurrentBasemap] = useState<MapBasemap>(initial.basemap);
  const [sinicaLayer, setSinicaLayer] = useState<string>(initial.sinica_layer);
  const [sinicaOpacity, setSinicaOpacity] = useState<number>(initial.sinica_opacity);
  const [nlscLayer, setNlscLayer] = useState<string>(initial.nlsc_layer);
  const [nlscOpacity, setNlscOpacity] = useState<number>(initial.nlsc_opacity);

  const tabBarInset = useTabBarInset();
  const rudyInstalled = useRudyInstall((s) => s.installed);
  const rudyReady = useRudyInstall((s) => s.ready);
  // 圖磚包被刪掉時**故意不**把 currentBasemap 改寫回 standard：使用者重新安裝後
  // 會自動回到他原本選的魯地圖，而不是被我們悄悄改掉設定。
  const rudyOn = currentBasemap === 'rudy' && rudyReady;

  // Drawing UI only produces simple types; Multi* arrive via import (KML/GPX).
  const [drawMode, setDrawMode] = useState<'Point' | 'LineString' | 'Polygon' | null>(null);
  const [drawPoints, setDrawPoints] = useState<LatLng[]>([]);
  /** What the current drawing is FOR. 'site' saves a 地理樣區; 'species' queries
   *  iNaturalist for what has been observed inside it. Same gesture, two
   *  terminuses — the alternative was a second drawing implementation. */
  const [drawPurpose, setDrawPurpose] = useState<'site' | 'species' | 'favoriteArea'>('site');
  /** Which 常用名錄's area is being redrawn, when handed off from favourites. */
  const favoriteAreaId = useRef<number | null>(null);
  const [areaOpen, setAreaOpen] = useState(false);
  const [areaQuery, setAreaQuery] = useState<{
    bbox: BBox;
    wkt: string;
    geojson: string;
    /** True when the drawn ring could not be used as-is (fewer than three
     *  distinct vertices, or self-intersecting) and the bounding box was
     *  substituted. The modal says so rather than letting the user believe
     *  their outline was queried. */
    simplified: boolean;
  } | null>(null);
  const [saveSiteOpen, setSaveSiteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sites, setSites] = useState<SiteWithProject[]>([]);
  const [plots, setPlots] = useState<PlotSurveyWithMeta[]>([]);
  const [sessions, setSessions] = useState<SessionWithStats[]>([]);
  // Editing an existing plot's geometry. 'point' = moving a fixed / point_count
  // marker; 'track' = dragging/deleting vertices of one transect segment.
  const [editPlot, setEditPlot] = useState<PlotSurveyWithMeta | null>(null);
  const [editMode, setEditMode] = useState<'point' | 'track' | null>(null);
  /** Which MultiLineString segment is being edited in 'track' mode. */
  const [editSegmentIndex, setEditSegmentIndex] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  /**
   * The region clustering is computed against. Separate from `lastRegion`
   * (a ref, so panning does not re-render): this is written only in
   * `onRegionChangeComplete`, i.e. once per gesture, which is the granularity
   * the grid needs anyway.
   */
  const [viewRegion, setViewRegion] = useState<Region>({
    latitude: initial.latitude,
    longitude: initial.longitude,
    latitudeDelta: initial.latitudeDelta,
    longitudeDelta: initial.longitudeDelta,
  });
  /** The tapped feature's details; 「操作」 on the card opens the action sheet. */
  const [info, setInfo] = useState<MapFeatureInfo | null>(null);

  const mapRef = useRef<MapView>(null);
  /** Mirror of `editPlot` for the focus effect — see the comment there. */
  const editPlotRef = useRef<PlotSurveyWithMeta | null>(null);
  /** A camera move requested before the map was ready (cold start), replayed below. */
  const pendingFocus = useRef<Region | null>(null);
  const searchInputRef = useRef<TextInput>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRegion = useRef<Region>({
    latitude: initial.latitude,
    longitude: initial.longitude,
    latitudeDelta: initial.latitudeDelta,
    longitudeDelta: initial.longitudeDelta,
  });

  const reloadSites = useCallback(() => setSites(listSites()), []);
  const reloadPlots = useCallback(() => setPlots(listPlotSurveysWithMeta()), []);
  const reloadSessions = useCallback(() => setSessions(listSessions()), []);

  useFocusEffect(
    useCallback(() => {
      // Read through a ref, NOT the state: with `editPlot` in the dependency
      // list this callback changed identity whenever an edit started or ended,
      // so react-navigation re-ran it — four synchronous SQLite queries plus a
      // re-parse of every track and site geometry, on the very tap that
      // cancels an edit. That was most of the freeze.
      if (editPlotRef.current) return;
      reloadSites();
      reloadPlots();
      reloadSessions();
      if (activeSession) {
        setActiveRecords(listSessionRecords(activeSession.id));
      } else {
        setActiveRecords([]);
      }
    }, [reloadSites, reloadPlots, reloadSessions, activeSession]),
  );

  // Safety: hide the loading overlay after a max wait if onMapReady doesn't fire (rare).
  useEffect(() => {
    const t = setTimeout(() => setMapReady(true), 4000);
    return () => clearTimeout(t);
  }, []);

  /**
   * Move the camera, the only supported way to arrive from another screen.
   *
   * Writing `map_view` and navigating here does NOT work: this is a tab screen,
   * so after the first visit it stays mounted and `initialRegion` is never read
   * again — the jump silently did nothing. Deferring to `mapReady` covers the
   * cold start, where the handoff lands before the map exists.
   */
  const focusRegion = useCallback(
    (r: Region) => {
      if (mapReady) mapRef.current?.animateToRegion(r, 400);
      else pendingFocus.current = r;
    },
    [mapReady],
  );

  useEffect(() => {
    editPlotRef.current = editPlot;
  }, [editPlot]);

  useEffect(() => {
    if (!mapReady || !pendingFocus.current) return;
    const r = pendingFocus.current;
    pendingFocus.current = null;
    // No animation: this is the initial placement, not a move the user watches.
    mapRef.current?.animateToRegion(r, 0);
  }, [mapReady]);

  // Handoffs from other screens: ?draw=Polygon&session=123 (draw a site for a
  // session), ?draw=Polygon&favoriteArea=4, ?site=7 (just centre on a site).
  useEffect(() => {
    const drawParam = params.draw;
    const sessionParam = params.session;
    const favParam = params.favoriteArea;
    const siteParam = params.site;
    const plotParam = params.plot;
    if (!drawParam && !sessionParam && !favParam && !siteParam && !plotParam) return;

    if (typeof siteParam === 'string') {
      const sid = parseInt(siteParam, 10);
      const site = Number.isNaN(sid) ? null : getSite(sid);
      if (site) {
        try {
          focusRegion(geometryBounds(parseGeometry(site)));
        } catch {
          // parseGeometry is a bare JSON.parse — one corrupt row must not take
          // the whole map tab down with it.
        }
      }
    }

    // 樣區 boundary handoff: centre on the existing boundary if there is one,
    // else on the plot itself. No coordinates anywhere is not a refusal — the
    // user can still pan to where the plot is and draw.
    let plotTarget: { plot: PlotSurvey; site: Site | null } | null = null;
    if (typeof plotParam === 'string') {
      const pid = parseInt(plotParam, 10);
      const plot = Number.isNaN(pid) ? null : getPlotSurvey(pid);
      if (plot) {
        const bound = plot.site_id !== null ? (getSite(plot.site_id) ?? null) : null;
        plotTarget = { plot, site: bound };
        let region: Region | null = null;
        if (bound) {
          try {
            region = geometryBounds(parseGeometry(bound));
          } catch {
            region = null;
          }
        }
        region = region ?? plotRegion(plot);
        if (region) focusRegion(region);
        else toast(t('map.noRecordCoord'));
      }
    }

    if (drawParam === 'Point' || drawParam === 'LineString' || drawParam === 'Polygon') {
      if (plotTarget) setPlotHandoff(plotTarget);
      if (typeof sessionParam === 'string') {
        const sid = parseInt(sessionParam, 10);
        if (!Number.isNaN(sid)) handoffSessionId.current = sid;
      }
      if (typeof favParam === 'string') {
        const fid = parseInt(favParam, 10);
        if (!Number.isNaN(fid)) {
          favoriteAreaId.current = fid;
          setDrawPurpose('favoriteArea');
          toast(t('areaSpecies.drawAreaHint'));
        }
      }
      setDrawMode(drawParam);
      setDrawPoints([]);
    }

    // Clear params to prevent re-trigger
    router.setParams({
      draw: undefined,
      session: undefined,
      favoriteArea: undefined,
      site: undefined,
      plot: undefined,
    });
  }, [
    params.draw,
    params.session,
    params.favoriteArea,
    params.site,
    params.plot,
    router,
    toast,
    t,
    focusRegion,
  ]);

  useEffect(() => {
    setSetting('map_view', {
      ...lastRegion.current,
      basemap: currentBasemap,
      sinica_layer: sinicaLayer,
      sinica_opacity: sinicaOpacity,
      nlsc_layer: nlscLayer,
      nlsc_opacity: nlscOpacity,
    });
  }, [currentBasemap, sinicaLayer, sinicaOpacity, nlscLayer, nlscOpacity, setSetting]);

  // Precompute transect track projection once per plots load (not per render /
  // map pan) — JSON parse + lng/lat swap is the costly part with many plots.
  /** site id → the 樣區 whose boundary it is, so the map can say so. */
  const plotBySiteId = useMemo(
    () => new Map(plots.filter((p) => p.site_id !== null).map((p) => [p.site_id as number, p])),
    [plots],
  );

  const plotRenderItems = useMemo(
    () =>
      plots.map((p) => ({
        plot: p,
        segments: usesTrack(p)
          ? parseTrackSegments(p.track_geojson).map((seg) =>
              seg.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
            )
          : [],
      })),
    [plots],
  );

  // Same precompute for session tracks (LineString or MultiLineString).
  /**
   * Parse each site's geometry once per load instead of on every render, and
   * keep a bad row from taking the tab down — `parseGeometry` is a bare
   * JSON.parse, and this used to run unguarded inside the render.
   */
  const siteRenderItems = useMemo(
    () =>
      sites.flatMap((s) => {
        try {
          const geometry = parseGeometry(s);
          const bounds = geometryBounds(geometry);
          return [
            {
              site: s,
              primitives: geometryToPrimitives(geometry),
              // Bounds centre, only ever used to place the site in a cluster
              // cell; the padding geometryBounds adds is symmetric, so the
              // centre is unaffected by it.
              latitude: bounds.latitude,
              longitude: bounds.longitude,
            },
          ];
        } catch {
          if (__DEV__) console.warn('[map] unreadable site geometry', s.id);
          return [];
        }
      }),
    [sites],
  );

  const sessionRenderItems = useMemo(
    () =>
      sessions.map((s) => ({
        session: s,
        segments: parseTrackSegments(s.track_geojson).map((seg) =>
          seg.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
        ),
      })),
    [sessions],
  );

  /**
   * One point per record. A 樣區 with a boundary contributes once, not twice:
   * the plot already stands for that record, and counting its site as well
   * would inflate every bubble it appears in.
   */
  const { clusterInputs, clusterFeatures } = useMemo(() => {
    const pts: ClusterPoint[] = [];
    // Built alongside the points so a member key has exactly one definition —
    // the picker below resolves records through it, and a second copy of these
    // template strings would silently stop matching the day one of them moved.
    const byKey = new Map<string, ClusterFeature>();
    for (const { plot, segments } of plotRenderItems) {
      const anchor =
        plot.decimal_latitude !== null && plot.decimal_longitude !== null
          ? { latitude: plot.decimal_latitude, longitude: plot.decimal_longitude }
          : segments.find((seg) => seg.length > 0)?.[0];
      if (!anchor) continue;
      const key = `plot-${plot.id}`;
      pts.push({ key, ...anchor });
      byKey.set(key, { kind: 'plot', plot });
    }
    for (const { session, segments } of sessionRenderItems) {
      const anchor =
        session.start_lat !== null && session.start_lng !== null
          ? { latitude: session.start_lat, longitude: session.start_lng }
          : segments.find((seg) => seg.length > 0)?.[0];
      if (!anchor) continue;
      const key = `sess-${session.id}`;
      pts.push({ key, ...anchor });
      byKey.set(key, { kind: 'session', session });
    }
    for (const item of siteRenderItems) {
      if (plotBySiteId.has(item.site.id)) continue;
      const key = `site-${item.site.id}`;
      pts.push({ key, latitude: item.latitude, longitude: item.longitude });
      byKey.set(key, { kind: 'site', site: item.site });
    }
    return { clusterInputs: pts, clusterFeatures: byKey };
  }, [plotRenderItems, sessionRenderItems, siteRenderItems, plotBySiteId]);

  const { clusters, hiddenKeys } = useMemo(() => {
    // Window size rather than a measured layout: the map fills the screen, and
    // a few points of tab-bar difference only nudges where cell edges fall.
    const all = clusterPoints(clusterInputs, {
      ...viewRegion,
      width: windowWidth,
      height: windowHeight,
    });
    const grouped = all.filter((c) => c.memberKeys.length > 1);
    return {
      clusters: grouped,
      hiddenKeys: new Set(grouped.flatMap((c) => c.memberKeys)),
    };
  }, [clusterInputs, viewRegion, windowWidth, windowHeight]);

  if (!settingsLoaded) return <View className="flex-1 bg-gray-100 dark:bg-gray-800" />;

  const handleRegionChangeComplete = (region: Region) => {
    lastRegion.current = region;
    setViewRegion(region);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      setSetting('map_view', {
        ...region,
        basemap: currentBasemap,
        sinica_layer: sinicaLayer,
        sinica_opacity: sinicaOpacity,
        nlsc_layer: nlscLayer,
        nlsc_opacity: nlscOpacity,
      });
    }, 600);
  };

  const handleLocateMe = async () => {
    setToolsOpen(false);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert(t('gps.permTitle'), t('gps.permMsg'));
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      mapRef.current?.animateToRegion(
        {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        },
        500,
      );
    } catch (e) {
      Alert.alert(t('gps.posFailTitle'), e instanceof Error ? e.message : String(e));
    }
  };

  const handlePickBasemap = async () => {
    setToolsOpen(false);
    const options = BASEMAP_OPTIONS.filter((o) => o.value !== 'rudy' || rudyReady);
    const idx = await showActionSheet({
      title: t('map.pickBasemap'),
      options: options.map((o) => ({ label: t(o.labelKey) })),
    });
    if (idx >= 0 && idx < options.length) setCurrentBasemap(options[idx].value);
  };

  const handleOpenLayers = () => {
    setToolsOpen(false);
    setLayersSheetOpen(true);
  };

  const handlePickDrawMode = async () => {
    setToolsOpen(false);
    const idx = await showActionSheet({
      title: t('map.drawSite'),
      options: [
        { label: t('sites.typePoint') },
        { label: t('sites.typeLineString') },
        { label: t('sites.typePolygon') },
      ],
    });
    if (idx === 0) startDraw('Point');
    else if (idx === 1) startDraw('LineString');
    else if (idx === 2) startDraw('Polygon');
  };

  const startDraw = (
    mode: 'Point' | 'LineString' | 'Polygon',
    purpose: 'site' | 'species' = 'site',
  ) => {
    setDrawMode(mode);
    setDrawPurpose(purpose);
    setDrawPoints([]);
    toast(
      purpose === 'species'
        ? t('areaSpecies.drawHint')
        : mode === 'Point'
          ? t('map.drawTapPoint')
          : mode === 'LineString'
            ? t('map.drawTapLine')
            : t('map.drawTapPolygon'),
    );
  };

  /** Query the area currently on screen, with no drawing step at all. */
  const searchVisibleArea = () => {
    setToolsOpen(false);
    const bbox = bboxOfRegion(lastRegion.current);
    const poly = {
      type: 'Polygon' as const,
      coordinates: [
        bboxCorners(bbox)
          .map((p) => [p.longitude, p.latitude] as [number, number])
          .concat([[bbox.swLng, bbox.swLat]]),
      ],
    };
    setAreaQuery({
      bbox,
      wkt: wellknown.stringify(poly as never),
      geojson: JSON.stringify(poly),
      // A rectangle is the shape the user asked for, not a fallback.
      simplified: false,
    });
    setAreaOpen(true);
  };

  const cancelDraw = () => {
    setDrawMode(null);
    setDrawPurpose('site');
    setDrawPoints([]);
    handoffSessionId.current = null;
    favoriteAreaId.current = null;
    setPlotHandoff(null);
  };

  const handleMapPress = (e: { nativeEvent: { coordinate: LatLng } }) => {
    // Tapping bare map dismisses the feature card — the same gesture that
    // opened it should be able to put it away.
    if (info) setInfo(null);
    if (!drawMode) return;
    const coord = e.nativeEvent.coordinate;
    if (drawMode === 'Point') {
      setDrawPoints([coord]);
      setSaveSiteOpen(true);
    } else {
      setDrawPoints((prev) => [...prev, coord]);
    }
  };

  const finishDraw = () => {
    if (!drawMode) return;
    if (drawPurpose === 'favoriteArea') {
      const fid = favoriteAreaId.current;
      if (fid == null) return;
      if (drawPoints.length < 2) {
        toast(t('areaSpecies.need2'));
        return;
      }
      const { polygon, simplified } = polygonOf(drawPoints);
      // Source is cleared: the area no longer matches whatever query built the
      // list, and claiming it came from iNaturalist/GBIF would be wrong.
      setFavoriteFolderArea(fid, JSON.stringify(polygon), '');
      useFavorites.getState().refresh();
      cancelDraw();
      toast(simplified ? t('areaSpecies.areaSavedBox') : t('areaSpecies.areaSaved'));
      // Return to the list the area belongs to, explicitly — same shape as the
      // session handoff below. `router.back()` does NOT work here: getting to
      // the map means navigating into the (tabs) group, which sits BELOW
      // /favorites in the root stack, so the favourites route is no longer the
      // thing behind us and back lands on whatever screen is.
      // `navigate` reuses the existing favourites route when it survived, and
      // the `folder` param reopens the folder either way.
      router.navigate(`/favorites?folder=${fid}` as Href);
      return;
    }
    if (drawPurpose === 'species') {
      // Two taps already define a rectangle, so this needs a lower floor than a
      // site polygon.
      if (drawPoints.length < 2) {
        toast(t('areaSpecies.need2'));
        return;
      }
      const { polygon, simplified } = polygonOf(drawPoints);
      setAreaQuery({
        bbox: bboxOf(drawPoints),
        // GBIF takes the drawn shape itself; iNaturalist only takes the box.
        wkt: wellknown.stringify(polygon as never),
        geojson: JSON.stringify(polygon),
        simplified,
      });
      setAreaOpen(true);
      return;
    }
    if (drawMode === 'LineString' && drawPoints.length < 2) {
      toast(t('map.lineNeed2'));
      return;
    }
    if (drawMode === 'Polygon' && drawPoints.length < 3) {
      toast(t('map.polyNeed3'));
      return;
    }
    setSaveSiteOpen(true);
  };

  const undoLastPoint = () => {
    if (drawPoints.length === 0) return;
    setDrawPoints((prev) => prev.slice(0, -1));
  };

  const handleSaveSite = (data: { name: string; project_id: number; notes: string | null }) => {
    if (!drawMode || drawPoints.length === 0) return;
    let geometry;
    if (drawMode === 'Point') {
      geometry = {
        type: 'Point' as const,
        coordinates: [drawPoints[0].longitude, drawPoints[0].latitude] as [number, number],
      };
    } else if (drawMode === 'LineString') {
      geometry = {
        type: 'LineString' as const,
        coordinates: drawPoints.map((p) => [p.longitude, p.latitude] as [number, number]),
      };
    } else {
      // Polygon: close the ring
      const ring: [number, number][] = drawPoints.map((p) => [p.longitude, p.latitude]);
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
      geometry = { type: 'Polygon' as const, coordinates: [ring] };
    }
    // 樣區 boundary: update the bound row in place rather than piling up a new
    // site per redraw. geometry_type has to be written too — the old row may be
    // the Point the user drew first, and leaving type='Point' on polygon
    // coordinates breaks every label, icon and KML/GPX exporter downstream.
    if (plotHandoff) {
      const { plot } = plotHandoff;
      // Re-read: the boundary may have been deleted from 地理樣區管理 while the
      // user was drawing, which also nulled plot.site_id via ON DELETE SET NULL.
      const existing = plotHandoff.site ? getSite(plotHandoff.site.id) : null;
      // Overwrite only when this plot is the sole owner. Copying or merging a
      // 樣區 leaves two plots pointing at one site row, and redrawing one of
      // them must not silently move the other's boundary — that case gets its
      // own row instead.
      const soleOwner = existing !== null && countSiteReferences(existing.id) <= 1;
      let siteId: number;
      if (existing && soleOwner) {
        updateSite(existing.id, {
          ...data,
          geometry_type: geometry.type,
          geometry_geojson: JSON.stringify(geometry),
        });
        siteId = existing.id;
      } else {
        // session_id stays null: that column means "this site belongs to a
        // 名錄", and it is a FK into sessions.
        siteId = createSite({ ...data, geometry, session_id: null });
      }
      updatePlotSurvey(plot.id, { site_id: siteId });
      cancelDraw();
      setSaveSiteOpen(false);
      reloadSites();
      reloadPlots();
      toast(t('map.boundPlotSite'));
      router.replace(`/plot/${plot.id}` as Href);
      return;
    }

    const handoff = handoffSessionId.current;
    const newSiteId = createSite({
      ...data,
      geometry,
      session_id: handoff,
    });
    cancelDraw();
    setSaveSiteOpen(false);
    reloadSites();

    if (handoff !== null) {
      // Bind site to the originating session and bounce back.
      updateSession(handoff, { site_id: newSiteId });
      handoffSessionId.current = null;
      toast(t('map.boundSite'));
      router.replace(`/session/${handoff}`);
    } else {
      toast(t('map.savedSite', { name: data.name }));
    }
  };

  const siteActions = async (site: SiteWithProject) => {
    const owner = plotBySiteId.get(site.id) ?? null;
    const idx = await showActionSheet({
      title: site.name,
      message:
        (owner
          ? t('map.siteOfPlot', { plotid: owner.plotid })
          : t(SITE_TYPE_LABEL[site.geometry_type])) +
        ` · ${site.project_name}${site.notes ? `\n\n${site.notes}` : ''}`,
      cancelLabel: t('common.close'),
      options: owner
        ? // A 樣區 boundary is deleted from the 樣區, not from under it: doing it
          // here would leave the plot silently without one.
          [
            { label: t('map.jumpToPlot') },
            { label: t('map.jumpToSite') },
            { label: t('map.redrawRange') },
          ]
        : [{ label: t('map.jumpToSite') }, { label: t('common.delete'), destructive: true }],
    });
    if (owner) {
      if (idx === 0) {
        router.push(`/plot/${owner.id}` as Href);
      } else if (idx === 1) {
        mapRef.current?.animateToRegion(geometryBounds(parseGeometry(site)), 400);
      } else if (idx === 2) {
        setPlotHandoff({ plot: owner, site });
        setDrawPurpose('site');
        setDrawMode('Polygon');
        setDrawPoints([]);
      }
      return;
    }
    if (idx === 0) {
      const region = geometryBounds(parseGeometry(site));
      mapRef.current?.animateToRegion(region, 400);
    } else if (idx === 1) {
      // 2-button confirm — Alert.alert is fine here.
      Alert.alert(t('sites.deleteTitle'), t('sites.deleteMsg', { name: site.name }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteSite(site.id);
            reloadSites();
            toast(t('sites.deleted'));
          },
        },
      ]);
    }
  };

  /** Region that fits a plot's geometry, or null if it has no coordinates. */
  const plotRegion = (plot: PlotSurvey) => {
    if (usesTrack(plot)) {
      const segs = parseTrackSegments(plot.track_geojson);
      // No track yet is NOT "no coordinates": the recorder's onFirstFix writes
      // the first fix into decimal_latitude/longitude, and the centre can also
      // be placed by hand on the 樣區 mini map. Fall through to it rather than
      // telling the user the plot has no location.
      if (segs.length > 0) {
        return geometryBounds({ type: 'MultiLineString', coordinates: segs });
      }
    }
    if (plot.decimal_latitude === null || plot.decimal_longitude === null) return null;
    return geometryBounds({
      type: 'Point',
      coordinates: [plot.decimal_longitude, plot.decimal_latitude] as [number, number],
    });
  };

  /**
   * Tap shows what the feature is; 「操作」 on the card opens the sheet.
   *
   * Long-press would be the obvious way to separate the two, but
   * react-native-maps has no onLongPress on Marker / Polyline / Polygon —
   * only MapView does, and it reports a coordinate, not the feature.
   */
  const openPlotInfo = (plot: PlotSurveyWithMeta) => {
    const lines: string[] = [];
    if (plot.decimal_latitude !== null && plot.decimal_longitude !== null) {
      lines.push(`${plot.decimal_latitude.toFixed(6)}, ${plot.decimal_longitude.toFixed(6)}`);
    }
    if (usesTrack(plot) && parseTrackSegments(plot.track_geojson).every((seg) => seg.length < 2)) {
      lines.push(t('map.trackNotYet'));
    }
    setInfo({
      title: plot.plotid || t('map.plotMenuTitle', { id: plot.id }),
      subtitle: t('map.plotSubtitle', {
        type: PLOT_TYPE_LABEL[plot.plot_type] ? t(PLOT_TYPE_LABEL[plot.plot_type]) : plot.plot_type,
        count: plot.species_count,
        project: plot.project_name,
      }),
      lines,
      badge: plot.status === 'active' ? t('map.inProgress') : null,
      accentColor: plot.status === 'active' ? PLOT_ACTIVE_COLOR : PLOT_COLOR,
      onAction: () => {
        setInfo(null);
        void plotActions(plot);
      },
    });
  };

  const openSessionInfo = (session: SessionWithStats) => {
    const isActive = activeSession?.id === session.id;
    const lines: string[] = [];
    if (session.start_lat !== null && session.start_lng !== null) {
      lines.push(`${session.start_lat.toFixed(6)}, ${session.start_lng.toFixed(6)}`);
    }
    setInfo({
      title: session.name || t('map.sessionMarkerTitle', { id: session.id }),
      subtitle: t('map.sessionSubtitle', {
        count: session.record_count,
        project: session.project_name,
      }),
      lines,
      badge: isActive ? t('map.inProgress') : null,
      accentColor: isActive ? SESSION_ACTIVE_COLOR : SESSION_COLOR,
      onAction: () => {
        setInfo(null);
        void sessionActions(session);
      },
    });
  };

  const openSiteInfo = (site: SiteWithProject) => {
    const owner = plotBySiteId.get(site.id) ?? null;
    setInfo({
      title: site.name,
      subtitle:
        (owner
          ? t('map.siteOfPlot', { plotid: owner.plotid })
          : t(SITE_TYPE_LABEL[site.geometry_type])) + ` · ${site.project_name}`,
      lines: site.notes ? [site.notes] : [],
      badge: null,
      accentColor: owner
        ? owner.status === 'active'
          ? PLOT_ACTIVE_COLOR
          : PLOT_COLOR
        : SITE_COLOR,
      onAction: () => {
        setInfo(null);
        void siteActions(site);
      },
    });
  };

  /**
   * Records under a bubble that zooming cannot pull apart.
   *
   * Tapping a bubble zooms to its members, which is a dead end when they share
   * a coordinate — the same grid cell holds them at every zoom, so the bubble
   * survives and nothing underneath is reachable. `clusterSplits` asks whether
   * the zoom would actually help; when it would not, the members are listed
   * instead and picking one opens the card it would have shown.
   */
  const openClusterMembers = async (c: PointCluster) => {
    const found = c.memberKeys.flatMap((k) => {
      const f = clusterFeatures.get(k);
      return f ? [f] : [];
    });
    if (found.length === 0) return;
    const label = (f: ClusterFeature) => {
      if (f.kind === 'plot') {
        const type = PLOT_TYPE_LABEL[f.plot.plot_type];
        const name = f.plot.plotid || t('map.plotMenuTitle', { id: f.plot.id });
        return `${type ? t(type) : f.plot.plot_type} · ${name}`;
      }
      if (f.kind === 'session') {
        return `${t('nav.session')} · ${f.session.name || t('map.sessionMarkerTitle', { id: f.session.id })}`;
      }
      return `${t(SITE_TYPE_LABEL[f.site.geometry_type])} · ${f.site.name}`;
    };
    const idx = await showActionSheet({
      title: t('map.clusterMembersTitle', { n: found.length }),
      cancelLabel: t('common.cancel'),
      options: found.map((f) => ({ label: label(f) })),
    });
    if (idx < 0) return;
    const pick = found[idx];
    if (pick.kind === 'plot') openPlotInfo(pick.plot);
    else if (pick.kind === 'session') openSessionInfo(pick.session);
    else openSiteInfo(pick.site);
  };

  const plotActions = async (plot: PlotSurveyWithMeta) => {
    const idx = await showActionSheet({
      title: plot.plotid || t('map.plotMenuTitle', { id: plot.id }),
      message:
        t('map.plotSubtitle', {
          type: PLOT_TYPE_LABEL[plot.plot_type]
            ? t(PLOT_TYPE_LABEL[plot.plot_type])
            : plot.plot_type,
          count: plot.species_count,
          project: plot.project_name,
        }) + (plot.status === 'active' ? `\n\n${t('map.inProgress')}` : ''),
      cancelLabel: t('common.close'),
      options: [
        { label: t('map.jumpBack') },
        { label: t('map.jumpToLoc') },
        { label: t('map.editLoc') },
      ],
    });
    if (idx === 0) {
      router.push(`/plot/${plot.id}`);
    } else if (idx === 1) {
      const region = plotRegion(plot);
      if (region) mapRef.current?.animateToRegion(region, 400);
      else toast(t('map.noRecordCoord'));
    } else if (idx === 2) {
      enterPlotEdit(plot);
    }
  };

  const enterPlotEdit = async (plot: PlotSurveyWithMeta) => {
    if (usesTrack(plot)) {
      // Block editing a transect that's actively recording — trackRecorder
      // flushes writePlotTrack every few points and would clobber the edit.
      if (isRecordingTarget({ kind: 'plot', id: plot.id })) {
        Alert.alert(t('map.transectRecording'), t('map.transectRecordingMsg'));
        return;
      }
      const segs = parseTrackSegments(plot.track_geojson);
      // Indices into `segs` — NOT a filtered copy: savePlotEdit re-parses the
      // original track and writes back at `editSegmentIndex`, so the index has
      // to survive. A 1-point segment is excluded because the track branch of
      // savePlotEdit needs >= 2 points, i.e. opening one strands the user with
      // something they cannot save.
      const editable = segs.map((_, i) => i).filter((i) => segs[i].length >= 2);
      if (editable.length === 0) {
        // Nothing to edit as a track. The plot is on the map as a centre-point
        // marker now, so refusing outright would contradict what the user just
        // tapped; edit that point instead when it exists.
        if (plot.decimal_latitude !== null && plot.decimal_longitude !== null) {
          setEditPlot(plot);
          setEditMode('point');
          setDrawPoints([
            { latitude: plot.decimal_latitude, longitude: plot.decimal_longitude },
          ]);
          toast(t('map.dragMarkerHint'));
          return;
        }
        Alert.alert(t('map.noTrack'), t('map.noTrackMsg'));
        return;
      }
      // Pick a segment when more than one is editable (pause/resume splits).
      let segIdx = editable[0];
      if (editable.length > 1) {
        const pick = await showActionSheet({
          title: t('map.pickSegTitle'),
          cancelLabel: t('common.cancel'),
          options: editable.map((i) => ({
            label: t('map.segLabel', { n: i + 1, count: segs[i].length }),
          })),
        });
        if (pick < 0 || pick >= editable.length) return; // cancelled
        segIdx = editable[pick];
      }
      if (segs[segIdx].length > TRACK_EDIT_WARN_POINTS) {
        const proceed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t('map.manyPointsTitle'),
            t('map.manyPointsMsg', { count: segs[segIdx].length }),
            [
              { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('common.continue'), onPress: () => resolve(true) },
            ],
          );
        });
        if (!proceed) return;
      }
      setEditPlot(plot);
      setEditMode('track');
      setEditSegmentIndex(segIdx);
      setDrawPoints(segs[segIdx].map(([lng, lat]) => ({ latitude: lat, longitude: lng })));
      toast(t('map.dragVertexHint'));
      return;
    }
    if (plot.decimal_latitude === null || plot.decimal_longitude === null) {
      Alert.alert(t('map.noPlotCoord'), t('map.noPlotCoordMsg'));
      return;
    }
    setEditPlot(plot);
    setEditMode('point');
    setDrawPoints([{ latitude: plot.decimal_latitude, longitude: plot.decimal_longitude }]);
    toast(t('map.dragMarkerHint'));
  };

  const cancelPlotEdit = () => {
    setEditPlot(null);
    setEditMode(null);
    setDrawPoints([]);
  };

  const savePlotEdit = () => {
    if (!editPlot || !editMode) return;
    const label = editPlot.plotid || t('map.plotMenuTitle', { id: editPlot.id });

    if (editMode === 'track') {
      if (drawPoints.length < 2) {
        toast(t('map.trackNeed2'));
        return;
      }
      Alert.alert(t('map.saveTrackTitle'), t('map.saveTrackMsg', { label }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.save'),
          onPress: () => {
            // Re-parse the original track, replace the edited segment, drop any
            // segment left with <2 points.
            const segs = parseTrackSegments(editPlot.track_geojson);
            segs[editSegmentIndex] = drawPoints.map((p) => [p.longitude, p.latitude]);
            writePlotTrack(
              editPlot.id,
              segs.filter((s) => s.length >= 2),
            );
            cancelPlotEdit();
            reloadPlots();
            toast(t('map.trackUpdated'));
          },
        },
      ]);
      return;
    }

    // editMode === 'point'
    if (drawPoints.length === 0) return;
    const pt = drawPoints[0];
    Alert.alert(t('map.savePosTitle'), t('map.savePosMsg', { label }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.save'),
        onPress: () => {
          updatePlotSurvey(editPlot.id, {
            decimal_latitude: pt.latitude,
            decimal_longitude: pt.longitude,
          });
          cancelPlotEdit();
          reloadPlots();
          toast(t('map.posUpdated'));
        },
      },
    ]);
  };

  /** Region that fits a session's geometry (track preferred, else start point). */
  const sessionRegion = (s: SessionWithStats) => {
    const segs = parseTrackSegments(s.track_geojson);
    if (segs.length > 0) return geometryBounds({ type: 'MultiLineString', coordinates: segs });
    if (s.start_lat === null || s.start_lng === null) return null;
    return geometryBounds({
      type: 'Point',
      coordinates: [s.start_lng, s.start_lat] as [number, number],
    });
  };

  const sessionActions = async (s: SessionWithStats) => {
    const isActive = activeSession?.id === s.id;
    const idx = await showActionSheet({
      title: s.name || t('map.sessionMarkerTitle', { id: s.id }),
      message:
        t('map.sessionSubtitle', { count: s.record_count, project: s.project_name }) +
        (isActive ? `\n\n${t('map.inProgress')}` : ''),
      cancelLabel: t('common.close'),
      options: [{ label: t('map.jumpBack') }, { label: t('map.jumpToLoc') }],
    });
    if (idx === 0) {
      router.push(`/session/${s.id}`);
    } else if (idx === 1) {
      const region = sessionRegion(s);
      if (region) mapRef.current?.animateToRegion(region, 400);
      else toast(t('map.noRecordCoord'));
    }
  };

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) return;
    Keyboard.dismiss();
    try {
      setSearchBusy(true);
      const results = await Location.geocodeAsync(q);
      if (results.length === 0) {
        toast(t('map.notFound', { q }));
        return;
      }
      const r = results[0];
      mapRef.current?.animateToRegion(
        { latitude: r.latitude, longitude: r.longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 },
        500,
      );
      setSearchQuery('');
      setSearchOpen(false);
    } catch (e) {
      toast(t('map.searchFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSearchBusy(false);
    }
  };

  const openSearch = () => {
    setSearchOpen(true);
    setToolsOpen(false);
    setTimeout(() => searchInputRef.current?.focus(), 60);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    Keyboard.dismiss();
  };

  return (
    <View className="flex-1 bg-gray-100 dark:bg-gray-800">
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude: initial.latitude,
          longitude: initial.longitude,
          latitudeDelta: initial.latitudeDelta,
          longitudeDelta: initial.longitudeDelta,
        }}
        mapType={basemapToMapType(currentBasemap)}
        showsCompass
        showsScale
        showsUserLocation
        showsMyLocationButton={false}
        onMapReady={() => setMapReady(true)}
        onRegionChangeComplete={handleRegionChangeComplete}
        onPress={handleMapPress}
      >
        {/* 魯地圖離線底圖。必須排在兩個 WMTS 疊圖之前 —— iOS 沒有 zIndex，靠加入
            順序決定先後，而 AIRMapUrlTile.m 的 update 會把重新掛載的 UrlTile 加到
            最上層；魯地圖的 props 全是常數，不會自己觸發 update 去搶最上層。

            用 <UrlTile tileCachePath offlineMode> 而不是 <LocalTile>，是讀過 native
            原始碼後的決定：LocalTile 沒有 maximumNativeZ（超過 z15 就一片空白，而野外
            一定會放大到 z17-19 看自己的點位），而且它把 canReplaceMapContent 寫死成
            YES，會在全球範圍關掉原生底圖 —— 我們刻意不 render 的海域會變成空白。 */}
        {rudyOn && rudyInstalled ? (
          <UrlTile
            // offlineMode 下永遠不會連出去，但 native 端仍要求這個 prop 有值。
            urlTemplate="https://offline.invalid/{z}/{x}/{y}.png"
            tileCachePath={rudyTileCachePath()}
            offlineMode
            tileCacheMaxAge={RUDY_TILE_CACHE_MAX_AGE}
            minimumZ={rudyInstalled.manifest.minZoom}
            maximumNativeZ={rudyInstalled.manifest.maxZoom}
            maximumZ={20}
            shouldReplaceMapContent={false}
            tileSize={rudyInstalled.manifest.tileSize}
            zIndex={0}
          />
        ) : null}
        {nlscLayer ? (
          <UrlTile
            // key 綁 currentBasemap：切底圖時強制重新掛載，讓這兩層重新加到
            // 魯地圖之上（iOS 的先後順序只看加入順序）。
            key={`nlsc-${currentBasemap}`}
            urlTemplate={NLSC_TILE_URL.replace('{LAYER}', nlscLayer)}
            opacity={nlscOpacity}
            zIndex={1}
            maximumZ={20}
          />
        ) : null}
        {sinicaLayer ? (
          <UrlTile
            key={`sinica-${currentBasemap}`}
            urlTemplate={SINICA_TILE_URL.replace('{LAYER}', sinicaLayer)}
            opacity={sinicaOpacity}
            zIndex={2}
            maximumZ={19}
          />
        ) : null}

        {/* All sessions (名錄): start-point marker + track. The active session is
            colored green; its per-record species points are drawn separately
            below. Tap → info / jump to the record. */}
        {sessionRenderItems.flatMap(({ session, segments }) => {
          if (hiddenKeys.has(`sess-${session.id}`)) return [];
          const isActive = activeSession?.id === session.id;
          const color = isActive ? SESSION_ACTIVE_COLOR : SESSION_COLOR;
          const els = segments
            .filter((seg) => seg.length >= 2)
            .map((seg, i) => (
              <Polyline
                key={`sess-${session.id}-${i}`}
                coordinates={seg}
                strokeColor={color}
                strokeWidth={4}
                zIndex={2}
                tappable
                onPress={() => openSessionInfo(session)}
              />
            ));
          if (session.start_lat !== null && session.start_lng !== null) {
            els.push(
              <Marker
                key={`sess-m-${session.id}`}
                coordinate={{ latitude: session.start_lat, longitude: session.start_lng }}
                title={session.name || t('map.sessionMarkerTitle', { id: session.id })}
                description={t('map.sessionDesc', { count: session.record_count })}
                pinColor={color}
                zIndex={3}
                onPress={() => openSessionInfo(session)}
              />,
            );
          }
          return els;
        })}
        {activeRecords
          .filter((r) => r.lat !== null && r.lng !== null)
          .map((r) => (
            <Marker
              key={`rec-${r.id}`}
              coordinate={{ latitude: r.lat as number, longitude: r.lng as number }}
              title={r.common_name_c || r.simple_name}
              description={r.family_c}
              pinColor="#f59e0b"
              zIndex={4}
            />
          ))}

        {/* Existing sites — Multi* geometries expand to multiple primitives */}
        {siteRenderItems.flatMap(({ site: s, primitives }) => {
          // A site bound to a 樣區 is that plot's boundary, so it wears the plot
          // colours — otherwise a blue shape sits around a purple pin with
          // nothing saying they are the same record.
          const owner = plotBySiteId.get(s.id);
          // A boundary is clustered under its owner's key, since the plot is
          // the record both of them stand for.
          if (hiddenKeys.has(owner ? `plot-${owner.id}` : `site-${s.id}`)) return [];
          const stroke = owner
            ? owner.status === 'active'
              ? PLOT_ACTIVE_COLOR
              : PLOT_COLOR
            : SITE_COLOR;
          const fill = owner ? PLOT_FILL : SITE_FILL;
          return primitives.map((prim, i) => {
            const key = `s-${s.id}-${i}`;
            if (prim.kind === 'point') {
              return (
                <Marker
                  key={key}
                  coordinate={{ latitude: prim.latitude, longitude: prim.longitude }}
                  title={s.name}
                  description={s.project_name}
                  pinColor={stroke}
                  onPress={() => openSiteInfo(s)}
                />
              );
            }
            if (prim.kind === 'line') {
              return (
                <Polyline
                  key={key}
                  coordinates={prim.coords}
                  strokeColor={stroke}
                  strokeWidth={3}
                  tappable
                  onPress={() => openSiteInfo(s)}
                />
              );
            }
            return (
              <Polygon
                key={key}
                coordinates={prim.coords}
                strokeColor={stroke}
                fillColor={fill}
                strokeWidth={2}
                tappable
                onPress={() => openSiteInfo(s)}
              />
            );
          });
        })}

        {/* Existing plot surveys — fixed/point_count markers (+ radius circle),
            transect tracks. The plot under edit is hidden here; the draggable
            marker below takes over. */}
        {plotRenderItems.flatMap(({ plot, segments }) => {
          if (editPlot && editPlot.id === plot.id) return [];
          if (hiddenKeys.has(`plot-${plot.id}`)) return [];
          const color = plot.status === 'active' ? PLOT_ACTIVE_COLOR : PLOT_COLOR;
          if (usesTrack(plot)) {
            const drawable = segments.filter((seg) => seg.length >= 2);
            // A transect whose track is not started yet, holds a single fix, or
            // was cleared has nothing to draw here — and returning early made
            // the whole plot disappear from the map even though it has a centre
            // point. Common, not an edge case: the recorder writes the first fix
            // into decimal_latitude/longitude, so a just-started transect always
            // has a centre and a one-point segment. Fall through to the marker.
            if (drawable.length > 0) {
              return drawable.map((seg, i) => (
                <Polyline
                  key={`plot-${plot.id}-${i}`}
                  coordinates={seg}
                  strokeColor={color}
                  strokeWidth={4}
                  zIndex={5}
                  tappable
                  onPress={() => openPlotInfo(plot)}
                />
              ));
            }
          }
          if (plot.decimal_latitude === null || plot.decimal_longitude === null) return [];
          const center = { latitude: plot.decimal_latitude, longitude: plot.decimal_longitude };
          const circle =
            plot.plot_type === 'point_count' && plot.point_radius_m && plot.point_radius_m > 0 ? (
              <Circle
                key={`plot-c-${plot.id}`}
                center={center}
                radius={plot.point_radius_m}
                strokeColor={color}
                fillColor={PLOT_FILL}
                strokeWidth={2}
                zIndex={4}
              />
            ) : null;
          return [
            circle,
            <Marker
              key={`plot-m-${plot.id}`}
              coordinate={center}
              pinColor={color}
              title={plot.plotid || t('map.plotMenuTitle', { id: plot.id })}
              description={
                t('map.plotDesc', {
                  type: PLOT_TYPE_LABEL[plot.plot_type]
                    ? t(PLOT_TYPE_LABEL[plot.plot_type])
                    : plot.plot_type,
                  count: plot.species_count,
                }) + (usesTrack(plot) ? ` · ${t('map.trackNotYet')}` : '')
              }
              zIndex={5}
              onPress={() => openPlotInfo(plot)}
            />,
          ];
        })}

        {/* One bubble per crowded grid cell; the features it stands for are
            skipped above. Tapping zooms to its members, which is what breaks
            it apart. Hidden while drawing so it cannot eat a vertex tap. */}
        {/* Clustering stays on in every mode. Turning it off while drawing or
            editing swapped the whole marker set twice per session — every
            clustered record mounted as its own annotation on entry and unmounted
            again on exit — which is a lot of native work on one tap. Only the
            press handler is dropped, so a tap falls through to the map and
            places a vertex instead of zooming. */}
        {clusters.map((c) => (
          <ClusterMarker
            key={c.key}
            latitude={c.latitude}
            longitude={c.longitude}
            count={c.memberKeys.length}
            onPress={
              drawMode || editMode
                ? undefined
                : () => {
                    const target = clusterRegion(c);
                    if (
                      clusterSplits(c, {
                        ...target,
                        width: windowWidth,
                        height: windowHeight,
                      })
                    ) {
                      mapRef.current?.animateToRegion(target, 350);
                    } else {
                      void openClusterMembers(c);
                    }
                  }
            }
          />
        ))}

        {/* In-progress drawing — markers are draggable; tap a marker to remove it */}
        {(drawMode || editMode) && drawPoints.length > 0
          ? drawPoints.map((p, i) => (
              <Marker
                key={`d-${i}`}
                identifier={`d-${i}`}
                coordinate={p}
                pinColor={DRAW_COLOR}
                anchor={{ x: 0.5, y: 0.5 }}
                draggable
                onDragEnd={(e) => {
                  const next = [...drawPoints];
                  next[i] = e.nativeEvent.coordinate;
                  setDrawPoints(next);
                }}
                onPress={() => {
                  // Editing a plot's single point: drag only, never delete.
                  if (editMode === 'point') return;
                  Alert.alert(t('map.editPointTitle'), t('map.pointN', { n: i + 1 }), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('map.deletePoint'),
                      style: 'destructive',
                      onPress: () => {
                        const next = drawPoints.filter((_, idx) => idx !== i);
                        setDrawPoints(next);
                      },
                    },
                  ]);
                }}
              />
            ))
          : null}
        {(drawMode === 'LineString' || editMode === 'track') && drawPoints.length >= 2 ? (
          <Polyline coordinates={drawPoints} strokeColor={DRAW_COLOR} strokeWidth={3} />
        ) : null}
        {drawMode === 'Polygon' && drawPurpose === 'site' && drawPoints.length >= 3 ? (
          <Polygon
            coordinates={drawPoints}
            strokeColor={DRAW_COLOR}
            fillColor={DRAW_FILL}
            strokeWidth={2}
          />
        ) : null}
        {/* Species query: draw BOTH shapes, because the two sources use
            different ones — the filled box is what iNaturalist is asked about,
            the outline is what GBIF is asked about. Showing only one of them
            would misrepresent whichever source the user then picks. */}
        {drawPurpose === 'species' && drawPoints.length >= 2 ? (
          <Polygon
            coordinates={bboxCorners(bboxOf(drawPoints))}
            strokeColor={AREA_COLOR}
            fillColor={AREA_FILL}
            strokeWidth={1}
          />
        ) : null}
        {(drawPurpose === 'species' || drawPurpose === 'favoriteArea') && drawPoints.length >= 3 ? (
          <Polygon
            coordinates={drawPoints}
            strokeColor={AREA_COLOR}
            fillColor="transparent"
            strokeWidth={3}
          />
        ) : null}
      </MapView>

      {/* 版權標示。ODbL 與魯地圖的授權都要求標示來源，所以這一行在魯地圖底圖
          啟用時是必要的，不是裝飾。文字讀自 installed.json 的 manifest —— 換一版
          圖磚包若換了資料來源，不必發 app 版本就會跟著更新。
          置左下並讓開原生的比例尺與浮動 tab bar。 */}
      {rudyOn ? (
        <Pressable
          onPress={() => router.push('/settings/rudymap' as Href)}
          style={{ bottom: tabBarInset + 6 }}
          className="absolute left-2 rounded bg-white/75 px-1.5 py-0.5 dark:bg-black/60"
        >
          <Text className="text-[9px] leading-3 text-gray-700 dark:text-gray-300">
            {rudyAttribution(rudyInstalled, i18n.language)}
          </Text>
        </Pressable>
      ) : null}

      {/* Loading overlay — shown until MapView fires onMapReady (or 4s fallback) */}
      {!mapReady ? (
        <View
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          className="items-center justify-center bg-gray-100 dark:bg-gray-800/85"
        >
          <ActivityIndicator size="large" color="#2563eb" />
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            {t('map.loadingMap')}
          </Text>
          <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('map.firstLoadHint')}
          </Text>
        </View>
      ) : null}

      {/* Top-left: search FAB / expanded bar (visible even during drawing) */}
      <View
        className="absolute left-3"
        style={{ top: insets.top + 8, right: searchOpen ? 12 : undefined }}
      >
        {searchOpen ? (
          <View className="flex-row items-center rounded-full bg-white px-3 py-2 shadow-md dark:bg-gray-900/95">
            <Pressable onPress={closeSearch} hitSlop={8}>
              <Ionicons name="arrow-back" size={18} color="#374151" />
            </Pressable>
            <TextInput
              ref={searchInputRef}
              className="ml-2 flex-1 text-sm text-gray-900 dark:text-gray-100"
              placeholder={t('map.searchPlaceholder')}
              placeholderTextColor="#9ca3af"
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={handleSearch}
              autoCorrect={false}
              returnKeyType="search"
              editable={!searchBusy}
            />
            {searchQuery ? (
              <Pressable onPress={() => setSearchQuery('')} hitSlop={6}>
                <Ionicons name="close-circle" size={18} color="#9ca3af" />
              </Pressable>
            ) : null}
          </View>
        ) : (
          <FabButton icon="search" onPress={openSearch} />
        )}
      </View>

      {/* Top-right: tools FAB */}
      {!searchOpen && !drawMode && !editMode ? (
        <View className="absolute right-3 items-end" style={{ top: insets.top + 8 }}>
          <FabButton
            icon={toolsOpen ? 'close' : 'apps'}
            onPress={() => setToolsOpen((v) => !v)}
            accent={!toolsOpen && (!!sinicaLayer || !!nlscLayer)}
          />

          {toolsOpen ? (
            <View className="mt-2 items-end">
              <FabRow
                icon={basemapMeta(currentBasemap).icon}
                label={t(basemapMeta(currentBasemap).labelKey)}
                onPress={handlePickBasemap}
              />
              <FabRow icon="locate" label={t('map.locate')} onPress={handleLocateMe} accent />
              <FabRow
                icon="albums-outline"
                label={sinicaLayer || nlscLayer ? t('map.layersOverlaid') : t('map.layers')}
                onPress={handleOpenLayers}
                accent={!!sinicaLayer || !!nlscLayer}
              />
              <FabRow
                icon="create-outline"
                label={t('map.drawSite')}
                onPress={handlePickDrawMode}
              />
              <FabRow
                icon="scan-outline"
                label={t('areaSpecies.fabVisible')}
                onPress={searchVisibleArea}
              />
              <FabRow
                icon="leaf-outline"
                label={t('areaSpecies.fab')}
                onPress={() => {
                  setToolsOpen(false);
                  startDraw('Polygon', 'species');
                }}
              />
              <FabRow
                icon="cloud-upload-outline"
                label={t('map.import')}
                onPress={() => {
                  setToolsOpen(false);
                  setImportOpen(true);
                }}
              />
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Drawing toolbar (below search FAB row) */}
      {drawMode ? (
        <View className="absolute left-3 right-3" style={{ top: insets.top + 60 }}>
          <View className="flex-row items-center rounded-full bg-white px-3 py-2 shadow-md dark:bg-gray-900/95">
            <Pressable onPress={cancelDraw} hitSlop={8} className="px-2">
              <Text className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Text className="flex-1 text-center text-xs text-gray-700 dark:text-gray-300">
              {t('map.drawingLabel', { type: t(SITE_TYPE_LABEL[drawMode]), count: drawPoints.length })}
            </Text>
            {drawPoints.length > 0 ? (
              <Pressable onPress={undoLastPoint} hitSlop={8} className="px-2">
                <Ionicons name="arrow-undo" size={16} color="#6b7280" />
              </Pressable>
            ) : null}
            {drawMode !== 'Point' ? (
              <Pressable
                onPress={finishDraw}
                hitSlop={8}
                className={`ml-1 rounded-full px-3 py-1 ${ACTION_FILL}`}
              >
                <Text className="text-xs font-semibold text-white">{t('common.done')}</Text>
              </Pressable>
            ) : null}
          </View>
          {plotHandoff ? (
            <View className="mt-2 rounded-full bg-emerald-500 px-3 py-1.5 shadow-md">
              <Text className="text-center text-xs font-medium text-white">
                {t('map.plotHandoffHint', { plotid: plotHandoff.plot.plotid })}
              </Text>
            </View>
          ) : null}
          {handoffSessionId.current !== null ? (
            <View className="mt-2 rounded-full bg-emerald-500 px-3 py-1.5 shadow-md">
              <Text className="text-center text-xs font-medium text-white">
                {t('map.handoffHint', { id: handoffSessionId.current })}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Edit-geometry toolbar (drag the marker, then save). */}
      {editMode ? (
        <View className="absolute left-3 right-3" style={{ top: insets.top + 60 }}>
          <View className="flex-row items-center rounded-full bg-white px-3 py-2 shadow-md dark:bg-gray-900/95">
            <Pressable onPress={cancelPlotEdit} hitSlop={8} className="px-2">
              <Text className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Text className="flex-1 text-center text-xs text-gray-700 dark:text-gray-300">
              {editMode === 'track' ? t('map.editTrackHint') : t('map.editPosHint')}
            </Text>
            <Pressable
              onPress={savePlotEdit}
              hitSlop={8}
              className={`ml-1 rounded-full px-3 py-1 ${ACTION_FILL}`}
            >
              <Text className="text-xs font-semibold text-white">{t('common.save')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Gated on the drawing modes so it never covers the vertex toolbar. */}
      {info && !drawMode && !editMode ? (
        <MapFeatureCard info={info} onClose={() => setInfo(null)} />
      ) : null}

      <LayerSheet
        visible={layersSheetOpen}
        onClose={() => setLayersSheetOpen(false)}
        sources={[
          {
            key: 'nlsc',
            label: t('map.nlsc'),
            layers: NLSC_LAYERS,
            selectedId: nlscLayer,
            opacity: nlscOpacity,
            onSelect: (id) => {
              setNlscLayer(id);
              if (id) toast(t('map.overlaid'));
            },
            onOpacityChange: setNlscOpacity,
          },
          {
            key: 'sinica',
            label: t('map.sinica'),
            layers: SINICA_LAYERS,
            selectedId: sinicaLayer,
            opacity: sinicaOpacity,
            onSelect: (id) => {
              setSinicaLayer(id);
              if (id) toast(t('map.overlaid'));
            },
            onOpacityChange: setSinicaOpacity,
          },
        ]}
      />

      {drawMode && drawPurpose === 'site' ? (
        <SaveSiteModal
          visible={saveSiteOpen}
          geometryType={drawMode}
          vertexCount={drawPoints.length}
          title={plotHandoff ? t('map.saveRangeTitle') : undefined}
          defaultName={
            plotHandoff
              ? (plotHandoff.site?.name ??
                t('map.rangeDefaultName', { plotid: plotHandoff.plot.plotid }))
              : ''
          }
          defaultProjectId={plotHandoff?.plot.project_id ?? 0}
          defaultNotes={plotHandoff?.site?.notes ?? ''}
          onCancel={() => setSaveSiteOpen(false)}
          onConfirm={handleSaveSite}
        />
      ) : null}

      <AreaSpeciesModal
        visible={areaOpen}
        bbox={areaQuery?.bbox ?? null}
        wkt={areaQuery?.wkt ?? null}
        simplified={areaQuery?.simplified ?? false}
        areaGeoJson={areaQuery?.geojson ?? null}
        onClose={() => {
          setAreaOpen(false);
          setAreaQuery(null);
        }}
        onImported={(name, added) => {
          setAreaOpen(false);
          setAreaQuery(null);
          cancelDraw();
          toast(t('areaSpecies.imported', { name, count: added }), {
            action: {
              label: t('favorites.goToFavorites'),
              onPress: () => router.push('/favorites'),
            },
          });
        }}
      />

      <GeoImportModal
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onCommitted={(n) => {
          reloadSites();
          if (n > 0) toast(t('map.imported', { count: n }));
        }}
      />
    </View>
  );
}

/**
 * Count bubble for a cluster.
 *
 * `tracksViewChanges` starts true so the custom view is captured once it has
 * laid out (leaving it false from the start renders a blank marker), then goes
 * off again as soon as the view reports a layout. A timer was used here first,
 * and a quarter of a second of per-frame re-capture — times every bubble that
 * mounts at once when an edit is cancelled — is long enough to look like the
 * app has locked up.
 *
 * It comes back on when the number or position changes, because the cluster
 * key is the grid cell alone: the marker stays mounted across pans (that is
 * the point), so a changed count has to be re-captured, not remounted.
 */
function ClusterMarker({
  latitude,
  longitude,
  count,
  onPress,
}: {
  latitude: number;
  longitude: number;
  count: number;
  /** Omitted while drawing or editing, so the tap reaches the map. */
  onPress?: () => void;
}) {
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
  }, [count, latitude, longitude]);
  return (
    <Marker
      coordinate={{ latitude, longitude }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracks}
      zIndex={6}
      onPress={onPress}
    >
      <View
        // One frame after layout, not a fixed delay: the capture is done by
        // then, and waiting longer only burns frames.
        onLayout={() => requestAnimationFrame(() => setTracks(false))}
        className="items-center justify-center rounded-full border-2 border-white shadow"
        style={{
          // Grows a little with the count so a big cluster reads as big, but
          // capped — a 300-record bubble must not cover the map.
          width: count >= 100 ? 46 : count >= 10 ? 40 : 34,
          height: count >= 100 ? 46 : count >= 10 ? 40 : 34,
          backgroundColor: CLUSTER_COLOR,
        }}
      >
        <Text className="text-xs font-bold text-white">{count}</Text>
      </View>
    </Marker>
  );
}

function FabButton({
  icon,
  onPress,
  accent = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  accent?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="h-11 w-11 items-center justify-center rounded-full bg-white shadow-md active:bg-gray-100 dark:bg-gray-900/95 dark:active:bg-gray-700"
    >
      <Ionicons name={icon} size={20} color={accent ? '#2563eb' : '#374151'} />
    </Pressable>
  );
}

function FabRow({
  icon,
  label,
  onPress,
  accent = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  accent?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="mt-2 flex-row items-center rounded-full bg-white px-3 py-2 shadow-md active:bg-gray-100 dark:bg-gray-900/95 dark:active:bg-gray-700"
    >
      <Text
        className={`mr-2 text-xs font-medium ${accent ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}
      >
        {label}
      </Text>
      <Ionicons name={icon} size={18} color={accent ? '#2563eb' : '#374151'} />
    </Pressable>
  );
}
