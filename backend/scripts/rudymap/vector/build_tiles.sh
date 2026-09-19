#!/usr/bin/env bash
# 把 RudyMapDump 產出的三份 GeoJSONL 建成單一 MVT tileset。
#
# .map 的 zoom interval 是**raster zoom**（256px 圖磚）的分界，實測這一份：
#   baseZoom 6  → raster z0-6
#   baseZoom 10 → raster z7-11
#   baseZoom 14 → raster z12-21
#
# MapLibre 用 512px 圖磚，同一個比例尺比 raster 低一級（實測 map.getBounds()
# 確認 MapLibre z14 = raster z15）。所以要看起來像魯地圖，MapLibre z11 就得拿到
# mapsforge 在 raster z12 會用的細節，也就是 baseZoom 14 那一份：
#
#   baseZoom 6  → MVT z0-5
#   baseZoom 10 → MVT z6-10
#   baseZoom 14 → MVT z11-15
#
# 早先每段都往上多算一級，結果 MapLibre z11 只拿得到 baseZoom 10 的資料 ——
# 那一份只有 elevation_major（3,771 條），而 baseZoom 14 有三級共 225,230 條，
# 所以低 zoom 的等高線幾乎是空的。
#
# 三段用同一個 layer 名稱 `rudy`，zoom 範圍不重疊，最後 tile-join 併成一份。
#
# 餵給 tippecanoe 之前先跑 prefilter.py：--drop-densest-as-needed 是在超過大小
# 上限時**隨機**丟最密的圖徵，它不知道主題規則。先把該段 zoom 畫不到的東西拿掉，
# 預算才會留給真的會顯示的圖徵。
set -euo pipefail

DIR="${1:-build/rudymap/vector}"
OUT="${2:-$DIR/rudy.mbtiles}"
STYLE="${3:-$DIR/style.json}"
PY="${PY:-backend/venv/bin/python}"
HERE="$(cd "$(dirname "$0")" && pwd)"

Q="--no-progress-indicator"            # tippecanoe 的旗標（保留 base zoom 等訊息）
JQ="--quiet"                          # tile-join 不吃 --no-progress-indicator

# 每段：來源、MVT 最小 zoom、最大 zoom
SEGMENTS="z6:0:5 z10:6:10 z14:11:15"

for seg in $SEGMENTS; do
  src=$(echo "$seg" | cut -d: -f1)
  zmin=$(echo "$seg" | cut -d: -f2)
  zmax=$(echo "$seg" | cut -d: -f3)
  echo "==> $src → MVT z$zmin-$zmax"
  "$PY" "$HERE/prefilter.py" "$DIR/$src.geojsonl" "$DIR/${src}f.geojsonl" \
      --style "$STYLE" --min-zoom "$zmin" --max-zoom "$zmax"
  # --drop-smallest-as-needed 而不是 densest：真的超量時要丟的是細碎的小東西，
  # densest 會把整片森林那種大面積的面丟掉，變成方格狀缺色。
  #
  # --drop-rate=1 關掉點的稀釋。tippecanoe 預設會依資料密度猜一個 base zoom，
  # 低於它的 zoom 就按比例丟點 —— 全臺資料量下，z14 的玉山山頂標示就這樣被丟掉了
  # （小範圍子集測不出來，因為猜出來的 base zoom 較低）。哪些圖徵該在哪一級出現
  # 已經由 prefilter 寫進 tippecanoe.minzoom，不需要它再猜一次。
  tippecanoe -o "$DIR/t$src.mbtiles" -l rudy -Z"$zmin" -z"$zmax" \
      --drop-smallest-as-needed --drop-rate=1 -f $Q "$DIR/${src}f.geojsonl"
done

echo "==> 合併"
tile-join -o "$OUT" -f $JQ "$DIR/tz6.mbtiles" "$DIR/tz10.mbtiles" "$DIR/tz14.mbtiles"
rm -f "$DIR/tz6.mbtiles" "$DIR/tz10.mbtiles" "$DIR/tz14.mbtiles"
ls -lh "$OUT" | awk '{print "   ", $5, $9}'
