"""Prove the dataset modules answer exactly like the combined twnamelist.db.

Run after every `build_datasets.py`, i.e. after every TaiCOL / YList / 檢索表
update:

    python -m backend.scripts.datasets.verify_datasets [--db …] [--out dist/datasets]

Why this exists rather than "it copied, it must be fine": the split changes
*where* an answer comes from for every query the app makes. A missing index, a
`CREATE TABLE AS SELECT` that dropped a PRIMARY KEY, or an `species_xref` half
that kept the wrong region are all invisible until a user in the field sees a
wrong name. So the checks below re-run the app's own SQL shapes against both
sides and compare results, and they follow Plan.md:1394's rule for keys:
resolve every taxon_id one by one, 0 failures — never just compare totals.
"""

from __future__ import annotations

import argparse
import random
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB = REPO_ROOT / "backend" / "twnamelist.db"
DEFAULT_OUT = REPO_ROOT / "dist" / "datasets"

#: Tables each module is allowed to contain (whitelist + derived).
ALLOWED = {
    "tw-taicol": {"taicol_names", "species_xref", "cname_fuzzy_index"},
    "jp-ylist": {"jp_names", "species_xref", "cname_fuzzy_index_jp"},
    "tw-keys": {
        "identification_keys",
        "key_couplets",
        "key_features",
        "key_taxon_features",
    },
}

failures: list[str] = []
checks = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global checks
    checks += 1
    if ok:
        print(f"  ✓ {label}")
    else:
        failures.append(f"{label}{(' — ' + detail) if detail else ''}")
        print(f"  ✗ {label}{(' — ' + detail) if detail else ''}")


def conn_of(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def tables_of(c: sqlite3.Connection) -> set[str]:
    return {
        r[0]
        for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")
        if not r[0].startswith("sqlite_")
    }


def indexes_of(c: sqlite3.Connection, table: str) -> set[str]:
    return {
        r[0]
        for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
            (table,),
        )
    }


def ddl_of(c: sqlite3.Connection, table: str) -> str:
    row = c.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return " ".join((row[0] or "").split()) if row else ""


def count(c: sqlite3.Connection, table: str, where: str = "", args: tuple = ()) -> int:
    """列數；表不存在回 -1，讓缺表變成一項失敗而不是整支腳本 traceback。"""
    sql = f"SELECT count(*) FROM {table}" + (f" WHERE {where}" if where else "")
    try:
        return int(c.execute(sql, args).fetchone()[0])
    except sqlite3.OperationalError:
        return -1


# ── 1. structure ────────────────────────────────────────────────────────────


def check_structure(master: sqlite3.Connection, mods: dict[str, sqlite3.Connection]) -> None:
    print("\n[結構] 表、索引、DDL")
    for ident, c in mods.items():
        present = tables_of(c)
        extra = present - ALLOWED[ident]
        check(not extra, f"{ident}: 沒有夾帶額外的表", f"多了 {sorted(extra)}")
        for table in ALLOWED[ident] & tables_of(master):
            if table not in present:
                check(False, f"{ident}: 少了 {table}")
                continue
            if table == "species_xref":
                continue  # 依 region 過濾，DDL 由本腳本自建，不比對
            check(
                ddl_of(c, table) == ddl_of(master, table),
                f"{ident}: {table} 的 DDL 與母檔相同",
            )
            missing_idx = indexes_of(master, table) - indexes_of(c, table)
            check(
                not missing_idx,
                f"{ident}: {table} 的索引齊全",
                f"缺 {sorted(missing_idx)}",
            )


# ── 2. row parity ───────────────────────────────────────────────────────────


def check_rows(master: sqlite3.Connection, mods: dict[str, sqlite3.Connection]) -> None:
    print("\n[列數] 逐表與母檔比對")
    for ident, c in mods.items():
        for table in sorted(ALLOWED[ident] & tables_of(master) - {"species_xref"}):
            if table.startswith("cname_fuzzy_index"):
                continue  # 衍生表，在 §4 單獨驗
            m, n = count(master, table), count(c, table)
            check(m == n, f"{ident}: {table} {n} 列", f"母檔 {m}")
    tw, jp = mods.get("tw-taicol"), mods.get("jp-ylist")
    if tw and jp:
        m_tw = count(master, "species_xref", "region = 'TW'")
        m_jp = count(master, "species_xref", "region = 'JP'")
        check(count(tw, "species_xref") == m_tw, f"tw-taicol: species_xref 的 TW 列 {m_tw}")
        check(count(jp, "species_xref") == m_jp, f"jp-ylist: species_xref 的 JP 列 {m_jp}")
        check(
            count(tw, "species_xref", "region != 'TW'") == 0,
            "tw-taicol: species_xref 沒有夾帶別區的列",
        )
        check(
            count(jp, "species_xref", "region != 'JP'") == 0,
            "jp-ylist: species_xref 沒有夾帶別區的列",
        )


