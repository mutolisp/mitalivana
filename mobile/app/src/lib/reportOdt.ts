/**
 * Report → .odt bytes: the ODF counterpart of `reportDocx.ts`, over the same
 * model and in the same section order.
 *
 * Charts are written as DATA TABLES, not drawn: a native ODF chart is an
 * embedded sub-document of its own, and for this format the numbers were
 * judged to be what a reader needs. The document says so once, under the
 * title (`Report.chartTableNote`), and points to the HTML version for the
 * figures. Because a profile becomes a table, it keeps its real metre ranges
 * in a column of their own — the DOCX caveat about evenly spaced bands does
 * not apply here and is not printed.
 *
 * Pure module (fflate + string building only) so `check:odt` can unzip and
 * validate the result under Node.
 */
import { parseRuns } from './docx';
import { ODT_BOLD, buildOdt, fontSize, odtSpans, odtText, paraStyle } from './odt';
import type { Report, ReportChart, ReportSection, ReportTable } from './reportTypes';

/** A4 with 2 cm margins leaves 17 cm of text width (see `A4_PAGE`). */
const CONTENT_W_CM = 17;

// Point sizes and spacing mirror the DOCX report (half-points / twips there).
const GREY = 'fo:color="#6b7280"';
const STYLES =
  paraStyle('R_title', 'fo:margin-bottom="0.0706cm"', `${ODT_BOLD} ${fontSize(15)}`) +
  paraStyle('R_sub', 'fo:margin-bottom="0.0353cm"', `${fontSize(10)} fo:color="#4b5563"`) +
  paraStyle('R_meta', 'fo:margin-bottom="0.2117cm"', `${fontSize(8)} ${GREY}`) +
  paraStyle(
    'R_heading',
    'fo:margin-top="0.4233cm" fo:margin-bottom="0.1411cm" fo:keep-with-next="always"',
    `${ODT_BOLD} ${fontSize(12)} fo:color="#065f46"`,
  ) +
  paraStyle('R_body', 'fo:margin-bottom="0.0706cm"', fontSize(10)) +
  paraStyle('R_note', 'fo:margin-bottom="0.0706cm"', `${fontSize(8)} ${GREY}`) +
  paraStyle(
    'R_caption',
    'fo:margin-top="0.1411cm" fo:margin-bottom="0.0706cm" fo:keep-with-next="always"',
    `${ODT_BOLD} ${fontSize(9)}`,
  ) +
  paraStyle('R_cell', '', fontSize(8)) +
  paraStyle('R_cellR', 'fo:text-align="end"', fontSize(8)) +
  paraStyle('R_head', '', `${ODT_BOLD} ${fontSize(8)}`) +
  paraStyle('R_headR', 'fo:text-align="end"', `${ODT_BOLD} ${fontSize(8)}`) +
  paraStyle('R_gap', '', fontSize(4)) +
  `<style:style style:name="R_tbl" style:family="table"><style:table-properties style:width="${CONTENT_W_CM}cm" table:align="left"/></style:style>` +
  // 0.5 pt light-grey rules on every side, as the DOCX tables have.
  '<style:style style:name="R_td" style:family="table-cell"><style:table-cell-properties' +
  ' fo:border="0.5pt solid #bfbfbf" fo:padding-top="0.0706cm" fo:padding-bottom="0.0706cm"' +
  ' fo:padding-left="0.1411cm" fo:padding-right="0.1411cm" style:vertical-align="middle"/></style:style>' +
  '<style:style style:name="R_th" style:family="table-cell"><style:table-cell-properties' +
  ' fo:background-color="#f3f4f6" fo:border="0.5pt solid #bfbfbf" fo:padding-top="0.0706cm"' +
  ' fo:padding-bottom="0.0706cm" fo:padding-left="0.1411cm" fo:padding-right="0.1411cm"' +
  ' style:vertical-align="middle"/></style:style>';

function p(style: string, text: string): string {
  return text ? `<text:p text:style-name="${style}">${odtText(text)}</text:p>` : '';
}

/** Same split as the DOCX tables: the first column carries names and takes the
 *  slack, the rest share 62 % of the width evenly. */
function columnWidthsCm(n: number): number[] {
  if (n === 1) return [CONTENT_W_CM];
  const rest = (CONTENT_W_CM * 0.62) / (n - 1);
  return [CONTENT_W_CM - rest * (n - 1), ...Array<number>(n - 1).fill(rest)];
}

type Alloc = { tables: number; columnStyles: string[] };

