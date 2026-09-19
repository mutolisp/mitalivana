#!/usr/bin/env python3
"""依翻譯後的 style，把某一段 zoom 根本畫不到的圖徵先濾掉。

為什麼要做：tippecanoe 的 `--drop-densest-as-needed` 是在圖磚超過大小上限時
**隨機**丟最密的圖徵，它不知道主題的規則。實測 MapLibre z11 的一張磚只剩 86 條
等高線，而 z12 的同一塊地有 1,127 條 —— 低 zoom 的等高線幾乎被砍光。

但主題本來就不會在那些 zoom 畫全部等高線：

    raster z9-11  只畫 elevation_major
    raster z12-13 加上 elevation_medium
    raster z14+   才有 elevation_minor

所以正解不是放寬圖磚上限（那只會讓手機解析變慢），而是**告訴 tippecanoe 每個
圖徵最低該從哪一級出現**：畫不到的直接丟掉，畫得到的寫進 `tippecanoe.minzoom`，
低 zoom 的圖磚就不會塞進那一級根本不會畫的東西。

只做「丟掉」不夠：z12 仍然擠滿 z13 才會畫的等高線，tippecanoe 為了塞進 500 KB
會把大面積的森林面丟掉，結果是森林呈方格狀一塊有一塊沒有。

判斷方式：掃過 style 的每一層，取出它 filter 裡「一定要成立」的簡單條件
（頂層 `all` 底下的 `==` / `in` / `has` 與 `$type`），建成索引。對每個圖徵找出
所有可能命中的層，取最小的 minzoom；比 `--max-zoom` 還大就丟掉。

巢狀的 `any` 與否定條件**不納入判斷**，所以這是個保守的近似：可能留下一些其實
畫不到的圖徵，但不會丟掉該畫的。
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path
from typing import Any

TYPE_OF = {"Point": "Point", "MultiPoint": "Point",
           "LineString": "LineString", "MultiLineString": "LineString",
           "Polygon": "Polygon", "MultiPolygon": "Polygon"}


def _simple_kv(node: Any) -> list[tuple[str, Any]] | None:
    """`["==", k, v]` / `["in", k, v...]` → [(k, v), ...]；其他回 None。"""
    if not isinstance(node, list) or len(node) < 3:
        return None
    op, key = node[0], node[1]
    if key == "$type":
        return None
    if op == "==" and len(node) == 3:
        return [(key, node[2])]
    if op == "in":
        return [(key, v) for v in node[2:]]
    return None


def indexable_constraints(filt: Any) -> list[dict[str, Any]]:
    """取出頂層 `all` 底下每個「一定要成立」且可索引的條件。

    三種形態：

        ["==", k, v] / ["in", k, ...]          → {'kv': [(k, v), ...]}
        ["any", <全是上面那種>]                 → {'kv': 合併起來}   ← 多鍵規則
        ["has", k]                              → {'key': k}

    含否定（`!has` / `!=`）或再巢狀的分支一律略過 —— 那種條件可以靠「標籤不存在」
    成立，拿來當索引會誤殺。略過只會讓判斷更保守。
    """
    if not isinstance(filt, list) or not filt:
        return []
    if filt[0] == "all":
        out: list[dict[str, Any]] = []
        for sub in filt[1:]:
            out.extend(indexable_constraints(sub))
        return out

    kv = _simple_kv(filt)
    if kv is not None:
        return [{"kv": kv}]

    if filt[0] == "has" and len(filt) == 2:
        return [{"key": filt[1]}]

    if filt[0] == "any":
        merged: list[tuple[str, Any]] = []
        for branch in filt[1:]:
            part = _simple_kv(branch)
            if part is None:
                return []          # 有否定或巢狀分支 → 整個 any 不可索引
            merged.extend(part)
        return [{"kv": merged}] if merged else []

    return []


class Index:
    """把 style 的層依「第一個具鑑別力的條件」建索引。"""

    def __init__(self, style: dict[str, Any]):
        # (key, value) → 最小 minzoom
        self.by_kv: dict[tuple[str, Any], int] = {}
        # key → 最小 minzoom（只要求該 key 存在的層）
        self.by_key: dict[str, int] = {}
        # 沒有任何 key 條件的層（例如只靠 $type），拿它們的最小 minzoom 當地板
        self.floor: int | None = None

        for layer in style["layers"]:
            if layer.get("type") in (None, "background", "raster"):
                continue
            mz = int(layer.get("minzoom", 0))
            cons = indexable_constraints(layer.get("filter"))
            if not cons:
                self.floor = mz if self.floor is None else min(self.floor, mz)
                continue
            # 條件之間是 AND，所以拿任何一個當索引都不會漏；挑最有鑑別力的那個。
            pick = min(cons, key=lambda c: len(c.get("kv", [])) or 10**6)
            if "kv" in pick:
                for k, v in pick["kv"]:
                    self._put(self.by_kv, (k, v), mz)
            else:
                self._put(self.by_key, pick["key"], mz)

    @staticmethod
    def _put(d: dict, key: Any, mz: int) -> None:
        cur = d.get(key)
        if cur is None or mz < cur:
            d[key] = mz

    def min_zoom(self, props: dict[str, Any]) -> int | None:
        """這個圖徵最低在哪一級可能被畫到；None 代表任何 zoom 都畫不到。"""
        best = self.floor
        for k, v in props.items():
            mz = self.by_kv.get((k, v))
            if mz is not None and (best is None or mz < best):
                best = mz
            mz = self.by_key.get(k)
            if mz is not None and (best is None or mz < best):
                best = mz
        return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--style", type=Path, required=True)
    ap.add_argument("--max-zoom", type=int, required=True,
                    help="這份 GeoJSONL 會被建成哪個 MapLibre zoom 為止")
    ap.add_argument("--min-zoom", type=int, required=True,
                    help="這份 GeoJSONL 的最低 MapLibre zoom；圖徵的可見 zoom 比它高時"
                         "會寫進 tippecanoe.minzoom")
    args = ap.parse_args()

    index = Index(json.loads(args.style.read_text()))
    kept = dropped = 0
    drop_reason: collections.Counter = collections.Counter()
    by_minzoom: collections.Counter = collections.Counter()

    with args.src.open() as fin, args.out.open("w") as fout:
        for line in fin:
            f = json.loads(line)
            props = {k: v for k, v in f.get("properties", {}).items() if k != "_layer"}
            mz = index.min_zoom(props)
            if mz is None or mz > args.max_zoom:
                dropped += 1
                # 記個大概，方便人工檢查有沒有誤殺
                tag = next((f"{k}={v}" for k, v in props.items()
                            if k in ("contour_ext", "highway", "natural", "landuse",
                                     "building", "man_made", "amenity")), "（其他）")
                drop_reason[tag] += 1
                continue
            kept += 1
            if mz > args.min_zoom:
                # tippecanoe 的 per-feature 設定：這個圖徵從 mz 才開始出現。
                f["tippecanoe"] = {"minzoom": mz}
                by_minzoom[mz] += 1
                fout.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
            else:
                by_minzoom[args.min_zoom] += 1
                fout.write(line)

    total = kept + dropped
    print(f"  {args.src.name} → {args.out.name}（≤ MapLibre z{args.max_zoom}）")
    print(f"    保留 {kept:,} / {total:,}（丟掉 {dropped:,}，{dropped / total:.0%}）")
    for tag, n in drop_reason.most_common(6):
        print(f"      丟：{tag:32s} {n:,}")
    print("    保留的圖徵各從哪一級開始出現：")
    for z in sorted(by_minzoom):
        print(f"      z{z}: {by_minzoom[z]:,}")


if __name__ == "__main__":
    main()
