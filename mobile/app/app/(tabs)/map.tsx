import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useIsFocused } from '@react-navigation/native';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LayerSheet } from '~/components/LayerSheet';
import { SINICA_LAYERS } from '~/lib/sinicaLayers';
import { NLSC_LAYERS } from '~/lib/nlscLayers';
import { SaveSiteModal } from '~/components/SaveSiteModal';
import { GeoImportModal } from '~/components/GeoImportModal';
import { AreaSpeciesModal } from '~/components/AreaSpeciesModal';
import {
  SpeciesDistributionSheet,
  type InatGridSelection,
} from '~/components/SpeciesDistributionSheet';
import { ScientificName } from '~/components/ScientificName';
import {
  INAT_GRID_LAYER,
  gridPrecisionOffset,
  gridTileUrl,
  tileZoomForRegion,
} from '~/lib/inatHeatmap';
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
import { trackLengthMeters } from '~/lib/track';
import { getSite as getMirenSite, setSiteClearance } from '~/modules/miren/db';
import { ROAD_CLEARANCE_M } from '~/modules/miren/model/planner';
import { MapFeatureCard, type MapFeatureInfo } from '~/components/MapFeatureCard';
import {
  clusterPoints,
  clusterRegion,
  clusterSplits,
  type ClusterPoint,
  type PointCluster,
} from '~/lib/mapCluster';
import { SITE_TYPE_LABEL } from '~/lib/siteLabels';
import { basemapToMapType } from '~/lib/basemap';
import { MapCanvas } from '~/components/map/MapCanvas';
import {
  MAPLIBRE_COMPASS_SIZE,
  NORTH_ARROW_SIZE,
  type LatLng,
  type MapCamera,
  type MapFeature,
  type Region,
} from '~/components/map/types';
import { MapScaleBar } from '~/components/MapScaleBar';
import { PoiGroupSheet } from '~/components/PoiGroupSheet';
import {
  getPoiDb,
  parsePoiTags,
  poiDisplayName,
  queryPoisInBounds,
  type RudyPoi,
} from '~/db/rudypoi';
import { describeVectorInstall, vectorStyleUri } from '~/lib/vectormap';
import { useVectorInstall } from '~/lib/vectormapInstall';
import { useTabBarInset } from '~/lib/tabBarLayout';
import { useThemeColors } from '~/theme/colors';
import { resolveLanguage } from '~/i18n';
import { useSettings, type MapBasemap } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { ACTION_FILL } from '~/lib/colors';
import { IconDisc } from '~/components/ui/IconDisc';
import { getFwSurvey, updateSurvey } from '~/survey/db/surveys';
import type { FwSurveyRow } from '~/survey/db/surveyCore';

/** What a cluster member stands for, so a bubble can list its records. */
type ClusterFeature =
  | { kind: 'plot'; plot: PlotSurveyWithMeta }
  | { kind: 'session'; session: SessionWithStats }
  | { kind: 'site'; site: SiteWithProject };

/**
 * Basemap menu. **No mapType here** — that mapping lives once in
 * `basemapToMapType()` in `src/lib/basemap.ts`; a second copy used to live here
 * and was a source of duplication.
 */
const BASEMAP_OPTIONS: {
  value: MapBasemap;
  labelKey: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { value: 'standard', labelKey: 'map.basemapStandard', icon: 'map-outline' },
  { value: 'satellite', labelKey: 'map.basemapSatellite', icon: 'globe-outline' },
  { value: 'hybrid', labelKey: 'map.basemapHybrid', icon: 'layers-outline' },
  { value: 'terrain', labelKey: 'map.basemapTerrain', icon: 'trail-sign-outline' },
  // The vector RudyMap. Always available online (reading the remote pmtiles
  // directly); once the offline package is installed it reads one local file.
  // The label tracks offline state, see basemapLabelKey().
  { value: 'vector', labelKey: 'map.basemapRudyVector', icon: 'triangle-outline' },
];

/** Landmarks are only queried when close enough. The `LIKE` tag filter does not
 *  use an index, so a wide viewport explodes the candidate set (measured: 3.6 s
 *  for all of Taiwan). 0.15 degrees is roughly z12. */
const POI_MAX_DELTA = 0.15;
/** Per-query cap. A single z14 viewport over Taipei already holds 40,000 raw
 *  POIs. */
const POI_LIMIT = 300;

/** Online vector style. Swapped for a local file:// path once the offline
 *  package is installed. */
const VECTOR_STYLE_URL = 'https://map.mitalivana.org/vector/latest/style.json';

const SINICA_TILE_URL =
  'https://gis.sinica.edu.tw/tileserver/file-exists.php?img={LAYER}-png-{z}-{x}-{y}';
// NLSC WMTS RESTful — note the WMTS tile order is z/y/x (TileMatrix/Row/Col).
const NLSC_TILE_URL =
  'https://wmts.nlsc.gov.tw/wmts/{LAYER}/default/GoogleMapsCompatible/{z}/{y}/{x}';

/** Deliberately not one of the record colours: a bubble is not a plot survey or
 *  a checklist, it is a stand-in for several of them. */
const CLUSTER_COLOR = '#4f46e5';

// A standalone place — drawn or imported by hand, owned by no record. Records
// wear teal / cyan (PLOT_COLOR / SESSION_COLOR below); this yellow-green is
// reserved for "nobody's record, just a place".
const SITE_COLOR = '#74AB00';
const SITE_FILL = 'rgba(116, 171, 0, 0.18)';
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

/** bbox → the four corners needed to draw it as a polygon. */
function bboxCorners(b: BBox): LatLng[] {
  return [
    { latitude: b.swLat, longitude: b.swLng },
    { latitude: b.swLat, longitude: b.neLng },
    { latitude: b.neLat, longitude: b.neLng },
    { latitude: b.neLat, longitude: b.swLng },
  ];
}
const DRAW_FILL = 'rgba(220, 38, 38, 0.18)';
// Plot survey overlay. Teal, the pre-redesign UI accent, kept as a map data
// colour; matches RECORD_TINT on 地理樣區管理's 樣區 rows (app/sites.tsx).
const PLOT_COLOR = '#00A2A5'; // teal — done plots
const PLOT_ACTIVE_COLOR = '#db2777'; // magenta — the single active plot
const PLOT_FILL = 'rgba(0, 162, 165, 0.15)'; // point_count radius circle
// Session (checklist) overlay.
const SESSION_COLOR = '#0891b2'; // cyan — done sessions
const SESSION_ACTIVE_COLOR = '#10b981'; // green — the active session
const SESSION_FILL = 'rgba(8, 145, 178, 0.15)'; // a 名錄's boundary polygon

