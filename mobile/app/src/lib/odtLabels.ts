/**
 * Herbarium label sheets as .odt — the ODF counterpart of `docxLabels.ts`:
 * A4, 0.8 cm margins, ten labels per page in a 2 × 5 table with dashed cut
 * lines. Content comes from `labelLines`, so the two formats print the same
 * words; geometry is the DOCX sheet's, converted from twips to cm
 * (1 cm = 566.93 twips).
 *
 * ODF does not need the DOCX sheet's separator paragraph between tables: each
 * page after the first is its own table whose style breaks the page before it.
 *
 * Pure module, like `docxLabels.ts`.
 */
import { type LabelOptions, type LabelSpecimen, LABELS_PER_PAGE, labelLines } from './docxLabels';
import { ODT_BOLD, buildOdt, fontSize, odtSpans, paraStyle } from './odt';

const TWIPS_PER_CM = 1440 / 2.54;
const cm = (twips: number) => `${(twips / TWIPS_PER_CM).toFixed(4)}cm`;

const MARGIN_CM = 454 / TWIPS_PER_CM; // 0.8 cm
const COL_W = 5386; // ≈ 9.5 cm, the DOCX column
/** Minimum, not exact: an overfull label grows its row instead of silently
 *  clipping the last lines (Det., Note). */
const ROW_H = 3170;
const COLS = 2;
/** Indents, twips — the DOCX sheet's. */
const FIELD_IND = 113; // 0.2 cm
const SUB_IND = FIELD_IND + 454; // + 0.8 cm

// Line heights are "at least", as in the DOCX sheet: deterministic for the
// fonts used, never clipping a tall glyph.
const STYLES =
  paraStyle('L_title', `fo:text-align="center" style:line-height-at-least="${cm(280)}"`, `${ODT_BOLD} ${fontSize(10)}`) +
  paraStyle('L_name', `fo:text-align="center" style:line-height-at-least="${cm(260)}"`, fontSize(9)) +
  paraStyle('L_body', `style:line-height-at-least="${cm(240)}"`, fontSize(8)) +
  // Same indents as the DOCX sheet: family, herbarium number and fields start
  // 0.2 cm in; a field wraps 0.8 cm further (hanging indent), where the
  // coordinates under Loc. also sit.
  paraStyle('L_plain', `fo:margin-left="${cm(FIELD_IND)}" style:line-height-at-least="${cm(240)}"`, fontSize(8)) +
  paraStyle(
    'L_field',
    `fo:margin-left="${cm(SUB_IND)}" fo:text-indent="-${cm(SUB_IND - FIELD_IND)}" style:line-height-at-least="${cm(240)}"`,
    fontSize(8),
  ) +
  paraStyle('L_sub', `fo:margin-left="${cm(SUB_IND)}" style:line-height-at-least="${cm(240)}"`, fontSize(8)) +
  paraStyle('L_blank', `style:line-height-at-least="${cm(160)}"`, fontSize(6)) +
  `<style:style style:name="L_tbl" style:family="table"><style:table-properties style:width="${cm(COL_W * COLS)}" table:align="left"/></style:style>` +
  `<style:style style:name="L_tblBreak" style:family="table"><style:table-properties style:width="${cm(COL_W * COLS)}" table:align="left" fo:break-before="page"/></style:style>` +
  `<style:style style:name="L_col" style:family="table-column"><style:table-column-properties style:column-width="${cm(COL_W)}"/></style:style>` +
  // keep-together: a label is never sliced across a page boundary.
  `<style:style style:name="L_row" style:family="table-row"><style:table-row-properties style:min-row-height="${cm(ROW_H)}" fo:keep-together="always"/></style:style>` +
  '<style:style style:name="L_cell" style:family="table-cell"><style:table-cell-properties' +
  ` fo:border="0.5pt dashed #808080" fo:padding-top="${cm(57)}" fo:padding-bottom="${cm(57)}"` +
  ` fo:padding-left="${cm(170)}" fo:padding-right="${cm(170)}" style:vertical-align="top"/></style:style>`;

function cellXml(sp: LabelSpecimen | undefined, opts: LabelOptions): string {
  const lines = sp ? labelLines(sp, opts) : [];
  const style = { title: 'L_title', plain: 'L_plain', name: 'L_name', field: 'L_field', sub: 'L_sub' };
  const inner = lines
    .map((l) => {
      if (l.kind === 'blank') return '<text:p text:style-name="L_blank"/>';
      // The title style is bold already; everywhere else a bold run is a
      // caption (Loc.:) or the herbarium number.
      const spans = odtSpans(
        l.runs.map((r) => ({ text: r.text, bold: !!r.bold, italic: !!r.italic })),
        l.kind === 'title',
      );
      return `<text:p text:style-name="${style[l.kind]}">${spans}</text:p>`;
    })
    .join('');
  return `<table:table-cell table:style-name="L_cell">${inner || '<text:p text:style-name="L_body"/>'}</table:table-cell>`;
}

export function buildLabelSheetOdt(items: LabelSpecimen[], opts: LabelOptions): Uint8Array {
  const tables: string[] = [];
  for (let start = 0; start < items.length; start += LABELS_PER_PAGE) {
    const page = items.slice(start, start + LABELS_PER_PAGE);
    const rows: string[] = [];
    for (let i = 0; i < page.length; i += COLS) {
      rows.push(
        `<table:table-row table:style-name="L_row">${cellXml(page[i], opts)}${cellXml(page[i + 1], opts)}</table:table-row>`,
      );
    }
    const n = tables.length + 1;
    tables.push(
      `<table:table table:name="Labels${n}" table:style-name="${n === 1 ? 'L_tbl' : 'L_tblBreak'}">` +
        `<table:table-column table:style-name="L_col" table:number-columns-repeated="${COLS}"/>` +
        `${rows.join('')}</table:table>`,
    );
  }
  return buildOdt(
    tables.join(''),
    STYLES,
    { widthCm: 21, heightCm: 29.7, marginCm: Number(MARGIN_CM.toFixed(4)) },
  );
}
