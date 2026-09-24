/**
 * Minimal OpenDocument Text (.odt) writer, hand-built with fflate — the ODF
 * counterpart of `docx.ts`, over the same inputs.
 *
 * Package rules, from OpenDocument v1.3 Part 2 (Packages) §3.3, checked
 * against the OASIS text rather than recalled:
 *   - `mimetype` is the FIRST zip entry, stored uncompressed, with no extra
 *     field, and holds the media type as ASCII;
 *   - `META-INF/manifest.xml` lists the package root (`/`) with that same
 *     media type, plus every other file.
 * `buildOdt` is the only place a package is assembled, so every caller gets
 * those right by construction. `check:odt` validates the XML against the
 * official ODF 1.3 RELAX NG schema.
 *
 * Formatting lives in automatic styles, not on each span: headings, indents
 * and table cells are paragraph styles, bold/italic are the three `T_*` text
 * styles below. Runs come from `parseRuns` in `docx.ts`, so scientific-name
 * italics follow exactly the same rules in both formats.
 *
 * Pure module (fflate + string building only) so it runs under Node.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import { indentLevel, parseRuns, xmlEscape, type Run } from './docx';

export const ODT_MIME = 'application/vnd.oasis.opendocument.text';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'office:version="1.3"';

// Latin → Times New Roman, CJK → DFKai-SB (標楷體), as in the DOCX export.
const FONT_FACES =
  '<office:font-face-decls>' +
  '<style:font-face style:name="Times New Roman" svg:font-family="&apos;Times New Roman&apos;" style:font-family-generic="roman"/>' +
  '<style:font-face style:name="標楷體" svg:font-family="標楷體"/>' +
  '</office:font-face-decls>';

/** Text formatting for one span. Bold and italic are set for both the Latin
 *  and the Asian script so a CJK run inside a bold heading is bold too. */
const BOLD = 'fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"';
const ITALIC = 'fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"';

/** Size (pt) set for all three scripts. */
export function fontSize(pt: number): string {
  return `fo:font-size="${pt}pt" style:font-size-asian="${pt}pt" style:font-size-complex="${pt}pt"`;
}
export const ODT_BOLD = BOLD;

const TEXT_STYLES =
  `<style:style style:name="T_b" style:family="text"><style:text-properties ${BOLD}/></style:style>` +
  `<style:style style:name="T_i" style:family="text"><style:text-properties ${ITALIC}/></style:style>` +
  `<style:style style:name="T_bi" style:family="text"><style:text-properties ${BOLD} ${ITALIC}/></style:style>`;

/**
 * Character data for a span or paragraph. ODF collapses runs of spaces (§6.1.2
 * of Part 3), so every space after the first of a run — and any space at the
 * start of the string, which may begin a paragraph — becomes `<text:s/>`.
 * Tabs and newlines get their own elements for the same reason.
 */
export function odtText(s: string): string {
  return xmlEscape(s)
    .replace(/\t/g, '<text:tab/>')
    .replace(/\r?\n/g, '<text:line-break/>')
    .replace(/^ +/, (m) => `<text:s text:c="${m.length}"/>`)
    .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
}

/** Runs → spans. A run's bold is stated only when it differs from the
 *  paragraph's own weight (`baseBold`), since the paragraph style already
 *  carries it. */
export function odtSpans(runs: Run[], baseBold = false): string {
  return runs
    .map((r) => {
      const bold = r.bold && !baseBold;
      const name = bold && r.italic ? 'T_bi' : bold ? 'T_b' : r.italic ? 'T_i' : '';
      const text = odtText(r.text);
      return name ? `<text:span text:style-name="${name}">${text}</text:span>` : text;
    })
    .join('');
}

export type OdtPage = {
  widthCm: number;
  heightCm: number;
  marginCm: number;
};

/** A4 portrait with 2 cm margins — the same page as `A4_SECT_PR`. */
export const A4_PAGE: OdtPage = { widthCm: 21, heightCm: 29.7, marginCm: 2 };

/** `styles.xml`: fonts, the defaults every paragraph inherits, and the one page
 *  layout. Named "Standard" because that is the master page a paragraph with
 *  no `master-page-name` uses. */
