#!/usr/bin/env python3
"""向量樣式預覽伺服器（開發用，調樣式時反覆會用到）。

供三樣東西給瀏覽器：

    /tiles/{z}/{x}/{y}.pbf   從 rudy.mbtiles 直出（tippecanoe 存的是 gzip，
                             所以一定要回 Content-Encoding: gzip，否則
                             maplibre-gl-js 拿到的是一團壓縮位元組）
    /style.json              把 style.json 的遠端 URL 改寫成本機的
    /index.html              maplibre-gl-js 的檢視器

另外收一個 POST /shot/{name}.png，把瀏覽器 canvas.toDataURL() 的結果寫到
--shots 目錄。這樣「開頁面 → 逐點算繪 → 存圖」整條可以一次跑完，不用
一張一張截圖。

用法：
    python preview_server.py            # 預設 build/rudymap/vector
    python preview_server.py --port 8899
"""

from __future__ import annotations

import argparse
import base64
import json
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 中文交給 maplibre-gl-js 的 localIdeographFontFamily 用系統字型算繪
# （MapLibre Native 兩個平台預設也是這樣），所以只需要拉丁的 glyph。
# build_glyphs.js 產在 <dir>/fonts/<fontstack>/<range>.pbf，沒有的話退回
# demotiles 的同名 fontstack。
DEMO_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf"

import os
TRACE_TILES = os.environ.get("TRACE_TILES") == "1"
TRACE_GLYPHS = os.environ.get("TRACE_GLYPHS") == "1"

VIEWER = """<!doctype html>
<meta charset="utf-8">
<title>Mitalivana Topo preview</title>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>
  body { margin:0; font:13px system-ui; background:#111; color:#eee }
  /* 截圖模式固定 512×512（圖磚對齊需要），互動瀏覽時滿版才好用。 */
  #map { width:512px; height:512px }
  body.browse #map { width:100vw; height:100vh }
  body.browse #log { position:fixed; left:0; bottom:0; background:rgba(0,0,0,.6) }
  #log { padding:8px 12px; white-space:pre-wrap }
</style>
<div id="map"></div>
<div id="log">起動中…</div>
<script>
const SAMPLES = __SAMPLES__;
const AUTO = new URLSearchParams(location.search).get('auto') === '1';
window.__extraWait = Number(new URLSearchParams(location.search).get('wait') || 0);
const log = (m) => { document.getElementById('log').textContent = m; console.log(m); };
if (!AUTO) document.body.classList.add('browse');

const map = new maplibregl.Map({
  container: 'map',
  style: '/style.json',
  center: [121.0, 23.5],
  zoom: 12,
  // 中文標籤用系統字型算繪，不必自架 CJK glyph。
  localIdeographFontFamily: "'PingFang TC','Heiti TC','Noto Sans CJK TC',sans-serif",
  // toDataURL() 要拿得到內容就得保留 drawing buffer。
  preserveDrawingBuffer: true,
  attributionControl: false,
  fadeDuration: 0,
});
if (!AUTO) {
  map.addControl(new maplibregl.NavigationControl());
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }));
}

// 等到「真的畫完」才截圖。
//
// 只等一次 idle 不夠：加了山體陰影的 raster source 之後，raster 圖磚載得比
// 向量快，idle 會在向量還在解析時就觸發，截到的圖只有陰影沒有地圖內容。
// 所以要求 idle 之後 areTilesLoaded() 仍成立，且連續兩次都穩定。
function settled(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    const tick = () => {
      if (Date.now() > deadline) {
        map.off('idle', tick);
        return reject(new Error('等待 idle 逾時'));
      }
      if (!map.isStyleLoaded() || !map.areTilesLoaded()) {
        stable = 0;
        map.once('idle', tick);
        map.triggerRepaint();
        return;
      }
      if (++stable < 2) {
        map.once('idle', tick);
        map.triggerRepaint();
        return;
      }
      map.off('idle', tick);
      // 再多等兩幀，確保 drawing buffer 有完整內容可讀。
      map.once('render', () =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)));
      map.triggerRepaint();
    };
    map.once('idle', tick);
  });
}

async function shoot(s) {
  map.jumpTo({ center: [s.lon, s.lat], zoom: s.z });
  try {
    await settled();
  } catch (e) {
    console.warn(`${s.name}: ${e.message}，仍然截圖`);
  }
  if (window.__extraWait) await new Promise(r => setTimeout(r, window.__extraWait));
  const png = map.getCanvas().toDataURL('image/png');
  await fetch('/shot/' + s.name + '.png', { method: 'POST', body: png });
  // 一併回報實際看到的地理範圍。MapLibre 的 zoom 是以 512px 圖磚為基準，
  // 與 256px 的 raster 金字塔差一級；與其靠慣例推算，不如讓它自己講。
  const b = map.getBounds();
  await fetch('/bounds/' + s.name + '.json', {
    method: 'POST',
    body: JSON.stringify({
      west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(),
      zoom: map.getZoom(), size: [map.getCanvas().width, map.getCanvas().height],
    }),
  });
}

map.on('error', (e) => console.warn('style error:', e && e.error && e.error.message));

map.once('load', async () => {
  if (!AUTO) { log('已載入樣式。加上 ?auto=1 會自動逐點算繪並回存。'); return; }
  for (let i = 0; i < SAMPLES.length; i++) {
    log(`算繪 ${i + 1}/${SAMPLES.length}：${SAMPLES[i].label}`);
    await shoot(SAMPLES[i]);
  }
  log('DONE');
  await fetch('/done', { method: 'POST', body: 'ok' });
});
</script>
"""


