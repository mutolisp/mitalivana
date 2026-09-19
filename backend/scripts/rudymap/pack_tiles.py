"""把 render 出來的圖磚目錄切成可續傳的塊，並產生 manifest.json。

切塊規則：
  chunk 0      = z0–11 全部（幾 MB）。裝完這一塊地圖就能用，之後每塊只加細節。
  chunk 1..N   = z12–15，以 **z12 祖先磚為單位**分組（一個 z12 磚含 1+4+16+64 = 85
                 個後代），依 Morton (Z-order) 排序後累積到 ~64 MiB 切一塊。
                 這樣中途停掉的結果是「某幾個山區已完整」而不是地理上的碎片。

zip 一律用 ZIP_STORED：PNG 已經壓過，deflate 收益接近 0，而 store-only 讓
app 端的 fflate 串流解壓完全不必做 inflate（method 0 走 UnzipPassThrough）。

entry 名稱是 `{z}/{x}/{y}`（**無副檔名**），直接對應 react-native-maps 的
tileCachePath 佈局，app 解壓後不需要再改名。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import zipfile
from pathlib import Path

CHUNK_TARGET_BYTES = 64 * 1024 * 1024

# 圖磚用 STORED（PNG 壓過了），但 POI 是 SQLite，DEFLATE 能從 237 MB 壓到約 61 MB，
# 所以這一個檔案例外用壓縮。app 端因此只有它需要做 inflate。
POI_ZIP_NAME = "rudypoi.zip"
POI_INSTALL_NAME = "rudypoi.db"
GROUP_ZOOM = 12
CHUNK0_MAX_ZOOM = GROUP_ZOOM - 1

ATTRIBUTION = {
    "zh-TW": "© OpenStreetMap 貢獻者（ODbL）・魯地圖 Taiwan TOPO・內政部 20 公尺網格 DTM・JAXA AW3D30",
    "en": "© OpenStreetMap contributors (ODbL) · Rudy Map Taiwan TOPO · MOI 20m grid DTM · JAXA AW3D30",
}


def morton(x: int, y: int) -> int:
    """交錯 x/y 的位元，讓相鄰的塊在地理上也相鄰。"""
    code = 0
    for i in range(32):
        code |= ((x >> i) & 1) << (2 * i)
        code |= ((y >> i) & 1) << (2 * i + 1)
    return code


def scan(tiles_dir: Path) -> dict[int, list[tuple[int, int, Path]]]:
    """回傳 {z: [(x, y, path), …]}。"""
    found: dict[int, list[tuple[int, int, Path]]] = {}
    for z_dir in sorted(tiles_dir.iterdir()):
        if not z_dir.is_dir() or not z_dir.name.isdigit():
            continue
        z = int(z_dir.name)
        rows: list[tuple[int, int, Path]] = []
        for x_dir in z_dir.iterdir():
            if not x_dir.is_dir() or not x_dir.name.isdigit():
                continue
            x = int(x_dir.name)
            for f in x_dir.glob("*.png"):
                if f.stem.isdigit():
                    rows.append((x, int(f.stem), f))
        if rows:
            found[z] = rows
    return found


def group_by_ancestor(found: dict[int, list[tuple[int, int, Path]]]
                      ) -> dict[tuple[int, int], list[tuple[int, int, int, Path]]]:
    """z12 以上的磚，依其 z12 祖先分組 → {(X, Y): [(z, x, y, path), …]}。"""
    groups: dict[tuple[int, int], list[tuple[int, int, int, Path]]] = {}
    for z, rows in found.items():
        if z < GROUP_ZOOM:
            continue
        shift = z - GROUP_ZOOM
        for x, y, path in rows:
            key = (x >> shift, y >> shift)
            groups.setdefault(key, []).append((z, x, y, path))
    return groups


def write_chunk(out_dir: Path, index: int,
                entries: list[tuple[int, int, int, Path]]) -> dict:
    name = f"chunk-{index:03d}.zip"
    dest = out_dir / name
    entries.sort(key=lambda e: (e[0], e[1], e[2]))
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_STORED) as zf:
        for z, x, y, path in entries:
            zf.write(path, arcname=f"{z}/{x}/{y}")

    raw = dest.read_bytes()
    zooms = [e[0] for e in entries]
    return {
        "id": index,
        "name": name,
        "bytes": len(raw),
        "tiles": len(entries),
        "zoomRange": [min(zooms), max(zooms)],
        "md5": hashlib.md5(raw).hexdigest(),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def pack_poi(poi_src: Path, out_dir: Path) -> dict:
    """把魯地圖的 `.poi`（SQLite）壓進 pack。

    刻意**不做任何篩選或轉檔**：上游那份是完整的 766,737 筆，app 端在查詢時
    以分類排除路徑／水系節點即可（實測桌面端一個視窗查詢 1–17 ms）。轉檔會
    多一層要維護的東西，而它換來的體積在綁進離線包的前提下不值得。
    """
    dest = out_dir / POI_ZIP_NAME
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(poi_src, arcname=POI_INSTALL_NAME)

    con = sqlite3.connect(f"file:{poi_src}?mode=ro", uri=True)
    try:
        count = con.execute("SELECT count(*) FROM poi_index").fetchone()[0]
        meta = dict(con.execute("SELECT name, value FROM metadata").fetchall())
    finally:
        con.close()

    raw = dest.read_bytes()
    return {
        "name": POI_ZIP_NAME,
        "installName": POI_INSTALL_NAME,
        "bytes": len(raw),
        "uncompressedBytes": poi_src.stat().st_size,
        "poiCount": count,
        "sourceComment": meta.get("comment", ""),
        "md5": hashlib.md5(raw).hexdigest(),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def pack(tiles_dir: Path, out_dir: Path, pack_version: str, base_url: str,
         target_bytes: int = CHUNK_TARGET_BYTES, poi_src: Path | None = None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    found = scan(tiles_dir)
    if not found:
        raise SystemExit(f"{tiles_dir} 裡沒有任何圖磚")

    chunks: list[dict] = []

    # chunk 0：z0–11 全部
    low = [(z, x, y, p) for z, rows in found.items() if z <= CHUNK0_MAX_ZOOM
           for x, y, p in rows]
    if low:
        chunks.append(write_chunk(out_dir, 0, low))
        print(f"chunk 000  z{chunks[0]['zoomRange'][0]}-{chunks[0]['zoomRange'][1]}  "
              f"{chunks[0]['tiles']:>7,} 磚  {chunks[0]['bytes'] / 1048576:>7.1f} MiB")

    # chunk 1..N：z12+ 依 z12 祖先分組，Morton 排序後累積切塊
    groups = group_by_ancestor(found)
    pending: list[tuple[int, int, int, Path]] = []
    pending_bytes = 0
    index = len(chunks)
    for key in sorted(groups, key=lambda k: morton(*k)):
        entries = groups[key]
        size = sum(p.stat().st_size for _, _, _, p in entries)
        if pending and pending_bytes + size > target_bytes:
            meta = write_chunk(out_dir, index, pending)
            chunks.append(meta)
            print(f"chunk {index:03d}  z{meta['zoomRange'][0]}-{meta['zoomRange'][1]}  "
                  f"{meta['tiles']:>7,} 磚  {meta['bytes'] / 1048576:>7.1f} MiB")
            index += 1
            pending, pending_bytes = [], 0
        pending.extend(entries)
        pending_bytes += size
    if pending:
        meta = write_chunk(out_dir, index, pending)
        chunks.append(meta)
        print(f"chunk {index:03d}  z{meta['zoomRange'][0]}-{meta['zoomRange'][1]}  "
              f"{meta['tiles']:>7,} 磚  {meta['bytes'] / 1048576:>7.1f} MiB")

    poi = None
    if poi_src is not None:
        print(f"\n打包 POI：{poi_src.name} ({poi_src.stat().st_size / 1048576:.0f} MB) …", flush=True)
        poi = pack_poi(poi_src, out_dir)
        print(f"  {poi['poiCount']:,} 筆 → {poi['name']}  {poi['bytes'] / 1048576:.0f} MB")

    zooms = sorted(found)
    manifest = {
        "kind": "rudymap-tile-pack",
        "formatVersion": 1,
        "packVersion": pack_version,
        "tileFormat": "png",
        "tileSize": 256,
        "minZoom": zooms[0],
        "maxZoom": zooms[-1],
        "tileCount": sum(c["tiles"] for c in chunks),
        "totalBytes": sum(c["bytes"] for c in chunks),
        "baseUrl": base_url.rstrip("/") + "/",
        "chunks": chunks,
        **({"poi": poi} if poi else {}),
        "attribution": ATTRIBUTION,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiles", type=Path, default=Path("build/rudymap/tiles"))
    ap.add_argument("--out", type=Path, default=Path("build/rudymap/pack"))
    ap.add_argument("--version", required=True, help="packVersion，例如 2026-09")
    ap.add_argument("--base-url", required=True,
                    help="例如 https://<r2-host>/rudymap/2026-09")
    ap.add_argument("--chunk-bytes", type=int, default=CHUNK_TARGET_BYTES)
    ap.add_argument("--poi", type=Path,
                    help="魯地圖 .poi（SQLite）路徑；給了就一併打包進 manifest")
    args = ap.parse_args()

    m = pack(args.tiles, args.out, args.version, args.base_url, args.chunk_bytes, args.poi)
    extra = ""
    if "poi" in m:
        extra = f"，POI {m['poi']['poiCount']:,} 筆（{m['poi']['bytes'] / 1048576:.0f} MB）"
    print(f"\n完成：{len(m['chunks'])} 塊，{m['tileCount']:,} 磚，"
          f"{m['totalBytes'] / 1024 ** 3:.2f} GB{extra}  → {args.out}/manifest.json")


if __name__ == "__main__":
    main()
