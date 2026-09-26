/**
 * Merging survey records — fold several records of one kind into a new one.
 *
 * Only checklists (sessions) and plot surveys merge. Specimen records are left
 * out on purpose: a specimen carries a collection number from the collector's
 * own career series, and re-issuing those numbers to resolve a clash between two
 * trips would rewrite the label already tied to the physical sheet.
 *
 * What the merged record inherits, and why:
 *
 * | field              | from                                                |
 * |--------------------|-----------------------------------------------------|
 * | time started/ended | the UNION — earliest start, latest end / observation |
 * | position, habitat  | the PRIMARY record the user picks                   |
 * | track              | the union of every source's segments                |
 * | recordedBy         | the union, de-duplicated, primary's order first     |
 * | project, site      | the primary                                         |
 * | species records    | every source, in the chosen order                   |
 *
 * Time is a union because a merged record must still answer "when was this
 * surveyed?" honestly — a range that covers every observation it contains.
 * Position is NOT: averaging two plot centres would invent a place nobody
 * surveyed, so the primary's coordinate is used verbatim and the per-record
 * coordinates each observation already carries are preserved untouched.
 *
 * The merged record is always written as finished (`done` / `ended_at` set) and
 * never claims the single-active slot — same rule as an imported record.
 */
import { buildTrackGeoJSON, parseTrackSegments } from '../lib/track';

export type MergeRecordOptions = {
  /** `sessions.name` / `plot_surveys.plotid` for the record being created. */
  name: string;
  /** Which source supplies the metadata above. Must be one of the merged ids;
   *  it is also first in the merge order, so it wins every de-duplication. */
  primaryId: number;
  /** Fold rows describing the same taxon (for a plot survey, the same taxon in
   *  the same layer and subplot) into one, keeping the earlier source's row. Off
   *  keeps every observation, which is the lossless reading of "merge". */
  dedupe: boolean;
  /** Leave the sources in place. When false they are deleted after the merged
   *  record is written — inside the same transaction, so a failure keeps both. */
  keepSources: boolean;
};

/** Primary first, then the rest in the caller's order, with duplicates dropped. */
export function mergeOrder(ids: number[], primaryId: number): number[] {
  return [primaryId, ...ids.filter((id) => id !== primaryId)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
}

/**
 * Union of comma-separated `recorded_by` strings, first occurrence wins.
 * DwC recordedBy is an ordered list of people, so 甲,乙 merged with 乙,丙 is
 * 甲,乙,丙 — not a set with an arbitrary order.
 */
export function unionSurveyors(values: (string | null)[]): string | null {
  const out: string[] = [];
  for (const v of values) {
    for (const nameRaw of (v ?? '').split(',')) {
      const name = nameRaw.trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out.length > 0 ? out.join(',') : null;
}

/**
 * Concatenate the sources' track segments into one MultiLineString.
 *
 * Segments are kept apart rather than joined end to end: two walks are two
 * lines, and stitching them would draw a leg between the end of one and the
 * start of the next that nobody walked.
 */
export function unionTracks(values: (string | null)[]): string | null {
  const segments = values.flatMap((v) => parseTrackSegments(v ?? null));
  const nonEmpty = segments.filter((s) => s.length > 0);
  return nonEmpty.length > 0 ? buildTrackGeoJSON(nonEmpty) : null;
}

/** Latest timestamp among the arguments; ignores null/0. */
export function latest(...values: (number | null | undefined)[]): number {
  return values.reduce<number>((max, v) => (v && v > max ? v : max), 0);
}
