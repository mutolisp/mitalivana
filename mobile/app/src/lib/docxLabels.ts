/**
 * Herbarium label sheets as .docx — A4, ten labels per page in a 2 × 5 table
 * with dashed cut lines.
 *
 * Imports nothing from `~/db` and nothing from React on purpose: the whole
 * module is pure string → bytes, so it can be compiled with plain `tsc` and run
 * under Node to render an actual PDF for inspection. A label sheet that looks
 * wrong is very hard to debug on a phone.
 *
 * Every caption below is a hard-coded English literal, NOT i18n. A label is a
 * permanent physical record read by curators anywhere; it must not change
 * because the phone's UI language changed. Same rule the export layer already
 * applies to DwC controlled values.
 */
import { buildDocx, parseRuns, runXml, xmlEscape } from './docx';
import { familyLatinParen } from './familyLabel';
import { formatScientificNameMarkdown } from './scientificNameMarkdown';

/** Structurally satisfied by `SpecimenWithTaxon`, so rows pass straight through. */
export type LabelSpecimen = {
  record_number: string;
  simple_name: string;
  name_author: string;
  kingdom: string;
  /** So a genus-level specimen ("Litsea sp.") gets its italic genus. */
  rank?: string | null;
  common_name_c: string;
  family: string;
  family_c: string;
  collected_at: number;
  locality: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  recorded_by: string | null;
  identified_by: string | null;
  notes: string | null;
  /** Herbarium number, printed as institution code + catalog number. */
  institution_code?: string | null;
  catalog_number?: string | null;
  /** Collecting altitude, metres. */
  elevation_m?: number | null;
};

export type LabelOptions = {
  /** Sheet heading, e.g. "Flora of Taiwan". Blank omits the line. */
  title: string;
  includeFamily: boolean;
};

// ── Geometry, in twips (1/1440 in). Every number is derived, not guessed. ──
const PAGE_W = 11906; // 210 mm
const PAGE_H = 16838; // 297 mm
/** 0.8 cm — still wider than the non-printable edge of a consumer inkjet
 *  (~5 mm), and the 340 twips this buys back over 1 cm go into the row budget. */
const MARGIN = 454;
const CONTENT_W = PAGE_W - MARGIN * 2; // 10772
const COL_W = Math.floor(CONTENT_W / 2); // 5386 ≈ 9.5 cm
/**
 * 5 × 3170 = 15850, plus the ~20-twip separator paragraph, against a content
 * height of 16838 − 2×454 = 15930. The separator is load-bearing arithmetic,
 * not decoration: OOXML requires a paragraph between two consecutive tables
 * (otherwise Word merges them), and sizing rows at content_height / 5 leaves no
 * room for it and produces a blank sixth page.
 */
const ROW_H = 3170;
const ROWS_PER_PAGE = 5;
const COLS = 2;
const PER_PAGE = ROWS_PER_PAGE * COLS;

const FONT = 16; // 8 pt, in half-points
const NAME_FONT = 18; // 9 pt
/** The heading is the largest thing on the label — it is what identifies the
 *  institution at a glance across a drawer of sheets. */
const TITLE_FONT = 20; // 10 pt

/**
 * Explicit line heights, in twips, one per font size.
 *
 * This is what makes the sheet hold five labels on ANY machine. With
 * `lineRule="auto"` the line height comes from the FONT, and DFKai-SB asks for
 * roughly 1.45 em where a substituted font asks for ~1.2 — which is why a sheet
 * that renders 5 rows here came out 4 rows in Word: every label grew past
 * ROW_H and `atLeast` duly grew the row. Pinning `lineRule="atLeast"` to a
 * value ABOVE what the face needs at that size makes the height deterministic
 * (nothing at 8-10 pt asks for more) while still never clipping a tall glyph.
 */
const LINE_BODY = 240; // 12 pt for 8 pt text
const LINE_NAME = 260;
const LINE_TITLE = 280;
const LINE_BLANK = 160;
/** Half a line of vertical padding: the cut edge needs less than the sides. */
const CELL_MAR_V = 57;

