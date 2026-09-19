import org.mapsforge.core.model.*;
import org.mapsforge.map.datastore.*;
import org.mapsforge.map.reader.MapFile;
import org.mapsforge.map.reader.header.SubFileParameter;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 把魯地圖的 .map 抽成 GeoJSONL，供 tippecanoe 產生 MVT。
 *
 * 為什麼從 .map 抽而不是從 OSM + DTM 自建：抽出來的 tag 與魯地圖主題**天生對得上**
 * —— 例如等高線在資料裡已經分級成 contour_80m / _160m / _320m / _640m / _1280m，
 * 那正是主題用來決定主曲線粗細的依據。自建就得自訂 schema，樣式翻譯器等於報廢。
 *
 * .map 的 zoom interval（實測這一份）：
 *     baseZoom 6  服務 z0-6
 *     baseZoom 10 服務 z7-11
 *     baseZoom 14 服務 z12-21
 * 每個 base zoom 各跑一次，產出的 GeoJSONL 再各自餵給 tippecanoe 的對應 zoom 範圍。
 *
 * 去重：`MapReadResult.deduplicate()` 只在單次讀取結果內有效，而跨 block 邊界的
 * way 會重複出現，所以另外維護一個全域的幾何雜湊集合。
 *
 * 具名線段會**先收起來、最後接成連續的線**再輸出。原因是 MapLibre 的
 * `symbol-placement: line` 是**每個線圖徵各放一個標籤**，而 .map 裡的道路與步道
 * 被切成很多小段（「八通關古道東段」在一張 z11 圖磚裡有 26 段），照抄的話同一個
 * 名字會沿線印八次，raster 版只有兩次。`symbol-spacing` 只管單一圖徵內的重複，
 * 對這種切碎的資料完全無效；tippecanoe 的 `--coalesce` 也只把 26 併成 24+1。
 * 接起來之後 tippecanoe 再依圖磚裁切，等於每張圖磚一條線，標籤密度就和 raster 一致。
 *
 * 用法：
 *   java -cp mapsforgesrv-fatjar.jar:. RudyMapDump <map> <out.geojsonl> <baseZoom> [blockTiles] [joinTolMetres]
 */
public class RudyMapDump {

  public static void main(String[] args) throws Exception {
    if (args.length < 3) {
      System.err.println("usage: RudyMapDump <map> <out.geojsonl> <baseZoom> [blockTiles] [joinTolMetres]");
      System.exit(2);
    }
    File mapFile = new File(args[0]);
    File out = new File(args[1]);
    byte zoom = Byte.parseByte(args[2]);
    int block = args.length > 3 ? Integer.parseInt(args[3]) : 16;
    // 具名線的接合容差（公尺）。0 代表不接。
    double joinTol = args.length > 4 ? Double.parseDouble(args[4]) : 20.0;

    MapFile map = new MapFile(mapFile);
    BoundingBox bbox = map.boundingBox();
    SubFileParameter sfp = map.getMapFileHeader().getSubFileParameter(zoom);
    if (sfp == null) throw new IllegalArgumentException("no sub-file for zoom " + zoom);
    System.err.printf("zoom=%d (baseZoom %d, 服務 z%d-%d)  bbox=%s%n",
        zoom, sfp.baseZoomLevel, sfp.zoomLevelMin, sfp.zoomLevelMax, bbox);

    int n = 1 << zoom;
    int xMin = lonToTileX(bbox.minLongitude, n), xMax = lonToTileX(bbox.maxLongitude, n);
    int yMin = latToTileY(bbox.maxLatitude, n),  yMax = latToTileY(bbox.minLatitude, n);
    long totalTiles = (long) (xMax - xMin + 1) * (yMax - yMin + 1);
    System.err.printf("tiles x=%d..%d y=%d..%d  共 %,d 張，block=%d%n",
        xMin, xMax, yMin, yMax, totalTiles, block);

    Set<Long> seen = new HashSet<>();
    // props JSON → 該組的所有線段（lon,lat 交錯的扁平陣列）
    Map<String, List<double[]>> pending = new HashMap<>();
    long ways = 0, pois = 0, dupes = 0, blocks = 0, pendingSegs = 0;
    long t0 = System.currentTimeMillis();

    try (BufferedWriter w = new BufferedWriter(
        new OutputStreamWriter(new FileOutputStream(out), StandardCharsets.UTF_8), 1 << 20)) {
      for (int by = yMin; by <= yMax; by += block) {
        for (int bx = xMin; bx <= xMax; bx += block) {
          Tile ul = new Tile(bx, by, zoom, 256);
          Tile lr = new Tile(Math.min(bx + block - 1, xMax), Math.min(by + block - 1, yMax), zoom, 256);
          MapReadResult r;
          try {
            r = map.readMapData(ul, lr);
          } catch (Exception e) {
            System.err.printf("  block (%d,%d) 讀取失敗: %s%n", bx, by, e);
            continue;
          }
          if (r == null) continue;
          r = r.deduplicate();

          for (PointOfInterest p : r.pois) {
            long h = hashPoi(p);
            if (!seen.add(h)) { dupes++; continue; }
            w.write(pointFeature(p));
            w.write('\n');
            pois++;
          }
          for (Way way : r.ways) {
            long h = hashWay(way);
            if (!seen.add(h)) { dupes++; continue; }
            if (isNamedLine(way)) {
              StringBuilder pb = new StringBuilder(128);
              props(pb, way.tags, way.layer);
              pending.computeIfAbsent(pb.toString(), k -> new ArrayList<>())
                     .add(flatten(way.latLongs[0]));
              pendingSegs++;
              continue;
            }
            String f = wayFeature(way);
            if (f == null) continue;
            w.write(f);
            w.write('\n');
            ways++;
          }
          if (++blocks % 50 == 0) {
            System.err.printf("  %,d block  ways=%,d pois=%,d 重複=%,d  %.0fs%n",
                blocks, ways, pois, dupes, (System.currentTimeMillis() - t0) / 1000.0);
          }
        }
      }
      System.err.printf("  接線中：%,d 段具名線，%,d 個 tag 組合，容差 %.0f m%n",
          pendingSegs, pending.size(), joinTol);
      long chains = 0;
      for (Map.Entry<String, List<double[]>> e : pending.entrySet()) {
        for (double[] chain : chainSegments(e.getValue(), joinTol)) {
          w.write(lineFeature(chain, e.getKey()));
          w.write('\n');
          chains++;
          ways++;
        }
      }
      System.err.printf("  接線完成：%,d 段 → %,d 條（少 %.0f%%）%n",
          pendingSegs, chains, pendingSegs == 0 ? 0 : 100.0 * (pendingSegs - chains) / pendingSegs);
    }
    map.close();
    System.err.printf("完成：ways=%,d pois=%,d 跨 block 重複略過=%,d  %.0fs  → %s (%.1f MB)%n",
        ways, pois, dupes, (System.currentTimeMillis() - t0) / 1000.0,
        out, out.length() / 1048576.0);
  }