class Handler(BaseHTTPRequestHandler):
    # 由 main() 注入
    mbtiles: Path
    style: Path
    shots: Path
    hillshade: Path
    samples: list[dict]
    finished: threading.Event

    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # 別把每個 tile 請求都印出來
        pass

    def _send(self, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]

        if path in ("/", "/index.html"):
            html = VIEWER.replace("__SAMPLES__", json.dumps(self.samples, ensure_ascii=False))
            self._send(html.encode(), "text/html; charset=utf-8")
            return

        if path == "/style.json":
            style = json.loads(self.style.read_text())
            host = self.headers["Host"]
            src = style["sources"]["rudy"]
            src.pop("url", None)
            src["tiles"] = [f"http://{host}/tiles/{{z}}/{{x}}/{{y}}.pbf"]
            style["glyphs"] = (
                f"http://{host}/fonts/{{fontstack}}/{{range}}.pbf"
                if (self.style.parent / "fonts").is_dir() else DEMO_GLYPHS
            )
            if (self.style.parent / "sprite.json").exists():
                style["sprite"] = f"http://{host}/sprite"
            if "hillshade" in style.get("sources", {}):
                style["sources"]["hillshade"]["tiles"] = [
                    f"http://{host}/hillshade/{{z}}/{{x}}/{{y}}.png"
                ]
            self._send(json.dumps(style).encode(), "application/json")
            return

        if path.startswith("/fonts/") and path.endswith(".pbf"):
            from urllib.parse import unquote
            rel = unquote(path[len("/fonts/"):])
            f = self.style.parent / "fonts" / rel
            if TRACE_GLYPHS:
                print(f"  glyph {rel} {'ok' if f.exists() else '缺'}", flush=True)
            if not f.exists():
                self.send_error(404)
                return
            self._send(f.read_bytes(), "application/x-protobuf")
            return

        if path.startswith("/hillshade/") and path.endswith(".png"):
            f = self.hillshade / Path(path[len("/hillshade/"):])
            if not f.exists():
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            self._send(f.read_bytes(), "image/png")
            return

        # MapLibre 會依 DPR 去要 sprite / sprite@2x 的 .json 與 .png
        if path.startswith("/sprite"):
            name = Path(path).name
            f = self.style.parent / name
            if not f.exists():
                self.send_error(404)
                return
            ctype = "application/json" if name.endswith(".json") else "image/png"
            self._send(f.read_bytes(), ctype)
            return

        if path.startswith("/tiles/") and path.endswith(".pbf"):
            try:
                _, _, z, x, yy = path.split("/")
                z, x = int(z), int(x)
                y = int(yy[:-4])
            except ValueError:
                self.send_error(400)
                return
            # mbtiles 用 TMS，y 軸與 XYZ 相反。
            flipped = (1 << z) - 1 - y
            con = sqlite3.connect(f"file:{self.mbtiles}?mode=ro", uri=True)
            try:
                row = con.execute(
                    "select tile_data from tiles where zoom_level=? and tile_column=? and tile_row=?",
                    (z, x, flipped),
                ).fetchone()
            finally:
                con.close()
            if row is None:
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            if TRACE_TILES:
                print(f"  tile {z}/{x}/{y}  {len(row[0])} bytes", flush=True)
            self._send(
                bytes(row[0]),
                "application/x-protobuf",
                {"Content-Encoding": "gzip"},
            )
            return

        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if self.path == "/done":
            self.finished.set()
            self._send(b"ok", "text/plain")
            return

        if self.path.startswith("/bounds/"):
            name = Path(self.path[len("/bounds/"):]).name
            (self.shots / name).write_bytes(body)
            self._send(b"ok", "text/plain")
            return

        if self.path.startswith("/shot/"):
            name = Path(self.path[len("/shot/"):]).name
            prefix = b"data:image/png;base64,"
            if not body.startswith(prefix):
                self.send_error(400)
                return
            out = self.shots / name
            out.write_bytes(base64.b64decode(body[len(prefix):]))
            print(f"  存 {out.name}  {out.stat().st_size / 1024:.0f} KB", flush=True)
            self._send(b"ok", "text/plain")
            return

        self.send_error(404)