/**
 * `<w:sectPr>` children are a SEQUENCE: pgSz → pgMar → cols. No `<w:docGrid>`
 * on purpose — the East-Asian document grid re-pitches lines inside cells and
 * is the usual cause of absurd CJK line spacing.
 */
const SECT_PR =
  `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>` +
  `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}"` +
  ` w:header="0" w:footer="0" w:gutter="0"/><w:cols w:space="425"/></w:sectPr>`;

const BORDER_SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
/** `w:sz` is in eighths of a point, so 4 = 0.5 pt. */
const TBL_BORDERS =
  '<w:tblBorders>' +
  BORDER_SIDES.map((k) => `<w:${k} w:val="dashed" w:sz="4" w:space="0" w:color="808080"/>`).join('') +
  '</w:tblBorders>';

/**
 * `CT_TblPrBase` is a sequence: tblW → … → tblBorders → shd → tblLayout →
 * tblCellMar. Putting `tblLayout` before `tblBorders` — the intuitive order —
 * makes Word offer to "repair" the file.
 *
 * `tblLayout fixed` is mandatory: without it Word auto-fits columns to their
 * content, the two columns end up different widths, and the sheet is useless
 * for cutting.
 */
const TBL_PR =
  `<w:tblPr><w:tblW w:w="${CONTENT_W}" w:type="dxa"/>${TBL_BORDERS}` +
  '<w:tblLayout w:type="fixed"/>' +
  `<w:tblCellMar><w:top w:w="${CELL_MAR_V}" w:type="dxa"/><w:left w:w="170" w:type="dxa"/>` +
  `<w:bottom w:w="${CELL_MAR_V}" w:type="dxa"/><w:right w:w="170" w:type="dxa"/></w:tblCellMar></w:tblPr>`;

const TBL_GRID = `<w:tblGrid><w:gridCol w:w="${COL_W}"/><w:gridCol w:w="${COL_W}"/></w:tblGrid>`;

/** NOT `lineRule="exact"` — that clips the ascenders of 標楷體 glyphs. */
const spacing = (line: number) =>
  `<w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="atLeast"/>`;

/** `CT_PPrBase` is a sequence: spacing → ind → … → jc, so `jc` goes last. */
const CENTER = '<w:jc w:val="center"/>';

function para(runs: string, line: number, extraProps = ''): string {
  return `<w:p><w:pPr>${spacing(line)}${extraProps}</w:pPr>${runs}</w:p>`;
}

/** A real empty paragraph, not just spacing: the reference layout has them as
 *  editable blank lines, and Word users expect to be able to type into one. */
const BLANK = `<w:p><w:pPr>${spacing(LINE_BLANK)}<w:rPr><w:sz w:val="12"/></w:rPr></w:pPr></w:p>`;

/** Local `YYYY-MM-DD HH:MM:SS`. Deliberately not `datetime.ts`'s `isoDateTime`,
 *  whose contract is `T`-separated and minute-precision; a collection label
 *  carries seconds and reads better with a space. */
function labelDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Latitude first — the herbarium and Google Maps convention. Printed under
 *  the Loc. line, so it carries no caption of its own. */
function coordLine(sp: LabelSpecimen): string {
  if (sp.lat == null || sp.lng == null) return '';
  const acc = sp.accuracy != null ? ` acc. ${Math.round(sp.accuracy)} m` : '';
  return `${sp.lat.toFixed(5)}, ${sp.lng.toFixed(5)}${acc}`;
}

/** The herbarium number as it is written on a sheet: institution code and
 *  catalog number run together (TAI13450). Empty when there is no catalog
 *  number — the line is then left out altogether. */
export function catalogLabel(sp: LabelSpecimen): string {
  const catalog = (sp.catalog_number ?? '').trim();
  if (!catalog) return '';
  const inst = (sp.institution_code ?? '').trim();
  // Already written with its code ("TAI13450") — do not double it.
  if (!inst || catalog.toUpperCase().startsWith(inst.toUpperCase())) return catalog;
  return `${inst}${catalog}`;
}