  // ---- 具名線的接合 ----

  /**
   * 這條 way 是不是「該接起來的具名線」。
   *
   * 只收單段、開放、且有 name 或 ref 的線 —— 那正是會產生標籤的那一群。面、
   * MultiLineString、無名的線都照原路徑直接輸出：接它們沒有好處，卻要多花
   * 幾百 MB 記憶體，而且無名的線接起來還可能把兩條不同的東西併成一條。
   */
  static boolean isNamedLine(Way way) {
    if (way.latLongs.length != 1) return false;
    LatLong[] pts = way.latLongs[0];
    if (pts.length < 2 || isClosed(pts)) return false;
    for (Tag t : way.tags) {
      if ("name".equals(t.key) || "ref".equals(t.key)) return true;
    }
    return false;
  }

  static double[] flatten(LatLong[] pts) {
    double[] a = new double[pts.length * 2];
    for (int i = 0; i < pts.length; i++) {
      a[i * 2] = pts[i].longitude;
      a[i * 2 + 1] = pts[i].latitude;
    }
    return a;
  }

  /** 把量化後的一個端點壓成一個 long，當作雜湊表的鍵。 */
  static long endpointKey(double[] a, boolean head) {
    int i = head ? 0 : a.length - 2;
    long lon = quantize(a[i]);
    long lat = quantize(a[i + 1]);
    return (lon << 32) ^ (lat & 0xFFFFFFFFL);
  }