# ── 3. query equivalence ────────────────────────────────────────────────────

SEARCH_COLS = (
    "name_id, simple_name, name_author, common_name_c, alternative_name_c, family, "
    "family_c, iucn, redlist, is_endemic, alien_type, taxon_id, usage_status, rank"
)


def sample_names(master: sqlite3.Connection, table: str, n: int) -> list[str]:
    where = "is_in_taiwan LIKE '%true%' AND " if table == "taicol_names" else ""
    rows = master.execute(
        f"SELECT common_name_c FROM {table} WHERE {where}common_name_c != '' "
        f"AND usage_status='accepted' ORDER BY random() LIMIT ?",
        (n,),
    ).fetchall()
    return [r[0] for r in rows]


def check_queries(
    master: sqlite3.Connection, mods: dict[str, sqlite3.Connection], sample: int
) -> None:
    print(f"\n[查詢] app 的搜尋 SQL，母檔 vs 模組（各 {sample} 個名字）")
    for ident, table, scope in (
        ("tw-taicol", "taicol_names", "is_in_taiwan LIKE '%true%'"),
        ("jp-ylist", "jp_names", "region='JP'"),
    ):
        c = mods.get(ident)
        if not c:
            continue
        names = sample_names(master, table, sample)

        # (a) lookupExactAccepted 的等值查詢（含 +usage_status 那道防呆）
        exact_sql = (
            f"SELECT {SEARCH_COLS} FROM {table} WHERE (common_name_c = ? OR simple_name = ?) "
            f"AND +usage_status = 'accepted' AND {scope} LIMIT 5"
        )
        # (b) searchSpecies 的 LIKE 掃描
        like_sql = (
            f"SELECT {SEARCH_COLS} FROM {table} WHERE (common_name_c LIKE ? OR "
            f"alternative_name_c LIKE ? OR simple_name LIKE ? OR family LIKE ? OR "
            f"family_c LIKE ?) AND {scope} LIMIT 100"
        )
        bad_exact = bad_like = 0
        for q in names:
            a = master.execute(exact_sql, (q, q)).fetchall()
            b = c.execute(exact_sql, (q, q)).fetchall()
            if [tuple(r) for r in a] != [tuple(r) for r in b]:
                bad_exact += 1
            pat = f"%{q}%"
            a = master.execute(like_sql, (pat,) * 5).fetchall()
            b = c.execute(like_sql, (pat,) * 5).fetchall()
            if sorted(tuple(r) for r in a) != sorted(tuple(r) for r in b):
                bad_like += 1
        check(bad_exact == 0, f"{ident}: 等值查詢結果相同", f"{bad_exact} 筆不同")
        check(bad_like == 0, f"{ident}: LIKE 查詢結果相同", f"{bad_like} 筆不同")

        # (c) 分類樹的聚合（bundledScope 的 SQL 形狀）
        a = master.execute(
            f"SELECT kingdom, count(DISTINCT genus) FROM {table} WHERE {scope} "
            f"AND usage_status='accepted' GROUP BY kingdom ORDER BY kingdom"
        ).fetchall()
        b = c.execute(
            f"SELECT kingdom, count(DISTINCT genus) FROM {table} WHERE {scope} "
            f"AND usage_status='accepted' GROUP BY kingdom ORDER BY kingdom"
        ).fetchall()
        check([tuple(r) for r in a] == [tuple(r) for r in b], f"{ident}: 各界的屬數相同")


# ── 4. derived indexes ──────────────────────────────────────────────────────


def check_derived(master: sqlite3.Connection, mods: dict[str, sqlite3.Connection]) -> None:
    print("\n[衍生] fuzzy index 與 pinyin")
    for ident, idx_table, names_table in (
        ("tw-taicol", "cname_fuzzy_index", "taicol_names"),
        ("jp-ylist", "cname_fuzzy_index_jp", "jp_names"),
    ):
        c = mods.get(ident)
        if not c:
            continue
        n = count(c, idx_table)
        check(n > 0, f"{ident}: {idx_table} 有 {n} 列")
        # name_ids 必須指得到同一個模組裡的列——拆檔後最容易壞的就是這條
        bad = 0
        rows = c.execute(f"SELECT cname, name_ids FROM {idx_table} ORDER BY random() LIMIT 200")
        for cname, name_ids in rows:
            ids = [int(x) for x in str(name_ids).split(",") if x]
            hit = count(
                c,
                names_table,
                f"name_id IN ({','.join('?' * len(ids))})",
                tuple(ids),
            )
            if hit != len(ids):
                bad += 1
        check(bad == 0, f"{ident}: fuzzy index 的 name_id 都指得到本模組的列", f"{bad} 筆落空")

    tw = mods.get("tw-taicol")
    if tw:
        cols = {r[1] for r in tw.execute("PRAGMA table_info(cname_fuzzy_index)")}
        check("pinyin" in cols, "tw-taicol: cname_fuzzy_index 有 pinyin 欄")
        if "pinyin" in cols:
            empty = count(tw, "cname_fuzzy_index", "pinyin IS NULL OR pinyin = ''")
            total = count(tw, "cname_fuzzy_index")
            check(
                empty < total * 0.05,
                f"tw-taicol: pinyin 已填（空值 {empty}/{total}）",
                "空值過多，build_pinyin_index 可能沒跑",
            )


