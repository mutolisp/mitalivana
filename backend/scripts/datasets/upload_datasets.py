#!/usr/bin/env python3
"""Upload the checklist dataset modules to R2 (data.mitalivana.org).

    python -m backend.scripts.datasets.upload_datasets \\
        --bucket mitalivana --base-url https://data.mitalivana.org/checklists \\
        [--out dist/datasets] [--only tw-keys] [--dry-run]

Follows the three rules already proven on the vector-map pipeline
(`rudymap/vector/upload_vector.py`):

1. **A version directory is never overwritten once uploaded**, so files an
   older app points at always stay. Enforced before anything is sent: if any
   version file already exists at its public URL, the whole run aborts.
   Overwriting would not even take effect for clients — those files are served
   `immutable` for a year, so a cached old zip would fail the new manifest's
   md5 check. Build with a new `--version` instead.
2. **`latest/manifest.json` is written last**, so the app never sees a version
   whose files are still uploading.
3. Files under a version directory are cached immutable forever; the manifest
   only for 5 minutes.

Credentials and transport are copied too: boto3 when S3 credentials exist
(large files are chunked), otherwise wrangler. The Taiwan module's zip is
34 MB, which both handle.
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
    """R2 S3 credentials: environment first, then ~/.mitalivana-r2.env. **Never print the values.**"""
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
        region_name="auto",  # R2 only accepts "auto"
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


def published(url: str) -> bool:
    """Whether `url` already answers 200.

    Checked on the public URL so the same test covers both upload paths
    (S3 and wrangler) and needs no credentials. Anything but 200/404 raises:
    when existence cannot be established, refusing to upload is the safe side.
    """
    import urllib.error
    import urllib.request

    # Cloudflare answers 403 to the default "Python-urllib" user agent.
    req = urllib.request.Request(
        url, method="HEAD", headers={"User-Agent": "mitalivana-upload-datasets"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


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

    # 0. Refuse up front if any version file is already published (rule 1).
    #    Checked for every file before the first upload, so a clash never
    #    leaves a half-uploaded version behind. Runs in --dry-run too: it only
    #    reads.
    clashes = []
    for entry in entries:
        if entry["id"] not in wanted:
            continue
        name = Path(entry["url"]).name
        url = f"{base}/{entry['id']}/{entry['version']}/{name}"
        if published(url):
            clashes.append(url)
    if clashes:
        raise SystemExit(
            "這些版本檔已經發布過，不可覆寫（immutable 快取，舊檔會讓 app 的 md5 驗證失敗）：\n  "
            + "\n  ".join(clashes)
            + "\n請用新的 --version 重新 make datasets 後再上傳。"
        )

    # 1. Files under the version directory first (immutable).
    for entry in entries:
        ident = entry["id"]
        if ident not in wanted:
            continue
        version = entry["version"]
        payload = args.out / Path(entry["url"]).name
        if not payload.exists():
            raise SystemExit(f"manifest 指到 {payload.name}，但檔案不在 {args.out}")
        send(f"{prefix}/{ident}/{version}/{payload.name}", payload, IMMUTABLE)
        # The url is only written into the manifest here, so a hosting change
        # needs no rebuild.
        entry["url"] = f"{base}/{ident}/{version}/{payload.name}"

    # 2. A snapshot of the manifest as uploaded (for debugging: what a given
    #    version looked like at the time).
    snapshot = args.out / "manifest.uploaded.json"
    snapshot.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    # 3. latest/manifest.json goes **last** — the app never sees a partial version.
    send(f"{prefix}/latest/manifest.json", snapshot, MANIFEST_CACHE)

    print(f"\n完成。app 讀取：{base}/latest/manifest.json")
    if args.dry_run:
        print("（dry-run：什麼都沒真的上傳）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