  /**
   * 把端點相近的線段串成盡量長的線。
   *
   * **不能只比對完全相同的端點**：同一個節點在不同 block 解出來的座標會差到
   * 第 7 位小數（實測 3 公分），照字面比對一條都接不起來。而且資料本身就有
   * 缺口 —— 「八通關古道東段」相鄰兩段實測差 24 公尺。所以用公尺級的容差。
   *
   * 容差一放寬就有把兩條平行道路接成 Z 字的風險（高速公路的南北雙向同名同 tag，
   * 相距也就二三十公尺），所以加兩道方向檢查：
   *
   *   1. 接上去之後方向不能反折（轉角 ≤ 90°）
   *   2. 缺口本身要朝著「前方」（與行進方向夾角 ≤ 60°），把「側向跨過去接到
   *      對向車道」擋掉。缺口小於 1 公尺時這個方向只是雜訊，不檢查
   *
   * 同一組的 tag 完全相同（含 name），所以接起來的本來就是同一條路。
   */
  static List<double[]> chainSegments(List<double[]> segs, double tolM) {
    int n = segs.size();
    if (n == 1) return segs;
    // 端點格網索引：格子邊長就是容差，查 3×3 格即可涵蓋
    double cell = tolM / M_PER_DEG_LON;
    Map<Long, List<Integer>> grid = new HashMap<>(n * 3);
    for (int i = 0; i < n; i++) {
      for (boolean head : HEAD_TAIL) {
        double[] e = endpoint(segs.get(i), head);
        grid.computeIfAbsent(cellKey(e[0], e[1], cell), k -> new ArrayList<>()).add(i);
      }
    }
    boolean[] used = new boolean[n];
    List<double[]> out = new ArrayList<>();
    for (int i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      ArrayDeque<double[]> chain = new ArrayDeque<>();
      chain.add(segs.get(i));
      extend(chain, segs, grid, used, false, cell, tolM);
      extend(chain, segs, grid, used, true, cell, tolM);
      out.add(concat(chain));
    }
    return out;
  }

  static final boolean[] HEAD_TAIL = {true, false};
  /** 台灣緯度帶：1 度經度約 102.1 km、1 度緯度約 110.5 km。 */
  static final double M_PER_DEG_LON = 102100.0;
  static final double M_PER_DEG_LAT = 110540.0;
  /** 缺口小於這個距離就不檢查缺口方向 —— 那只是座標捨入的雜訊。 */
  static final double GAP_DIR_MIN_M = 1.0;

  static double[] endpoint(double[] a, boolean head) {
    int i = head ? 0 : a.length - 2;
    return new double[]{a[i], a[i + 1]};
  }

  static long cellKey(double lon, double lat, double cell) {
    long cx = (long) Math.floor(lon / cell);
    long cy = (long) Math.floor(lat / cell);
    return (cx << 32) ^ (cy & 0xFFFFFFFFL);
  }

  static double distM(double lon1, double lat1, double lon2, double lat2) {
    return Math.hypot((lon1 - lon2) * M_PER_DEG_LON, (lat1 - lat2) * M_PER_DEG_LAT);
  }

  /** 線在某一端「朝外」的單位方向（公尺座標）。 */
  static double[] dirOutward(double[] a, boolean head) {
    int i = head ? 0 : a.length - 2;
    int j = head ? 2 : a.length - 4;
    if (j < 0 || j + 1 >= a.length) return null;
    double dx = (a[i] - a[j]) * M_PER_DEG_LON;
    double dy = (a[i + 1] - a[j + 1]) * M_PER_DEG_LAT;
    double len = Math.hypot(dx, dy);
    return len == 0 ? null : new double[]{dx / len, dy / len};
  }

  /** 從 chain 的某一端接上最近、且方向合理的線段，接到接不動為止。 */
  static void extend(ArrayDeque<double[]> chain, List<double[]> segs,
                     Map<Long, List<Integer>> grid, boolean[] used,
                     boolean atHead, double cell, double tolM) {
    while (true) {
      double[] edge = atHead ? chain.peekFirst() : chain.peekLast();
      double[] pt = endpoint(edge, atHead);
      double[] out = dirOutward(edge, atHead);
      int bestIdx = -1;
      boolean bestReverse = false;
      double bestDist = Double.MAX_VALUE;
      long cx = (long) Math.floor(pt[0] / cell), cy = (long) Math.floor(pt[1] / cell);
      for (long ox = -1; ox <= 1; ox++) {
        for (long oy = -1; oy <= 1; oy++) {
          List<Integer> cand = grid.get(((cx + ox) << 32) ^ ((cy + oy) & 0xFFFFFFFFL));
          if (cand == null) continue;
          for (int j : cand) {
            if (used[j]) continue;
            double[] s = segs.get(j);
            for (boolean joinAtHead : HEAD_TAIL) {
              double[] e = endpoint(s, joinAtHead);
              double d = distM(pt[0], pt[1], e[0], e[1]);
              if (d > tolM || d >= bestDist) continue;
              if (!joinOk(out, pt, e, s, joinAtHead, d)) continue;
              bestDist = d;
              bestIdx = j;
              // 新的自由端要朝外：從尾端長就要讓 s 的 head 貼著接點
              bestReverse = (atHead == joinAtHead);
            }
          }
        }
      }
      if (bestIdx < 0) return;
      used[bestIdx] = true;
      double[] next = bestReverse ? reverse(segs.get(bestIdx)) : segs.get(bestIdx);
      if (atHead) chain.addFirst(next); else chain.addLast(next);
    }
  }

