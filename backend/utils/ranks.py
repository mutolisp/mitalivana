"""Shared rank vocabulary for the species-level SQL filters.

Why this module exists: the same `rank IN (...)` list was written out by hand in
two API modules and they drifted — `taxonomy_api.py` listed 8 occurrences of
('Species','Subspecies','Variety','Form') while `qa_api.py` listed 4 of the same
plus 'Forma'. So the QA panel counted a row the tree, the statistics and the
export all skipped. TaiCOL happens to emit only 'Form' today (3,003 rows,
0 'Forma' as of the 2026-08-26 import), so the divergence costs nothing right
now — which is exactly why it survived. One list, one place.

`Forma` stays in the tuple: it is the Latin nominative that other checklists use
(GBIF and IPNI both emit it), and this filter also runs over region packs that
are not TaiCOL.

Not included, deliberately: `Subform`, `Subvariety`, `Nothosubspecies`,
`Nothovariety`, `Special Form`, `Race`, `Morph`, `Lusus`, `Aberration`. All of
them exist in the current DB and all of them are excluded by both APIs today.
Adding them would change published counts, which is a data decision, not a
cleanup — see `mobile/Plan.md`.
"""

# Ranks that count as "identified to species or finer".
SPECIES_LEVEL_RANKS = ("Species", "Subspecies", "Variety", "Form", "Forma")

# Ranks below species, for the infraspecific tallies.
INFRASPECIFIC_RANKS = ("Subspecies", "Variety", "Form", "Forma")


def sql_in(ranks: tuple[str, ...]) -> str:
    """`'A','B'` — for interpolating into an `IN (...)` clause.

    The values are module constants, never user input, so there is nothing to
    parameterise; the quoting here only exists so the literals stay in one file.
    """
    return ",".join(f"'{r}'" for r in ranks)


SPECIES_LEVEL_SQL = sql_in(SPECIES_LEVEL_RANKS)
INFRASPECIFIC_SQL = sql_in(INFRASPECIFIC_RANKS)
