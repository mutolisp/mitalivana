/**
 * Engine-neutral map interface.
 *
 * Why it exists: the app supports two rendering engines — `react-native-maps`
 * (Apple/Google basemaps online; RudyMap raster tiles offline) and MapLibre
 * (vector, online or offline). They are different native views and **cannot be
 * mixed in one screen**, so the choice is per canvas.
 *
 * The coordinate types are defined here rather than re-exported from
 * `react-native-maps`, which would be an engine-specific dependency. The shapes
 * are structurally identical, so the two interoperate, while nothing above the
 * adapter has to import an engine.
 */
import type { ReactNode } from 'react';

export type LatLng = { latitude: number; longitude: number };
export type Region = LatLng & { latitudeDelta: number; longitudeDelta: number };

/** Native basemap type. Only Android's Google Maps really supports `none`
 *  (iOS's MKMapType enum has no none and falls back to standard). */
export type BaseMapType = 'standard' | 'satellite' | 'hybrid' | 'terrain' | 'none';

export type MapEngine = 'native' | 'vector';

/**
 * One drawable feature.
 *
 * `zIndex` is **optional, and "unspecified" carries meaning** — sites and every
 * in-progress drawing feature in the current code leave it out, and filling in a
 * default would change the stacking order. Do not add one.
 */
export type MapFeature =
  | {
      kind: 'marker';
      id: string;
      lat: number;
      lng: number;
      /** Pin colour; ignored when `render` is given. */
      color?: string;
      title?: string;
      description?: string;
      zIndex?: number;
      opacity?: number;
      anchor?: { x: number; y: number };
      tappable?: boolean;
      draggable?: boolean;
      onPress?: () => void;
      onDragEnd?: (coord: LatLng) => void;
      /** Custom content (a cluster's count bubble). Replaces the default pin. */
      render?: () => ReactNode;
      /**
       * Content identity for `render`. When it changes the engine must re-capture
       * the custom view — react-native-maps' `tracksViewChanges` needs this
       * signal, because a cluster's key only holds the cell coordinates, so
       * markers stay mounted across a pan instead of remounting.
       */
      renderKey?: string | number;
    }
  | {
      kind: 'line';
      id: string;
      coords: LatLng[];
      color: string;
      width: number;
      zIndex?: number;
      onPress?: () => void;
    }
  | {
      kind: 'polygon';
      id: string;
      coords: LatLng[];
      stroke: string;
      fill: string;
      width: number;
      zIndex?: number;
      onPress?: () => void;
    }
  | {
      kind: 'circle';
      id: string;
      lat: number;
      lng: number;
      /** **Metres**, not screen pixels. The MapLibre side has to build its own
 *  geodesic buffer. */
      radiusM: number;
      stroke: string;
      fill: string;
      width: number;
      zIndex?: number;
    };

/** Online WMTS overlay (NLSC / Academia Sinica). */
export type RasterOverlay = {
  id: string;
  urlTemplate: string;
  opacity: number;
  zIndex: number;
  maxZoom: number;
};

/**
 * Vector style source. Only the vector engine looks at it.
 *
 * Either a remote URL (online) or a local `file://` path (the style.json
 * unpacked from the offline package). MapLibre's `mapStyle` also accepts an
 * inline style object, but that style is 600 KB and pushing it across the bridge
 * on every render is not worth it, so this interface takes URLs only.
 */
export type VectorStyle = string;

/**
 * Camera. The whole project uses exactly one method, `animateToRegion` (all 11
 * call sites), so that is all the interface has — no fitToCoordinates, no
 * animateCamera.
 */
export type MapCamera = {
  animateToRegion(region: Region, ms: number): void;
};

export type MapCanvasProps = {
  engine?: MapEngine;
  initialRegion: Region;
  mapType: BaseMapType;
  features: MapFeature[];
  rasterOverlays?: RasterOverlay[];
  /** Style source for the vector engine; required when `engine="vector"`. */
  vectorStyle?: VectorStyle;
  showsUserLocation?: boolean;
  showsCompass?: boolean;
  /**
   * How far the compass sits from the bottom-right corner, in points.
   *
   * Everywhere except the bottom-right is taken: back/search top-left, tools
   * top-right, the scale bar bottom-left. The native engine has no equivalent
   * setting and ignores this.
   */
  compassInset?: { bottom: number; right: number };
  /** iOS Apple Maps only, and only briefly during a zoom gesture; unsupported on
   *  Android. The permanent scale bar is drawn by `MapScaleBar` itself. */
  showsScale?: boolean;
  showsMyLocationButton?: boolean;
  toolbarEnabled?: boolean;
  /** Forces overlays to remount when the basemap changes (on iOS overlay order
 *  follows mount order). */
  overlayGeneration?: string;
  onMapReady?: () => void;
  onRegionChangeComplete?: (region: Region) => void;
  onPress?: (coord: LatLng) => void;
  style?: object;
  children?: ReactNode;
};