  /** 兩道方向檢查，見 chainSegments 的說明。 */
  static boolean joinOk(double[] out, double[] pt, double[] e,
                        double[] s, boolean joinAtHead, double gapM) {
    if (out == null) return true;             // 只有兩點的線沒有可靠方向，放行
    // 這裡**刻意不檢查接續方向**。山徑滿是之字形，實測「八通關古道東段」相鄰兩段
    // 在接點的夾角就是 180°（資料剛好切在髮夾彎上），加了轉角限制反而一條都接不起來。
    // 擋雙向車道靠的是下面的缺口方向：對向車道在側邊，缺口朝側面而不是朝前。
    if (gapM < GAP_DIR_MIN_M) return true;
    double gx = (e[0] - pt[0]) * M_PER_DEG_LON, gy = (e[1] - pt[1]) * M_PER_DEG_LAT;
    double len = Math.hypot(gx, gy);
    return len == 0 || (out[0] * gx + out[1] * gy) / len > 0.5;
  }

  static double[] reverse(double[] a) {
    double[] r = new double[a.length];
    for (int i = 0, j = a.length - 2; i < a.length; i += 2, j -= 2) {
      r[i] = a[j];
      r[i + 1] = a[j + 1];
    }
    return r;
  }

  /** 串接時要略過重複的接點，不然線上會多一個原地不動的點。 */
  static double[] concat(ArrayDeque<double[]> chain) {
    int total = 0;
    boolean first = true;
    for (double[] a : chain) {
      total += first ? a.length : a.length - 2;
      first = false;
    }
    double[] out = new double[total];
    int at = 0;
    first = true;
    for (double[] a : chain) {
      int from = first ? 0 : 2;
      System.arraycopy(a, from, out, at, a.length - from);
      at += a.length - from;
      first = false;
    }
    return out;
  }

  static String lineFeature(double[] flat, String propsJson) {
    StringBuilder sb = new StringBuilder(flat.length * 12 + propsJson.length() + 64);
    sb.append("{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[");
    for (int i = 0; i < flat.length; i += 2) {
      if (i > 0) sb.append(',');
      sb.append('[').append(round7(flat[i])).append(',').append(round7(flat[i + 1])).append(']');
    }
    sb.append("]},\"properties\":").append(propsJson).append('}');
    return sb.toString();
  }

  // ---- tile 座標 ----
  static int lonToTileX(double lon, int n) {
    return Math.max(0, Math.min(n - 1, (int) ((lon + 180.0) / 360.0 * n)));
  }

