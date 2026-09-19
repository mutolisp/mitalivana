"""臺灣圖磚涵蓋範圍與 slippy-map 座標列舉。

魯地圖離線圖磚包的「要 render 哪些磚」由這裡定義。刻意拆成數個小 bbox
取聯集，而不是一個大框：單一大框會把整個臺灣海峽、巴士海峽都算進來，
z15 光是海面就多出十幾萬張磚。
"""

from __future__ import annotations

import math
from typing import Iterator, NamedTuple


class BBox(NamedTuple):
    name: str
    west: float
    south: float
    east: float
    north: float


# 經緯度範圍取自各島群外接矩形，邊界各留約 0.05 度餘裕。
TAIWAN: tuple[BBox, ...] = (
    # 本島、龜山島、小琉球、綠島、蘭嶼都在這個框裡
    BBox("main", 119.98, 21.85, 122.05, 25.35),
    BBox("penghu", 119.30, 23.15, 119.75, 23.85),
    BBox("kinmen", 118.15, 24.35, 118.55, 24.60),
    BBox("matsu", 119.88, 25.90, 120.55, 26.40),
    # 彭佳嶼／棉花嶼／花瓶嶼在本島框的北緣之外
    BBox("north_islets", 121.90, 25.40, 122.15, 25.70),
)


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    """WGS84 經緯度 → Web Mercator 圖磚座標（floor 後的整數）。"""
    n = 1 << z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    # 高緯度/邊界可能算出 n，夾回合法範圍
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_range(box: BBox, z: int) -> tuple[int, int, int, int]:
    """回傳 (x_min, y_min, x_max, y_max)，皆為含端點。"""
    x_min, y_min = lonlat_to_tile(box.west, box.north, z)
    x_max, y_max = lonlat_to_tile(box.east, box.south, z)
    return x_min, y_min, x_max, y_max


def iter_tiles(boxes: tuple[BBox, ...], z: int) -> Iterator[tuple[int, int, int]]:
    """列舉某個 zoom 下所有涵蓋的 (z, x, y)，跨 bbox 去重。"""
    seen: set[tuple[int, int]] = set()
    for box in boxes:
        x_min, y_min, x_max, y_max = tile_range(box, z)
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                if (x, y) not in seen:
                    seen.add((x, y))
                    yield z, x, y


def count_tiles(boxes: tuple[BBox, ...], z_min: int, z_max: int) -> dict[int, int]:
    """各 zoom 的磚數（不實際產生座標，供估算體積用）。"""
    return {z: sum(1 for _ in iter_tiles(boxes, z)) for z in range(z_min, z_max + 1)}


if __name__ == "__main__":
    import sys

    z_max = int(sys.argv[1]) if len(sys.argv) > 1 else 15
    counts = count_tiles(TAIWAN, 0, z_max)
    total = 0
    print(f"{'z':>3} {'tiles':>12} {'cumulative':>12}")
    for z, n in counts.items():
        total += n
        print(f"{z:>3} {n:>12,} {total:>12,}")
    print(f"\nbbox 總磚數 z0-{z_max}: {total:,}")
