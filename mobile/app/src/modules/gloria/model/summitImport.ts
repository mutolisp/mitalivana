/**
 * Summit base data from a table (CSV or the first sheet of an .xlsx) — the
 * columns of sheet 00_plot_coordinates. Pure: parsing, validation and the
 * compare-with-what-is-stored step; the screen applies what the user ticks.
 *
 * Accepted headers (case, spaces and underscores ignored):
 *   fullSummitCode | full_code | code        TW-DAS-SUN (country-region-summit)
 *   country, targetRegion, summit            instead of, or besides, the full code
 *   name
 *   decimalLatitude | latitude | lat
 *   decimalLongitude | longitude | lon | lng
 *   elevation | elevation_m | altitude
 *   Vegetation Zone | vegZone | veg_zone
 * Anything else (twd97x, the empty degree-minute columns) is ignored.
 * A blank cell means "no data here", never "clear the stored value".
 */
import { normalizeVegZone } from './vegZones';
import { unguardFormula } from '../../../lib/csvFormula';

export type ImportedSummit = {
  line: number;
  full_code: string;
  country: string;
  target_region: string;
  summit: string;
  name: string | null;
  decimal_latitude: number | null;
  decimal_longitude: number | null;
  elevation_m: number | null;
  veg_zone: string | null;
};
export type ImportProblem = { line: number; message: string; value?: string };
export type ParsedSummits = { items: ImportedSummit[]; problems: ImportProblem[] };

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF, a leading BOM. Tab or
 *  semicolon separated files are recognised from the first line. The leading
 *  apostrophe this app's own export puts on formula-like values is dropped
 *  (code review L17), so an exported table reads back as it was. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  const sep = count('\t') > count(',') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== '')).map((r) => r.map(unguardFormula));
}

type Field = 'full_code' | 'country' | 'target_region' | 'summit' | 'name' | 'lat' | 'lon' | 'elevation' | 'veg_zone';
const ALIASES: Record<string, Field> = {
  fullsummitcode: 'full_code',
  fullcode: 'full_code',
  code: 'full_code',
  country: 'country',
  countrycode: 'country',
  targetregion: 'target_region',
  region: 'target_region',
  summit: 'summit',
  summitcode: 'summit',
  name: 'name',
  summitname: 'name',
  decimallatitude: 'lat',
  latitude: 'lat',
  lat: 'lat',
  decimallongitude: 'lon',
  longitude: 'lon',
  lon: 'lon',
  lng: 'lon',
  elevation: 'elevation',
  elevationm: 'elevation',
  altitude: 'elevation',
  vegetationzone: 'veg_zone',
  vegzone: 'veg_zone',
};
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
// decimalLatitude beats a same-meaning "Latitude" column (the sheet has both; the latter is empty).
const PREFERRED = new Set(['decimallatitude', 'decimallongitude', 'fullsummitcode']);
const CODE3 = /^[A-Z0-9]{3}$/;

export function tableToSummits(table: string[][]): ParsedSummits {
  const problems: ImportProblem[] = [];
  // The header is the first row that names a summit column (a title row may sit above it).
  const h = table.findIndex((r) => r.some((c) => ['full_code', 'summit'].includes(ALIASES[key(c)] ?? '')));
  if (h < 0) return { items: [], problems: [{ line: 1, message: 'noHeader' }] };
  const col = new Map<Field, number>();
  table[h].forEach((c, i) => {
    const f = ALIASES[key(c)];
    if (f && (!col.has(f) || PREFERRED.has(key(c)))) col.set(f, i);
  });
  const items: ImportedSummit[] = [];
  const seen = new Map<string, number>();
  for (let r = h + 1; r < table.length; r++) {
    const line = r + 1;
    const get = (f: Field) => (col.has(f) ? (table[r][col.get(f)!] ?? '').trim() : '');
    const full = get('full_code').toUpperCase();
    const parts = full ? full.split('-') : [];
    const country = (get('country') || parts[0] || '').toUpperCase();
    const region = (get('target_region') || parts[1] || '').toUpperCase();
    const summit = (get('summit') || parts[2] || '').toUpperCase();
    if (!full && !region && !summit) continue;
    if (!/^[A-Z]{2}$/.test(country) || !CODE3.test(region) || !CODE3.test(summit)) {
      problems.push({ line, message: 'badCode', value: full || [country, region, summit].join('-') });
      continue;
    }
    const code = `${country}-${region}-${summit}`;
    if (full && full !== code) {
      problems.push({ line, message: 'codeMismatch', value: `${full} ≠ ${code}` });
      continue;
    }
    if (seen.has(code)) {
      problems.push({ line, message: 'duplicate', value: `${code} (${seen.get(code)})` });
      continue;
    }
    const num = (f: Field, min: number, max: number): number | null | 'bad' => {
      const v = get(f).replace(',', '.');
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? n : 'bad';
    };
    const lat = num('lat', -90, 90);
    const lon = num('lon', -180, 180);
    const ele = num('elevation', -500, 9000);
    const bad = ([['lat', lat], ['lon', lon], ['elevation', ele]] as const).filter(([, v]) => v === 'bad');
    if (bad.length) {
      for (const [f] of bad) problems.push({ line, message: `bad_${f}`, value: get(f) });
      continue;
    }
    const zoneRaw = get('veg_zone');
    const zone = zoneRaw ? normalizeVegZone(zoneRaw) : null;
    if (zoneRaw && !zone) problems.push({ line, message: 'unknownZone', value: zoneRaw });
    seen.set(code, line);
    items.push({
      line,
      full_code: code,
      country,
      target_region: region,
      summit,
      name: get('name') || null,
      decimal_latitude: lat as number | null,
      decimal_longitude: lon as number | null,
      elevation_m: ele as number | null,
      // An unknown zone is reported and left out rather than stored misspelt.
      veg_zone: zone,
    });
  }
  return { items, problems };
}

export const COMPARED = ['name', 'decimal_latitude', 'decimal_longitude', 'elevation_m', 'veg_zone'] as const;
export type Compared = (typeof COMPARED)[number];
export type StoredSummit = { id: number; full_code: string } & Record<Compared, string | number | null>;
export type SummitDiff =
  | { kind: 'new'; item: ImportedSummit }
  | { kind: 'changed'; item: ImportedSummit; id: number; changes: Array<{ field: Compared; from: unknown; to: unknown }> }
  | { kind: 'same'; item: ImportedSummit; id: number };

/** Each imported summit against what is stored. Blank imported cells never count as a change. */
export function diffSummits(stored: StoredSummit[], items: ImportedSummit[]): SummitDiff[] {
  const byCode = new Map(stored.map((s) => [s.full_code, s]));
  return items.map((item) => {
    const s = byCode.get(item.full_code);
    if (!s) return { kind: 'new', item };
    const changes = COMPARED.filter((f) => item[f] != null && item[f] !== s[f]).map((f) => ({ field: f, from: s[f], to: item[f] }));
    return changes.length ? { kind: 'changed', item, id: s.id, changes } : { kind: 'same', item, id: s.id };
  });
}