/** Soft cap above which editing a track segment warns about map jank. */
const TRACK_EDIT_WARN_POINTS = 200;

const PLOT_TYPE_LABEL: Record<string, string> = {
  fixed: 'map.plotFixed',
  transect: 'map.plotTransect',
  point_count: 'map.plotPointCount',
};

function basemapMeta(b: MapBasemap): (typeof BASEMAP_OPTIONS)[number] {
  return BASEMAP_OPTIONS.find((o) => o.value === b) ?? BASEMAP_OPTIONS[0];
}

/**
 * Display label for a basemap.
 *
 * Only the vector one is dynamic: "RudyMap" online, "RudyMap (offline)" once the
 * offline package is installed — what the user cares about is whether this map
 * needs the network right now, not how it is rendered.
 */
function basemapLabelKey(o: (typeof BASEMAP_OPTIONS)[number], vectorReady: boolean): string {
  if (o.value === 'vector' && vectorReady) return 'map.basemapRudyVectorOffline';
  return o.labelKey;
}

/** Length of a measured polyline in metres — the app's one haversine (lib/track). */
function measuredMeters(points: LatLng[]): number {
  return trackLengthMeters([points.map((p) => [p.longitude, p.latitude] as [number, number])]);
}

export default function MapScreen() {
  const tc = useThemeColors();
  const { t } = useTranslation();
  const { overlayIcon, accent: overlayAccent, ink3: muted } = useThemeColors();
  const initial = useSettings((s) => s.map_view);
  const setSetting = useSettings((s) => s.set);
  const settingsLoaded = useSettings((s) => s.loaded);
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const toast = useToast((s) => s.show);
  const router = useRouter();
  // A tab screen stays mounted after its first visit, so an unconditional
  // showsUserLocation kept GNSS running on every other tab too.
  const isFocused = useIsFocused();
  const params = useLocalSearchParams<{
    draw?: string;
    session?: string;
    favoriteArea?: string;
    site?: string;
    plot?: string;
    /** MIREN site id: measure from its planned point, then offer to record the distance. */
    measureSite?: string;
    /** A checklist / plot-style survey (2G-b): its place, or a plot-style one's boundary. */
    survey?: string;
  }>();
  /** When set, after saving the next drawn site we bind it to this session and bounce back. */
  const handoffSessionId = useRef<number | null>(null);
  /** Same for a plot boundary: the plot to bind to, plus its current boundary
   *  (non-null = redrawing an existing one, which updates that row in place). */
  const [plotHandoff, setPlotHandoff] = useState<{ plot: PlotSurvey; site: Site | null } | null>(
    null,
  );
  /** A checklist / plot-style survey to bind the drawn site to (2G-b): a
   *  plot-style one's boundary is redrawn in place like a plot's; a
   *  checklist-style one gets a new site, like 快速名錄. */
  const [surveyHandoff, setSurveyHandoff] = useState<{ survey: FwSurveyRow; site: Site | null } | null>(null);
  const activeSession = useActiveSession((s) => s.session);
  /**
   * Which session's species points are drawn.
   *
   * One session at a time, deliberately. These markers are per OBSERVATION and
   * are not clustered (the clustering upstream works on whole records — one
   * point per session / plot / site), so every session at once would be
   * thousands of pins.
   *
   * Null = follow whatever is being recorded, which is the right default while
   * surveying. Tapping any session marker pins it here instead, so a finished
   * session — the one you just imported photos into — can be looked at too.
   */
  const [pointsSessionId, setPointsSessionId] = useState<number | null>(null);
  const shownSessionId = pointsSessionId ?? activeSession?.id ?? null;
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
  const [poiGroups, setPoiGroups] = useState<string[]>(initial.poi_groups);
  /**
   * Mountain landmarks come from RudyMap, which covers Taiwan only, so the
   * feature is offered only to the Traditional Chinese UI.
   *
   * Resolved, not the raw setting: 'system' is a legitimate value and a device
   * in zh-TW must still get the landmarks.
   */
  const uiLanguage = useSettings((s) => s.language);
  const poiAvailable = resolveLanguage(uiLanguage) === 'zh-TW';
  const [poiSheetOpen, setPoiSheetOpen] = useState(false);
  /**
   * The taxon whose iNaturalist observation grid is drawn, and its sheet.
   *
   * Deliberately NOT persisted with the rest of the map view: every tile is a
   * network request, and a layer that silently resumes downloading on the next
   * launch is not something to decide for a user with one bar of signal. It is
   * picked when it is wanted.
   */
  const [inatGrid, setInatGrid] = useState<InatGridSelection | null>(null);
  const [distSheetOpen, setDistSheetOpen] = useState(false);
  const [pois, setPois] = useState<RudyPoi[]>([]);

  const tabBarInset = useTabBarInset();
  const vectorInstalled = useVectorInstall((s) => s.installed);
  const vectorReady = useVectorInstall((s) => s.ready);
  const vectorStyleRev = useVectorInstall((s) => s.styleRev);
  // When the tile package is deleted, currentBasemap is **deliberately not**
  // rewritten back to standard: after reinstalling, the user returns to the
  // RudyMap they had chosen instead of finding their setting quietly changed.
  const vectorOn = currentBasemap === 'vector';
  /**
   * With the offline package installed, read the local copy (its source points at
   * pmtiles://file://…); otherwise go remote.
   *
   * The path is recomputed rather than taken from `installed.styleUri`: that is
   * the absolute path at install time, and the iOS app container UUID changes
   * after a reinstall, leaving the old path pointing at a file that is not there.
   */
  const vectorStyle = vectorOn
    ? vectorReady && vectorInstalled
      ? vectorStyleUri()
      : VECTOR_STYLE_URL
    : undefined;

  useEffect(() => {
    if (!vectorStyle) return;
    // When the map will not load, MapLibre only throws a reasonless "loading style
    // failed", so whatever can be determined is printed here first.
    console.log('[vectormap] style', vectorStyle, JSON.stringify(describeVectorInstall()));
  }, [vectorStyle, vectorStyleRev]);

  // Drawing UI only produces simple types; Multi* arrive via import (KML/GPX).
  const [drawMode, setDrawMode] = useState<'Point' | 'LineString' | 'Polygon' | null>(null);
  const [drawPoints, setDrawPoints] = useState<LatLng[]>([]);
  /** What the current drawing is FOR. 'site' saves a geographic site; 'species'
   *  queries iNaturalist for what has been observed inside it. Same gesture, two
   *  terminuses — the alternative was a second drawing implementation. */
  const [drawPurpose, setDrawPurpose] = useState<'site' | 'species' | 'favoriteArea' | 'measure'>('site');
  /** The MIREN site a measurement is recorded to (Road protocol §2.3 a: the
   *  farthest plot end ≥ 100 m from all roads), when handed off from a site. */
  const measureSiteId = useRef<number | null>(null);
  /** Which favourite folder's area is being redrawn, when handed off from
   *  favourites. */
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

  // Landmark queries follow viewRegion (once per gesture), the same granularity
  // as point clustering.
  // Too far out and nothing is queried: the tag LIKE filter does not use an
  // index, so a wide viewport is slow.
  useEffect(() => {
    // Gated here too, not just on the menu row: a user who had landmarks on and
    // then switched language would otherwise be left with pins on the map and
    // no entry point left to turn them off.
    if (!poiAvailable || poiGroups.length === 0 || viewRegion.longitudeDelta > POI_MAX_DELTA) {
      setPois((prev) => (prev.length ? [] : prev));
      return;
    }
    if (!getPoiDb()) return;
    try {
      setPois(
        queryPoisInBounds(
          {
            minLat: viewRegion.latitude - viewRegion.latitudeDelta / 2,
            maxLat: viewRegion.latitude + viewRegion.latitudeDelta / 2,
            minLon: viewRegion.longitude - viewRegion.longitudeDelta / 2,
            maxLon: viewRegion.longitude + viewRegion.longitudeDelta / 2,
          },
          poiGroups,
          POI_LIMIT,
        ),
      );
    } catch (e) {
      // Reached when the tile package was just deleted, or the DB is not ready yet.
      // Landmarks are a bonus; failing to find them must not break the whole map
      // screen.
      if (__DEV__) console.warn('[poi] query failed', e);
      setPois([]);
    }
  }, [viewRegion, poiGroups, poiAvailable]);
  /** The tapped feature's details; the action button on the card opens the action
   *  sheet. */
  const [info, setInfo] = useState<MapFeatureInfo | null>(null);

  const mapRef = useRef<MapCamera>(null);
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
      setActiveRecords(shownSessionId ? listSessionRecords(shownSessionId) : []);
    }, [reloadSites, reloadPlots, reloadSessions, shownSessionId]),
  );

  // Switching sessions happens while the screen is already focused, so the
  // focus effect above would not see it.
  useEffect(() => {
    setActiveRecords(shownSessionId ? listSessionRecords(shownSessionId) : []);
  }, [shownSessionId]);

  // Starting or resuming a recording pulls the map back to it. Otherwise a
  // session tapped earlier would keep the view while the one actually being
  // surveyed drew nothing — the opposite of what the default is for.
  useEffect(() => {
    setPointsSessionId(null);
  }, [activeSession?.id]);

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
    const measureParam = params.measureSite;
    const surveyParam = params.survey;
    if (!drawParam && !sessionParam && !favParam && !siteParam && !plotParam && !measureParam && !surveyParam) return;

    if (typeof measureParam === 'string') {
      const msid = parseInt(measureParam, 10);
      const ms = Number.isNaN(msid) ? null : getMirenSite(msid);
      if (ms) {
        measureSiteId.current = ms.id;
        const start = ms.planned_lat != null && ms.planned_lon != null ? { latitude: ms.planned_lat, longitude: ms.planned_lon } : null;
        if (start) focusRegion({ ...start, latitudeDelta: 0.004, longitudeDelta: 0.004 });
        startDraw('LineString', 'measure');
        if (start) setDrawPoints([start]);
      }
    }

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

    // Plot boundary handoff: centre on the existing boundary if there is one,
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

    // A survey's place: centred like a plot's boundary (its place, else its position).
    let surveyTarget: { survey: FwSurveyRow; site: Site | null } | null = null;
    if (typeof surveyParam === 'string') {
      const id = parseInt(surveyParam, 10);
      const survey = Number.isNaN(id) ? null : getFwSurvey(id);
      if (survey) {
        const bound = survey.site_id !== null ? (getSite(survey.site_id) ?? null) : null;
        surveyTarget = { survey, site: bound };
        let region: Region | null = null;
        if (bound) {
          try {
            region = geometryBounds(parseGeometry(bound));
          } catch {
            region = null;
          }
        }
        if (!region && survey.lat != null && survey.lng != null) region = { latitude: survey.lat, longitude: survey.lng, latitudeDelta: 0.004, longitudeDelta: 0.004 };
        if (region) focusRegion(region);
      }
    }

    if (drawParam === 'Point' || drawParam === 'LineString' || drawParam === 'Polygon') {
      if (plotTarget) setPlotHandoff(plotTarget);
      if (surveyTarget) setSurveyHandoff(surveyTarget);
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
      measureSite: undefined,
      survey: undefined,
    });
  }, [
    params.draw,
    params.session,
    params.favoriteArea,
    params.site,
    params.plot,
    params.measureSite,
    params.survey,
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
      poi_groups: poiGroups,
    });
  }, [currentBasemap, sinicaLayer, sinicaOpacity, nlscLayer, nlscOpacity, poiGroups, setSetting]);

  // Precompute transect track projection once per plots load (not per render /
  // map pan) — JSON parse + lng/lat swap is the costly part with many plots.
  /** site id → the plot whose boundary it is, so the map can say so. */
  const plotBySiteId = useMemo(
    () => new Map(plots.filter((p) => p.site_id !== null).map((p) => [p.site_id as number, p])),
    [plots],
  );

  /**
   * site id → the 名錄 holding it.
   *
   * Same reason as `plotBySiteId`: a record's shape wears its record's colour.
   * Without this a 名錄's boundary would draw in the standalone yellow-green,
   * which is the one thing that colour is supposed to rule out.
   */
  const sessionBySiteId = useMemo(
    () => new Map(sessions.filter((x) => x.site_id !== null).map((x) => [x.site_id as number, x])),
    [sessions],
  );

  /**
   * A 名錄 whose records all lack coordinates draws nothing, and an empty map
   * looks exactly like "this 名錄 has no records". Say which one it is.
   *
   * Only when there ARE records — zero records genuinely has nothing to say,
   * and the session list already shows the count.
   */
  const shownSessionNoCoords = useMemo(() => {
    if (shownSessionId == null || activeRecords.length === 0) return null;
    if (activeRecords.some((r) => r.lat !== null && r.lng !== null)) return null;
    // No count in the message on purpose: i18next reserves `count` for
    // pluralisation, and the number adds nothing the record list doesn't show.
    return { name: sessions.find((s) => s.id === shownSessionId)?.name ?? '' };
  }, [shownSessionId, activeRecords, sessions]);

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
   * One point per record. A plot survey with a boundary contributes once, not
   * twice: the plot already stands for that record, and counting its site as well
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
        poi_groups: poiGroups,
      });
    }, 600);
  };

  const handleLocateMe = async () => {
    setToolsOpen(false);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
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
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  const handlePickBasemap = async () => {
    setToolsOpen(false);
    const options = BASEMAP_OPTIONS;
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
    purpose: 'site' | 'species' | 'measure' = 'site',
  ) => {
    setDrawMode(mode);
    setDrawPurpose(purpose);
    setDrawPoints([]);
    toast(
      purpose === 'measure'
        ? t('map.measureHint')
        : purpose === 'species'
        ? t('areaSpecies.drawHint')
        : mode === 'Point'
          ? t('map.drawTapPoint')
          : mode === 'LineString'
            ? t('map.drawTapLine')
            : t('map.drawTapPolygon'),
    );
  };

  /** Query the area currently on screen, with no drawing step at all. */
  /**
   * Area tab → the full-screen area-species modal.
   *
   * The wait is not decoration: iOS will not present a modal while another is
   * still dismissing, and the panel is a modal. Without it the query screen
   * silently never appears. 450 ms covers the fade-out — the same figure the
   * export overlay uses before handing off to the share sheet.
   */
  const handleAreaFromVisible = async () => {
    setDistSheetOpen(false);
    await new Promise((r) => setTimeout(r, 450));
    searchVisibleArea();
  };

  const searchVisibleArea = () => {
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
    measureSiteId.current = null;
    setPlotHandoff(null);
    setSurveyHandoff(null);
  };

  const handleMapPress = (coord: LatLng) => {
    // Tapping bare map dismisses the feature card — the same gesture that
    // opened it should be able to put it away.
    if (info) setInfo(null);
    if (!drawMode) return;
    if (drawMode === 'Point') {
      setDrawPoints([coord]);
      setSaveSiteOpen(true);
    } else {
      setDrawPoints((prev) => [...prev, coord]);
    }
  };

  const finishDraw = () => {
    if (!drawMode) return;
    if (drawPurpose === 'measure') {
      if (drawPoints.length < 2) {
        toast(t('map.lineNeed2'));
        return;
      }
      const meters = measuredMeters(drawPoints);
      const siteId = measureSiteId.current;
      const shown = `${Math.round(meters)} m`;
      if (siteId == null) {
        Alert.alert(t('map.measure'), t('map.measureResult', { d: shown }), [{ text: t('common.ok'), onPress: cancelDraw }]);
        return;
      }
      Alert.alert(
        t('map.measure'),
        t(meters >= ROAD_CLEARANCE_M ? 'map.measureRecord' : 'map.measureRecordShort', { d: shown, m: ROAD_CLEARANCE_M }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('map.measureSave'),
            onPress: () => {
              setSiteClearance(siteId, meters);
              cancelDraw();
              // Not router.back(): the map is in the (tabs) group, below the site
              // screen in the root stack (same as the favourites area handoff).
              router.navigate(`/miren/site/${siteId}` as Href);
            },
          },
        ],
      );
      return;
    }
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

    // A checklist / plot-style survey: a plot-style one's boundary is redrawn in
    // place when the survey is its only owner (as a plot's); a checklist-style
    // one gets a new site each time (as 快速名錄).
    if (surveyHandoff) {
      const { survey } = surveyHandoff;
      const existing = surveyHandoff.site ? getSite(surveyHandoff.site.id) : null;
      let siteId: number;
      if (survey.style === 'plot' && existing && countSiteReferences(existing.id) <= 1) {
        updateSite(existing.id, { ...data, geometry_type: geometry.type, geometry_geojson: JSON.stringify(geometry) });
        siteId = existing.id;
      } else {
        siteId = createSite({ ...data, geometry, session_id: null });
      }
      updateSurvey(survey.id, { siteId });
      cancelDraw();
      setSaveSiteOpen(false);
      reloadSites();
      toast(t(survey.style === 'plot' ? 'map.boundPlotSite' : 'map.boundSite'));
      router.replace(`/survey/form/${survey.id}` as Href);
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
        ? // A plot boundary is deleted from the plot, not from under it: doing it
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
    // Tapping a session is also how you ask to see its points.
    setPointsSessionId(session.id);
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
      // Matches the stroke the same site is drawn with, so the card reads as
      // belonging to the shape that was tapped.
      accentColor: owner
        ? owner.status === 'active'
          ? PLOT_ACTIVE_COLOR
          : PLOT_COLOR
        : sessionBySiteId.has(site.id)
          ? sessionBySiteId.get(site.id)?.status === 'active'
            ? SESSION_ACTIVE_COLOR
            : SESSION_COLOR
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
          setDrawPoints([{ latitude: plot.decimal_latitude, longitude: plot.decimal_longitude }]);
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
      toast(t('map.searchFailed', { error: errText(e) }));
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

  /**
   * 所有要畫在地圖上的圖徵，攤平成引擎中性的陣列。
   *
   * **陣列順序就是掛載順序**，而 iOS 的疊圖先後只看掛載順序（zIndex 在
   * react-native-maps 的 tile overlay 上無效）。所以這裡的排列必須與重構前的
   * JSX 順序逐項相同，不要「順手」重排。
   *
   * zIndex「未指定」也有語意 —— site 與所有繪製中的圖徵本來就沒有指定，
   * 補一個預設值會改變層序。
   */
  const mapFeatures: MapFeature[] = [
    // 山域地標（魯地圖 POI）。zIndex 最低 —— 它是背景參考資訊，不該蓋住使用者的記錄。
    ...pois.map((poi) => {
      const tags = parsePoiTags(poi.data);
      const name = poiDisplayName(tags);
      const ele = tags.ele ? `${Math.round(Number(tags.ele))} m` : undefined;
      return {
        kind: 'marker' as const,
        id: `poi-${poi.id}`,
        lat: poi.lat,
        lng: poi.lon,
        title: name ?? t('poi.title'),
        description: [ele, tags.description].filter(Boolean).join('  ') || undefined,
        color: '#0ea5e9',
        opacity: 0.9,
        zIndex: 1,
      };
    }),

    // 名錄 session：軌跡 + 起點。進行中的那筆是綠色；它的逐筆物種點另外畫。
    ...sessionRenderItems.flatMap(({ session, segments }) => {
      if (hiddenKeys.has(`sess-${session.id}`)) return [];
      const isActive = activeSession?.id === session.id;
      const color = isActive ? SESSION_ACTIVE_COLOR : SESSION_COLOR;
      const out: MapFeature[] = segments
        .filter((seg) => seg.length >= 2)
        .map((seg, i) => ({
          kind: 'line' as const,
          id: `sess-${session.id}-${i}`,
          coords: seg,
          color,
          width: 4,
          zIndex: 2,
          onPress: () => openSessionInfo(session),
        }));
      if (session.start_lat !== null && session.start_lng !== null) {
        out.push({
          kind: 'marker',
          id: `sess-m-${session.id}`,
          lat: session.start_lat,
          lng: session.start_lng,
          title: session.name || t('map.sessionMarkerTitle', { id: session.id }),
          description: t('map.sessionDesc', { count: session.record_count }),
          color,
          zIndex: 3,
          onPress: () => openSessionInfo(session),
        });
      }
      return out;
    }),

    ...activeRecords
      .filter((r) => r.lat !== null && r.lng !== null)
      .map((r) => ({
        kind: 'marker' as const,
        id: `rec-${r.id}`,
        lat: r.lat as number,
        lng: r.lng as number,
        title: r.common_name_c || r.simple_name,
        description: r.family_c,
        color: '#f59e0b',
        zIndex: 4,
      })),

    // 既有地理樣區 —— Multi* geometry 會展開成多個 primitive
    ...siteRenderItems.flatMap(({ site: s, primitives }) => {
      // 綁在樣區上的 site 就是那個樣區的邊界，所以穿樣區的顏色 —— 否則藍色形狀
      // 圍著紫色圖釘，卻沒有任何東西說它們是同一筆記錄。
      const owner = plotBySiteId.get(s.id);
      // 邊界跟著它的擁有者一起聚合，因為兩者代表的是同一筆記錄。
      if (hiddenKeys.has(owner ? `plot-${owner.id}` : `site-${s.id}`)) return [];
      const sessionOwner = owner ? null : sessionBySiteId.get(s.id);
      const stroke = owner
        ? owner.status === 'active'
          ? PLOT_ACTIVE_COLOR
          : PLOT_COLOR
        : sessionOwner
          ? sessionOwner.status === 'active'
            ? SESSION_ACTIVE_COLOR
            : SESSION_COLOR
          : SITE_COLOR;
      const fill = owner ? PLOT_FILL : sessionOwner ? SESSION_FILL : SITE_FILL;
      return primitives.map((prim, i): MapFeature => {
        const id = `s-${s.id}-${i}`;
        if (prim.kind === 'point') {
          return {
            kind: 'marker',
            id,
            lat: prim.latitude,
            lng: prim.longitude,
            title: s.name,
            description: s.project_name,
            color: stroke,
            onPress: () => openSiteInfo(s),
          };
        }
        if (prim.kind === 'line') {
          return {
            kind: 'line',
            id,
            coords: prim.coords,
            color: stroke,
            width: 3,
            onPress: () => openSiteInfo(s),
          };
        }
        return {
          kind: 'polygon',
          id,
          coords: prim.coords,
          stroke,
          fill,
          width: 2,
          onPress: () => openSiteInfo(s),
        };
      });
    }),

    // 既有樣區 —— fixed/point_count 圖釘（+ 半徑圓）、穿越線軌跡。
    // 編輯中的那個樣區在這裡隱藏，由下面可拖曳的圖釘接手。
    ...plotRenderItems.flatMap(({ plot, segments }): MapFeature[] => {
      if (editPlot && editPlot.id === plot.id) return [];
      if (hiddenKeys.has(`plot-${plot.id}`)) return [];
      const color = plot.status === 'active' ? PLOT_ACTIVE_COLOR : PLOT_COLOR;
      if (usesTrack(plot)) {
        const drawable = segments.filter((seg) => seg.length >= 2);
        // 軌跡還沒開始、只有一個定位點、或被清掉的穿越線在這裡沒東西可畫 ——
        // 而提早 return 會讓整個樣區從地圖上消失，即使它有中心點。這很常見不是
        // 邊界情況：recorder 會把第一個定位寫進 decimal_latitude/longitude，
        // 所以剛開始的穿越線一定有中心點和一個單點 segment。往下走到圖釘。
        if (drawable.length > 0) {
          return drawable.map((seg, i) => ({
            kind: 'line' as const,
            id: `plot-${plot.id}-${i}`,
            coords: seg,
            color,
            width: 4,
            zIndex: 5,
            onPress: () => openPlotInfo(plot),
          }));
        }
      }
      if (plot.decimal_latitude === null || plot.decimal_longitude === null) return [];
      const out: MapFeature[] = [];
      if (plot.plot_type === 'point_count' && plot.point_radius_m && plot.point_radius_m > 0) {
        out.push({
          kind: 'circle',
          id: `plot-c-${plot.id}`,
          lat: plot.decimal_latitude,
          lng: plot.decimal_longitude,
          radiusM: plot.point_radius_m,
          stroke: color,
          fill: PLOT_FILL,
          width: 2,
          zIndex: 4,
        });
      }
      out.push({
        kind: 'marker',
        id: `plot-m-${plot.id}`,
        lat: plot.decimal_latitude,
        lng: plot.decimal_longitude,
        color,
        title: plot.plotid || t('map.plotMenuTitle', { id: plot.id }),
        description:
          t('map.plotDesc', {
            type: PLOT_TYPE_LABEL[plot.plot_type]
              ? t(PLOT_TYPE_LABEL[plot.plot_type])
              : plot.plot_type,
            count: plot.species_count,
          }) + (usesTrack(plot) ? ` · ${t('map.trackNotYet')}` : ''),
        zIndex: 5,
        onPress: () => openPlotInfo(plot),
      });
      return out;
    }),

    // 每個擁擠格子一個泡泡；它代表的圖徵在上面被跳過。
    //
    // 聚合在所有模式下都保持開啟。繪製或編輯時關掉它，等於一次 session 內把整組
    // marker 換掉兩次 —— 每個被聚合的記錄進入時各自掛載成一個 annotation、離開時
    // 再全部卸載 —— 那是一次點擊要付的大量原生工作。只拿掉 press handler，讓點擊
    // 穿透到地圖去放頂點。
    ...clusters.map(
      (c): MapFeature => ({
        kind: 'marker',
        id: c.key,
        lat: c.latitude,
        lng: c.longitude,
        anchor: { x: 0.5, y: 0.5 },
        zIndex: 6,
        renderKey: c.memberKeys.length,
        render: () => <ClusterBubble count={c.memberKeys.length} />,
        onPress:
          drawMode || editMode
            ? undefined
            : () => {
                const target = clusterRegion(c);
                if (clusterSplits(c, { ...target, width: windowWidth, height: windowHeight })) {
                  mapRef.current?.animateToRegion(target, 350);
                } else {
                  void openClusterMembers(c);
                }
              },
      }),
    ),

    // 繪製中 —— 頂點可拖曳；點一下刪除
    ...((drawMode || editMode) && drawPoints.length > 0
      ? drawPoints.map(
          (pt, i): MapFeature => ({
            kind: 'marker',
            id: `d-${i}`,
            lat: pt.latitude,
            lng: pt.longitude,
            color: DRAW_COLOR,
            anchor: { x: 0.5, y: 0.5 },
            draggable: true,
            onDragEnd: (coord) => {
              const next = [...drawPoints];
              next[i] = coord;
              setDrawPoints(next);
            },
            onPress: () => {
              // 編輯樣區的單一點位：只能拖，不能刪。
              if (editMode === 'point') return;
              Alert.alert(t('map.editPointTitle'), t('map.pointN', { n: i + 1 }), [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('map.deletePoint'),
                  style: 'destructive',
                  onPress: () => setDrawPoints(drawPoints.filter((_, idx) => idx !== i)),
                },
              ]);
            },
          }),
        )
      : []),

    ...((drawMode === 'LineString' || editMode === 'track') && drawPoints.length >= 2
      ? [
          {
            kind: 'line' as const,
            id: 'draw-line',
            coords: drawPoints,
            color: DRAW_COLOR,
            width: 3,
          },
        ]
      : []),

    ...(drawMode === 'Polygon' && drawPurpose === 'site' && drawPoints.length >= 3
      ? [
          {
            kind: 'polygon' as const,
            id: 'draw-poly',
            coords: drawPoints,
            stroke: DRAW_COLOR,
            fill: DRAW_FILL,
            width: 2,
          },
        ]
      : []),

    // 物種查詢：兩種形狀都要畫，因為兩個來源用的不一樣 —— 填色的框是問
    // iNaturalist 的範圍，外框線是問 GBIF 的範圍。只畫一個會誤導使用者
    // 之後選了哪個來源。
    ...(drawPurpose === 'species' && drawPoints.length >= 2
      ? [
          {
            kind: 'polygon' as const,
            id: 'area-bbox',
            coords: bboxCorners(bboxOf(drawPoints)),
            stroke: AREA_COLOR,
            fill: AREA_FILL,
            width: 1,
          },
        ]
      : []),

    ...((drawPurpose === 'species' || drawPurpose === 'favoriteArea') && drawPoints.length >= 3
      ? [
          {
            kind: 'polygon' as const,
            id: 'area-outline',
            coords: drawPoints,
            stroke: AREA_COLOR,
            fill: 'transparent',
            width: 3,
          },
        ]
      : []),
  ];

  /**
   * iNaturalist grid tiles for the current view.
   *
   * The zoom only picks how coarse the cells are, and it is bucketed to two
   * values (see `gridPrecisionOffset`), so the URL — and with it every loaded
   * tile — changes at one threshold rather than on every pinch.
   */
  const inatTileUrl = inatGrid
    ? gridTileUrl(
        inatGrid.inatTaxonId,
        inatGrid.mode,
        gridPrecisionOffset(tileZoomForRegion(viewRegion.longitudeDelta, windowWidth)),
      )
    : null;

  return (
    <View className="flex-1 bg-gray-100 dark:bg-gray-800">
      <MapCanvas
        // 樣式只在掛載時讀一次，換版後要重掛才看得到（styleUri 字串不變）。
        key={`map-${vectorStyleRev}`}
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude: initial.latitude,
          longitude: initial.longitude,
          latitudeDelta: initial.latitudeDelta,
          longitudeDelta: initial.longitudeDelta,
        }}
        engine={vectorOn ? 'vector' : 'native'}
        vectorStyle={vectorStyle}
        mapType={basemapToMapType(currentBasemap)}
        showsCompass
        // 右下角是唯一沒被佔用的角落（左上返回／搜尋、右上工具、左下比例尺）
        compassInset={{ bottom: tabBarInset + 12, right: 12 }}
        showsScale
        showsUserLocation={isFocused}
        showsMyLocationButton={false}
        onMapReady={() => setMapReady(true)}
        onRegionChangeComplete={handleRegionChangeComplete}
        onPress={handleMapPress}
        features={mapFeatures}
        rasterOverlays={[
          ...(nlscLayer
            ? [
                {
                  id: 'nlsc',
                  urlTemplate: NLSC_TILE_URL.replace('{LAYER}', nlscLayer),
                  opacity: nlscOpacity,
                  zIndex: 1,
                  maxZoom: 20,
                },
              ]
            : []),
          ...(sinicaLayer
            ? [
                {
                  id: 'sinica',
                  urlTemplate: SINICA_TILE_URL.replace('{LAYER}', sinicaLayer),
                  opacity: sinicaOpacity,
                  zIndex: 2,
                  maxZoom: 19,
                },
              ]
            : []),
          ...(inatTileUrl ? [{ ...INAT_GRID_LAYER, urlTemplate: inatTileUrl }] : []),
        ]}
        // 切底圖時強制疊圖重新掛載，讓它們重新加到離線圖磚之上
        // （iOS 的疊圖先後只看掛載順序）。
        overlayGeneration={currentBasemap}
      />

      <PoiGroupSheet
        visible={poiSheetOpen}
        enabled={poiGroups}
        available={getPoiDb() != null}
        onToggle={(key) =>
          setPoiGroups((prev) =>
            prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
          )
        }
        onClose={() => setPoiSheetOpen(false)}
      />

      {/* 比例尺。不用 <MapView showsScale>：那是 iOS Apple Maps 專用、Android
          不支援，而且只在縮放手勢期間短暫出現。野外判讀距離要常駐。 */}
      <MapScaleBar region={viewRegion} screenWidth={windowWidth} bottom={tabBarInset + 6} />

      {/* Locate, on its own above the compass rather than buried in the tools
          menu: centring on yourself is the one map action taken mid-stride,
          and it belongs next to the other orientation affordance. Icon only —
          the compass beneath it carries no label either.
          The clearance is per engine: the two draw different north pointers and
          MapLibre's is the taller one, so one shared figure covered ours and
          hid RudyMap's. See the constants' note in map/types.ts. */}
      {info && !drawMode && !editMode ? null : (
        <View
          className="absolute right-3"
          style={{
            bottom: tabBarInset + 12 + (vectorOn ? MAPLIBRE_COMPASS_SIZE : NORTH_ARROW_SIZE) + 10,
          }}
        >
          <FabButton icon="locate" onPress={handleLocateMe} accent a11yLabel={t('map.locate')} />
        </View>
      )}

      {/* Loading overlay — shown until MapView fires onMapReady (or 4s fallback) */}
      {!mapReady ? (
        <View
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          className="items-center justify-center bg-gray-100 dark:bg-gray-800/85"
        >
          <ActivityIndicator size="large" color={overlayAccent} />
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
          <View className="flex-row items-center rounded-full bg-card px-3 py-2 shadow-md dark:bg-gray-900/95">
            <View className="-my-2 -ml-2">
              <IconDisc icon="back" onPress={closeSearch} accessibilityLabel={t('common.back')} />
            </View>
            <TextInput
              ref={searchInputRef}
              className="ml-2 flex-1 text-sm text-gray-900 dark:text-gray-100"
              placeholder={t('map.searchPlaceholder')}
              placeholderTextColor={tc.ink3}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={handleSearch}
              autoCorrect={false}
              returnKeyType="search"
              editable={!searchBusy}
            />
            {searchQuery ? (
              <Pressable onPress={() => setSearchQuery('')} hitSlop={6}>
                <Ionicons name="close-circle" size={18} color={muted} />
              </Pressable>
            ) : null}
          </View>
        ) : (
          <FabButton icon="search" onPress={openSearch} a11yLabel={t('map.searchPlaceholder')} />
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
                label={t(basemapLabelKey(basemapMeta(currentBasemap), vectorReady))}
                onPress={handlePickBasemap}
              />
              <FabRow
                icon="albums-outline"
                label={sinicaLayer || nlscLayer ? t('map.layersOverlaid') : t('map.layers')}
                onPress={handleOpenLayers}
                accent={!!sinicaLayer || !!nlscLayer}
              />
              {poiAvailable ? (
                <FabRow
                  icon="navigate-circle-outline"
                  label={t('poi.title')}
                  onPress={() => {
                    setToolsOpen(false);
                    setPoiSheetOpen(true);
                  }}
                  accent={pois.length > 0}
                />
              ) : null}
              <FabRow
                icon="create-outline"
                label={t('map.drawSite')}
                onPress={handlePickDrawMode}
              />
              <FabRow
                icon="resize-outline"
                label={t('map.measure')}
                onPress={() => {
                  setToolsOpen(false);
                  startDraw('LineString', 'measure');
                }}
              />
              <FabRow
                icon={inatGrid ? 'grid' : 'globe-outline'}
                label={t('speciesDist.title')}
                onPress={() => {
                  setToolsOpen(false);
                  setDistSheetOpen(true);
                }}
                accent={!!inatGrid}
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

      {/* What the grid is showing. Not optional: an orange grid with no caption
          is indistinguishable from "this species is not here", and it may not
          even be the name the user searched — see InatGridSheet's header. */}
      {/* Hidden while the tools menu is open: its rows start at this same
          height on the right, and a long species name used to run straight
          under them. The width cap is what is left over — enough for a long
          binomial, short of the right edge. */}
      {inatGrid && !toolsOpen && !drawMode && !editMode && !searchOpen ? (
        <View
          className="absolute left-3"
          style={{ top: insets.top + 60, maxWidth: windowWidth * 0.72 }}
        >
          <View className="flex-row items-center self-start rounded-full bg-card/95 px-3 py-1.5 shadow-md dark:bg-gray-900/95">
            {/* Tapping the pill reopens the picker: it is the only affordance
                that leads back to what this layer is and to searching again. */}
            <Pressable
              className="shrink flex-row items-center"
              onPress={() => setDistSheetOpen(true)}
              accessibilityRole="button"
            >
              <View
                style={{ backgroundColor: '#FF4500', opacity: 0.8, width: 12, height: 12 }}
                className="rounded-[2px]"
              />
              <View className="ml-2 shrink">
                {/* Vernacular and scientific name in ONE Text, so the line
                    ellipsises as a whole ("阿里山山椒魚 Hynobius ari…"). Two
                    sibling Texts in a row cannot: neither one knows it has run
                    out of room, so the name just ran on under the ✕. */}
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  className="text-xs text-gray-700 dark:text-gray-300"
                >
                  {inatGrid.commonName ? (
                    <Text className="font-medium text-gray-900 dark:text-gray-100">
                      {inatGrid.commonName}{' '}
                    </Text>
                  ) : null}
                  <ScientificName name={inatGrid.inatName} rank={inatGrid.rank} />
                </Text>
                <Text numberOfLines={1} className="text-[10px] text-gray-500 dark:text-gray-400">
                  {inatGrid.mode === 'wild'
                    ? t('inatGrid.wild', { count: inatGrid.count })
                    : t('inatGrid.captiveOnly', { count: inatGrid.count })}
                  {inatGrid.askedName
                    ? ` · ${t('inatGrid.viaSynonymShort', { name: inatGrid.askedName })}`
                    : ''}
                </Text>
              </View>
            </Pressable>
            <Pressable onPress={() => setInatGrid(null)} hitSlop={8} className="ml-1">
              <Ionicons name="close-circle" size={18} color={muted} />
            </Pressable>
          </View>
        </View>
      ) : null}

      <SpeciesDistributionSheet
        visible={distSheetOpen}
        current={inatGrid}
        onApply={(sel) => {
          setInatGrid(sel);
          setDistSheetOpen(false);
        }}
        onClear={() => {
          setInatGrid(null);
          setDistSheetOpen(false);
        }}
        onClose={() => setDistSheetOpen(false)}
        onPickVisibleArea={handleAreaFromVisible}
        onDrawArea={() => {
          // Drawing is map state, not another modal, so this one can start the
          // moment the panel is told to close.
          setDistSheetOpen(false);
          startDraw('Polygon', 'species');
        }}
      />

      {/* Drawing toolbar (below search FAB row) */}
      {drawMode ? (
        <View className="absolute left-3 right-3" style={{ top: insets.top + 60 }}>
          <View className="flex-row items-center rounded-full bg-card px-3 py-2 shadow-md dark:bg-gray-900/95">
            <Pressable onPress={cancelDraw} hitSlop={8} className="px-2">
              <Text className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Text className="flex-1 text-center text-xs text-gray-700 dark:text-gray-300">
              {drawPurpose === 'measure'
                ? t('map.measuring', { d: `${Math.round(measuredMeters(drawPoints))} m` })
                : t('map.drawingLabel', {
                    type: t(SITE_TYPE_LABEL[drawMode]),
                    count: drawPoints.length,
                  })}
            </Text>
            {drawPoints.length > 0 ? (
              <Pressable onPress={undoLastPoint} hitSlop={8} className="px-2">
                <Ionicons name="arrow-undo" size={16} color={overlayIcon} />
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
          {surveyHandoff ? (
            <View className="mt-2 rounded-full bg-emerald-500 px-3 py-1.5 shadow-md">
              <Text className="text-center text-xs font-medium text-white">
                {t(surveyHandoff.survey.style === 'plot' ? 'map.plotHandoffHint' : 'map.surveyHandoffHint', {
                  plotid: surveyHandoff.survey.name ?? '',
                  name: surveyHandoff.survey.name ?? '',
                })}
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
          <View className="flex-row items-center rounded-full bg-card px-3 py-2 shadow-md dark:bg-gray-900/95">
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

      {/* "This 名錄 has records, they just have no coordinates." Same slot as the
          two toolbars above, so it is gated on them not being up. */}
      {shownSessionNoCoords && !drawMode && !editMode && !info ? (
        <View className="absolute left-3 right-3" style={{ top: insets.top + 60 }} pointerEvents="none">
          <View className="flex-row items-center rounded-full bg-card px-3 py-2 shadow-md dark:bg-gray-900/95">
            <Ionicons name="information-circle-outline" size={16} color={overlayIcon} />
            <Text className="ml-2 flex-1 text-xs text-gray-700 dark:text-gray-300">
              {t('map.sessionNoCoords', shownSessionNoCoords)}
            </Text>
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
          title={plotHandoff || surveyHandoff?.survey.style === 'plot' ? t('map.saveRangeTitle') : undefined}
          defaultName={
            plotHandoff
              ? (plotHandoff.site?.name ??
                t('map.rangeDefaultName', { plotid: plotHandoff.plot.plotid }))
              : ''
          }
          defaultProjectId={plotHandoff?.plot.project_id ?? surveyHandoff?.survey.project_id ?? 0}
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
 * Cluster 的數字泡泡（只有視覺）。
 *
 * 原本這裡還管著 `tracksViewChanges` 的 true→false 生命週期，那是
 * react-native-maps 專屬的 —— 已經移進 `engines/RNMapsCanvas.tsx`，由引擎依
 * feature 的 `renderKey` 決定何時重新擷取。
 */
function ClusterBubble({ count }: { count: number }) {
  return (
    <View
      className="items-center justify-center rounded-full border-2 border-white shadow"
      style={{
        // 數量越多泡泡略大，讓大群一眼看得出來，但有上限 ——
        // 300 筆的泡泡不能把地圖蓋住。
        width: count >= 100 ? 46 : count >= 10 ? 40 : 34,
        height: count >= 100 ? 46 : count >= 10 ? 40 : 34,
        backgroundColor: CLUSTER_COLOR,
      }}
    >
      <Text className="text-xs font-bold text-white">{count}</Text>
    </View>
  );
}

function FabButton({
  icon,
  onPress,
  accent = false,
  a11yLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  accent?: boolean;
  /** Required in practice for the icon-only buttons: a glyph alone tells a
   *  screen reader nothing. */
  a11yLabel?: string;
}) {
  const { overlayIcon, accent: overlayAccent } = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      className="h-11 w-11 items-center justify-center rounded-full bg-card shadow-md active:bg-gray-100 dark:bg-gray-900/95 dark:active:bg-gray-700"
    >
      <Ionicons name={icon} size={20} color={accent ? overlayAccent : overlayIcon} />
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
  const { overlayIcon, accent: overlayAccent } = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      className="mt-2 flex-row items-center rounded-full bg-card px-3 py-2 shadow-md active:bg-gray-100 dark:bg-gray-900/95 dark:active:bg-gray-700"
    >
      <Text
        className={`mr-2 text-xs font-medium ${accent ? 'text-accent-700 dark:text-accent-300' : 'text-gray-700 dark:text-gray-300'}`}
      >
        {label}
      </Text>
      <Ionicons name={icon} size={18} color={accent ? overlayAccent : overlayIcon} />
    </Pressable>
  );
}
