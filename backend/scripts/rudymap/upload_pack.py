"""把打包好的魯地圖圖磚包上傳到 Cloudflare R2。

用法：
    python -m backend.scripts.rudymap.upload_pack \\
        --bucket <r2-bucket> --base-url https://<host>/rudymap [--dry-run]

物件配置：

    <prefix>/<packVersion>/chunk-000.zip …   不可變，快取一年
    <prefix>/<packVersion>/manifest.json     該版本的清單
    <prefix>/latest/manifest.json            **app 只讀這一個**，短快取

**latest 一定最後上傳**：任何一塊失敗就不會動到 latest，使用者永遠不會拿到
指向半套圖磚包的清單。同理，每個版本自己的目錄不會被覆寫 —— 舊版留著，還沒
升級的使用者可以把沒下載完的續傳完。

`baseUrl` 在這裡改寫而不是重跑 pack_tiles：換 hosting 不該需要把 1.9 GB 重新
壓一次 zip，chunk 內容本來就不含 URL。

wrangler 只有 get/put/delete，沒有 head，所以「已上傳」靠本地的
`.uploaded.json` 記錄；換一台機器重跑就是全部重傳（put 本身是冪等的）。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

WRANGLER = ["npx", "--yes", "wrangler@latest"]

# 版本化路徑下的 chunk 永遠不會變內容，可以讓 CDN 與裝置無限期快取。
CHUNK_CACHE = "public, max-age=31536000, immutable"
# latest 的清單要能在發新版後很快被看到。
LATEST_CACHE = "public, max-age=300"

STATE_FILE = ".uploaded.json"


def run_put(bucket: str, key: str, local: Path, content_type: str,
            cache_control: str, dry_run: bool) -> None:
    cmd = [
        *WRANGLER, "r2", "object", "put", f"{bucket}/{key}",
        "--file", str(local),
        "--content-type", content_type,
        "--cache-control", cache_control,
        "--remote",
    ]
    if dry_run:
        print("    (dry-run) " + " ".join(cmd[3:]))
        return
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise RuntimeError(f"上傳失敗：{key}")


def load_state(pack: Path) -> set[str]:
    f = pack / STATE_FILE
    if not f.exists():
        return set()
    try:
        return set(json.loads(f.read_text(encoding="utf-8")))
    except Exception:
        return set()


def save_state(pack: Path, done: set[str]) -> None:
    (pack / STATE_FILE).write_text(json.dumps(sorted(done), indent=2), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", type=Path, default=Path("build/rudymap/pack"))
    ap.add_argument("--bucket", required=True, help="R2 bucket 名稱")
    ap.add_argument("--base-url", required=True,
                    help="公開存取的網址前綴，例如 https://map.example.tw/rudymap")
    ap.add_argument("--prefix", default="rudymap", help="bucket 內的路徑前綴")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="忽略 .uploaded.json，全部重傳")
    ap.add_argument("--no-latest", action="store_true",
                    help="只傳版本目錄，不更新 latest/manifest.json")
    args = ap.parse_args()

    manifest_path = args.pack / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("kind") != "rudymap-tile-pack":
        raise SystemExit(f"{manifest_path} 不是圖磚包 manifest")

    version = manifest["packVersion"]
    base = args.base_url.rstrip("/")
    version_dir = f"{args.prefix.strip('/')}/{version}"
    manifest["baseUrl"] = f"{base}/{version}/"

    done = set() if args.force else load_state(args.pack)
    chunks = manifest["chunks"]
    total_bytes = sum(c["bytes"] for c in chunks)

    print(f"bucket   : {args.bucket}")
    print(f"版本     : {version}")
    print(f"baseUrl  : {manifest['baseUrl']}")
    poi_note = ""
    if manifest.get("poi"):
        total_bytes += manifest["poi"]["bytes"]
        poi_note = f" + POI {manifest['poi']['bytes'] / 1048576:.0f} MB"
    print(f"內容     : {len(chunks)} 塊{poi_note} + manifest，{total_bytes / 1024 ** 3:.2f} GB")
    if done:
        print(f"續傳     : 已完成 {len(done)} 個物件，會跳過")
    print()

    sent = 0
    t0 = time.time()
    for i, chunk in enumerate(chunks, 1):
        key = f"{version_dir}/{chunk['name']}"
        if key in done:
            print(f"[{i:>2}/{len(chunks)}] {chunk['name']}  已上傳，跳過")
            continue
        local = args.pack / chunk["name"]
        if not local.exists():
            raise SystemExit(f"缺少 {local}")
        mb = chunk["bytes"] / 1048576
        print(f"[{i:>2}/{len(chunks)}] {chunk['name']}  {mb:>6.1f} MiB …", flush=True)
        run_put(args.bucket, key, local, "application/zip", CHUNK_CACHE, args.dry_run)
        if not args.dry_run:
            done.add(key)
            save_state(args.pack, done)
        sent += chunk["bytes"]

    poi = manifest.get("poi")
    if poi:
        key = f"{version_dir}/{poi['name']}"
        if key in done:
            print(f"\nPOI {poi['name']}  已上傳，跳過")
        else:
            local = args.pack / poi["name"]
            if not local.exists():
                raise SystemExit(f"缺少 {local}")
            print(f"\nPOI {poi['name']}  {poi['bytes'] / 1048576:>6.1f} MiB "
                  f"（{poi['poiCount']:,} 筆）…", flush=True)
            run_put(args.bucket, key, local, "application/zip", CHUNK_CACHE, args.dry_run)
            if not args.dry_run:
                done.add(key)
                save_state(args.pack, done)
            sent += poi["bytes"]

    # 改寫過 baseUrl 的 manifest 寫到暫存檔再上傳，不動 build 產物。
    staged = args.pack / f".manifest-{version}.json"
    staged.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        print(f"\n上傳 {version_dir}/manifest.json")
        run_put(args.bucket, f"{version_dir}/manifest.json", staged,
                "application/json", LATEST_CACHE, args.dry_run)

        if not args.no_latest:
            # 全部成功之後才動 latest：半套的圖磚包永遠不會被 app 看到。
            print(f"上傳 {args.prefix}/latest/manifest.json（指向 {version}）")
            run_put(args.bucket, f"{args.prefix.strip('/')}/latest/manifest.json", staged,
                    "application/json", LATEST_CACHE, args.dry_run)
    finally:
        staged.unlink(missing_ok=True)

    if args.dry_run:
        print(f"\n(dry-run) 沒有實際上傳任何東西。實跑會傳 {sent / 1024 ** 3:.2f} GB。")
    else:
        dt = time.time() - t0
        rate = f"{sent / 1048576 / dt:.1f} MiB/s" if dt > 0 and sent else "—"
        print(f"\n完成：本次上傳 {sent / 1024 ** 3:.2f} GB，耗時 {dt / 60:.1f} 分鐘（{rate}）")
    print(f"\napp 端的 MANIFEST_URL 應設為：")
    print(f"    {base}/latest/manifest.json")


if __name__ == "__main__":
    main()
