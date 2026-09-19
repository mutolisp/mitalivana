#!/usr/bin/env python3
"""把名錄模組上傳到 R2（data.mitalivana.org）。

    python -m backend.scripts.datasets.upload_datasets \\
        --bucket mitalivana --base-url https://data.mitalivana.org/checklists \\
        [--out dist/datasets] [--only tw-keys] [--dry-run]

沿用向量地圖那條管線已經驗證過的三條規則（`rudymap/vector/upload_vector.py`）：

1. **版本目錄一旦上傳就不再覆蓋**，所以舊版 app 指到的檔案永遠還在。
2. **`latest/manifest.json` 最後才寫**，app 不會在檔案還沒傳完時就看到新版本。
3. 版本目錄底下的檔案 immutable 永久快取，manifest 只快取 5 分鐘。

憑證與上傳方式也照抄：有 S3 憑證就走 boto3（大檔自動分塊），沒有就退回 wrangler。
臺灣名錄的 zip 有 34 MB，兩條路都吃得下。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = REPO_ROOT / "dist" / "datasets"
DEFAULT_BASE_URL = "https://data.mitalivana.org/checklists"
DEFAULT_PREFIX = "checklists"

WRANGLER = ["npx", "--yes", "wrangler@latest"]
R2_ENDPOINT = "https://{account}.r2.cloudflarestorage.com"
CREDS_FILE = Path.home() / ".mitalivana-r2.env"

IMMUTABLE = "public, max-age=31536000, immutable"
MANIFEST_CACHE = "public, max-age=300"

CONTENT_TYPES = {".zip": "application/zip", ".json": "application/json"}


def load_creds() -> tuple[str, str, str] | None:
    """R2 的 S3 憑證。環境變數優先，其次 ~/.mitalivana-r2.env。**不要印出值。**"""
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
        return (
            values["R2_ACCOUNT_ID"],
            values["R2_ACCESS_KEY_ID"],
            values["R2_SECRET_ACCESS_KEY"],
        )
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
        region_name="auto",  # R2 只認 auto
        config=Config(signature_version="s3v4", retries={"max_attempts": 5}),
    )


def put_s3(s3, bucket: str, key: str, local: Path, cache: str, dry_run: bool) -> None:
    ctype = CONTENT_TYPES.get(local.suffix, "application/octet-stream")
    print(f"  {key}  {local.stat().st_size / 1048576:.1f} MB (s3)", flush=True)
    if dry_run:
        return
    from boto3.s3.transfer import TransferConfig

    cfg = TransferConfig(
        multipart_threshold=64 * 1024 * 1024,
        multipart_chunksize=64 * 1024 * 1024,
        max_concurrency=4,
    )
    s3.upload_file(
        str(local), bucket, key, Config=cfg,
        ExtraArgs={"ContentType": ctype, "CacheControl": cache},
    )


def put_wrangler(bucket: str, key: str, local: Path, cache: str, dry_run: bool) -> None:
    ctype = CONTENT_TYPES.get(local.suffix, "application/octet-stream")
    print(f"  {key}  {local.stat().st_size / 1048576:.1f} MB", flush=True)
    if dry_run:
        return
    proc = subprocess.run(
        [
            *WRANGLER, "r2", "object", "put", f"{bucket}/{key}",
            "--file", str(local),
            "--content-type", ctype,
            "--cache-control", cache,
            "--remote",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise RuntimeError(f"上傳失敗：{key}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload dataset modules to R2")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="build output directory")
    ap.add_argument("--bucket", required=True, help="R2 bucket name")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help="public base URL")
    ap.add_argument("--prefix", default=DEFAULT_PREFIX, help="key prefix inside the bucket")
    ap.add_argument("--only", action="append", help="upload only these module ids")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    manifest_path: Path = args.out / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"找不到 {manifest_path} —— 先跑 make datasets")
    manifest = json.loads(manifest_path.read_text())
    entries = manifest.get("datasets", [])
    wanted = set(args.only) if args.only else {e["id"] for e in entries}

    creds = load_creds()
    s3 = make_s3(creds) if creds else None
    print(f"上傳方式：{'S3（boto3）' if s3 else 'wrangler'}{'（dry-run）' if args.dry_run else ''}")

    def send(key: str, local: Path, cache: str) -> None:
        if s3:
            put_s3(s3, args.bucket, key, local, cache, args.dry_run)
        else:
            put_wrangler(args.bucket, key, local, cache, args.dry_run)

    base = args.base_url.rstrip("/")
    prefix = args.prefix.strip("/")

    # ① 先傳版本目錄底下的檔案（immutable）
    for entry in entries:
        ident = entry["id"]
        if ident not in wanted:
            continue
        version = entry["version"]
        payload = args.out / Path(entry["url"]).name
        if not payload.exists():
            raise SystemExit(f"manifest 指到 {payload.name}，但檔案不在 {args.out}")
        send(f"{prefix}/{ident}/{version}/{payload.name}", payload, IMMUTABLE)
        # url 在這裡才寫進 manifest，換 hosting 不必重新打包
        entry["url"] = f"{base}/{ident}/{version}/{payload.name}"

    # ② 版本目錄自己的 manifest 快照（除錯用：知道某一版當時長什麼樣）
    snapshot = args.out / "manifest.uploaded.json"
    snapshot.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    # ③ latest/manifest.json **最後**才傳 —— 半套的版本永遠不會被 app 看到
    send(f"{prefix}/latest/manifest.json", snapshot, MANIFEST_CACHE)

    print(f"\n完成。app 讀取：{base}/latest/manifest.json")
    if args.dry_run:
        print("（dry-run：什麼都沒真的上傳）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
