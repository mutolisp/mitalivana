/**
 * 地圖引擎的中性介面。
 *
 * 存在的理由：app 要同時支援兩個算繪引擎 —— `react-native-maps`（Apple/Google
 * 底圖，線上；魯地圖 raster 圖磚，離線）與 MapLibre（向量，線上離線皆可）。
 * 兩者是不同的原生 view，**不能在同一個畫面裡混用**，所以是整個 canvas 二選一。
 *
 * 座標型別刻意自己定義而不 re-export `react-native-maps` 的 —— 那是引擎專屬的
 * 依賴。這裡的形狀與它結構相同，所以兩邊可以互通，但 adapter 之上的程式碼
 * 不再需要 import 任何引擎。
 */
import type { ReactNode } from 'react';

export type LatLng = { latitude: number; longitude: number };
export type Region = LatLng & { latitudeDelta: number; longitudeDelta: number };

/** 原生底圖類型。`none` 只有 Android 的 Google Maps 真的支援（iOS 的
 *  MKMapType enum 沒有 none，會 fallback 成 standard）。 */
export type BaseMapType = 'standard' | 'satellite' | 'hybrid' | 'terrain' | 'none';

export type MapEngine = 'native' | 'vector';

/**
 * 一個可繪製的圖徵。
 *
 * `zIndex` 是**可選的，而且「未指定」有語意** —— 現有程式碼裡 site 與所有繪製
 * 中的圖徵都沒有指定，改成補一個預設值會改變層序。不要擅自補。
 */
export type MapFeature =
  | {
      kind: 'marker';
      id: string;
      lat: number;
      lng: number;
      /** pin 顏色；有 `render` 時忽略。 */
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
      /** 自繪內容（cluster 的數字泡泡）。給了就取代預設 pin。 */
      render?: () => ReactNode;
      /**
       * `render` 的內容識別。變動時引擎要重新擷取自繪 view——
       * react-native-maps 的 `tracksViewChanges` 需要這個訊號，因為 cluster
       * 的 key 只含格子座標，marker 會跨 pan 保持掛載而不是 remount。
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
      /** **公尺**，不是螢幕像素。MapLibre 端要自己做測地線 buffer。 */
      radiusM: number;
      stroke: string;
      fill: string;
      width: number;
      zIndex?: number;
    };

/** 線上 WMTS 疊圖（NLSC / 中研院）。 */
export type RasterOverlay = {
  id: string;
  urlTemplate: string;
  opacity: number;
  zIndex: number;
  maxZoom: number;
};

/**
 * 向量樣式來源。只有 vector 引擎會看。
 *
 * 可以是遠端 URL（線上）或本機 `file://` 路徑（離線包解出來的 style.json）。
 * MapLibre 的 `mapStyle` 也吃 inline 的 style 物件，但那份 style 有 600 KB，
 * 每次 render 都往 bridge 丟一次不划算，所以介面只收 URL。
 */
export type VectorStyle = string;

/**
 * 相機。全專案只用到 `animateToRegion` 一個方法（11 處呼叫都是），
 * 所以介面就只有這個 —— 沒有 fitToCoordinates / animateCamera。
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
  /** vector 引擎的樣式來源；`engine="vector"` 時必要。 */
  vectorStyle?: VectorStyle;
  showsUserLocation?: boolean;
  showsCompass?: boolean;
  /**
   * 指北針要離右下角多遠（點）。
   *
   * 畫面右下角以外的地方都被別的東西佔著：左上是返回／搜尋、右上是工具、
   * 左下是比例尺。native 引擎沒有對應設定，會忽略這個值。
   */
  compassInset?: { bottom: number; right: number };
  /** iOS Apple Maps 專用，且只在縮放手勢期間短暫出現；Android 不支援。
   *  常駐的比例尺是 `MapScaleBar` 自己畫的。 */
  showsScale?: boolean;
  showsMyLocationButton?: boolean;
  toolbarEnabled?: boolean;
  /** 切換底圖時用來強制疊圖重新掛載（iOS 的疊圖先後看掛載順序）。 */
  overlayGeneration?: string;
  onMapReady?: () => void;
  onRegionChangeComplete?: (region: Region) => void;
  onPress?: (coord: LatLng) => void;
  style?: object;
  children?: ReactNode;
};