const metres = (m: number) => `${Number.isInteger(m) ? m : Number(m.toFixed(1))} m`;

export type LabelRun = { text: string; bold?: boolean; italic?: boolean };

/**
 * One label's content, format-neutral: what each line says and what kind of
 * line it is. Both label writers (this file and `odtLabels.ts`) render from
 * this, so a DOCX sheet and an ODT sheet cannot say different things.
 *
 *   title  centred, bold          sheet heading
 *   plain  indented               family, herbarium number
 *   name   centred                scientific name + one vernacular
 *   field  indented like plain,   Loc. / Alt. / Coll. / Date / Det. / Note
 *          bold caption
 *   sub    indented further       continuation of the field above
 *   blank  spacer
 *
 * Runs rather than Markdown: user text (a note with an asterisk in it) must
 * print as typed, never be parsed into italics.
 */
export type LabelLine =
  | { kind: 'title' | 'plain' | 'name' | 'field' | 'sub'; runs: LabelRun[] }
  | { kind: 'blank' };

export function labelLines(sp: LabelSpecimen, opts: LabelOptions): LabelLine[] {
  const out: LabelLine[] = [];
  const field = (caption: string, value: string | null | undefined, more: LabelRun[] = []) =>
    out.push({
      kind: 'field',
      runs: [{ text: `${caption} `, bold: true }, { text: (value ?? '').trim() }, ...more],
    });

  const title = opts.title.trim();
  if (title) out.push({ kind: 'title', runs: [{ text: title, bold: true }] });

  // Identity first: family, then the herbarium number when the sheet has one.
  const family = opts.includeFamily ? familyLatinParen(sp.family, sp.family_c) : '';
  if (family) out.push({ kind: 'plain', runs: [{ text: family }] });
  const catalog = catalogLabel(sp);
  if (catalog) out.push({ kind: 'plain', runs: [{ text: catalog, bold: true }] });

  // Genus + species italic, author upright, via the same pipeline the Markdown
  // export uses; then the one vernacular the caller chose.
  const full = [sp.simple_name, sp.name_author].filter(Boolean).join(' ').trim();
  if (full) {
    const md = formatScientificNameMarkdown(full, sp.kingdom, '', sp.rank ?? '');
    const runs: LabelRun[] = parseRuns(md, false).map((r) => ({ text: r.text, italic: r.italic }));
    if (sp.common_name_c) runs.push({ text: ` ${sp.common_name_c}` });
    out.push({ kind: 'name', runs });
  }
  out.push({ kind: 'blank' });

  // The record. Every caption is printed even when empty: a blank Alt. or
  // Note is where the collector writes it in by hand.
  field('Loc.:', sp.locality);
  const coords = coordLine(sp);
  if (coords) out.push({ kind: 'sub', runs: [{ text: coords }] });
  field('Alt.:', sp.elevation_m != null ? metres(sp.elevation_m) : '');
  field('Coll.:', sp.recorded_by, [
    { text: '; ' },
    { text: 'Coll. No.: ', bold: true },
    { text: sp.record_number ?? '' },
  ]);
  field('Date:', labelDateTime(sp.collected_at));
  // Never falls back to the collector: that would assert a determination
  // nobody made.
  field('Det.:', sp.identified_by);
  field('Note:', sp.notes);
  return out;
}

/** Indents (twips): the family, the herbarium number and the data fields all
 *  start on one line, slightly in from the cell edge; the second line of a
 *  wrapped field and a continuation line (the coordinates under Loc.) line up
 *  past the caption. A field is therefore a hanging indent: first line at
 *  FIELD_IND, the rest at SUB_IND. */
const FIELD_IND = 113; // 0.2 cm
const SUB_IND = FIELD_IND + 454; // + 0.8 cm

const ind = (twips: number, hanging = 0) =>
  `<w:ind w:left="${twips}"${hanging ? ` w:hanging="${hanging}"` : ''}/>`;
