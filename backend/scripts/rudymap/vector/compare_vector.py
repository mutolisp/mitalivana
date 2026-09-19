#!/usr/bin/env python3
"""把向量算繪結果與現有 raster 圖磚並排，產生對照表。

preview_server.py 存下每個取樣點的 PNG 與 bounds（瀏覽器回報的實際地理範圍）。
這支照那個 bounds 去 raster 圖磚目錄拼出同一塊地，兩張並排。

為什麼要靠回報的 bounds 而不是自己算：MapLibre 的 zoom 以 512px 圖磚為基準，
raster 金字塔是 256px，同一個數字的 zoom 並不是同一個比例尺。直接拿實際範圍
反推該用哪一級 raster，就不會踩到這個慣例差。

用法：
    python compare_vector.py                    # 預設路徑
    python compare_vector.py --raster build/rudymap/tiles-opt
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

TILE = 256


def lonlat_to_px(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    n = TILE * (1 << zoom)
    x = (lon + 180.0) / 360.0 * n
    rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0 * n
    return x, y


def pick_zoom(bounds: dict, width: int, available: list[int]) -> int:
    """挑一級 raster，使它的像素寬最接近向量那張圖的寬度。"""
    best, best_err = available[0], float("inf")
    for z in available:
        x0, _ = lonlat_to_px(bounds["west"], bounds["north"], z)
        x1, _ = lonlat_to_px(bounds["east"], bounds["north"], z)
        err = abs((x1 - x0) - width)
        if err < best_err:
            best, best_err = z, err
    return best


def mosaic(raster_root: Path, bounds: dict, zoom: int, size: tuple[int, int]) -> Image.Image | None:
    """從 z/x/y.png 拼出 bounds 涵蓋的那塊，再縮到 size。"""
    x0, y0 = lonlat_to_px(bounds["west"], bounds["north"], zoom)
    x1, y1 = lonlat_to_px(bounds["east"], bounds["south"], zoom)
    tx0, ty0 = int(x0 // TILE), int(y0 // TILE)
    tx1, ty1 = int(x1 // TILE), int(y1 // TILE)

    canvas = Image.new("RGBA", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE), (255, 255, 255, 255))
    found = 0
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            f = raster_root / str(zoom) / str(tx) / f"{ty}.png"
            if not f.exists():
                continue
            canvas.paste(Image.open(f).convert("RGBA"), ((tx - tx0) * TILE, (ty - ty0) * TILE))
            found += 1
    if found == 0:
        return None

    crop = canvas.crop((
        int(x0 - tx0 * TILE), int(y0 - ty0 * TILE),
        int(x1 - tx0 * TILE), int(y1 - ty0 * TILE),
    ))
    return crop.resize(size, Image.LANCZOS)


def sheet(vector: Image.Image, raster: Image.Image | None, label: str, sub: str) -> Image.Image:
    w, h = vector.size
    gap, bar = 12, 34
    out = Image.new("RGB", (w * 2 + gap, h + bar), (24, 24, 24))
    out.paste(raster or Image.new("RGB", (w, h), (60, 60, 60)), (0, bar))
    out.paste(vector.convert("RGB"), (w + gap, bar))
    d = ImageDraw.Draw(out)
    d.text((6, 4), f"{label}   {sub}", fill=(235, 235, 235))
    d.text((6, 18), "raster (existing)", fill=(160, 160, 160))
    d.text((w + gap + 6, 18), "vector (translated)", fill=(160, 200, 160))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shots", type=Path, default=Path("build/rudymap/vector/shots"))
    ap.add_argument("--raster", type=Path, default=Path("build/rudymap/tiles-opt"))
    ap.add_argument("--out", type=Path, default=Path("build/rudymap/vector/compare"))
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    zooms = sorted(int(d.name) for d in args.raster.iterdir() if d.is_dir() and d.name.isdigit())
    print(f"raster 可用 zoom：{zooms}")

    sheets: list[tuple[str, Image.Image]] = []
    for meta_path in sorted(args.shots.glob("*.json")):
        name = meta_path.stem
        png = args.shots / f"{name}.png"
        if not png.exists():
            continue
        bounds = json.loads(meta_path.read_text())
        vec = Image.open(png)
        z = pick_zoom(bounds, vec.width, zooms)
        ras = mosaic(args.raster, bounds, z, vec.size)
        sub = f"maplibre z{bounds['zoom']:.0f} → raster z{z}" + ("" if ras else "（無 raster）")
        out = args.out / f"{name}.png"
        one = sheet(vec, ras, name, sub)
        one.save(out)
        sheets.append((name, one))
        print(f"  {name:14s} {sub}  → {out}")

    if sheets:
        # 一次看完的總表：每列一個取樣點，縮到一半寬度才塞得下。
        scale = 0.5
        w = int(sheets[0][1].width * scale)
        h = int(sheets[0][1].height * scale)
        combined = Image.new("RGB", (w, h * len(sheets)), (24, 24, 24))
        for i, (_, im) in enumerate(sheets):
            combined.paste(im.resize((w, h), Image.LANCZOS), (0, i * h))
        allout = args.out / "_all.png"
        combined.save(allout)
        print(f"\n  總表 {len(sheets)} 列 → {allout}")


if __name__ == "__main__":
    main()
