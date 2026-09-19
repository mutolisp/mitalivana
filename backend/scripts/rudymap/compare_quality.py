"""壓縮品質 A/B：產生數字 + **人眼要看的 contact sheet**。

驗收閘門是人，不是數字。魯地圖的價值在等高線細線與地名小字，
「等高線斷掉一截」在 RMSE 上幾乎看不出來。所以這支的主要產出是
原圖／壓縮圖／差異 三欄並排的圖，外加 4× 裁切放大。

**contact sheet 要傳到手機上看，不是在 27 吋螢幕上看。**

量化指標刻意不宣稱是 CIE ΔE：那需要 Lab 色彩轉換與逐像素開根號，
在這裡沒有價值。改用兩個誠實的代理指標：
  rmse            — RGB 空間的均方根誤差（Pillow ImageStat，C 實作）
  pct_ink_changed — 「墨跡像素」中最大通道差 > 閾值的比例。墨跡 =
                    原圖中與該磚眾數背景色差異夠大的像素，也就是等高線、
                    道路、文字。不先挑出墨跡的話，整片底色會把數字稀釋掉。
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat

QUALITY_SETTINGS = ("65-90", "80-95", "90-100")
INK_THRESHOLD = 24          # 與背景色的最大通道差，超過才算墨跡
CHANGED_THRESHOLD = 8       # 壓縮前後的最大通道差，超過才算「被改動」
MIN_INK_FOR_STATS = 2000    # 墨跡像素少於這個數的磚不列入統計：一張近乎空白的
                            # 海岸磚只要動幾十個像素，百分比就會衝到 50%，那是
                            # 指標假象不是品質問題。


def modal_background(img: Image.Image) -> tuple[int, int, int]:
    """取該磚出現最多次的顏色當背景色。"""
    colors = img.convert("RGB").getcolors(maxcolors=256 * 256)
    return max(colors)[1] if colors else (255, 255, 255)


def max_channel_diff(a: Image.Image, b: Image.Image) -> Image.Image:
    """逐像素的最大通道絕對差，回傳單通道 L 影像。"""
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    r, g, bl = diff.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), bl)


def count_above(mask: Image.Image, threshold: int) -> int:
    hist = mask.histogram()
    return sum(hist[threshold + 1:])


def measure(orig_path: Path, quant_path: Path) -> dict:
    orig = Image.open(orig_path).convert("RGB")
    quant = Image.open(quant_path).convert("RGB")

    stat = ImageStat.Stat(ImageChops.difference(orig, quant))
    rmse = (sum(v ** 2 for v in stat.rms) / 3) ** 0.5

    bg = modal_background(orig)
    ink_mask = max_channel_diff(orig, Image.new("RGB", orig.size, bg))
    ink_pixels = count_above(ink_mask, INK_THRESHOLD)

    changed = max_channel_diff(orig, quant)
    # 只看墨跡位置的改動：把非墨跡處歸零
    ink_only = ImageChops.darker(changed, ink_mask.point(lambda v: 255 if v > INK_THRESHOLD else 0))
    changed_ink = count_above(ink_only, CHANGED_THRESHOLD)

    return {
        "bytesBefore": orig_path.stat().st_size,
        "bytesAfter": quant_path.stat().st_size,
        "rmse": round(rmse, 3),
        "inkPixels": ink_pixels,
        "pctInkChanged": round(100 * changed_ink / ink_pixels, 2) if ink_pixels else 0.0,
    }


def contact_sheet(orig_path: Path, quant_path: Path, out: Path, label: str) -> None:
    """原圖 / 壓縮 / 差異 三欄，下方各附 4× 中央裁切。"""
    orig = Image.open(orig_path).convert("RGB")
    quant = Image.open(quant_path).convert("RGB")
    diff = max_channel_diff(orig, quant).point(lambda v: min(255, v * 8)).convert("RGB")

    w = h = orig.width
    crop_box = (w // 2 - 32, h // 2 - 32, w // 2 + 32, h // 2 + 32)
    zooms = [im.crop(crop_box).resize((w, w), Image.NEAREST) for im in (orig, quant, diff)]

    pad, top = 4, 18
    sheet = Image.new("RGB", (w * 3 + pad * 4, top + h + pad + w + pad), (245, 245, 245))
    draw = ImageDraw.Draw(sheet)
    # PIL 內建點陣字型沒有 CJK，標題一律用 ASCII，避免整行變豆腐字
    draw.text((pad, 4), f"{label}   row1 1x: orig | quant | diff x8    row2: 4x crop",
              fill=(20, 20, 20))
    for i, (full, zoom) in enumerate(zip((orig, quant, diff), zooms)):
        x = pad + i * (w + pad)
        sheet.paste(full, (x, top))
        sheet.paste(zoom, (x, top + h + pad))
    sheet.save(out)


def pick_samples(tiles: Path, per_bucket: int, seed: int) -> dict[str, list[Path]]:
    """依 zoom 分層抽樣。z15 最能看出細線損傷，權重最高。"""
    rng = random.Random(seed)
    buckets: dict[str, list[Path]] = {}
    for z in (12, 13, 14, 15):
        pool = list((tiles / str(z)).rglob("*.png")) if (tiles / str(z)).is_dir() else []
        if pool:
            buckets[f"z{z}"] = rng.sample(pool, min(per_bucket, len(pool)))
    return buckets


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiles", type=Path, default=Path("build/rudymap/tiles"))
    ap.add_argument("--out", type=Path, default=Path("build/rudymap-qa"))
    ap.add_argument("--per-bucket", type=int, default=50)
    ap.add_argument("--sheets", type=int, default=3,
                    help="每組設定、每個 zoom 各產幾張 contact sheet")
    ap.add_argument("--seed", type=int, default=20260919)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    buckets = pick_samples(args.tiles, args.per_bucket, args.seed)
    if not buckets:
        raise SystemExit(f"{args.tiles} 裡找不到 z12-15 的圖磚")

    report: dict[str, dict] = {}
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        for quality in QUALITY_SETTINGS:
            rows: list[dict] = []
            sheet_dir = args.out / f"q{quality}"
            sheet_dir.mkdir(parents=True, exist_ok=True)
            sheets_per_bucket: dict[str, int] = {}
            for bucket, paths in buckets.items():
                for src in paths:
                    dst = tmp_dir / f"{quality}_{bucket}_{src.parent.parent.name}_{src.parent.name}_{src.name}"
                    proc = subprocess.run(
                        ["pngquant", "--quality", quality, "--speed", "1", "--strip",
                         "--force", "--output", str(dst), "--", str(src)],
                        capture_output=True)
                    if proc.returncode != 0 or not dst.exists():
                        shutil.copyfile(src, dst)
                    m = measure(src, dst)
                    m["bucket"] = bucket
                    m["tile"] = f"{src.parent.parent.name}/{src.parent.name}/{src.stem}"
                    rows.append(m)
                    if (sheets_per_bucket.get(bucket, 0) < args.sheets
                            and m["inkPixels"] >= MIN_INK_FOR_STATS):
                        contact_sheet(src, dst, sheet_dir / f"{m['tile'].replace('/', '_')}.png",
                                      f"q={quality} {m['tile']}")
                        sheets_per_bucket[bucket] = sheets_per_bucket.get(bucket, 0) + 1

            before = sum(r["bytesBefore"] for r in rows)
            after = sum(r["bytesAfter"] for r in rows)
            # 墨跡統計只看有足夠內容的磚，避免近空白磚的百分比假象
            scored = [r for r in rows if r["inkPixels"] >= MIN_INK_FOR_STATS] or rows
            worst = max(scored, key=lambda r: r["pctInkChanged"])
            report[quality] = {
                "samples": len(rows),
                "scoredSamples": len(scored),
                "sizeRatio": round(after / before, 4),
                "meanRmse": round(sum(r["rmse"] for r in rows) / len(rows), 3),
                "meanPctInkChanged": round(sum(r["pctInkChanged"] for r in scored) / len(scored), 2),
                "worstTile": worst,
                "rows": rows,
            }
            print(f"q={quality:<8} 體積 {after / before:>6.1%}  "
                  f"RMSE {report[quality]['meanRmse']:>6.2f}  "
                  f"墨跡改動 {report[quality]['meanPctInkChanged']:>5.2f}%  "
                  f"（最差 {worst['pctInkChanged']:.2f}% @ {worst['tile']}，"
                  f"n={len(scored)}/{len(rows)}）")

    (args.out / "quality-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\ncontact sheet → {args.out}/q*/")
    print("⚠ 驗收閘門是人眼：把 contact sheet 傳到**手機**上看。")
    print("  1× 下等高線不得斷裂、地名不得糊成一團；不過關就不壓，接受原始體積。")


if __name__ == "__main__":
    main()