def lan_ip() -> str:
    """本機在區域網路上的位址，給手機連。不會真的送出封包。"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 80))   # TEST-NET-1，不可路由
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def load_samples(path: Path | None) -> list[dict]:
    if path is not None:
        return json.loads(path.read_text())
    # 這組點刻意各測一件事，改樣式時看這六張就知道有沒有壞。
    return [
        {"name": "yushan", "label": "玉山主峰（等高線密集、山徑）", "lat": 23.4700, "lon": 120.9574, "z": 14},
        {"name": "taroko", "label": "太魯閣（峽谷等高線、隧道）", "lat": 24.1583, "lon": 121.6222, "z": 14},
        {"name": "alishan", "label": "阿里山（林道、鐵路）", "lat": 23.5108, "lon": 120.8055, "z": 13},
        {"name": "sunmoonlake", "label": "日月潭（水體、岸線）", "lat": 23.8569, "lon": 120.9153, "z": 13},
        {"name": "taipei", "label": "臺北車站（市區密度、地名）", "lat": 25.0478, "lon": 121.5170, "z": 14},
        {"name": "kenting", "label": "墾丁（海岸線、海域填色）", "lat": 21.9500, "lon": 120.7900, "z": 12},
        # 山體陰影只在金字塔 z9-13，對應 MapLibre z8-12，所以另外排兩個低 zoom 點。
        {"name": "hs_central", "label": "中央山脈（山體陰影）", "lat": 23.4700, "lon": 121.0500, "z": 11},
        {"name": "hs_hehuan", "label": "合歡山區（山體陰影）", "lat": 24.1400, "lon": 121.2800, "z": 12},
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", type=Path, default=Path("build/rudymap/vector"))
    ap.add_argument("--shots", type=Path, default=Path("build/rudymap/vector/shots"))
    ap.add_argument("--hillshade", type=Path, default=Path("build/rudymap/hillshade"))
    ap.add_argument("--style", type=Path, default=None,
                    help="要預覽的 style，預設 <dir>/style.json（除錯用的簡化樣式可以指到別份）")
    ap.add_argument("--samples", type=Path, default=None, help="自訂取樣點 JSON")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--host", default="127.0.0.1",
                    help="綁定位址。要讓同網段的手機連進來就設 0.0.0.0")
    ap.add_argument("--wait", action="store_true", help="等瀏覽器回報 DONE 後自動結束")
    args = ap.parse_args()

    args.shots.mkdir(parents=True, exist_ok=True)

    Handler.mbtiles = (args.dir / "rudy.mbtiles").resolve()
    Handler.style = (args.style or args.dir / "style.json").resolve()
    Handler.shots = args.shots.resolve()
    Handler.hillshade = args.hillshade.resolve()
    Handler.samples = load_samples(args.samples)
    Handler.finished = threading.Event()

    for p in (Handler.mbtiles, Handler.style):
        if not p.exists():
            raise SystemExit(f"找不到 {p}")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    shown = args.host if args.host != "0.0.0.0" else lan_ip()
    print(f"樣式預覽： http://{shown}:{args.port}/")
    print(f"自動算繪： http://{shown}:{args.port}/?auto=1   → {args.shots}")

    if args.wait:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        Handler.finished.wait()
        print("瀏覽器回報完成。")
        srv.shutdown()
    else:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
