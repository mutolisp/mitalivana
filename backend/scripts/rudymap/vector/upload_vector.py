#!/usr/bin/env python3
"""把向量地圖的產物上傳到 R2。

    python upload_vector.py --bucket <r2-bucket> --base-url https://<host>/vector \\
        [--version 2026-09-19] [--dry-run]

**為什麼是 PMTiles 而不是逐張圖磚**：向量有 370,899 張、陰影有 2,952 張，
`wrangler r2 object put` 一次只能傳一個物件，逐張傳不可行（也會產生 37 萬次
Class A 操作）。PMTiles 把整個金字塔收成單一檔案，靠 HTTP range 讀取，
上傳從 37 萬個物件變成 2 個。代價是要有一支 Worker 把
`/{z}/{x}/{y}.pbf` 翻譯成對 PMTiles 的範圍請求 —— MapLibre Native 不認
pmtiles 協定，只認一般的圖磚 URL。

**為什麼要 S3 模式**：`wrangler r2 object put` 單檔上限 300 MiB，而整份向量
金字塔是 383 MB。更重要的是 **MapLibre Native 原生支援 `pmtiles://`**，一個
style source 對應一個 .pmtiles 檔 —— 拆成兩份就沒辦法用那條路。給了 R2 的 S3
憑證（`--s3`）就走 boto3 的 multipart，單檔直接上去。

沒有憑證時退回 wrangler，並改傳依 zoom 切開的兩份（線上仍可用，靠 Worker 合併，
但離線的單檔方案就用不了）。

版本目錄一旦上傳就不再覆蓋；`latest/manifest.json` **最後**才寫，這樣
app 不會在檔案還沒齊的時候讀到新版本（沿用 raster 管線的做法）。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

WRANGLER = ["npx", "--yes", "wrangler@latest"]

# R2 的 S3 相容端點。帳號 ID 不是機密（URL 裡就看得到），金鑰才是。
R2_ENDPOINT = "https://{account}.r2.cloudflarestorage.com"

# 憑證檔：每行 KEY=VALUE。刻意放家目錄而不是 repo 裡，避免不小心進版控。
CREDS_FILE = Path.home() / ".mitalivana-r2.env"

# 版本目錄底下的東西永不改動，可以無限期快取。
IMMUTABLE = "public, max-age=31536000, immutable"
# manifest 要能換版，快取短一點。
MANIFEST_CACHE = "public, max-age=300"

CONTENT_TYPES = {
    ".pmtiles": "application/octet-stream",
    ".json": "application/json",
    ".png": "image/png",
    ".pbf": "application/x-protobuf",
}


def load_creds() -> tuple[str, str, str] | None:
    """讀 R2 的 S3 憑證。環境變數優先，其次 ~/.mitalivana-r2.env。

    回傳 (account_id, access_key, secret)；缺任何一項就回 None。
    **不要把值印出來。**
    """
    import os

    values: dict[str, str] = {}
    if CREDS_FILE.exists():
        for line in CREDS_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        if os.environ.get(k):
            values[k] = os.environ[k]
    if all(values.get(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")):
        return (values["R2_ACCOUNT_ID"], values["R2_ACCESS_KEY_ID"],
                values["R2_SECRET_ACCESS_KEY"])
    return None


def make_s3(creds: tuple[str, str, str]):
    import boto3
    from botocore.config import Config

    account, key, secret = creds
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT.format(account=account),
        aws_access_key_id=key,
        aws_secret_access_key=secret,
        # R2 只認 auto
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 5}),
    )


def put_s3(s3, bucket: str, key: str, local: Path, cache: str, dry_run: bool) -> None:
    ctype = CONTENT_TYPES.get(local.suffix, "application/octet-stream")
    size = local.stat().st_size
    print(f"  {key}  {size / 1048576:.1f} MB (s3)", flush=True)
    if dry_run:
        return
    from boto3.s3.transfer import TransferConfig

    # 超過 64 MB 自動切塊平行上傳；R2 的分塊上限是 5 GiB，這裡遠低於。
    cfg = TransferConfig(multipart_threshold=64 * 1024 * 1024,
                         multipart_chunksize=64 * 1024 * 1024,
                         max_concurrency=4)
    s3.upload_file(str(local), bucket, key, Config=cfg,
                   ExtraArgs={"ContentType": ctype, "CacheControl": cache})


def put(bucket: str, key: str, local: Path, cache: str, dry_run: bool) -> None:
    ctype = CONTENT_TYPES.get(local.suffix, "application/octet-stream")
    cmd = [
        *WRANGLER, "r2", "object", "put", f"{bucket}/{key}",
        "--file", str(local),
        "--content-type", ctype,
        "--cache-control", cache,
        "--remote",
    ]
    size = local.stat().st_size
    print(f"  {key}  {size / 1048576:.1f} MB", flush=True)
    if dry_run:
        return
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise RuntimeError(f"上傳失敗：{key}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--base-url", required=True,
                    help="公開存取的前綴，例：https://map.mitalivana.org/vector")
    ap.add_argument("--dir", type=Path, default=Path("build/rudymap/vector"))
    ap.add_argument("--hillshade", type=Path, default=Path("build/rudymap/hillshade.pmtiles"))
    ap.add_argument("--prefix", default="vector")
    ap.add_argument("--poi", type=Path, default=Path("build/rudymap/pack/rudypoi.zip"),
                    help="山域地標壓縮檔。與地圖引擎無關，但放同一份 manifest "
                         "讓 app 只要讀一個地方")
    ap.add_argument("--version", default=date.today().isoformat())
    ap.add_argument("--sprite-name", default="sprite",
                    help="sprite 檔在這一版底下的名字。改樣式或 sprite 時換一個名字，"
                         "舊檔是用 immutable 快取上傳的，原地覆蓋不會生效")
    ap.add_argument("--only-style", action="store_true",
                    help="只重傳 style 與 sprite（圖磚、glyph、POI 不動）。"
                         "樣式或圖示修正時用，免得為了 1 MB 重推 466 MB")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-s3", action="store_true",
                    help="即使有憑證也強制走 wrangler（切檔模式）")
    args = ap.parse_args()

    prefix = args.prefix.strip("/")
    vdir = f"{prefix}/{args.version}"
    base = args.base_url.rstrip("/")

    creds = None if args.no_s3 else load_creds()
    s3 = make_s3(creds) if creds else None
    single = args.dir / "rudy.pmtiles"
    # 有 S3 憑證就傳單檔（MapLibre 的 pmtiles:// 一個 source 只能指一個檔）；
    # 沒有就退回依 zoom 切開的兩份，線上靠 Worker 合併。
    use_single = s3 is not None and single.exists()
    tiles_lo = args.dir / "rudy-z0-14.pmtiles"
    tiles_hi = args.dir / "rudy-z15.pmtiles"
    style = args.dir / "style.json"
    fonts = args.dir / "fonts"
    sprites = sorted(args.dir.glob(f"{args.sprite_name}.*")) + \
              sorted(args.dir.glob(f"{args.sprite_name}@*"))
    required = [single] if use_single else [tiles_lo, tiles_hi]
    for p in (*required, style, args.hillshade):
        if not p.exists():
            raise SystemExit(f"找不到 {p}")

    def send(key: str, local: Path, cache: str) -> None:
        if s3 is not None:
            put_s3(s3, args.bucket, key, local, cache, args.dry_run)
        else:
            put(args.bucket, key, local, cache, args.dry_run)

    font_files = sorted(fonts.rglob("*.pbf")) if fonts.is_dir() else []
    tile_bytes = (single.stat().st_size if use_single
                  else tiles_lo.stat().st_size + tiles_hi.stat().st_size)
    total = (tile_bytes + args.hillshade.stat().st_size
             + style.stat().st_size
             + sum(p.stat().st_size for p in sprites)
             + sum(p.stat().st_size for p in font_files))
    print(f"bucket   : {args.bucket}")
    print(f"版本     : {args.version}")
    print(f"baseUrl  : {base}/{args.version}/")
    print(f"傳輸     : {'S3 multipart（單檔）' if use_single else 'wrangler（依 zoom 切兩份）'}")
    print(f"內容     : {2 if use_single else 3} 個 pmtiles + style"
          f" + {len(sprites)} 個 sprite 檔 + {len(font_files)} 段 glyph，"
          f"共 {total / 1048576:.0f} MB")
    print()

    if not args.only_style:
        if use_single:
            send(f"{vdir}/rudy.pmtiles", single, IMMUTABLE)
        else:
            send(f"{vdir}/rudy-z0-14.pmtiles", tiles_lo, IMMUTABLE)
            send(f"{vdir}/rudy-z15.pmtiles", tiles_hi, IMMUTABLE)
        send(f"{vdir}/hillshade.pmtiles", args.hillshade, IMMUTABLE)
    for p in sprites:
        send(f"{vdir}/{p.name}", p, IMMUTABLE)
    if not args.only_style:
        for p in font_files:
            # 保留 <fontstack>/<range>.pbf 的相對路徑，style 的 glyphs 樣板才對得上
            send(f"{vdir}/fonts/{p.relative_to(fonts)}", p, IMMUTABLE)

    # style 裡的 URL 要指向這一版的實際位置，所以上傳前先改寫
    staged = args.dir / ".style.uploaded.json"
    s = json.loads(style.read_text())
    if use_single:
        # MapLibre Native 原生支援 pmtiles://，直接對 R2 做 range request，
        # 不必經過 Worker；離線時 app 只要把這個 URL 換成 pmtiles://file://…
        src = s["sources"]["rudy"]
        src.pop("tiles", None)
        src["url"] = f"pmtiles://{base}/{args.version}/rudy.pmtiles"
        if "hillshade" in s.get("sources", {}):
            hs = s["sources"]["hillshade"]
            hs.pop("tiles", None)
            hs["url"] = f"pmtiles://{base}/{args.version}/hillshade.pmtiles"
    else:
        s["sources"]["rudy"]["tiles"] = [f"{base}/{args.version}/tiles/{{z}}/{{x}}/{{y}}.pbf"]
        if "hillshade" in s.get("sources", {}):
            s["sources"]["hillshade"]["tiles"] = [
                f"{base}/{args.version}/hillshade/{{z}}/{{x}}/{{y}}.png"
            ]
    s["glyphs"] = f"{base}/{args.version}/fonts/{{fontstack}}/{{range}}.pbf"
    if sprites:
        s["sprite"] = f"{base}/{args.version}/{args.sprite_name}"
    staged.write_text(json.dumps(s, ensure_ascii=False))
    send(f"{vdir}/style.json", staged, MANIFEST_CACHE)
    # 也放一份在 latest/：app 用得到一個穩定網址，才不必在算繪路徑上先抓
    # manifest 再抓 style。裡面的 URL 都是指向這一版的絕對路徑，所以自洽。
    send(f"{prefix}/latest/style.json", staged, MANIFEST_CACHE)

    poi_meta = None
    if args.poi.exists():
        import hashlib
        # --only-style 時 POI 已經在這一版底下了，66 MB 不必再推一次
        if not args.only_style:
            send(f"{vdir}/{args.poi.name}", args.poi, IMMUTABLE)
        poi_meta = {
            "name": f"{base}/{args.version}/{args.poi.name}",
            "installName": "rudypoi.db",
            "bytes": args.poi.stat().st_size,
            "uncompressedBytes": 248_600_000,
            "poiCount": 766_737,
            "md5": hashlib.md5(args.poi.read_bytes()).hexdigest(),
            "sourceComment": "2026.09.17  /  (c) Map data: OSM contributors",
        }

    manifest = {
        "version": args.version,
        "styleUrl": f"{base}/{args.version}/style.json",
        "tilesPmtiles": ([f"{base}/{args.version}/rudy.pmtiles"] if use_single else [
            f"{base}/{args.version}/rudy-z0-14.pmtiles",
            f"{base}/{args.version}/rudy-z15.pmtiles",
        ]),
        "tileBytes": tile_bytes,
        "hillshadePmtiles": f"{base}/{args.version}/hillshade.pmtiles",
        "bytes": total,
        "attribution": "資料基於魯地圖 Taiwan TOPO・© OpenStreetMap 貢獻者（ODbL）・內政部 20 公尺網格 DTM",
        **({"poi": poi_meta} if poi_meta else {}),
    }
    mpath = args.dir / ".manifest.uploaded.json"
    mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    send(f"{vdir}/manifest.json", mpath, MANIFEST_CACHE)
    # 最後才指過去
    send(f"{prefix}/latest/manifest.json", mpath, MANIFEST_CACHE)

    print()
    print(f"完成。app 的樣式網址：{base}/latest/manifest.json → styleUrl")


if __name__ == "__main__":
    main()
