"""用 pngquant 把圖磚轉成 8-bit palette PNG。

**跑這支之前必須先跑 compare_quality.py 並由人眼驗收。** 等高線細線與地名
小字是魯地圖的價值所在，量化指標看不出「等高線斷掉」這種失敗。

預設寫到另一個目錄而非就地覆蓋，方便回頭比對與重跑。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock


def quantize(src: Path, dst: Path, quality: str, speed: int) -> tuple[int, int]:
    """回傳 (原始 bytes, 輸出 bytes)。pngquant 放棄時退回原檔複製。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    before = src.stat().st_size
    proc = subprocess.run(
        ["pngquant", "--quality", quality, "--speed", str(speed),
         "--strip", "--force", "--output", str(dst), "--", str(src)],
        capture_output=True,
    )
    # exit 99 = 達不到要求的品質。這種磚保留原檔，不要犧牲畫質。
    if proc.returncode != 0 or not dst.exists():
        shutil.copyfile(src, dst)
        return before, before
    after = dst.stat().st_size
    if after >= before:                 # 量化後反而變大就別用
        shutil.copyfile(src, dst)
        return before, before
    return before, after


def run(tiles: Path, out: Path, quality: str, speed: int, workers: int) -> None:
    srcs = sorted(tiles.rglob("*.png"))
    if not srcs:
        raise SystemExit(f"{tiles} 裡沒有圖磚")

    total_before = total_after = 0
    kept = 0
    lock = Lock()
    done = 0

    def work(src: Path) -> None:
        nonlocal total_before, total_after, kept, done
        b, a = quantize(src, out / src.relative_to(tiles), quality, speed)
        with lock:
            total_before += b
            total_after += a
            if a == b:
                kept += 1
            done += 1
            if done % 2000 == 0:
                print(f"  {done:,}/{len(srcs):,}  目前 {total_after / total_before:.1%}", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, srcs))

    print(f"\n{len(srcs):,} 張：{total_before / 1024**3:.2f} GB → {total_after / 1024**3:.2f} GB "
          f"（{total_after / total_before:.1%}），其中 {kept:,} 張保留原檔")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiles", type=Path, default=Path("build/rudymap/tiles"))
    ap.add_argument("--out", type=Path, default=Path("build/rudymap/tiles-opt"))
    ap.add_argument("--quality", default="80-95")
    ap.add_argument("--speed", type=int, default=1, help="1 最慢最好，11 最快")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    run(args.tiles, args.out, args.quality, args.speed, args.workers)


if __name__ == "__main__":
    main()
