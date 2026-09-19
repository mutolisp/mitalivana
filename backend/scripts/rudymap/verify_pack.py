"""校驗打包產物：manifest 對得上、每張磚都是合法的 256×256 PNG。

發佈到 R2 之前一定要跑。app 端只比對 md5，這裡連 sha256、磚數、PNG 尺寸
一起查，把「render 到一半的壞磚」擋在發佈前。

PNG 尺寸直接讀 IHDR（前 24 bytes），不引入 Pillow。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import zipfile
from pathlib import Path

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_size(data: bytes) -> tuple[int, int] | None:
    """回傳 (width, height)，非合法 PNG 則 None。"""
    if len(data) < 24 or not data.startswith(PNG_MAGIC):
        return None
    if data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def verify(pack_dir: Path, deep: bool) -> int:
    manifest = json.loads((pack_dir / "manifest.json").read_text(encoding="utf-8"))
    problems: list[str] = []
    total_tiles = 0

    for chunk in manifest["chunks"]:
        path = pack_dir / chunk["name"]
        if not path.exists():
            problems.append(f"{chunk['name']}: 檔案不存在")
            continue

        raw = path.read_bytes()
        if len(raw) != chunk["bytes"]:
            problems.append(f"{chunk['name']}: 大小 {len(raw)} != manifest {chunk['bytes']}")
        if hashlib.md5(raw).hexdigest() != chunk["md5"]:
            problems.append(f"{chunk['name']}: md5 不符")
        if hashlib.sha256(raw).hexdigest() != chunk["sha256"]:
            problems.append(f"{chunk['name']}: sha256 不符")

        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            if len(names) != chunk["tiles"]:
                problems.append(f"{chunk['name']}: 磚數 {len(names)} != manifest {chunk['tiles']}")
            for info in zf.infolist():
                if info.compress_type != zipfile.ZIP_STORED:
                    problems.append(f"{chunk['name']}/{info.filename}: 不是 STORED")
                    break
            for name in names:
                parts = name.split("/")
                if len(parts) != 3 or not all(p.isdigit() for p in parts):
                    problems.append(f"{chunk['name']}: entry 名稱格式錯誤 {name!r}")
                    continue
                if deep:
                    data = zf.read(name)
                    size = png_size(data)
                    if size is None:
                        problems.append(f"{chunk['name']}/{name}: 不是合法 PNG（{len(data)} bytes）")
                    elif size != (manifest["tileSize"], manifest["tileSize"]):
                        problems.append(f"{chunk['name']}/{name}: 尺寸 {size}")
            total_tiles += len(names)

        print(f"  {chunk['name']}  {len(names):>7,} 磚  {len(raw) / 1048576:>7.1f} MiB  ok")

    if total_tiles != manifest["tileCount"]:
        problems.append(f"總磚數 {total_tiles:,} != manifest {manifest['tileCount']:,}")

    print(f"\npackVersion={manifest['packVersion']}  z{manifest['minZoom']}-{manifest['maxZoom']}  "
          f"{total_tiles:,} 磚  {manifest['totalBytes'] / 1024 ** 3:.2f} GB")
    if problems:
        print(f"\n✗ {len(problems)} 個問題：")
        for p in problems[:50]:
            print(f"    {p}")
        return 1
    print("✓ 全部通過")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", type=Path, default=Path("build/rudymap/pack"))
    ap.add_argument("--quick", action="store_true",
                    help="只查雜湊與磚數，跳過逐張 PNG 解析")
    args = ap.parse_args()
    raise SystemExit(verify(args.pack, deep=not args.quick))


if __name__ == "__main__":
    main()
