"""把 MapsforgeSrv 渲染出的圖磚抓成本機 XYZ 目錄。

用法（需先另起 MapsforgeSrv，見 README.md）：
    python -m backend.scripts.rudymap.render_tiles --out build/rudymap/tiles --zmax 15

海域圖磚不寫檔：先渲染幾個確定純海的座標建立 blank hash 集合，之後任何
內容雜湊命中的磚就跳過。App 端是 <UrlTile shouldReplaceMapContent={false}>，
缺磚會露出 Apple/Google 原生底圖，所以海面留白是安全的。

刻意**不**自動跳過「高頻重複但不在 seed 內」的雜湊：一張純林地的均勻綠色
磚也會高頻重複，自動跳掉會在山區挖洞。那類雜湊只寫進報告供人工判讀。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

from .bboxes import TAIWAN, BBox, count_tiles, iter_tiles, lonlat_to_tile

# 確定是純海面的座標（臺灣海峽中線、太平洋、巴士海峽），用來建立 blank 指紋
OCEAN_SEEDS: tuple[tuple[float, float], ...] = (
    (119.10, 24.60),   # 臺灣海峽北段
    (123.30, 24.00),   # 西太平洋
    (120.90, 21.20),   # 巴士海峽
    (121.00, 26.60),   # 東海
)

# 採樣 zoom 固定，不跟 render 範圍耦合：空白磚是單一背景色，任何 zoom 算繪出來的
# PNG 位元組都一樣，而這兩層夠高，海域座標落在真正的外海上。
BLANK_SAMPLE_ZOOMS = (14, 15)

SUSPICIOUS_MIN_COUNT = 50
SUSPICIOUS_MAX_BYTES = 2048


class Stats:
    def __init__(self) -> None:
        self.written = 0
        self.skipped_blank = 0
        self.skipped_out_of_range = 0
        self.skipped_existing = 0
        self.failed: list[tuple[int, int, int]] = []
        self.last_error: str = ""
        self.bytes_written = 0
        self.hash_counts: Counter[str] = Counter()
        self.hash_sizes: dict[str, int] = {}
        self._lock = Lock()


class OutOfRange(Exception):
    """MapsforgeSrv 對 .map 涵蓋範圍外的請求回 404（body 仍是一張 PNG）。

    這不是錯誤，是「這裡沒有圖資」，不該重試也不該寫檔。
    """


def fetch(url: str, retries: int = 3, timeout: int = 60) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise OutOfRange(url) from exc
            last = exc
            time.sleep(2 ** attempt * 0.5)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            time.sleep(2 ** attempt * 0.5)
    raise RuntimeError(f"{type(last).__name__}: {last}") from last


def tile_url(srv: str, task: str, z: int, x: int, y: int) -> str:
    return f"{srv.rstrip('/')}/{z}/{x}/{y}.png?task={task}"


def collect_blank_hashes(srv: str, task: str) -> dict[str, int]:
    """建立「無內容圖磚」的指紋表，回傳 {sha256: bytes}。

    只在 `BLANK_SAMPLE_ZOOMS` 採樣，與實際要 render 的範圍無關。低 zoom 的一張磚
    涵蓋極大範圍 —— z6 那張含有「純海座標」的磚同時也含著整個臺灣 —— 拿它當 blank
    指紋會把真正有內容的磚整片跳掉。

    無內容的磚是單一背景色，在任何 zoom 算繪出來的 PNG 位元組都一樣，所以在高
    zoom 採到的指紋可以套用到所有 zoom。

    兩道保險：
      1. 同一個指紋要被**至少兩個相距很遠的海域座標**同時算出來，才算數。
         真正空白的磚四處都長一樣；含有地物的磚不可能兩地相同。
      2. 大小上限：空白磚只有幾百 bytes，含地物的磚是它的幾十倍。
    """
    MAX_BLANK_BYTES = 4096
    seen: dict[str, tuple[int, set[int]]] = {}
    for z in BLANK_SAMPLE_ZOOMS:
        for seed_index, (lon, lat) in enumerate(OCEAN_SEEDS):
            x, y = lonlat_to_tile(lon, lat, z)
            try:
                data = fetch(tile_url(srv, task, z, x, y))
            except (RuntimeError, OutOfRange):
                continue
            if len(data) > MAX_BLANK_BYTES:
                continue
            digest = hashlib.sha256(data).hexdigest()
            size, seeds = seen.get(digest, (len(data), set()))
            seeds.add(seed_index)
            seen[digest] = (size, seeds)
    return {d: size for d, (size, seeds) in seen.items() if len(seeds) >= 2}


def render_one(srv: str, task: str, out: Path, blanks: set[str], st: Stats,
               tile: tuple[int, int, int]) -> None:
    z, x, y = tile
    dest = out / str(z) / str(x) / f"{y}.png"
    if dest.exists() and dest.stat().st_size > 0:
        with st._lock:
            st.skipped_existing += 1
        return

    try:
        data = fetch(tile_url(srv, task, z, x, y))
    except OutOfRange:
        with st._lock:
            st.skipped_out_of_range += 1
        return
    except RuntimeError as exc:
        with st._lock:
            st.failed.append(tile)
            st.last_error = str(exc)
        return

    digest = hashlib.sha256(data).hexdigest()
    with st._lock:
        st.hash_counts[digest] += 1
        st.hash_sizes[digest] = len(data)
        blank = digest in blanks

    if blank:
        with st._lock:
            st.skipped_blank += 1
        return

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".png.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dest)          # 原子寫入，中斷不會留下截斷檔讓續跑誤判
    with st._lock:
        st.written += 1
        st.bytes_written += len(data)


def render(out: Path, boxes: tuple[BBox, ...], z_min: int, z_max: int,
           srv: str, task: str, workers: int) -> Stats:
    st = Stats()
    print(f"建立海域指紋（{len(OCEAN_SEEDS)} 個座標 × z{BLANK_SAMPLE_ZOOMS}）…", flush=True)
    blank_map = collect_blank_hashes(srv, task)
    blanks = set(blank_map)
    print(f"  取得 {len(blanks)} 個 blank 指紋，大小 {sorted(set(blank_map.values()))} bytes")
    if not blanks:
        # 一個海域指紋都拿不到 = server 根本連不上或全部回錯。繼續跑只會
        # 安靜地產出空目錄，跑滿十幾分鐘才發現。
        raise SystemExit(
            f"無法從 {srv} 取得任何圖磚。請確認 MapsforgeSrv 已啟動"
            f"（make rudymap-serve）且 task 名稱正確（--task {task}）。")

    planned = count_tiles(boxes, z_min, z_max)
    for z in range(z_min, z_max + 1):
        tiles = list(iter_tiles(boxes, z))
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(lambda t: render_one(srv, task, out, blanks, st, t), tiles))
        print(f"z={z:<3} 規劃 {planned[z]:>7,}  已寫 {st.written:>8,}  "
            f"海域 {st.skipped_blank:>7,}  範圍外 {st.skipped_out_of_range:>7,}  "
            f"既有 {st.skipped_existing:>7,}  失敗 {len(st.failed):>6,}  "
            f"{time.time() - t0:>6.1f}s", flush=True)
        if st.last_error:
            print(f"      最近錯誤：{st.last_error}", flush=True)

    suspicious = [
        {"sha256": h, "count": c, "bytes": st.hash_sizes[h]}
        for h, c in st.hash_counts.most_common(40)
        if c >= SUSPICIOUS_MIN_COUNT and st.hash_sizes[h] <= SUSPICIOUS_MAX_BYTES and h not in blanks
    ]
    report = {
        "zoomRange": [z_min, z_max],
        "written": st.written,
        "skippedBlank": st.skipped_blank,
        "skippedOutOfRange": st.skipped_out_of_range,
        "skippedExisting": st.skipped_existing,
        "failed": st.failed,
        "bytesWritten": st.bytes_written,
        "blankHashes": blank_map,
        "suspiciousHashes": suspicious,
    }
    (out / "render-stats.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    if suspicious:
        print("\n⚠ 以下雜湊高頻重複且體積很小，但不在海域 seed 內。")
        print("  可能是均勻色塊的內陸磚（不該跳），請人工判讀 render-stats.json：")
        for s in suspicious[:10]:
            print(f"    {s['sha256'][:16]}…  ×{s['count']:,}  {s['bytes']} bytes")
    if st.failed:
        print(f"\n⚠ {len(st.failed)} 張抓取失敗，重跑本指令會只補這些（已存在的會跳過）")
    return st


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("build/rudymap/tiles"))
    ap.add_argument("--srv", default="http://127.0.0.1:8080")
    # task 名稱 = config/tasks/ 底下的檔名去掉 .properties。make rudymap-config
    # 產生的是 rudy.properties，所以預設就是 rudy；名稱對不上時 server 會回錯，
    # 上面的 fail-fast 檢查會直接點名這件事。
    ap.add_argument("--task", default="rudy", help="MapsforgeSrv 的 task 名稱")
    # z7 起算是實測結果：魯地圖的 mapsforge 圖資在 z6 以下沒有資料，算繪出來是
    # 白底加上大片**不透明黑色**（z6 實測最高 79% 的像素是黑的），會用黑方塊蓋住
    # 底圖。z7 以上乾淨（海色 179,221,255、零黑點）。低 zoom 缺磚不是問題 ——
    # app 端是 shouldReplaceMapContent={false}，缺磚就顯示 Apple/Google 原生底圖，
    # 那個尺度下原生底圖本來就比較好看。
    ap.add_argument("--zmin", type=int, default=7)
    ap.add_argument("--zmax", type=int, default=15)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    st = render(args.out, TAIWAN, args.zmin, args.zmax, args.srv, args.task, args.workers)
    gb = st.bytes_written / 1024 ** 3
    print(f"\n完成：寫入 {st.written:,} 張（{gb:.2f} GB），"
          f"海域跳過 {st.skipped_blank:,} 張，範圍外 {st.skipped_out_of_range:,} 張")


if __name__ == "__main__":
    main()