  static int latToTileY(double lat, int n) {
    double r = Math.toRadians(lat);
    int y = (int) ((1.0 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2.0 * n);
    return Math.max(0, Math.min(n - 1, y));
  }

  // ---- 去重雜湊 ----
  static long hashPoi(PointOfInterest p) {
    long h = 1469598103934665603L;
    h = mix(h, Double.hashCode(p.position.latitude));
    h = mix(h, Double.hashCode(p.position.longitude));
    for (Tag t : p.tags) h = mix(h, Objects.hash(t.key, t.value));
    return h;
  }

  static long hashWay(Way way) {
    long h = 1469598103934665603L;
    for (Tag t : way.tags) h = mix(h, Objects.hash(t.key, t.value));
    for (LatLong[] part : way.latLongs) {
      h = mix(h, part.length);
      // 全部點位都參與。原本只取首尾兩點，結果地被面在某些 z14 圖磚整塊消失
      // （缺口寬度剛好一個 z14 圖磚），因為相鄰 block 的不同裁切片段會被誤判成
      // 同一條。2.5M 條 way 全點雜湊實測只多幾秒，沒有省的必要。
      for (LatLong pt : part) {
        h = mix(h, Double.hashCode(pt.latitude));
        h = mix(h, Double.hashCode(pt.longitude));
      }
    }
    return h;
  }

  static long mix(long h, int v) {
    h ^= v;
    return h * 1099511628211L;
  }

  // ---- GeoJSON ----
  static String pointFeature(PointOfInterest p) {
    StringBuilder sb = new StringBuilder(256);
    sb.append("{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[");
    coord(sb, p.position);
    sb.append("]},\"properties\":");
    props(sb, p.tags, p.layer);
    sb.append('}');
    return sb.toString();
  }

  static String wayFeature(Way way) {
    LatLong[][] parts = way.latLongs;
    if (parts.length == 0 || parts[0].length < 2) return null;
    // mapsforge 自己也是用「首尾相同」判斷封閉多邊形。
    boolean closed = isClosed(parts[0]);
    StringBuilder sb = new StringBuilder(512);
    sb.append("{\"type\":\"Feature\",\"geometry\":{\"type\":\"");
    if (closed) {
      // parts[0] 是外環，其餘是洞。
      sb.append("Polygon\",\"coordinates\":[");
      for (int i = 0; i < parts.length; i++) {
        if (i > 0) sb.append(',');
        closedRing(sb, parts[i], i == 0);
      }
      sb.append(']');
    } else if (parts.length == 1) {
      sb.append("LineString\",\"coordinates\":");
      ring(sb, parts[0]);
    } else {
      sb.append("MultiLineString\",\"coordinates\":[");
      for (int i = 0; i < parts.length; i++) {
        if (i > 0) sb.append(',');
        ring(sb, parts[i]);
      }
      sb.append(']');
    }
    sb.append("},\"properties\":");
    props(sb, way.tags, way.layer);
    sb.append('}');
    return sb.toString();
  }

  /**
   * 封閉判斷必須用「輸出後」的座標，不能比原始 double。
   *
   * mapsforge 解出來的座標不是整數微度（實測有 7 位小數），首尾可能差 5 mm 以內；
   * 那種環寫進 GeoJSON 後首尾字面相同、卻通不過 double 的 ==。之前就是這樣讓
   * 487,920 個環掉成 LineString，湖泊、林地、建物全部沒有填色。
   */
  static boolean isClosed(LatLong[] pts) {
    if (pts.length < 4) return false;
    LatLong a = pts[0], b = pts[pts.length - 1];
    return quantize(a.latitude) == quantize(b.latitude)
        && quantize(a.longitude) == quantize(b.longitude);
  }

  /** 與 round7 同一個量化，整數比較不會有浮點誤差。 */
  static long quantize(double v) {
    return Math.round(v * 1e7);
  }

  /**
   * 環的最後一點一律寫成起點，並且**照 RFC 7946 的繞向**輸出：外環逆時針、
   * 內環順時針。
   *
   * mapsforge 存的繞向剛好相反（實測 30 萬個多邊形有 99.1% 的外環是順時針），
   * 而 tippecanoe 是依繞向判斷外環與內環的。照抄的話大片地被判成洞，整塊圖磚
   * 會被填成反的 —— 實際症狀是森林呈棋盤狀一格有一格沒有。
   */
  static void closedRing(StringBuilder sb, LatLong[] pts, boolean outer) {
    boolean ccw = signedArea(pts) > 0;
    boolean reverse = (outer != ccw);
    sb.append('[');
    for (int i = 0; i < pts.length; i++) {
      if (i > 0) sb.append(',');
      int j = reverse ? pts.length - 1 - i : i;
      // 頭尾一定要是同一個點（來源可能差 5 mm 以內）
      if (i == pts.length - 1) j = reverse ? pts.length - 1 : 0;
      sb.append('[');
      coord(sb, pts[j]);
      sb.append(']');
    }
    sb.append(']');
  }

  /** 鞋帶公式；> 0 代表逆時針（經緯度直接算，只用來判方向）。 */
  static double signedArea(LatLong[] pts) {
    double s = 0;
    for (int i = 0; i < pts.length - 1; i++) {
      s += pts[i].longitude * pts[i + 1].latitude
         - pts[i + 1].longitude * pts[i].latitude;
    }
    return s / 2.0;
  }

  static void ring(StringBuilder sb, LatLong[] pts) {
    sb.append('[');
    for (int i = 0; i < pts.length; i++) {
      if (i > 0) sb.append(',');
      sb.append('[');
      coord(sb, pts[i]);
      sb.append(']');
    }
    sb.append(']');
  }

  static void coord(StringBuilder sb, LatLong p) {
    // 七位小數約 1 cm，遠超圖磚需要；再多只是讓檔案變大。
    sb.append(round7(p.longitude)).append(',').append(round7(p.latitude));
  }

  static String round7(double v) {
    return String.valueOf(Math.round(v * 1e7) / 1e7);
  }

  static void props(StringBuilder sb, List<Tag> tags, byte layer) {
    sb.append('{');
    boolean first = true;
    for (Tag t : tags) {
      if (t.key == null || t.value == null) continue;
      if (!first) sb.append(',');
      first = false;
      json(sb, t.key);
      sb.append(':');
      json(sb, t.value);
    }
    if (layer != 0) {
      if (!first) sb.append(',');
      sb.append("\"_layer\":").append(layer);
    }
    sb.append('}');
  }

  static void json(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        default -> {
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
        }
      }
    }
    sb.append('"');
  }
}