const runsXml = (runs: LabelRun[], size: number) =>
  runs.map((r) => runXml({ text: r.text, bold: !!r.bold, italic: !!r.italic }, size)).join('');

function labelParagraphs(sp: LabelSpecimen, opts: LabelOptions): string {
  const body = labelLines(sp, opts)
    .map((l) => {
      switch (l.kind) {
        case 'title':
          return para(runsXml(l.runs, TITLE_FONT), LINE_TITLE, CENTER);
        case 'plain':
          return para(runsXml(l.runs, FONT), LINE_BODY, ind(FIELD_IND));
        case 'name':
          return para(runsXml(l.runs, NAME_FONT), LINE_NAME, CENTER);
        case 'field':
          return para(runsXml(l.runs, FONT), LINE_BODY, ind(SUB_IND, SUB_IND - FIELD_IND));
        case 'sub':
          return para(runsXml(l.runs, FONT), LINE_BODY, ind(SUB_IND));
        case 'blank':
          return BLANK;
      }
    })
    .join('');
  // A <w:tc> with no block-level child is the single most common cause of
  // Word's "unreadable content" prompt.
  return body || '<w:p/>';
}

/** `CT_TcPr` is a sequence too: tcW → … → vAlign. */
function cell(inner: string): string {
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${COL_W}" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr>` +
    `${inner}</w:tc>`
  );
}

function row(cells: string[]): string {
  return (
    `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${ROW_H}" w:hRule="atLeast"/></w:trPr>` +
    cells.join('') +
    '</w:tr>'
  );
}

/**
 * `atLeast`, not `exact`.
 *
 * `exact` silently CLIPS overflow, and the lines that get clipped are the last
 * ones — Det. and Note. Losing the attribution off a permanent label, with no
 * visible sign, is the worst outcome available here. `atLeast` instead grows
 * the row, which the user sees immediately.
 *
 * Budget: a full label (title, family, number, name, spacer, seven data
 * lines) is 280 + 2×240 + 260 + 160 + 7×240 = 2860 twips plus 114 of cell
 * margin, against a 3170 row — room for one wrapped line (a long Loc. or
 * Note) before the grid moves. `cantSplit` keeps a label from being sliced across a page
 * boundary either way.
 */
function tableXml(page: LabelSpecimen[], opts: LabelOptions): string {
  const rows: string[] = [];
  for (let i = 0; i < page.length; i += COLS) {
    const cells = [cell(labelParagraphs(page[i], opts))];
    // Only emit the trailing filler cell that the row actually needs; a short
    // last page does not get five empty rows.
    cells.push(page[i + 1] ? cell(labelParagraphs(page[i + 1], opts)) : cell('<w:p/>'));
    rows.push(row(cells));
  }
  return `<w:tbl>${TBL_PR}${TBL_GRID}${rows.join('')}</w:tbl>`;
}

/** 1 pt tall, so it fits in the slack left by the five rows. */
const SEPARATOR = `<w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>{BREAK}</w:p>`;
const PAGE_BREAK = SEPARATOR.replace('{BREAK}', '<w:r><w:br w:type="page"/></w:r>');
/** The body must not end with a table, so the last page still gets a trailer. */
const TRAILER = SEPARATOR.replace('{BREAK}', '');

export function buildLabelSheetDocx(items: LabelSpecimen[], opts: LabelOptions): Uint8Array {
  const pages: LabelSpecimen[][] = [];
  for (let i = 0; i < items.length; i += PER_PAGE) pages.push(items.slice(i, i + PER_PAGE));

  // join(), not += in a loop: a 200-specimen sheet is 20 tables of XML.
  const body = pages.map((p) => tableXml(p, opts)).join(PAGE_BREAK) + TRAILER;
  return buildDocx(body, SECT_PR);
}

/** Exported for the verification harness and `odtLabels.ts`. */
export const LABELS_PER_PAGE = PER_PAGE;
export { xmlEscape };
