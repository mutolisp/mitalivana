#!/usr/bin/env python3
"""掃出資料裡的標籤實際用到哪些 glyph range。

為什麼要精算：**缺一個 range 會讓 MapLibre 整張圖算不出來**，不是只有標籤消失。
實測拿掉 CJK 標點那幾段之後，玉山那張只剩下緣一條帶子有內容（其餘全白），而且
console 只報 glyph 404、沒有任何算繪錯誤 —— 上線才發現會很難查。

CJK 本體（U+3400-4DBF、U+4E00-9FFF、U+F900-FAFF）不用產：MapLibre Native 兩個
平台預設都用裝置字型本地算繪，實測 8 個取樣點一次都沒請求過那些 range。但
**標點、注音、全形英數不在本地算繪範圍**（U+3000-30FF、U+FF00-FFEF 等），臺灣的
地名又很常用，所以一定要自己產。

**超出 BMP 的字要算它的 UTF-16 代理半**。MapLibre Native 是按 UTF-16 code unit
決定 range 的，所以 `石𥕢山`（U+25562）會讓它去要 55296-55551 與 56320-56575
這種代理區。瀏覽器端不會有這個行為，所以桌面驗證抓不到 —— 實機第一次開圖就
撞上 `Failed to load glyph range 56832-57087 ... HTTP status code 404`。
全臺資料有 20 個這種字（罕用地名用字，共出現 169 次）。

用法：
    python glyph_ranges.py build/rudymap/vector/z*.geojsonl --out ranges.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

# style 的 text-field 只會用到這幾個 key（translate_theme 的 caption/pathText）。
TEXT_KEYS = ("name", "ele", "ref", "addr:housenumber")

# 本地算繪接手的區段，不必自架。
LOCAL_BLOCKS = [
    (0x3400, 0x4DBF),   # CJK 擴充 A
    (0x4E00, 0x9FFF),   # CJK 統一表意文字
    (0xF900, 0xFAFF),   # CJK 相容表意文字
    (0xAC00, 0xD7AF),   # 韓文音節
]

RANGE_SIZE = 256
MAX_CODEPOINT = 0xFFFF   # MapLibre 的 glyph range 只到 65535


def is_local(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in LOCAL_BLOCKS)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", type=Path, nargs="+")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    needed: set[int] = set()
    local_hits = 0
    over = 0
    for src in args.inputs:
        with src.open() as fh:
            for line in fh:
                if '"name"' not in line and '"ele"' not in line and '"ref"' not in line:
                    continue
                props = json.loads(line).get("properties", {})
                for key in TEXT_KEYS:
                    val = props.get(key)
                    if not isinstance(val, str):
                        continue
                    for ch in val:
                        cp = ord(ch)
                        if cp > MAX_CODEPOINT:
                            # 超出 BMP：MapLibre Native 會去要這個字的 UTF-16
                            # 代理半所在的 range，兩個都要算進來。
                            over += 1
                            enc = ch.encode("utf-16-le")
                            for i in range(0, len(enc), 2):
                                unit = int.from_bytes(enc[i:i + 2], "little")
                                needed.add(unit // RANGE_SIZE)
                            continue
                        if is_local(cp):
                            local_hits += 1
                            continue
                        needed.add(cp // RANGE_SIZE)

    blocks = sorted(needed)
    ranges = [[b * RANGE_SIZE, b * RANGE_SIZE + RANGE_SIZE - 1] for b in blocks]
    args.out.write_text(json.dumps(ranges))
    print(f"  需要自架 {len(ranges)} 個 range（本地算繪接手 {local_hits:,} 個字元，"
          f"超出 BMP 的 {over:,} 個字元改算代理半）")
    for lo, hi in ranges:
        print(f"    {lo}-{hi}")
    print(f"  → {args.out}")


if __name__ == "__main__":
    main()
