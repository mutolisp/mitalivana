#!/usr/bin/env python3
"""把 MapsforgeSrv 出的灰階山體陰影轉成可疊圖的黑色＋alpha 圖磚。

向量版從 `.map` 抽不到山體陰影 —— mapsforge 的陰影是算繪時拿另外的 DEM
（`src/dem` 的 HGT）即時算的，不在圖資裡。所以改成用同一個 MapsforgeSrv、
同一份 DEM、同一組參數跑一個「只有 <hillshading/>」的主題（`style-hs/`），
出來的陰影就與現有 raster 完全同源，不是自己用 gdaldem 調的近似值。

**那個主題的底色必須是不透明白色。** mapsforge 的 `shadeBitmap` 是對既有像素
做混合，畫布全透明的話等於沒東西可陰影，圖磚會整張空白（踩過）。

白底算出來的灰階 L 只落在 191-255（只變暗、最深 25%），所以：

    在白底上  L = 255 × s        （s = 陰影係數）
    要的疊圖  黑色 α = 1 - s      → 疊在任何底色 B 上得到 B × s

也就是 `alpha = 255 - L`，疊上去等同乘算，與 mapsforge 直接畫在地圖上的結果一致。

輸出 LA（灰階＋alpha）PNG：L 整張是 0，壓縮後幾乎不佔空間。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

# alpha 最大值低於這個的圖磚視為平地，整張不畫，不必收進包裡。
MIN_ALPHA = 2


def convert(src: Path, dst: Path) -> int | None:
    """回傳寫出的位元組數；整張沒有陰影則回 None。"""
    grey = Image.open(src).convert("L")
    # L 越暗代表陰影越重 → alpha = 255 - L
    alpha = grey.point(lambda v: 255 - v)
    if alpha.getextrema()[1] < MIN_ALPHA:
        return None
    shade = Image.merge("LA", (Image.new("L", grey.size, 0), alpha))
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp")
    shade.save(tmp, "PNG", optimize=True)
    tmp.replace(dst)
    return dst.stat().st_size


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=Path("build/rudymap/hillshade-raw"))
    ap.add_argument("--out", type=Path, default=Path("build/rudymap/hillshade"))
    args = ap.parse_args()

    if not args.src.is_dir():
        raise SystemExit(f"找不到 {args.src}；先跑 render_tiles.py --task hillshade")

    zooms = sorted(int(d.name) for d in args.src.iterdir() if d.is_dir() and d.name.isdigit())
    total_in = total_out = kept = flat = 0
    for z in zooms:
        z_in = z_out = z_kept = z_flat = 0
        for png in sorted((args.src / str(z)).rglob("*.png")):
            z_in += png.stat().st_size
            size = convert(png, args.out / png.relative_to(args.src))
            if size is None:
                z_flat += 1
            else:
                z_out += size
                z_kept += 1
        print(f"  z{z:<3d} 保留 {z_kept:5,} 張  平地略過 {z_flat:5,}  "
              f"{z_in / 1048576:7.1f} MB → {z_out / 1048576:6.1f} MB")
        total_in += z_in
        total_out += z_out
        kept += z_kept
        flat += z_flat

    print(f"\n完成：{kept:,} 張（平地略過 {flat:,}），"
          f"{total_in / 1048576:.0f} MB → {total_out / 1048576:.0f} MB "
          f"（{total_out / total_in:.0%}）  → {args.out}")


if __name__ == "__main__":
    main()