# ── 5. keys ⋈ names across modules ──────────────────────────────────────────


def check_keys(master: sqlite3.Connection, mods: dict[str, sqlite3.Connection]) -> None:
    keys, tw = mods.get("tw-keys"), mods.get("tw-taicol")
    if not keys or not tw:
        return
    print("\n[檢索表] 跨模組的 taxon 解析（Plan.md:1394：逐一查，0 失敗）")
    targets: set[str] = set()
    for col in ("lead_a_target_id", "lead_b_target_id"):
        for (tid,) in keys.execute(
            f"SELECT DISTINCT {col} FROM key_couplets "
            f"WHERE {col} IS NOT NULL AND {col} LIKE 't%'"
        ):
            targets.add(str(tid))
    for (tid,) in keys.execute("SELECT DISTINCT taxon_id FROM key_taxon_features"):
        targets.add(str(tid))

    missing = [
        tid
        for tid in sorted(targets)
        if count(tw, "taicol_names", "taxon_id = ?", (tid,)) == 0
    ]
    check(
        not missing,
        f"檢索表引用的 {len(targets)} 個 taxon_id 都在 tw-taicol 裡",
        f"{len(missing)} 個查不到，例如 {missing[:5]}",
    )
    m = count(master, "key_couplets")
    check(count(keys, "key_couplets") == m, f"couplet 數與母檔相同（{m}）")


# ── 6. cross-region vernacular ──────────────────────────────────────────────


def check_cross_region(
    master: sqlite3.Connection, mods: dict[str, sqlite3.Connection], sample: int
) -> None:
    tw, jp = mods.get("tw-taicol"), mods.get("jp-ylist")
    if not tw or not jp:
        return
    print("\n[跨區俗名] 單檔自我 JOIN vs 兩段式跨模組查詢")
    ids = [
        r[0]
        for r in master.execute(
            "SELECT x0.taxon_id FROM species_xref x0 JOIN species_xref x1 "
            "ON x1.sci_norm = x0.sci_norm AND x1.region != x0.region "
            "ORDER BY random() LIMIT ?",
            (sample,),
        )
    ]
    bad = 0
    for tid in ids:
        # 母檔：現行的自我 JOIN
        want = {
            (r["region"], r["common_name_c"])
            for r in master.execute(
                "SELECT x1.region, x1.common_name_c FROM species_xref x0 "
                "JOIN species_xref x1 ON x1.sci_norm = x0.sci_norm "
                "WHERE x0.taxon_id = ?",
                (tid,),
            )
        }
        # 模組：① 在自己的模組查 sci_norm ② 拿去對方模組查俗名
        owner, other = (tw, jp) if tid.startswith("t") else (jp, tw)
        row = owner.execute(
            "SELECT sci_norm FROM species_xref WHERE taxon_id = ?", (tid,)
        ).fetchone()
        got: set[tuple[str, str]] = set()
        if row:
            for src in (owner, other):
                for r in src.execute(
                    "SELECT region, common_name_c FROM species_xref WHERE sci_norm = ?",
                    (row["sci_norm"],),
                ):
                    got.add((r["region"], r["common_name_c"]))
        if want != got:
            bad += 1
    check(bad == 0, f"{len(ids)} 個共有種的跨區俗名相同", f"{bad} 筆不同")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Verify dataset modules against the master DB")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--sample", type=int, default=150, help="names per query check")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args(argv)

    if args.seed is not None:
        random.seed(args.seed)
    if not args.db.exists():
        raise SystemExit(f"master DB not found: {args.db}")

    master = conn_of(args.db)
    mods: dict[str, sqlite3.Connection] = {}
    for ident in ALLOWED:
        path = args.out / f"{ident}.db"
        if path.exists():
            mods[ident] = conn_of(path)
        else:
            print(f"（略過 {ident}：{path} 不存在）")
    if not mods:
        raise SystemExit("no module found — run build_datasets.py first")

    check_structure(master, mods)
    check_rows(master, mods)
    check_queries(master, mods, args.sample)
    check_derived(master, mods)
    check_keys(master, mods)
    check_cross_region(master, mods, args.sample)

    print(f"\n{checks - len(failures)}/{checks} 項通過")
    if failures:
        print("\n失敗項目：")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("✓ 模組與母檔等價")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
