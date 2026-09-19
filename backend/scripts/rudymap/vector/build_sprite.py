#!/usr/bin/env python3
"""把魯地圖主題的圖示資源打包成 MapLibre sprite。

主題有 348 個資源（235 SVG + 113 PNG），用在三個地方：

    <area src=...>        面的圖樣填色 → MapLibre 的 fill-pattern
    <symbol src=...>      點圖示       → icon-image
    <lineSymbol src=...>  沿線重複圖示 → icon-image + symbol-placement: line

**同一個檔可能被用在好幾種尺寸**（森林圖樣 z14-16 用 64px、z17+ 用 128px）。
fill-pattern 不像 icon-image 有 icon-size 可以縮放，圖樣一律照 sprite 裡的
原始尺寸鋪，所以每一種尺寸都要各自進 sprite，名稱帶上尺寸。

輸出 sprite.json / sprite.png 與 @2x 版本（MapLibre 會依裝置 DPR 自己挑）。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

NS = "{http://mapsforge.org/renderTheme}"

# 主題沒寫 symbol-width/height 時 mapsforge 用資源本身的尺寸，這裡照做；
# 但 SVG 常常沒有明確尺寸，給一個和主題其他圖示一致的預設。
DEFAULT_SIZE = 20

# sprite 之間留一格，避免取樣時吃到隔壁的邊。
PADDING = 2


def sprite_name(src: str, width: int, height: int) -> str:
    """sprite 裡的名稱。翻譯器要用同一個函式，兩邊才對得起來。"""
    stem = Path(src).stem
    return f"{stem}_{width}x{height}"


def collect(theme: Path) -> dict[tuple[str, int, int], bool]:
    """掃出主題實際引用到的 (檔案, 寬, 高) 組合，值代表「是不是圖樣填色」。

    要分開是因為**圖樣不能套 symbol-scale**：MapLibre 的 fill-pattern 是把圖照
    原尺寸在多邊形裡重複鋪，相位錨在圖磚座標上。尺寸若不是 2 的冪，就除不盡
    512px 的圖磚，圖樣會在每條圖磚邊界重新起算 —— 畫面上就是一格一格的格線
    （森林那種深綠色的格子）。1.15 的縮放會把 128 變成 147，剛好踩中。
    """
    root = ET.parse(theme).getroot()
    wanted: dict[tuple[str, int, int], bool] = {}
    for el in root.iter():
        src = el.get("src")
        if not src:
            continue
        is_pattern = el.tag.split("}")[-1] == "area"
        path = src.removeprefix("file:")
        w = el.get("symbol-width")
        h = el.get("symbol-height")
        if w and h:
            size = (int(w), int(h))
        elif w:
            size = (int(w), int(w))
        elif h:
            size = (int(h), int(h))
        else:
            size = (DEFAULT_SIZE, DEFAULT_SIZE)
        key = (path, *size)
        wanted[key] = wanted.get(key, False) or is_pattern
    return wanted


def rasterize(src: Path, w: int, h: int, scale: float) -> Image.Image:
    """把一個資源畫成 w*scale × h*scale 的 RGBA。"""
    tw, th = max(1, round(w * scale)), max(1, round(h * scale))
    if src.suffix.lower() == ".svg":
        png = subprocess.run(
            ["rsvg-convert", "-w", str(tw), "-h", str(th), "-f", "png", str(src)],
            check=True,
            capture_output=True,
        ).stdout
        import io

        img = Image.open(io.BytesIO(png))
    else:
        img = Image.open(src)
        if img.size != (tw, th):
            img = img.resize((tw, th), Image.LANCZOS)
    return img.convert("RGBA")


def flatten(img: Image.Image, base: tuple[int, int, int]) -> Image.Image:
    """把圖樣壓成完全不透明，半透明的部分先合成到底色上。

    **半透明的面填色在圖磚邊界會疊出一條線**。MapLibre 不會把面裁到圖磚範圍內，
    所以邊界上那一排像素左右兩張圖磚都會畫一次；不透明的顏色畫兩次還是同一色，
    半透明的畫兩次就變深 —— 森林那種深綠色格線就是這樣來的（實測用
    queryRenderedFeatures 在邊界上量到同一個面回傳 2–4 次，兩側各只有 1 次）。

    魯地圖的植被圖樣底下就是陸地底色，所以合成到那個顏色等於原本的長相。
    """
    out = Image.new("RGB", img.size, base)
    out.paste(img.convert("RGBA"), (0, 0), img.convert("RGBA").split()[3])
    return out.convert("RGBA")


def pack(images: dict[str, Image.Image]) -> tuple[Image.Image, dict[str, dict]]:
    """貨架式排版：先照高度分組，再一列一列往下堆。夠用，不必上 MaxRects。"""
    order = sorted(images.items(), key=lambda kv: (-kv[1].height, kv[0]))
    width = 1024
    # 先試排一次算出總高，再真的畫。
    x = y = row_h = 0
    placed: dict[str, tuple[int, int]] = {}
    for name, img in order:
        if x + img.width + PADDING > width:
            x = 0
            y += row_h + PADDING
            row_h = 0
        placed[name] = (x, y)
        x += img.width + PADDING
        row_h = max(row_h, img.height)
    height = y + row_h

    atlas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    index: dict[str, dict] = {}
    for name, img in order:
        px, py = placed[name]
        atlas.paste(img, (px, py))
        index[name] = {"x": px, "y": py, "width": img.width, "height": img.height}
    return atlas, index


def build(theme: Path, res_root: Path, out_base: Path, scale: int,
          symbol_scale: float,
          pattern_base: tuple[int, int, int] = (0xF8, 0xF8, 0xF8)) -> tuple[int, int]:
    wanted = collect(theme)
    images: dict[str, Image.Image] = {}
    failed = 0
    for (src, w, h), is_pattern in wanted.items():
        path = res_root / src
        if not path.exists():
            print(f"  缺資源：{src}")
            failed += 1
            continue
        try:
            # 圖樣維持 2 的冪（不套 symbol-scale），否則會出現圖磚格線。
            factor = scale if is_pattern else scale * symbol_scale
            img = rasterize(path, w, h, factor)
            if is_pattern:
                img = flatten(img, pattern_base)
            images[sprite_name(src, w, h)] = img
        except subprocess.CalledProcessError as e:
            print(f"  轉檔失敗 {src}: {e.stderr.decode()[:120]}")
            failed += 1

    atlas, index = pack(images)
    for entry in index.values():
        entry["pixelRatio"] = scale

    suffix = "" if scale == 1 else f"@{scale}x"
    png = out_base.with_name(out_base.name + suffix + ".png")
    js = out_base.with_name(out_base.name + suffix + ".json")
    atlas.save(png, optimize=True)
    js.write_text(json.dumps(index, ensure_ascii=False, sort_keys=True))
    print(
        f"  {png.name}  {atlas.width}×{atlas.height}  "
        f"{len(index)} 個圖示  {png.stat().st_size / 1024:.0f} KB"
    )
    return len(index), failed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("theme", type=Path)
    ap.add_argument("out_base", type=Path, help="輸出前綴，例：build/rudymap/vector/sprite")
    ap.add_argument(
        "--symbol-scale",
        type=float,
        default=1.15,
        help="與 raster 管線的 symbol-scale 一致（rudy.properties 是 1.15）。"
             "圖樣填色沒有縮放參數，只能在這裡烤進圖裡；sprite 名稱仍用主題寫的尺寸。",
    )
    ap.add_argument(
        "--res-root",
        type=Path,
        default=None,
        help="資源根目錄，預設與主題同一層（主題裡寫的是相對路徑）",
    )
    args = ap.parse_args()

    res_root = args.res_root or args.theme.parent
    args.out_base.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    failed = 0
    for scale in (1, 2):
        n, f = build(args.theme, res_root, args.out_base, scale, args.symbol_scale)
        total, failed = n, failed + f
    print(f"完成：{total} 個圖示，失敗 {failed}")


if __name__ == "__main__":
    main()
