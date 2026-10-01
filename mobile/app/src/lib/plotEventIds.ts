/**
 * One Darwin Core eventID per plot survey, the same in every export.
 *
 * plotid is not UNIQUE — a resurvey reuses it — so ids are assigned over every
 * survey sharing a plotid, in start order: the earliest keeps the bare plotid,
 * later ones get `_YYYYMMDD` (local date), and `_2`, `_3`… if two start the
 * same day. Fed the whole local set (`plotEventIds` in db/plots.ts), a survey
 * gets the same id whether it is exported alone or inside a project, and the
 * relevé tables (vegMatrix), the plot CSVs and the DwC-A all use it, so their
 * ids join.
 *
 * Pure (no DB, no i18n) so check:vegmatrix can run it under Node.
 */
export type PlotIdInput = { id: number; plotid: string; start_ts: number | null };

export function ymdCompact(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function assignPlotEventIds(plots: readonly PlotIdInput[]): Map<number, string> {
  const sorted = [...plots].sort(
    (a, b) => a.plotid.localeCompare(b.plotid) || (a.start_ts ?? 0) - (b.start_ts ?? 0) || a.id - b.id,
  );
  const used = new Set<string>();
  const out = new Map<number, string>();
  for (const p of sorted) {
    const base = p.plotid || 'plot';
    let id = base;
    if (used.has(id)) {
      const date = ymdCompact(p.start_ts);
      const dated = date ? `${base}_${date}` : base;
      id = dated;
      for (let n = 2; used.has(id); n++) id = `${dated}_${n}`;
    }
    used.add(id);
    out.set(p.id, id);
  }
  return out;
}
