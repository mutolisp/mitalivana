"""Build the species database for the GLORIA web app (web/gloria).

Input is a published `tw-taicol.db` module (``make datasets`` output or the
file downloaded from data.mitalivana.org), not the master database, so CI
needs neither Git LFS nor the backend virtualenv: this script uses only the
standard library.

The output keeps the module's table names and columns, so the mobile search
code (src/db/search.ts, fuzzy.ts) and `datasets.ts` SPECS['tw-taicol'] run on
it unchanged. Only vascular plants (phylum Tracheophyta) are kept, because
GLORIA's species search is scoped to them (useSurvey.ts GLORIA_SEARCH_GROUPS):

- ``taicol_names``: rows with ``phylum = 'Tracheophyta'`` (accepted names and
  their synonyms; synonyms carry the same phylum), with the module's indexes;
- ``cname_fuzzy_index``: entries whose ``name_ids`` (comma-separated
  ``taicol_names.name_id``) point at a kept row, trimmed to the kept ids;
- ``species_xref``, ``taxon_tree``, ``rank_bridge``: the Plantae part.

Writes ``<out>/tw-taicol-tracheophyta.<version>.<sha8>.db.gz`` (content-hashed
so a browser cache can never serve an old file under a new name) and
``<out>/species-manifest.json``.

Usage:
    python3 -m backend.scripts.datasets.build_web_species \
        --module dist/datasets/tw-taicol.db --out web/gloria/public/data [--verify]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Same index set as build_datasets.TAICOL_INDEXES, so the subset is as
# queryable as the module. Imported rather than copied when possible.
try:
    from backend.scripts.datasets.build_datasets import TAICOL_INDEXES
except Exception:  # pragma: no cover - running as a plain script
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_datasets import TAICOL_INDEXES  # type: ignore

PHYLUM = "Tracheophyta"
KINGDOM = "Plantae"
SUBSET = PHYLUM
FILE_STEM = "tw-taicol-tracheophyta"


def _table_sql(cur: sqlite3.Cursor, name: str) -> str | None:
    row = cur.execute(
        "SELECT sql FROM src.sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone()
    return row[0] if row else None


def build(module: Path, out_db: Path) -> dict[str, int]:
    if out_db.exists():
        out_db.unlink()
    con = sqlite3.connect(out_db)
    cur = con.cursor()
    cur.execute("ATTACH DATABASE ? AS src", (f"file:{module}?mode=ro",))

    rows: dict[str, int] = {}

    # taicol_names
    cur.execute(_table_sql(cur, "taicol_names"))
    cur.execute(
        "INSERT INTO main.taicol_names SELECT * FROM src.taicol_names WHERE phylum = ?",
        (PHYLUM,),
    )
    for name, table, cols in TAICOL_INDEXES:
        cur.execute(f"CREATE INDEX {name} ON {table}({cols})")
    rows["taicol_names"] = cur.execute("SELECT count(*) FROM taicol_names").fetchone()[0]

    # cname_fuzzy_index: keep and trim to kept name_ids
    cur.execute(_table_sql(cur, "cname_fuzzy_index"))
    kept_ids = {r[0] for r in cur.execute("SELECT name_id FROM taicol_names")}
    has_pinyin = any(
        r[1] == "pinyin" for r in cur.execute("PRAGMA src.table_info(cname_fuzzy_index)")
    )
    sel = "SELECT cname, name_ids" + (", pinyin" if has_pinyin else "") + " FROM src.cname_fuzzy_index"
    out_rows = []
    for row in cur.execute(sel).fetchall():
        ids = [i for i in str(row[1]).split(",") if i.strip() and int(i) in kept_ids]
        if ids:
            out_rows.append((row[0], ",".join(ids), *row[2:]))
    placeholders = ", ".join("?" * (3 if has_pinyin else 2))
    cols = "cname, name_ids" + (", pinyin" if has_pinyin else "")
    cur.executemany(f"INSERT INTO cname_fuzzy_index ({cols}) VALUES ({placeholders})", out_rows)
    rows["cname_fuzzy_index"] = len(out_rows)

    # species_xref: kept taxa only
    if _table_sql(cur, "species_xref"):
        cur.execute(_table_sql(cur, "species_xref"))
        cur.execute(
            "INSERT INTO species_xref SELECT * FROM src.species_xref "
            "WHERE taxon_id IN (SELECT taxon_id FROM taicol_names)"
        )
        cur.execute("CREATE INDEX idx_xref_sci_norm ON species_xref(sci_norm)")
        rows["species_xref"] = cur.execute("SELECT count(*) FROM species_xref").fetchone()[0]

    # taxon_tree / rank_bridge: Plantae part (small; used by the taxonomy tree)
    for table in ("taxon_tree", "rank_bridge"):
        if not _table_sql(cur, table):
            continue
        cur.execute(_table_sql(cur, table))
        cur.execute(f"INSERT INTO {table} SELECT * FROM src.{table} WHERE kingdom = ?", (KINGDOM,))
        rows[table] = cur.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    if "taxon_tree" in rows:
        cur.execute("CREATE INDEX idx_taxon_tree_name ON taxon_tree(simple_name)")
        cur.execute("CREATE INDEX idx_taxon_tree_cname ON taxon_tree(common_name_c)")
    if "rank_bridge" in rows:
        cur.execute(
            "CREATE INDEX idx_rank_bridge_anchor ON rank_bridge(kingdom, anchor_rank, anchor_name, child_rank)"
        )

    con.commit()
    cur.execute("DETACH DATABASE src")
    cur.execute("VACUUM")
    con.close()
    return rows


def verify(db_path: Path, module: Path) -> list[str]:
    """Row counts against the module, and a few queries the app makes."""
    errors: list[str] = []
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    src = sqlite3.connect(f"file:{module}?mode=ro", uri=True)
    want = src.execute("SELECT count(*) FROM taicol_names WHERE phylum = ?", (PHYLUM,)).fetchone()[0]
    got = con.execute("SELECT count(*) FROM taicol_names").fetchone()[0]
    if got != want:
        errors.append(f"taicol_names: {got} rows, module has {want} {PHYLUM} rows")
    other = con.execute("SELECT count(*) FROM taicol_names WHERE phylum IS NOT ?", (PHYLUM,)).fetchone()[0]
    if other:
        errors.append(f"{other} rows outside {PHYLUM}")
    # Every accepted taxon_id of a kept synonym is kept too.
    dangling = con.execute(
        "SELECT count(DISTINCT taxon_id) FROM taicol_names t WHERE +usage_status != 'accepted' "
        "AND NOT EXISTS (SELECT 1 FROM taicol_names a WHERE a.taxon_id = t.taxon_id AND +a.usage_status = 'accepted')"
    ).fetchone()[0]
    src_dangling = src.execute(
        # `+usage_status`: the low-selectivity usage_status index would otherwise
        # be chosen for the inner lookup and turn it into a scan per row.
        "SELECT count(DISTINCT taxon_id) FROM taicol_names t WHERE phylum = ? AND +usage_status != 'accepted' "
        "AND NOT EXISTS (SELECT 1 FROM taicol_names a WHERE a.taxon_id = t.taxon_id AND +a.usage_status = 'accepted')",
        (PHYLUM,),
    ).fetchone()[0]
    if dangling != src_dangling:
        errors.append(f"{dangling} synonym taxa without an accepted row (module: {src_dangling})")
    # Fuzzy index ids all resolve.
    ids = set()
    for (s,) in con.execute("SELECT name_ids FROM cname_fuzzy_index"):
        ids.update(int(x) for x in s.split(","))
    known = {r[0] for r in con.execute("SELECT name_id FROM taicol_names")}
    if ids - known:
        errors.append(f"{len(ids - known)} fuzzy-index ids do not resolve")
    # Sample lookups the search makes (exact common name, exact scientific name).
    for q in ("玉山圓柏", "Juniperus squamata"):
        n = con.execute(
            "SELECT count(*) FROM taicol_names WHERE common_name_c = ? OR simple_name = ?", (q, q)
        ).fetchone()[0]
        m = src.execute(
            "SELECT count(*) FROM taicol_names WHERE (common_name_c = ? OR simple_name = ?) AND phylum = ?",
            (q, q, PHYLUM),
        ).fetchone()[0]
        if n != m:
            errors.append(f"lookup {q!r}: {n} rows, module has {m}")
    if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        errors.append("integrity_check failed")
    con.close()
    src.close()
    return errors


def module_version(module: Path) -> str:
    manifest = module.parent / "manifest.json"
    if manifest.exists():
        data = json.loads(manifest.read_text(encoding="utf-8"))
        for d in data.get("datasets", []):
            if d.get("id") == "tw-taicol":
                return str(d.get("version"))
    return datetime.fromtimestamp(module.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--module", required=True, type=Path, help="tw-taicol.db module")
    ap.add_argument("--out", required=True, type=Path, help="output directory")
    ap.add_argument("--version", default=None, help="source version (default: from manifest.json)")
    ap.add_argument("--verify", action="store_true", help="check the result against the module")
    args = ap.parse_args(argv)

    module: Path = args.module.resolve()
    if not module.exists():
        print(f"module not found: {module}", file=sys.stderr)
        return 2
    version = args.version or module_version(module)
    args.out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / f"{FILE_STEM}.db"
        rows = build(module, db_path)
        if args.verify:
            errs = verify(db_path, module)
            if errs:
                for e in errs:
                    print(f"verify: {e}", file=sys.stderr)
                return 1
            print("verify: ok")
        raw = db_path.read_bytes()
        sha256 = hashlib.sha256(raw).hexdigest()
        safe_version = "".join(c if c.isalnum() or c in "-." else "-" for c in version)
        name = f"{FILE_STEM}.{safe_version}.{sha256[:8]}.db.gz"
        # Remove older builds so the deploy carries one file.
        for old in args.out.glob(f"{FILE_STEM}.*.db.gz"):
            old.unlink()
        gz_path = args.out / name
        with open(gz_path, "wb") as f, gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(raw)
        manifest = {
            "schema": 1,
            "id": "tw-taicol",
            "subset": SUBSET,
            "version": f"{version}+{sha256[:8]}",
            "sourceVersion": version,
            "file": name,
            "sha256": sha256,
            "bytes": gz_path.stat().st_size,
            "uncompressedBytes": len(raw),
            "rows": rows,
            "attribution": "TaiCOL 臺灣物種名錄",
            "license": "CC BY 4.0",
        }
        (args.out / "species-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(f"{name}: {manifest['bytes'] / 1e6:.2f} MB gz, {manifest['uncompressedBytes'] / 1e6:.1f} MB raw, rows {rows}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
