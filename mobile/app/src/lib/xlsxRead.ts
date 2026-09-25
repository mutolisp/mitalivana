/**
 * The first worksheet of an .xlsx as rows of strings. Pure (fflate + xmldom),
 * so it runs under Node for the checks.
 *
 * Reads the workbook → its first sheet's part via the relationships, shared
 * strings, inline strings and plain values. Numbers come back as written in
 * the file (full precision), dates as their serial number — callers here only
 * need text and decimal degrees. Formulas give their cached value.
 */
import { DOMParser, type Element } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function xml(files: Record<string, Uint8Array>, path: string) {
  const bytes = files[path];
  if (!bytes) throw new Error(`xlsx: missing ${path}`);
  return new DOMParser().parseFromString(strFromU8(bytes), 'text/xml');
}

function textOf(el: Element): string {
  // Rich text keeps its runs in <r><t>; plain in a single <t>.
  const ts = el.getElementsByTagNameNS(MAIN, 't');
  let out = '';
  for (let i = 0; i < ts.length; i++) out += ts[i].textContent ?? '';
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsxFirstSheet(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes);
  const wb = xml(files, 'xl/workbook.xml');
  const sheet = wb.getElementsByTagNameNS(MAIN, 'sheet')[0];
  if (!sheet) throw new Error('xlsx: no worksheet');
  const rid =
    sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ??
    sheet.getAttribute('r:id');
  const rels = xml(files, 'xl/_rels/workbook.xml.rels').getElementsByTagName('Relationship');
  let target = 'worksheets/sheet1.xml';
  for (let i = 0; i < rels.length; i++) if (rels[i].getAttribute('Id') === rid) target = rels[i].getAttribute('Target') ?? target;
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

  const shared: string[] = [];
  if (files['xl/sharedStrings.xml']) {
    const si = xml(files, 'xl/sharedStrings.xml').getElementsByTagNameNS(MAIN, 'si');
    for (let i = 0; i < si.length; i++) shared.push(textOf(si[i]));
  }

  const out: string[][] = [];
  const rows = xml(files, path).getElementsByTagNameNS(MAIN, 'row');
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].getElementsByTagNameNS(MAIN, 'c');
    const row: string[] = [];
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      const at = colIndex(cell.getAttribute('r') ?? '');
      const type = cell.getAttribute('t');
      const v = cell.getElementsByTagNameNS(MAIN, 'v')[0]?.textContent ?? '';
      const value = type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? textOf(cell) : v;
      while (row.length < at) row.push('');
      row[at] = value;
    }
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim() !== ''));
}
