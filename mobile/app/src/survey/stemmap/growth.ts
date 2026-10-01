/**
 * Growth between two censuses and the extreme-growth re-measure list
 * (docs/planned/Modular_survey.md §8.4).
 *
 * Condit (1998), book p.86 (PDF p.97): once part of a recensus is entered,
 * plants are split into dbh classes 10–19, 20–39, 40–79, 80–159, 160–319 and
 * ≥320 mm, growth rates are ranked within each class, and the extremes at both
 * ends are re-measured in the field. Growth is only valid between censuses
 * measured at the same POM (book p.164, PDF p.175).
 *
 * App's choices: the rate ranked is the absolute annual increment (cm/yr);
 * each end of a class lists max(min, ceil(pct × n)) stems (5 % and 3 by
 * default, decided 2026-10-01); a value off by a factor of ten or more is
 * flagged at entry (Condit reports 10-fold dbh errors as common, book p.86).
 *
 * Pure: check:stemmap runs it under Node.
 */
export type Measure = { dbhCm: number | null; pomSeq: number; measuredAt: number | null };

export type Growth =
  | { valid: true; deltaCm: number; annualCm: number }
  | { valid: false; reason: 'missing' | 'pom_changed' | 'no_interval' };

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export function growth(prev: Measure, cur: Measure): Growth {
  if (prev.dbhCm == null || cur.dbhCm == null || prev.dbhCm <= 0 || cur.dbhCm <= 0) return { valid: false, reason: 'missing' };
  if (prev.pomSeq !== cur.pomSeq) return { valid: false, reason: 'pom_changed' };
  if (prev.measuredAt == null || cur.measuredAt == null || cur.measuredAt <= prev.measuredAt) {
    return { valid: false, reason: 'no_interval' };
  }
  const deltaCm = cur.dbhCm - prev.dbhCm;
  return { valid: true, deltaCm, annualCm: deltaCm / ((cur.measuredAt - prev.measuredAt) / YEAR_MS) };
}

/** Lower bounds (mm) of Condit's six dbh classes. */
export const CONDIT_QA_CLASSES_MM: readonly number[] = [10, 20, 40, 80, 160, 320];

/** Class index (0–5) of a dbh in cm, or null below 10 mm. */
export function qaClass(dbhCm: number): number | null {
  const mm = dbhCm * 10;
  for (let i = CONDIT_QA_CLASSES_MM.length - 1; i >= 0; i--) if (mm >= CONDIT_QA_CLASSES_MM[i]) return i;
  return null;
}

export type ExtremeItem = { id: string; dbhCm: number; annualCm: number };
/** `few`: the class has too few stems to rank, so all are re-measured. */
export type ExtremePick = { id: string; end: 'high' | 'low' | 'few'; qaClass: number };

/** The stems to re-measure: both ends of every dbh class. */
export function extremeList(items: readonly ExtremeItem[], pct = 0.05, min = 3): ExtremePick[] {
  const byClass = new Map<number, ExtremeItem[]>();
  for (const it of items) {
    const k = qaClass(it.dbhCm);
    if (k == null) continue;
    (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(it);
  }
  const out: ExtremePick[] = [];
  for (const [k, list] of [...byClass.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => a.annualCm - b.annualCm || a.id.localeCompare(b.id));
    const n = Math.max(min, Math.ceil(pct * sorted.length));
    if (2 * n >= sorted.length) {
      sorted.forEach((it) => out.push({ id: it.id, end: 'few', qaClass: k }));
      continue;
    }
    for (const it of sorted.slice(0, n)) out.push({ id: it.id, end: 'low', qaClass: k });
    for (const it of sorted.slice(-n)) out.push({ id: it.id, end: 'high', qaClass: k });
  }
  return out;
}

export type EntryHint = 'shrank' | 'tenfold' | 'pom_changed';

/** Soft hints shown while typing — never a reason to refuse the save
 *  (Condit book p.83: a smaller dbh "still must be recorded"). */
export function entryHints(prev: Measure | null, cur: Measure): EntryHint[] {
  if (!prev || prev.dbhCm == null || cur.dbhCm == null || prev.dbhCm <= 0 || cur.dbhCm <= 0) return [];
  const out: EntryHint[] = [];
  if (prev.pomSeq !== cur.pomSeq) out.push('pom_changed');
  const ratio = cur.dbhCm / prev.dbhCm;
  if (ratio >= 10 || ratio <= 0.1) out.push('tenfold');
  else if (cur.dbhCm < prev.dbhCm) out.push('shrank');
  return out;
}
