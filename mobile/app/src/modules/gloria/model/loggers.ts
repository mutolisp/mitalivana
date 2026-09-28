/**
 * GLORIA temperature loggers (manual §4.3.3–4.3.4, Box 6.1, Form 4) — pure,
 * so check:gloria runs it in Node.
 *
 *   - A visit is one Form 4: loggers read out, changed or newly installed on
 *     one day. Visits belong to the summit and fall into a monitoring cycle by
 *     date: the cycle of the last survey that started on or before that day
 *     (from mocy 4 in 2026 until mocy 5 starts, every visit is mocy 4).
 *   - Position: the central quadrat of each 3 m × 3 m cluster (N22 …); when
 *     that is impossible, N12 / N21 / N23 / N32 — never a corner quadrat,
 *     where species are recorded (manual p.44).
 *   - Several loggers per position are told apart by a letter (E22a, E22b,
 *     then E22c after a change) — the Taiwan practice; the manual has one.
 *   - Full-length code CC_TTT_SSS_QQQ_YYYY (Box 6.1), here with the letter
 *     after the quadrat. Photos carry LOG- before the quadrat (Box 6.1).
 *   - UTC difference as Form 4 note 5 defines it: the hours to add to local
 *     time to get UTC (local 14:00, UTC 12:00 → −2; Taiwan → −8).
 */
import type { Direction } from './units';

export type LoggerRole = 'install' | 'readout';
/** Form 4 note 10: LC logger change, DR data read-out, BC battery change. */
export type LoggerFlag = 'LC' | 'DR' | 'BC';
export const LOGGER_FLAGS: readonly LoggerFlag[] = ['LC', 'DR', 'BC'];

/** A file kept with a logger or a visit (Documents/files/). */
export type FileRef = { uri: string; name: string; size: number | null };

export const LOGGER_DIRECTIONS: readonly Direction[] = ['E', 'N', 'S', 'W'];

/** The positions a logger may take in a cluster: the centre first, never a corner. */
export function loggerQuadrats(d: Direction): string[] {
  return ['22', '12', '21', '23', '32'].map((rc) => `${d}${rc}`);
}
export function validQuadrat(q: string): boolean {
  return /^[NESW](22|12|21|23|32)$/.test(q);
}

/** The next letter after every one already used at this position (on this summit, any visit). */
export function nextLoggerLabel(used: ReadonlyArray<string | null | undefined>): string {
  let max = -1;
  for (const l of used) {
    const c = (l ?? '').trim().toLowerCase();
    if (/^[a-z]$/.test(c)) max = Math.max(max, c.charCodeAt(0) - 97);
  }
  return max >= 25 ? 'z' : String.fromCharCode(97 + max + 1);
}

/** Full-length logger code (Box 6.1), with the letter: TW_SAC_JIA_E22c_2026. */
export function loggerCode(
  s: { country: string; target_region: string; summit: string },
  quadrat: string,
  label: string | null | undefined,
  year: number,
): string {
  return `${s.country}_${s.target_region}_${s.summit}_${quadrat}${label ?? ''}_${year}`;
}

/** Annex III item code of a logger photo: LOG-E22c (8 characters at most). */
export function loggerPhotoItem(quadrat: string, label: string | null | undefined): string {
  return `LOG-${quadrat}${label ?? ''}`.slice(0, 8);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The monitoring cycle (mocy) a visit on `visitTs` belongs to: the last
 * survey that started on or before that day. Before the first survey → the
 * first one. No survey at all → null.
 */
export function cycleOf(visitTs: number, surveys: ReadonlyArray<{ mocy: number; start_ts: number }>): number | null {
  if (!surveys.length) return null;
  const sorted = [...surveys].sort((a, b) => a.start_ts - b.start_ts);
  const day = startOfDay(visitTs);
  let hit = sorted[0].mocy;
  for (const s of sorted) if (startOfDay(s.start_ts) <= day) hit = s.mocy;
  return hit;
}

export type LoggerLike = {
  uuid: string;
  role: LoggerRole;
  direction: Direction;
  quadrat: string;
  label: string | null;
  serial: string | null;
  logger_type: string | null;
  start_ts: number | null;
  dist11_m: number | null;
  dist31_m: number | null;
  flags: string | null;
};

export type CarrySeed = Pick<LoggerLike, 'direction' | 'quadrat' | 'label' | 'serial' | 'logger_type' | 'start_ts' | 'dist11_m' | 'dist31_m'> & {
  prev_uuid: string;
};

export function parseFlags(json: string | null | undefined): LoggerFlag[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((f): f is LoggerFlag => (LOGGER_FLAGS as readonly string[]).includes(f)) : [];
  } catch {
    return [];
  }
}

export function parseFiles(json: string | null | undefined): FileRef[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((f) => f && typeof f.uri === 'string').map((f) => ({ uri: f.uri, name: String(f.name ?? ''), size: typeof f.size === 'number' ? f.size : null })) : [];
  } catch {
    return [];
  }
}

const DIR_ORDER: Record<string, number> = { E: 0, N: 1, S: 2, W: 3 };

/**
 * What the next visit reads out, from the last visit: every logger installed
 * then, and every logger read then that stayed in the ground (not changed —
 * LC). A battery change (BC) or a read-out (DR) leaves the logger in place.
 */
export function carryForward(prev: ReadonlyArray<LoggerLike>): CarrySeed[] {
  return prev
    .filter((l) => l.role === 'install' || !parseFlags(l.flags).includes('LC'))
    .map((l) => ({
      direction: l.direction,
      quadrat: l.quadrat,
      label: l.label,
      serial: l.serial,
      logger_type: l.logger_type,
      start_ts: l.start_ts,
      dist11_m: l.dist11_m,
      dist31_m: l.dist31_m,
      prev_uuid: l.uuid,
    }))
    .sort((a, b) => DIR_ORDER[a.direction] - DIR_ORDER[b.direction] || a.quadrat.localeCompare(b.quadrat) || (a.label ?? '').localeCompare(b.label ?? ''));
}

/**
 * The seeds a visit still lacks, for pulling them in again after an earlier
 * visit was typed in later: one already carried (same prev_uuid) or a
 * read-out entered by hand at the same position and letter is kept as is.
 */
export function missingCarry(
  seeds: ReadonlyArray<CarrySeed>,
  existing: ReadonlyArray<{ role: LoggerRole; quadrat: string; label: string | null; prev_uuid: string | null }>,
): CarrySeed[] {
  const prevs = new Set(existing.map((l) => l.prev_uuid).filter(Boolean));
  const places = new Set(existing.filter((l) => l.role === 'readout').map((l) => `${l.quadrat}|${(l.label ?? '').toLowerCase()}`));
  return seeds.filter((s) => !prevs.has(s.prev_uuid) && !places.has(`${s.quadrat}|${(s.label ?? '').toLowerCase()}`));
}

/** Form 4 note 5: hours to add to local time to get UTC (Taiwan −8). */
export function utcDiffHours(at: Date): number {
  return at.getTimezoneOffset() / 60;
}

export const ymd = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The identifier of a visit's Form 4, as sheet 01_ `temperature_loggers`
 * writes it (mocy4_TW-SAC-JIA_1_temperature-logger_20260804); `seq` is the
 * visit's order within the cycle.
 */
export function form4Id(mocy: number, fullCode: string, seq: number, visitTs: number): string {
  return `mocy${mocy}_${fullCode}_${seq}_temperature-logger_${ymd(visitTs)}`;
}
