/**
 * Temperature loggers in the sheet export (Form 4; model/loggers.ts). Pure.
 *
 * The Taiwan sheet has no logger tab: `04_temperature_loggers` is ours, one
 * row per logger per visit, column names from Form 4. Sheet 01_ keeps its
 * `temperature_loggers` column for the form identifier
 * (mocy4_TW-SAC-JIA_1_temperature-logger_20260804) — the cycle's first
 * visit; later visits number 2, 3 … and name their own scans.
 */
import { form4Id, loggerCode, parseFiles, parseFlags, type FileRef, type LoggerRole } from '../model/loggers';

export const H04_TEMPERATURE_LOGGERS = [
  'id', 'mocy', 'visitDate', 'country', 'targetRegion', 'summit', 'loggerCode', 'role', 'quadratCode', 'label',
  'loggerSerial', 'loggerType', 'startDate', 'startTime', 'stopDate', 'stopTime', 'utcDiff', 'dist11', 'dist31',
  'photoCheckOpen', 'photoCheckClosed', 'researcher', 'flags', 'comments', 'dataFiles', 'form4', 'uuid',
] as const;

export type ExportLogger = {
  uuid: string;
  role: LoggerRole;
  quadrat: string;
  label: string | null;
  serial: string | null;
  logger_type: string | null;
  start_ts: number | null;
  stop_ts: number | null;
  utc_diff_h: number | null;
  dist11_m: number | null;
  dist31_m: number | null;
  photo_open: number | null;
  photo_closed: number | null;
  photo_open_uri: string | null;
  photo_closed_uri: string | null;
  flags: string | null;
  researcher: string | null;
  comments: string | null;
  data_files: string | null;
};

export type ExportVisit = {
  uuid: string;
  visit_ts: number;
  researchers: string | null;
  comments: string | null;
  form4_files: string | null;
  loggers: ExportLogger[];
};

type Summit = { full_code: string; country: string; target_region: string; summit: string };

const pad = (n: number) => String(n).padStart(2, '0');
const date = (ts: number | null) => {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const time = (ts: number | null) => {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const num = (v: number | null) => (v == null ? '' : String(Math.round(v * 100) / 100));
const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_');

/** The logger's full-length code: its installation year, else the visit's. */
export function codeOf(s: Summit, l: ExportLogger, visitTs: number): string {
  return loggerCode(s, l.quadrat, l.label, new Date(l.start_ts ?? visitTs).getFullYear());
}

/** Visits in date order, each with its Form 4 identifier (numbered within the cycle). */
export function orderedVisits(mocy: number, s: Summit, visits: ReadonlyArray<ExportVisit>): Array<ExportVisit & { form4: string }> {
  return [...visits]
    .sort((a, b) => a.visit_ts - b.visit_ts)
    .map((v, i) => ({ ...v, form4: form4Id(mocy, s.full_code, i + 1, v.visit_ts) }));
}

/** Where each attached file lands in the zip, by source uri. */
export type FilePlan = Array<{ uri: string; name: string; kind: 'data' | 'form4' }>;

export function planLoggerFiles(mocy: number, s: Summit, visits: ReadonlyArray<ExportVisit>): FilePlan {
  const out: FilePlan = [];
  for (const v of orderedVisits(mocy, s, visits)) {
    parseFiles(v.form4_files).forEach((f: FileRef, i) => {
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(f.name)?.[1]?.toLowerCase() ?? 'jpg';
      out.push({ uri: f.uri, name: `${v.form4}${i ? `-${i + 1}` : ''}.${ext}`, kind: 'form4' });
    });
    for (const l of v.loggers)
      for (const f of parseFiles(l.data_files))
        out.push({ uri: f.uri, name: safe(`${codeOf(s, l, v.visit_ts)}_${l.serial ?? 'no-serial'}_${f.name}`), kind: 'data' });
  }
  return out;
}

export function loggerRows(mocy: number, s: Summit, visits: ReadonlyArray<ExportVisit>): string[][] {
  const rows: string[][] = [];
  orderedVisits(mocy, s, visits).forEach((v, vi) => {
    for (const l of v.loggers) {
      const code = codeOf(s, l, v.visit_ts);
      rows.push([
        // By the visit's number in the cycle, not its date: two visits can fall on one day.
        `${s.full_code}-mocy_${mocy}-logger_${vi + 1}-${l.quadrat}${l.label ?? ''}-${l.role}`,
        String(mocy),
        date(v.visit_ts),
        s.country,
        s.target_region,
        s.summit,
        code,
        l.role === 'install' ? 'installation' : 'read-out',
        l.quadrat,
        l.label ?? '',
        l.serial ?? '',
        l.logger_type ?? '',
        date(l.start_ts),
        time(l.start_ts),
        date(l.stop_ts),
        time(l.stop_ts),
        num(l.utc_diff_h),
        num(l.dist11_m),
        num(l.dist31_m),
        l.photo_open === 1 || l.photo_open_uri ? 'TRUE' : 'FALSE',
        l.photo_closed === 1 || l.photo_closed_uri ? 'TRUE' : 'FALSE',
        l.researcher ?? v.researchers ?? '',
        parseFlags(l.flags).join(';'),
        l.comments ?? '',
        parseFiles(l.data_files).map((f) => safe(`${code}_${l.serial ?? 'no-serial'}_${f.name}`)).join('; '),
        v.form4,
        l.uuid,
      ]);
    }
  });
  return rows;
}

/** Sheet 01_ `temperature_loggers`: the cycle's first visit, or blank without one. */
export function temperatureLoggersId(mocy: number, s: Summit, visits: ReadonlyArray<ExportVisit>): string {
  return orderedVisits(mocy, s, visits)[0]?.form4 ?? '';
}
