"""Snapshot TaiCOL's parent links (`parent_taxon_id`) for the mobile taxonomy tree.

The TaiCOL CSV downloads only carry the six fixed ranks (kingdom…genus), so a
species can never be tied to its subfamily / tribe / superfamily from them.
The API does carry the link: every `/v2/taxon` record has `parent_taxon_id`,
and paging the unfiltered listing returns every taxon concept (~137k).

    python -m backend.scripts.datasets.fetch_taicol_tree [--out references/TW]

Writes `TaiCOL_taxon_tree_YYYYMMDD.json.gz` — a list of
`[taxon_id, parent_taxon_id, rank, simple_name, common_name_c, kingdom]` rows.
`build_datasets.py` turns the newest snapshot into the `taxon_tree` and
`rank_bridge` tables of the tw-taicol module. Re-run after every TaiCOL update.

TaiCOL data is CC BY 4.0 (taicol.tw/zh-hant/policy). The API publishes no rate
limit, so this stays at one request per second (~8 minutes for a full pass).
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = REPO_ROOT / "references" / "TW"
API = "https://api.taicol.tw/v2/taxon"
PAGE = 300  # the API caps `limit` at 300
FIELDS = ("taxon_id", "parent_taxon_id", "rank", "simple_name", "common_name_c", "kingdom")


def _get(url: str, retries: int = 5) -> dict:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "checklister-ng dataset build"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            wait = 5 * (attempt + 1)
            print(f"  retry {attempt + 1}/{retries} after {wait}s: {e}", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"giving up on {url}")


def fetch_all(delay: float) -> list[list]:
    rows: dict[str, list] = {}
    offset = 0
    total = None
    while total is None or offset < total:
        data = _get(f"{API}?limit={PAGE}&offset={offset}")
        total = int(data["info"]["total"])
        page = data.get("data") or []
        if not page:
            break
        for rec in page:
            rows[rec["taxon_id"]] = [rec.get(f) for f in FIELDS]
        offset += PAGE
        print(f"  {min(offset, total)}/{total}", end="\r", flush=True)
        time.sleep(delay)
    print()
    if total is not None and len(rows) != total:
        # Offset paging over a table that changed mid-run, or an API quirk —
        # either way the snapshot would silently drop taxa.
        raise SystemExit(f"got {len(rows)} unique taxa, API reported {total}; re-run")
    return list(rows.values())


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Snapshot TaiCOL parent links")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    args = ap.parse_args(argv)

    rows = fetch_all(args.delay)
    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / f"TaiCOL_taxon_tree_{date.today():%Y%m%d}.json.gz"
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump({"fields": list(FIELDS), "rows": rows}, fh, ensure_ascii=False)
    print(f"{len(rows)} taxa → {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