/** `headless` drops the header row — used for the key/value metadata blocks. */
function tableXml(table: ReportTable, alloc: Alloc, headless = false): string {
  const n = ++alloc.tables;
  const widths = columnWidthsCm(table.columns.length);
  const cols = widths
    .map((w, i) => {
      const name = `R_t${n}c${i}`;
      alloc.columnStyles.push(
        `<style:style style:name="${name}" style:family="table-column">` +
          `<style:table-column-properties style:column-width="${w.toFixed(3)}cm"/></style:style>`,
      );
      return `<table:table-column table:style-name="${name}"/>`;
    })
    .join('');
  const right = (i: number) => table.align?.[i] === 'right';

  // Header rows repeat when a long table breaks across pages.
  const head = headless
    ? ''
    : '<table:table-header-rows><table:table-row>' +
      table.columns
        .map(
          (c, i) =>
            `<table:table-cell table:style-name="R_th"><text:p text:style-name="${right(i) ? 'R_headR' : 'R_head'}">` +
            `${odtText(c)}</text:p></table:table-cell>`,
        )
        .join('') +
      '</table:table-row></table:table-header-rows>';

  const body = table.rows
    .map(
      (r) =>
        '<table:table-row>' +
        r
          .map(
            // Cell text carries `*italic*` markers from the model, so genus
            // and epithet stay italic here exactly as in the DOCX report.
            (v, i) =>
              `<table:table-cell table:style-name="R_td"><text:p text:style-name="${right(i) ? 'R_cellR' : 'R_cell'}">` +
              `${odtSpans(parseRuns(v, false))}</text:p></table:table-cell>`,
          )
          .join('') +
        '</table:table-row>',
    )
    .join('');

  return (
    `<table:table table:name="Table${n}" table:style-name="R_tbl">${cols}${head}${body}</table:table>` +
    '<text:p text:style-name="R_gap"/>'
  );
}

const fmt = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '–' : Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));

const titled = (title: string, unit?: string) => (unit ? `${title} (${unit})` : title);

/** A chart's numbers as a table, one row per bar / x value / band. */
export function chartAsTable(chart: ReportChart): ReportTable {
  switch (chart.kind) {
    case 'bar':
    case 'column': {
      const second = chart.rows.some((r) => r.value2 != null);
      const notes = chart.rows.some((r) => r.note);
      const valueHead = chart.seriesLabels?.[0] ?? chart.valueAxisTitle ?? titled(chart.title, chart.unit);
      return {
        columns: [
          chart.categoryAxisTitle ?? '',
          valueHead,
          ...(second ? [chart.seriesLabels?.[1] ?? ''] : []),
          ...(notes ? [''] : []),
        ],
        rows: chart.rows.map((r) => [
          r.label,
          fmt(r.value),
          ...(second ? [fmt(r.value2)] : []),
          ...(notes ? [r.note ?? ''] : []),
        ]),
        align: ['left', 'right', ...(second ? ['right' as const] : []), ...(notes ? ['left' as const] : [])],
      };
    }
    case 'line': {
      // Series need not share their x values; the table covers all of them.
      const xs = [...new Set(chart.series.flatMap((s) => s.points.map((pt) => pt.x)))].sort(
        (a, b) => a - b,
      );
      const ticks = chart.xTickLabels;
      const columns = [chart.xAxis.title ?? 'x', ...(ticks ? [''] : [])];
      const align: Array<'left' | 'right'> = ['right', ...(ticks ? ['left' as const] : [])];
      for (const s of chart.series) {
        columns.push(s.label);
        align.push('right');
        if (s.band) {
          columns.push(`${s.label} (–/+)`);
          align.push('right');
        }
      }
      const rows = xs.map((x, xi) => {
        const row = [fmt(x), ...(ticks ? [ticks[xi] ?? ''] : [])];
        for (const s of chart.series) {
          const j = s.points.findIndex((pt) => pt.x === x);
          row.push(j >= 0 ? fmt(s.points[j].y) : '–');
          if (s.band) {
            const b = j >= 0 ? s.band[j] : undefined;
            row.push(b ? `${fmt(b.lo)}–${fmt(b.hi)}` : '–');
          }
        }
        return row;
      });
      return { columns, rows, align };
    }
    case 'profile':
      return {
        columns: ['', chart.heightAxisTitle ?? 'm', chart.valueAxisTitle ?? titled(chart.title, chart.unit)],
        rows: chart.bands.map((b) => [b.label, `${fmt(b.y0)}–${fmt(b.y1)}`, fmt(b.value)]),
        align: ['left', 'right', 'right'],
      };
  }
}

function sectionXml(section: ReportSection, alloc: Alloc): string {
  const parts: string[] = [p('R_heading', section.heading)];
  for (const para of section.paras ?? []) parts.push(p('R_body', para));
  if (section.meta && section.meta.length > 0) {
    parts.push(
      tableXml({ columns: ['', ''], rows: section.meta.map((m) => [m.key, m.value]) }, alloc, true),
    );
  }
  if (section.chart) {
    parts.push(p('R_caption', titled(section.chart.title, section.chart.unit)));
    parts.push(tableXml(chartAsTable(section.chart), alloc));
    if (section.chart.note) parts.push(p('R_note', section.chart.note));
  }
  if (section.table) parts.push(tableXml(section.table, alloc));
  if (section.note) parts.push(p('R_note', section.note));
  return parts.join('');
}

export function buildReportOdt(report: Report): Uint8Array {
  const alloc: Alloc = { tables: 0, columnStyles: [] };
  const hasChart = report.sections.some((s) => s.chart);
  const head =
    p('R_title', report.title) +
    (report.subtitle ? p('R_sub', report.subtitle) : '') +
    p('R_meta', report.generatedAt) +
    (hasChart && report.chartTableNote ? p('R_note', report.chartTableNote) : '');
  const body = report.sections.map((s) => sectionXml(s, alloc)).join('');
  return buildOdt(head + body, STYLES + alloc.columnStyles.join(''));
}
