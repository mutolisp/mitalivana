"""驗證**已發佈**的圖磚包 app 真的拿得到。

`verify_pack.py` 驗的是本機打包產物；這一支驗的是線上實況 —— 兩者不一樣：
物件可能沒傳完、baseUrl 可能寫錯、自訂網域可能還在佈建、快取標頭可能沒套上。
每次發新版都該跑。

檢查項目（完全照 app 端的取用方式，匿名 GET，不帶任何認證）：
  1. latest/manifest.json 取得、格式正確、baseUrl 指向這一版
  2. 每一塊都存在、Content-Length 與 manifest 相符、Content-Type 是 application/zip
  3. 抽樣完整下載並比對 md5（app 端就是比 md5）
  4. chunk 有 immutable 快取標頭（沒有的話每次安裝都會回源，流量爆掉）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import urllib.error
import urllib.request

DEFAULT_MANIFEST = "https://map.mitalivana.org/rudymap/latest/manifest.json"


# Cloudflare 會擋掉 urllib 的預設 UA（實測直接 403，換成任何其他字串就 200）。
# app 端也明確帶 UA（src/lib/apiFetch.ts 的 USER_AGENT），這裡用同一個字串，
# 驗的才是 app 真正會走的路徑。
USER_AGENT = "Checklister-NG/1.0 (Taiwan species checklist; mutolisp@gmail.com)"


def fetch(url: str, timeout: int = 120, head: bool = False):
    req = urllib.request.Request(url, method="HEAD" if head else "GET",
                                 headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req, timeout=timeout)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest-url", default=DEFAULT_MANIFEST)
    ap.add_argument("--sample", type=int, default=2,
                    help="完整下載並比對 md5 的塊數（0 = 只查標頭）")
    ap.add_argument("--all", action="store_true", help="每一塊都完整下載比對（很慢）")
    args = ap.parse_args()

    problems: list[str] = []

    print(f"取得 {args.manifest_url}")
    try:
        with fetch(args.manifest_url) as r:
            manifest = json.loads(r.read())
            cc = r.headers.get("cache-control", "")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"✗ manifest 取不到：HTTP {e.code}")

    if manifest.get("kind") != "rudymap-tile-pack":
        raise SystemExit("✗ 不是圖磚包 manifest")

    version = manifest["packVersion"]
    base = manifest["baseUrl"]
    print(f"  packVersion={version}  z{manifest['minZoom']}-{manifest['maxZoom']}  "
          f"{manifest['tileCount']:,} 磚  {manifest['totalBytes'] / 1024 ** 3:.2f} GB")
    print(f"  baseUrl={base}")
    print(f"  cache-control={cc or '(無)'}")
    if version not in base:
        problems.append(f"baseUrl 沒有指向這一版（{version}）：{base}")
    if not manifest.get("attribution"):
        problems.append("manifest 缺 attribution —— 授權要求要標示來源")

    chunks = manifest["chunks"]
    print(f"\n檢查 {len(chunks)} 塊的標頭…")
    missing = 0
    for c in chunks:
        url = f"{base}{c['name']}"
        try:
            with fetch(url, head=True) as r:
                length = int(r.headers.get("content-length", -1))
                ctype = r.headers.get("content-type", "")
                cache = r.headers.get("cache-control", "")
        except urllib.error.HTTPError as e:
            problems.append(f"{c['name']}: HTTP {e.code}")
            missing += 1
            continue
        if length != c["bytes"]:
            problems.append(f"{c['name']}: 大小 {length} != manifest {c['bytes']}")
        if "zip" not in ctype:
            problems.append(f"{c['name']}: content-type={ctype!r}")
        if "immutable" not in cache:
            problems.append(f"{c['name']}: 缺 immutable 快取標頭（cache-control={cache!r}）")
    print(f"  缺少 {missing} 塊")

    targets = chunks if args.all else random.sample(chunks, min(args.sample, len(chunks)))
    if targets:
        print(f"\n完整下載並比對 md5（{len(targets)} 塊）…")
    for c in targets:
        url = f"{base}{c['name']}"
        try:
            with fetch(url) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            problems.append(f"{c['name']}: 下載失敗 HTTP {e.code}")
            continue
        got = hashlib.md5(data).hexdigest()
        ok = got == c["md5"]
        print(f"  {c['name']}  {len(data) / 1048576:>6.1f} MiB  {'✓' if ok else '✗ md5 不符'}")
        if not ok:
            problems.append(f"{c['name']}: md5 {got} != {c['md5']}")

    if problems:
        print(f"\n✗ {len(problems)} 個問題：")
        for p in problems[:40]:
            print(f"    {p}")
        raise SystemExit(1)
    print("\n✓ 發佈的圖磚包 app 可以正常取用")


if __name__ == "__main__":
    main()
