"""掃過抽出來的 GeoJSONL，統計每個 tag key 出現過哪些值。

用途是給 translate_theme.py 剪枝：mapsforge 主題涵蓋整個 OSM 標籤宇宙，但 .map
只保留了建圖時 tag-mapping 指定的那些。不剪的話會翻譯出近兩千個 style layer，
其中一大半永遠不會命中任何資料。

值太多的 key（name、ele 之類）標成 null，剪枝時一律當成「可能命中」——
主題也不會對那種 key 比對具體值。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

VALUE_CAP = 2000


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", type=Path, nargs="+")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    index: dict[str, set[str] | None] = {}
    lines = 0
    for path in args.inputs:
        with path.open(encoding="utf-8") as f:
            for line in f:
                lines += 1
                try:
                    props = json.loads(line)["properties"]
                except Exception:
                    continue
                for k, v in props.items():
                    cur = index.get(k, set())
                    if cur is None:
                        continue
                    cur.add(str(v))
                    if len(cur) > VALUE_CAP:
                        index[k] = None  # 值太多：剪枝時當成永遠可能命中
                    else:
                        index[k] = cur

    out = {k: (sorted(v) if v is not None else None) for k, v in index.items()}
    args.out.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    capped = [k for k, v in out.items() if v is None]
    print(f"掃描 {lines:,} 筆，{len(out)} 個 tag key → {args.out} "
          f"({args.out.stat().st_size / 1024:.0f} KB)")
    print(f"  值過多而不剪枝的 key（{len(capped)}）: {', '.join(sorted(capped)[:12])}")


if __name__ == "__main__":
    main()
