"""Split the combined twnamelist.db into downloadable dataset modules.

The mobile app no longer ships a species database; it downloads one module per
dataset from R2 (data.mitalivana.org). This script is what produces them from
the master `backend/twnamelist.db`, which itself is never modified.

    python -m backend.scripts.datasets.build_datasets [--db backend/twnamelist.db]
                                                      [--out dist/datasets]
                                                      [--base-url https://…]

Three design rules worth keeping:

1. **Whitelist, never blacklist.** Each module names the tables it wants. When
   the master grows a table, the default is that it does NOT reach a phone —
   the same reasoning `backup.ts` uses for listing zip entries one by one.
   Today that keeps ~7.5 MB of dead `dao_*` / debris / web-scaffolding tables
   (including `admin_audit`, which currently ships 26 rows of "測試草" test
   edits to every user) out of the download.
2. **ATTACH is fine here.** The no-ATTACH rule is an app-side constraint
   (`src/db/datasets.ts`); on the build machine it is the cheapest correct way
   to copy a subset.
3. **Derived indexes come from the existing tools**, not a second copy of the
   logic: `backend.scripts.build_mobile_fuzzy_index` builds the fuzzy index
   (it skips whichever names table is absent, so the same call works for both
   name modules) and `mobile/app/scripts/build_pinyin_index.mjs` fills the
   pinyin column on the Taiwan module.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import zipfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB = REPO_ROOT / "backend" / "twnamelist.db"
DEFAULT_OUT = REPO_ROOT / "dist" / "datasets"
DEFAULT_BASE_URL = "https://data.mitalivana.org/checklists"
PINYIN_SCRIPT = REPO_ROOT / "mobile" / "app" / "scripts" / "build_pinyin_index.mjs"

MANIFEST_SCHEMA = 1
#: Bump when a module's shape changes in a way older apps cannot read.
MIN_APP_SCHEMA = 1


@dataclass(frozen=True)
class Module:
    """One downloadable dataset module."""

    ident: str
    region: str | None
    #: Tables copied verbatim from the master (the whitelist).
    tables: tuple[str, ...]
    #: Indexes to create after the copy: (name, table, columns).
    indexes: tuple[tuple[str, str, str], ...]
    #: `species_xref` rows to keep, by region. None = don't copy that table.
    xref_region: str | None
    title_zh: str
    title_en: str
    attribution: str
    license: str
    requires: tuple[str, ...] = ()
    #: Table whose row count goes into the manifest (sanity for the client).
    count_table: str | None = None
    #: Run the pinyin filler (Mandarin only).
    pinyin: bool = False
    #: Version, taken from the master unless overridden on the CLI.
    version: str = field(default="")


# Indexes mirror what `taicol_import._create_indexes` + `jp_import` produce, so
# a module is byte-for-byte as queryable as the combined file it came from.
TAICOL_INDEXES = (
    ("idx_taicol_common_name", "taicol_names", "common_name_c"),
    ("idx_taicol_simple_name", "taicol_names", "simple_name"),
    ("idx_taicol_family", "taicol_names", "family"),
    ("idx_taicol_family_c", "taicol_names", "family_c"),
    ("idx_taicol_genus", "taicol_names", "genus"),
    ("idx_taicol_taxon_id", "taicol_names", "taxon_id"),
    ("idx_taicol_usage_status", "taicol_names", "usage_status"),
    ("idx_taicol_kingdom_phylum", "taicol_names", "kingdom, phylum"),
    ("idx_taicol_kingdom_genus", "taicol_names", "kingdom, genus"),
    ("idx_taicol_class", "taicol_names", "class"),
)

JP_INDEXES = (
    ("idx_jp_common_name_c", "jp_names", "common_name_c"),
    ("idx_jp_simple_name", "jp_names", "simple_name"),
    ("idx_jp_family", "jp_names", "family"),
    ("idx_jp_order", "jp_names", '"order"'),
    ("idx_jp_genus", "jp_names", "genus"),
    ("idx_jp_taxon_id", "jp_names", "taxon_id"),
)

KEY_INDEXES = (
    ("ix_identification_keys_scope_name", "identification_keys", "scope_name"),
    ("ix_identification_keys_scope_rank", "identification_keys", "scope_rank"),
    ("ix_identification_keys_scope_taxon_id", "identification_keys", "scope_taxon_id"),
    ("ix_identification_keys_parent_key_id", "identification_keys", "parent_key_id"),
    ("ix_key_couplets_key_id", "key_couplets", "key_id"),
    ("ix_key_features_key_id", "key_features", "key_id"),
    ("ix_key_taxon_features_key_id", "key_taxon_features", "key_id"),
    ("ix_key_taxon_features_taxon_id", "key_taxon_features", "taxon_id"),
    ("ix_key_taxon_features_feature_id", "key_taxon_features", "feature_id"),
)

MODULES: tuple[Module, ...] = (
    Module(
        ident="tw-taicol",
        region="TW",
        tables=("taicol_names",),
        indexes=TAICOL_INDEXES,
        xref_region="TW",
        title_zh="臺灣物種名錄 TaiCOL",
        title_en="Taiwan Species Checklist (TaiCOL)",
        attribution="TaiCOL 臺灣物種名錄",
        license="CC BY 4.0",
        count_table="taicol_names",
        pinyin=True,
    ),
    Module(
        ident="jp-ylist",
        region="JP",
        tables=("jp_names",),
        indexes=JP_INDEXES,
        xref_region="JP",
        title_zh="日本物種名錄 YList / wamei",
        title_en="Japan Species Checklist (YList / wamei)",
        attribution="YList・wamei checklist",
        license="CC BY 4.0",
        count_table="jp_names",
    ),
    Module(
        ident="tw-keys",
        region=None,
        tables=(
            "identification_keys",
            "key_couplets",
            "key_features",
            "key_taxon_features",
        ),
        indexes=KEY_INDEXES,
        xref_region=None,
        title_zh="臺灣植物檢索表",
        title_en="Taiwan Plant Identification Keys",
        attribution="臺灣維管束植物野外鑑定指南 等",
        license="CC BY-NC 4.0",
        # 檢索表的 lead target 全是 t… id，單獨安裝沒有意義。
        requires=("tw-taicol",),
        count_table="identification_keys",
    ),
)

XREF_DDL = """
CREATE TABLE species_xref (
  taxon_id TEXT PRIMARY KEY,
  region TEXT,
  sci_norm TEXT,
  common_name_c TEXT
);
"""


def _master_has(cur: sqlite3.Cursor, name: str) -> bool:
    """Does the ATTACHed master have this table?

    `master.` is load-bearing: querying bare `sqlite_master` here asks the
    brand-new (empty) module file instead, which silently answers "no" and
    skipped `species_xref` entirely — caught by verify_datasets.py, which is
    the whole reason that script exists.
    """
    row = cur.execute(
        "SELECT 1 FROM master.sqlite_master WHERE type='table' AND name=? LIMIT 1;", (name,)
    ).fetchone()
    return row is not None


def _create_like(cur: sqlite3.Cursor, table: str) -> None:
    """Recreate `table` in the module with the master's exact DDL, then fill it.

    Copying the CREATE statement rather than `CREATE TABLE AS SELECT` keeps
    column types, NOT NULL and PRIMARY KEY — `AS SELECT` drops all of them, and
    a lost PRIMARY KEY silently removes the index the app relies on.
    """
    ddl = cur.execute(
        "SELECT sql FROM master.sqlite_master WHERE type='table' AND name=?;", (table,)
    ).fetchone()
    if not ddl or not ddl[0]:
        raise SystemExit(f"master has no table {table}")
    cur.execute(ddl[0])
    cur.execute(f"INSERT INTO {table} SELECT * FROM master.{table};")


def build_module(master: Path, mod: Module, out_dir: Path) -> Path:
    path = out_dir / f"{mod.ident}.db"
    if path.exists():
        path.unlink()

    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute("ATTACH DATABASE ? AS master;", (str(master),))

    for table in mod.tables:
        _create_like(cur, table)

    if mod.xref_region and _master_has(cur, "species_xref"):
        cur.execute(XREF_DDL)
        cur.execute(
            "INSERT INTO species_xref SELECT taxon_id, region, sci_norm, common_name_c "
            "FROM master.species_xref WHERE region = ?;",
            (mod.xref_region,),
        )
        cur.execute("CREATE INDEX idx_xref_sci_norm ON species_xref(sci_norm);")

    for name, table, cols in mod.indexes:
        cur.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table}({cols});")

    conn.commit()
    cur.execute("DETACH DATABASE master;")
    conn.commit()
    conn.close()
    return path


# ─── Intermediate ranks (subfamily, tribe, superfamily, subgenus …) ─────────
#
# The TaiCOL CSVs only carry kingdom…genus, so the tree could never show a
# subfamily. The API's parent links can (fetch_taicol_tree.py snapshots them);
# this folds the newest snapshot into two tables the app reads:
#
#   taxon_tree  — every intermediate-rank taxon some tree child hangs under,
#                 with its intermediate parent (NULL = directly under the
#                 fixed-rank anchor) and that anchor.
#   rank_bridge — per tree child (a fixed-rank taxon, or a species under a
#                 subgenus/section), the intermediates between it and its
#                 fixed-rank parent, top-down, as a JSON array of taxon_ids.
#
# Only children the tree can actually show (accepted, in Taiwan) are kept, so
# the tree search never offers an intermediate that has nothing under it.

TREE_SNAPSHOT_GLOB = "TaiCOL_taxon_tree_*.json.gz"
TREE_SNAPSHOT_DIR = REPO_ROOT / "references" / "TW"
FIXED_RANKS = ("Kingdom", "Phylum", "Class", "Order", "Family", "Genus")
#: Ranks that are neither fixed nor intermediate: above kingdom, or species level.
NON_INTERMEDIATE = {
    "Domain", "Superkingdom", "Realm", "Subrealm", "Unranked",
    "Species", "Subspecies", "Nothosubspecies", "Variety", "Subvariety", "Nothovariety",
    "Form", "Subform", "Special Form", "Race", "Stirp", "Morph", "Aberration",
    "Hybrid Formula",
}
SPECIES_LEVEL_SQL = "rank IN ('Species','Subspecies','Variety','Form')"
IN_TAIWAN_SQL = "is_in_taiwan LIKE '%true%'"

TREE_DDL = """
CREATE TABLE taxon_tree (
  taxon_id TEXT PRIMARY KEY,
  parent_taxon_id TEXT,
  rank TEXT NOT NULL,
  simple_name TEXT NOT NULL,
  common_name_c TEXT,
  kingdom TEXT NOT NULL,
  anchor_rank TEXT NOT NULL,
  anchor_name TEXT NOT NULL
);
CREATE TABLE rank_bridge (
  kingdom TEXT NOT NULL,
  child_rank TEXT NOT NULL,
  child_name TEXT NOT NULL,
  anchor_rank TEXT NOT NULL,
  anchor_name TEXT NOT NULL,
  chain TEXT NOT NULL,
  PRIMARY KEY (kingdom, child_rank, child_name, anchor_name)
);
CREATE INDEX idx_rank_bridge_anchor ON rank_bridge(kingdom, anchor_rank, anchor_name, child_rank);
CREATE INDEX idx_taxon_tree_name ON taxon_tree(simple_name);
CREATE INDEX idx_taxon_tree_cname ON taxon_tree(common_name_c);
"""


def latest_tree_snapshot(directory: Path = TREE_SNAPSHOT_DIR) -> Path:
    found = sorted(directory.glob(TREE_SNAPSHOT_GLOB))
    if not found:
        # Fail loudly: a module without the tables still works in the app, but
        # the tree would silently lose every subfamily users had.
        raise SystemExit(
            f"no {TREE_SNAPSHOT_GLOB} in {directory}; run "
            "`python -m backend.scripts.datasets.fetch_taicol_tree` first"
        )
    return found[-1]


def build_rank_tree(db_path: Path, snapshot: Path) -> tuple[int, int]:
    """Add `taxon_tree` + `rank_bridge` to a built tw-taicol module."""
    with gzip.open(snapshot, "rt", encoding="utf-8") as fh:
        payload = json.load(fh)
    fields = payload["fields"]
    ix = {f: i for i, f in enumerate(fields)}
    taxa = {r[ix["taxon_id"]]: r for r in payload["rows"]}

    def rank_of(tid: str | None) -> str | None:
        r = taxa.get(tid) if tid else None
        return r[ix["rank"]] if r else None

    def is_intermediate(tid: str | None) -> bool:
        rk = rank_of(tid)
        return rk is not None and rk not in FIXED_RANKS and rk not in NON_INTERMEDIATE

    # ~8k records (mostly species/genera) come without `kingdom`; the Kingdom
    # ancestor is authoritative anyway, so walk up to it.
    kingdom_cache: dict[str, str] = {}

    def kingdom_of(tid: str) -> str:
        if tid in kingdom_cache:
            return kingdom_cache[tid]
        path: list[str] = []
        cur: str | None = tid
        found = ""
        while cur and cur in taxa and cur not in kingdom_cache and cur not in path:
            path.append(cur)
            r = taxa[cur]
            if r[ix["rank"]] == "Kingdom":
                found = r[ix["simple_name"]]
                break
            cur = r[ix["parent_taxon_id"]]
        else:
            if cur in kingdom_cache:
                found = kingdom_cache[cur]
        if not found:
            found = taxa[tid][ix["kingdom"]] or ""
        for p in path:
            kingdom_cache[p] = found
        return found

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # What the tree can show: every fixed-rank value on an accepted, in-Taiwan
    # species-level row, and those species themselves (for subgenus/section).
    shown: set[tuple[str, str, str]] = set()
    for col in ("phylum", "class", "order", "family", "genus"):
        q = f'"{col}"' if col in ("order", "class") else col
        for kingdom, name in cur.execute(
            f"SELECT DISTINCT kingdom, {q} FROM taicol_names "
            f"WHERE usage_status='accepted' AND {IN_TAIWAN_SQL} AND {SPECIES_LEVEL_SQL} "
            f"AND {q} IS NOT NULL AND {q} != ''"
        ):
            shown.add((kingdom, col, name))
    for kingdom, name in cur.execute(
        f"SELECT DISTINCT kingdom, simple_name FROM taicol_names "
        f"WHERE usage_status='accepted' AND {IN_TAIWAN_SQL} AND rank='Species'"
    ):
        shown.add((kingdom, "species", name))

    # The listing also carries stale concepts under the same name (~840 pairs,
    # e.g. two Acidobacteriota). Where names collide, the taxon_id the
    # checklist itself accepts wins.
    accepted_ids = {
        r[0]
        for r in cur.execute(
            "SELECT DISTINCT taxon_id FROM taicol_names WHERE usage_status='accepted' AND taxon_id IS NOT NULL"
        )
    }

    # The tree lists child rank C under the fixed rank right above it; a
    # bridge row anchored anywhere else would never be read.
    expected_anchor = {
        "Phylum": "Kingdom", "Class": "Phylum", "Order": "Class",
        "Family": "Order", "Genus": "Family", "Species": "Genus",
    }

    bridge: dict[tuple[str, str, str, str], tuple[bool, list[str]]] = {}
    for tid, row in taxa.items():
        rank = row[ix["rank"]]
        if rank not in expected_anchor:
            continue
        chain: list[str] = []
        p = row[ix["parent_taxon_id"]]
        seen: set[str] = set()
        while is_intermediate(p) and p not in seen:
            seen.add(p)
            chain.append(p)
            p = taxa[p][ix["parent_taxon_id"]]
        if not chain or rank_of(p) != expected_anchor[rank]:
            continue
        kingdom = kingdom_of(tid)
        child_rank = rank.lower()
        name = row[ix["simple_name"]]
        if (kingdom, child_rank, name) not in shown:
            continue
        anchor_rank = expected_anchor[rank].lower()
        anchor_name = taxa[p][ix["simple_name"]]
        chain.reverse()
        key = (kingdom, child_rank, name, anchor_name)
        preferred = tid in accepted_ids
        if key in bridge and (bridge[key][0] or not preferred):
            continue
        bridge[key] = (preferred, chain)

    used: dict[str, tuple[str, str]] = {}  # intermediate taxon_id → anchor
    bridge_rows = []
    for (kingdom, child_rank, name, anchor_name), (_, chain) in bridge.items():
        anchor_rank = expected_anchor[child_rank.capitalize()].lower()
        bridge_rows.append((kingdom, child_rank, name, anchor_rank, anchor_name, json.dumps(chain)))
        for c in chain:
            used[c] = (anchor_rank, anchor_name)

    tree_rows = []
    for tid, (anchor_rank, anchor_name) in used.items():
        r = taxa[tid]
        parent = r[ix["parent_taxon_id"]]
        tree_rows.append((
            tid,
            parent if is_intermediate(parent) else None,
            r[ix["rank"]],
            r[ix["simple_name"]],
            r[ix["common_name_c"]],
            kingdom_of(tid),
            anchor_rank,
            anchor_name,
        ))

    cur.executescript(TREE_DDL)
    cur.executemany("INSERT INTO taxon_tree VALUES (?,?,?,?,?,?,?,?)", tree_rows)
    cur.executemany("INSERT INTO rank_bridge VALUES (?,?,?,?,?,?)", bridge_rows)
    conn.commit()
    conn.close()
    return len(tree_rows), len(bridge_rows)


def _file_md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _row_count(path: Path, table: str) -> int:
    conn = sqlite3.connect(path)
    try:
        return int(conn.execute(f"SELECT count(*) FROM {table};").fetchone()[0])
    finally:
        conn.close()


def _zip(path: Path) -> Path:
    zip_path = path.with_suffix(".db.zip")
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.write(path, arcname=path.name)
    return zip_path


def _run(cmd: list[str]) -> None:
    print("  $", " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=REPO_ROOT)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Build downloadable dataset modules")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help="master twnamelist.db")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help="public base URL")
    ap.add_argument("--version", default=date.today().isoformat(), help="module version")
    ap.add_argument("--only", action="append", help="build only these module ids")
    ap.add_argument("--no-zip", action="store_true", help="skip zipping (faster iteration)")
    ap.add_argument(
        "--tree-snapshot", type=Path, default=None,
        help=f"TaiCOL parent-link snapshot (default: newest {TREE_SNAPSHOT_GLOB})",
    )
    args = ap.parse_args(argv)

    if not args.db.exists():
        raise SystemExit(f"master DB not found: {args.db}")
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    wanted = set(args.only or [m.ident for m in MODULES])
    entries: list[dict] = []

    for mod in MODULES:
        if mod.ident not in wanted:
            continue
        print(f"[{mod.ident}] building…")
        db_path = build_module(args.db, mod, out_dir)

        if mod.ident == "tw-taicol":
            snapshot = args.tree_snapshot or latest_tree_snapshot()
            n_tree, n_bridge = build_rank_tree(db_path, snapshot)
            print(f"  intermediate ranks from {snapshot.name}: {n_tree} taxa, {n_bridge} bridge rows")

        # 衍生索引沿用既有工具（見檔頭規則 3）
        if mod.ident in ("tw-taicol", "jp-ylist"):
            _run([sys.executable, "-m", "backend.scripts.build_mobile_fuzzy_index", str(db_path)])
        if mod.pinyin:
            _run(["node", str(PINYIN_SCRIPT), str(db_path)])

        # VACUUM last: the fuzzy/pinyin steps rewrite pages.
        conn = sqlite3.connect(db_path)
        conn.execute("VACUUM;")
        conn.close()

        raw_bytes = db_path.stat().st_size
        rows = (
            {mod.count_table: _row_count(db_path, mod.count_table)}
            if mod.count_table
            else {}
        )
        payload = db_path if args.no_zip else _zip(db_path)
        entry = {
            "id": mod.ident,
            "region": mod.region,
            "version": args.version,
            "title": {"zh-TW": mod.title_zh, "en": mod.title_en},
            "url": f"{args.base_url.rstrip('/')}/{mod.ident}/{args.version}/{payload.name}",
            "bytes": payload.stat().st_size,
            "uncompressedBytes": raw_bytes,
            "md5": _file_md5(payload),
            "rows": rows,
            "requires": list(mod.requires),
            "minAppSchema": MIN_APP_SCHEMA,
            "attribution": mod.attribution,
            "license": mod.license,
        }
        entries.append(entry)
        print(
            f"[{mod.ident}] {raw_bytes / 1e6:.1f} MB → {entry['bytes'] / 1e6:.1f} MB "
            f"({entry['bytes'] / raw_bytes:.0%}), rows={rows}"
        )

    # `--only` 是部分建置，不能把 manifest 洗成只剩這次做的模組——那會讓 app
    # 以為其他模組消失了。既有條目保留，這次做的覆蓋掉同 id 的舊條目。
    manifest_path = out_dir / "manifest.json"
    kept: list[dict] = []
    if manifest_path.exists():
        try:
            previous = json.loads(manifest_path.read_text())
            built = {e["id"] for e in entries}
            kept = [e for e in previous.get("datasets", []) if e.get("id") not in built]
        except (ValueError, KeyError):
            print("（既有 manifest 讀不動，改為重新產生）")
    order = [m.ident for m in MODULES]
    merged = sorted(kept + entries, key=lambda e: order.index(e["id"]) if e["id"] in order else 99)
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "generated": date.today().isoformat(),
        "datasets": merged,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"\nmanifest → {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
