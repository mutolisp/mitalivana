/**
 * CSV formula injection (code review L17). Pure: the check scripts load it.
 *
 * A spreadsheet reads a cell that begins with one of these characters as a
 * formula. The list is OWASP's "CSV Injection" page
 * (OWASP/www-community, pages/attacks/CSV_Injection.md): = + - @, Tab, CR,
 * LF, and the full-width ＝ ＋ － ＠ that some locales (Japanese) also treat
 * as formulas. The same page says no single sanitization is safe for every
 * spreadsheet and every downstream program, hence the split used here:
 *
 *  - Files meant to be opened in Excel (the UTF-8 BOM tables) get a leading
 *    apostrophe on such values (`excelCell`, `guardFormula`).
 *  - Files read by R or GBIF (vegan tables, DwC-A) keep the value as it is;
 *    `formulaTally` counts what is in them so the export can say so.
 *
 * Numbers (-12.5, +3, 1e-3) and one-character codes (the Braun-Blanquet "+",
 * a "-" meaning "none") are values, not formulas, and are left alone.
 */

const FORMULA_LEAD = /^[=+\-@\t\r\n＝＋－＠]/;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** True when a spreadsheet would read `s` as a formula and it is not a number. */
export function formulaLike(s: string): boolean {
  return s.length > 1 && FORMULA_LEAD.test(s) && !NUMBER.test(s);
}

// Formula-like, or already an apostrophe in front of one: a value typed as
// '=x gets a second apostrophe, so reading the table back is lossless.
function needsGuard(s: string): boolean {
  return formulaLike(s) || (s.startsWith("'") && needsGuard(s.slice(1)));
}

/** The value as an Excel-bound table should hold it: an apostrophe in front
 *  of anything formula-like. */
export function guardFormula(s: string): string {
  return needsGuard(s) ? `'${s}` : s;
}

/** Undo `guardFormula` on a value read back from a table this app wrote. */
export function unguardFormula(s: string): string {
  return s.startsWith("'") && needsGuard(s.slice(1)) ? s.slice(1) : s;
}

/** One RFC 4180 cell of an Excel-bound CSV (null / undefined → empty). */
export function excelCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = guardFormula(String(v));
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type FormulaTally = {
  /** Formula-like values written with the leading apostrophe. */
  guarded: number;
  /** Formula-like values left as they are (R / GBIF files). */
  raw: number;
};

function countCell(cell: string, t: FormulaTally): void {
  if (cell.length < 2) return;
  if (cell.startsWith("'") && needsGuard(cell.slice(1))) t.guarded += 1;
  else if (formulaLike(cell)) t.raw += 1;
}

// One cell and the character after it: a quoted cell (with "" inside) or an
// unquoted run up to the next comma or line end.
const CSV_CELL = /(?:"((?:[^"]|"")*)"|([^,\n]*))(,|\r?\n|$)/y;

function tallyCsv(text: string, t: FormulaTally): void {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  CSV_CELL.lastIndex = 0;
  while (CSV_CELL.lastIndex < src.length) {
    const at = CSV_CELL.lastIndex;
    const m = CSV_CELL.exec(src);
    if (!m) break;
    countCell(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2], t);
    // A cell that is not followed by a separator ends the scan (malformed
    // input); an empty match at the end of the text likewise.
    if (CSV_CELL.lastIndex === at || m[3] === '') break;
  }
}

/** DwC-A data files: tab separated, nothing enclosed (meta.xml says so). */
function tallyTsv(text: string, t: FormulaTally): void {
  for (const line of text.split('\n')) for (const cell of line.split('\t')) countCell(cell, t);
}

/**
 * Formula-like values across the files of one export. `.csv` files are read
 * as RFC 4180; the `.txt` data files of a Darwin Core Archive (a folder with
 * a meta.xml) as unquoted TSV. Other files are skipped.
 */
export function formulaTally(files: { name: string; text: () => string }[]): FormulaTally {
  const t: FormulaTally = { guarded: 0, raw: 0 };
  for (const _ of tallyEach(files, t));
  return t;
}

/**
 * The same, letting the UI draw after each table: a large census export has
 * tens of megabytes of them, which held the screen still for seconds after
 * the hashing bar reached 100% (code review M38).
 */
export async function formulaTallyYielding(
  files: { name: string; text: () => string }[],
  pause: () => Promise<void>,
): Promise<FormulaTally> {
  const t: FormulaTally = { guarded: 0, raw: 0 };
  for (const _ of tallyEach(files, t)) await pause();
  return t;
}

function* tallyEach(files: { name: string; text: () => string }[], t: FormulaTally): Generator<void> {
  const folder = (n: string) => n.slice(0, n.lastIndexOf('/') + 1);
  const dwcaFolders = new Set(files.filter((f) => /(^|\/)meta\.xml$/.test(f.name)).map((f) => folder(f.name)));
  for (const f of files) {
    if (/\.csv$/i.test(f.name)) tallyCsv(f.text(), t);
    else if (/\.txt$/i.test(f.name) && dwcaFolders.has(folder(f.name))) tallyTsv(f.text(), t);
    else continue;
    yield;
  }
}