function stylesXml(page: OdtPage, basePt: number): string {
  const m = `${page.marginCm}cm`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<office:document-styles ${NS}>${FONT_FACES}` +
    '<office:styles>' +
    '<style:default-style style:family="paragraph">' +
    '<style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0cm"/>' +
    '<style:text-properties style:font-name="Times New Roman" style:font-name-asian="標楷體"' +
    ` style:font-name-complex="Times New Roman" ${fontSize(basePt)}/>` +
    '</style:default-style>' +
    '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
    '</office:styles>' +
    '<office:automatic-styles>' +
    `<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="${page.widthCm}cm"` +
    ` fo:page-height="${page.heightCm}cm" style:print-orientation="portrait"` +
    ` fo:margin-top="${m}" fo:margin-bottom="${m}" fo:margin-left="${m}" fo:margin-right="${m}"/>` +
    '</style:page-layout>' +
    '</office:automatic-styles>' +
    '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>' +
    '</office:document-styles>'
  );
}

function contentXml(bodyXml: string, automaticStyles: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<office:document-content ${NS}>${FONT_FACES}` +
    `<office:automatic-styles>${TEXT_STYLES}${automaticStyles}</office:automatic-styles>` +
    `<office:body><office:text>${bodyXml}</office:text></office:body>` +
    '</office:document-content>'
  );
}

const MANIFEST =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
  `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODT_MIME}"/>` +
  '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
  '</manifest:manifest>';

/**
 * Zip a caller-built `<office:text>` body into an .odt.
 *
 * `automaticStyles` holds the caller's own paragraph/table styles; the `T_*`
 * span styles are always present. `basePt` is the default font size.
 */
export function buildOdt(
  bodyXml: string,
  automaticStyles: string,
  page: OdtPage = A4_PAGE,
  basePt = 12,
): Uint8Array {
  // Insertion order is zip order: `mimetype` must come first. Level 0 stores
  // it uncompressed; fflate writes no extra field unless asked to.
  const zippable: Zippable = {
    mimetype: [strToU8(ODT_MIME), { level: 0 }],
    'META-INF/manifest.xml': strToU8(MANIFEST),
    'styles.xml': strToU8(stylesXml(page, basePt)),
    'content.xml': strToU8(contentXml(bodyXml, automaticStyles)),
  };
  return zipSync(zippable, { level: 6 });
}

/** Paragraph style with the given paragraph and text properties. */
export function paraStyle(name: string, paraProps: string, textProps = ''): string {
  return (
    `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard">` +
    (paraProps ? `<style:paragraph-properties ${paraProps}/>` : '') +
    (textProps ? `<style:text-properties ${textProps}/>` : '') +
    '</style:style>'
  );
}

// ── Markdown checklist ──────────────────────────────────────────────────────

// Same measures as the DOCX path: headings 16/14/13/12 pt with 10 pt before and
// 3 pt after; 240 twips (1/6 in) of indent per hierarchy level.
const HEADING_PT: Record<number, number> = { 1: 16, 2: 14, 3: 13, 4: 12 };
const INDENT_CM = 0.4233;

function indentProp(level: number): string {
  return `fo:margin-left="${(level * INDENT_CM).toFixed(4)}cm"`;
}

const MD_STYLES =
  [1, 2, 3, 4]
    .map((h) =>
      paraStyle(
        `P_h${h}`,
        `fo:margin-top="0.3528cm" fo:margin-bottom="0.1058cm" ${indentProp(Math.max(0, h - 2))}`,
        `${BOLD} ${fontSize(HEADING_PT[h])}`,
      ),
    )
    .join('') +
  [0, 1, 2].map((l) => paraStyle(`P_l${l}`, indentProp(l))).join('');

function mdParagraph(line: string): string {
  if (line.trim() === '') return '';
  const h = /^(#{1,4})\s+(.*)$/.exec(line);
  if (h) {
    const level = h[1].length;
    return (
      `<text:h text:style-name="P_h${level}" text:outline-level="${level}">` +
      `${odtSpans(parseRuns(h[2], true), true)}</text:h>`
    );
  }
  return `<text:p text:style-name="P_l${indentLevel(line)}">${odtSpans(parseRuns(line, false))}</text:p>`;
}

/** Render a Markdown string (the subset `generateMarkdown` emits) to .odt
 *  bytes, laid out like `markdownToDocx`. */
export function markdownToOdt(md: string): Uint8Array {
  return buildOdt(md.split(/\r?\n/).map(mdParagraph).join(''), MD_STYLES);
}
