/**
 * Fixture check for the ODT writers (`src/lib/odt.ts`, `reportOdt.ts`,
 * `odtLabels.ts`).
 *
 * What this is defending: an .odt that breaks a package rule is not opened at
 * all, and a paragraph pointing at a style that was never declared is opened
 * but silently loses its formatting — scientific names come out upright and
 * nobody notices. So every output below is unzipped and checked for:
 *   - the package rules of ODF 1.3 Part 2 §3.3: `mimetype` first, stored,
 *     no extra field, equal to the manifest's root media type;
 *   - a manifest that lists exactly the files in the zip;
 *   - well-formed XML with nothing unescaped;
 *   - every style name used in content.xml declared somewhere;
 * then for what each writer must say (italics, chart tables, label pages).
 *
 * Full RELAX NG validation against the official ODF 1.3 schema needs Java and
 * the schema files, so it is a manual step (see mobile/Update_log.md), not
 * part of this check.
 *
 * Run: npm run check:odt
 */
import { strFromU8, unzipSync } from 'fflate';
import { ODT_MIME, markdownToOdt, odtText } from '../src/lib/odt.ts';
import { buildReportOdt, chartAsTable } from '../src/lib/reportOdt.ts';
import { buildLabelSheetOdt } from '../src/lib/odtLabels.ts';
import { DOC_FORMATS, reportFormatLabels } from '../src/lib/docFormat.ts';

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const ok = (label, cond) => {
  if (!cond) fail(label);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};

/** Tag-balance check. The writers emit no comments, CDATA or PIs beyond the
 *  XML declaration, so a stack over start/end tags is a complete test. */
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return `unbalanced </${name}>`;
    } else stack.push(name);
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  const stray = body.replace(/<\/?[A-Za-z][\w:.-]*(?:\s+[\w:.-]+="[^"<]*")*\s*\/?>/g, '');
  if (/[<>]/.test(stray)) return 'stray < or > outside a tag';
  return null;
}

/** Package + structure checks shared by every writer. Returns the parts. */
function inspect(label, bytes) {
  // Local file header of the first entry (APPNOTE 4.3.7): signature,
  // compression method at +8, name length at +26, extra length at +28.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  ok(`${label}: starts with a local file header`, dv.getUint32(0, true) === 0x04034b50);
  const nameLen = dv.getUint16(26, true);
  const first = strFromU8(bytes.subarray(30, 30 + nameLen));
  eq(`${label}: first entry`, first, 'mimetype');
  eq(`${label}: mimetype stored uncompressed`, dv.getUint16(8, true), 0);
  eq(`${label}: mimetype has no extra field`, dv.getUint16(28, true), 0);

  const zip = unzipSync(bytes);
  const names = Object.keys(zip);
  const text = (n) => strFromU8(zip[n]);
  eq(`${label}: mimetype content`, text('mimetype'), ODT_MIME);

  const manifest = text('META-INF/manifest.xml');
  const listed = [...manifest.matchAll(/manifest:full-path="([^"]+)"/g)].map((m) => m[1]);
  ok(`${label}: manifest root entry`, manifest.includes(`manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODT_MIME}"`));
  eq(
    `${label}: manifest lists exactly the package files`,
    listed.filter((p) => p !== '/').sort(),
    names.filter((n) => n !== 'mimetype' && !n.startsWith('META-INF/')).sort(),
  );

  for (const n of names.filter((x) => x.endsWith('.xml'))) {
    const xml = text(n);
    const err = wellFormed(xml);
    ok(`${label}: ${n} well-formed${err ? ` (${err})` : ''}`, !err);
    ok(`${label}: ${n} ampersands escaped`, !/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(xml));
  }

  // Every style a paragraph, span, table, column, row or cell names must be
  // declared — an undeclared one is ignored without a word.
  const content = text('content.xml');
  const styles = text('styles.xml');
  const declared = new Set(
    [...(content + styles).matchAll(/<style:(?:style|page-layout) style:name="([^"]+)"/g)].map((m) => m[1]),
  );
  const used = new Set(
    [...content.matchAll(/(?:text|table):style-name="([^"]+)"/g)].map((m) => m[1]),
  );
  for (const s of used) ok(`${label}: style ${s} is declared`, declared.has(s));
  return { content, styles, names };
}

// ── text escaping ──────────────────────────────────────────────────────────
eq('odtText keeps leading and repeated spaces', odtText('  a  b'), '<text:s text:c="2"/>a <text:s text:c="1"/>b');
eq('odtText tab and newline', odtText('a\tb\nc'), 'a<text:tab/>b<text:line-break/>c');
eq('odtText escapes', odtText('<b> & "q"'), '&lt;b&gt; &amp; &quot;q&quot;');

// ── Markdown checklist ─────────────────────────────────────────────────────
{
  const md = [
    '# 名錄 & <script>',
    '',
    '## 真雙子葉植物 Eudicots',
    '### 樟目',
    '**1. 樟科 Lauraceae**',
    '1. *Litsea cubeba* (Lour.) Pers. 山胡椒  *',
    '2. *Litsea* sp.',
  ].join('\n');
  const { content } = inspect('markdown', markdownToOdt(md));
  ok('markdown: h1 is an outline-level-1 heading', content.includes('<text:h text:style-name="P_h1" text:outline-level="1">'));
  ok('markdown: species name italic', content.includes('<text:span text:style-name="T_i">Litsea cubeba</text:span>'));
  ok('markdown: genus-only name italic', content.includes('<text:span text:style-name="T_i">Litsea</text:span><text:s text:c="1"/>sp.'));
  ok('markdown: lone naturalised * stays literal', /山胡椒 <text:s text:c="1"\/>\*<\/text:p>/.test(content));
  ok('markdown: family line indented one level', content.includes('<text:p text:style-name="P_l1"><text:span text:style-name="T_b">1. 樟科 Lauraceae</text:span></text:p>'));
  ok('markdown: species line indented two levels', content.includes('<text:p text:style-name="P_l2">1. <text:span'));
  ok('markdown: hostile title escaped', content.includes('名錄 &amp; &lt;script&gt;') && !content.includes('<script>'));
  ok('markdown: blank lines dropped', !content.includes('<text:p text:style-name="P_l0"></text:p>'));
}

// ── report ─────────────────────────────────────────────────────────────────
{
  /** @type {import('../src/lib/reportTypes').Report} */
  const report = {
    kind: 'plot',
    title: 'Plot & <b>',
    subtitle: 'Sub',
    generatedAt: '2026-09-24T10:00',
    chartTableNote: 'charts as tables',
    sections: [
      { id: 'meta', heading: 'Meta', meta: [{ key: 'Area', value: '400 m²' }] },
      {
        id: 'dom',
        heading: 'Dominants',
        chart: {
          kind: 'bar',
          title: 'Cover',
          unit: '%',
          seriesLabels: ['Observed', 'Chao1'],
          rows: [
            { label: '*Litsea cubeba*', value: 40, value2: 41.5 },
            { label: 'L & <i>', value: 2.25 },
          ],
        },
        table: { columns: ['Species', 'Cover'], rows: [['*Machilus*', '12']], align: ['left', 'right'] },
        note: 'note',
      },
      {
        id: 'acc',
        heading: 'Accumulation',
        chart: {
          kind: 'line',
          title: 'S',
          xAxis: { title: 'n' },
          yAxis: {},
          series: [
            { label: 'A', points: [{ x: 1, y: 3 }, { x: 2, y: 5 }], band: [{ lo: 2, hi: 4 }, { lo: 4, hi: 6 }] },
            { label: 'B', points: [{ x: 2, y: 1 }, { x: 3, y: 2 }] },
          ],
        },
      },
      {
        id: 'prof',
        heading: 'Profile',
        chart: {
          kind: 'profile',
          title: 'Profile',
          heightAxisTitle: 'Height (m)',
          valueAxisTitle: 'Cover (%)',
          degradedNote: 'DOCX-only caveat',
          bands: [
            { label: 'E1', y0: 12.4, y1: 20, value: 60 },
            { label: 'E2', y0: 2, y1: 5, value: 30 },
          ],
        },
      },
    ],
  };
  const { content } = inspect('report', buildReportOdt(report));
  ok('report: chart note printed once', content.split('charts as tables').length === 2);
  ok('report: DOCX-only profile caveat not printed', !content.includes('DOCX-only caveat'));
  ok('report: hostile title escaped', content.includes('Plot &amp; &lt;b&gt;') && !content.includes('<b>'));
  ok('report: table header row repeats', content.includes('<table:table-header-rows>'));
  ok('report: italic kept in table cells', content.includes('<text:span text:style-name="T_i">Machilus</text:span>'));
  ok('report: italic kept in chart tables', content.includes('<text:span text:style-name="T_i">Litsea cubeba</text:span>'));
  ok('report: numeric cells right-aligned', content.includes('<text:p text:style-name="R_cellR">41.5</text:p>'));
  // meta + bar + table + line + profile
  eq('report: one table per block', (content.match(/<table:table /g) ?? []).length, 5);
  ok('report: profile keeps its metre range', content.includes('12.4–20'));

  eq('bar → table', chartAsTable(report.sections[1].chart), {
    columns: ['', 'Observed', 'Chao1'],
    rows: [
      ['*Litsea cubeba*', '40', '41.5'],
      ['L & <i>', '2.25', '–'],
    ],
    align: ['left', 'right', 'right'],
  });
  eq('line → table covers every x of every series', chartAsTable(report.sections[2].chart), {
    columns: ['n', 'A', 'A (–/+)', 'B'],
    rows: [
      ['1', '3', '2–4', '–'],
      ['2', '5', '4–6', '1'],
      ['3', '–', '–', '2'],
    ],
    align: ['right', 'right', 'right', 'right'],
  });
  eq('profile → table', chartAsTable(report.sections[3].chart).rows, [
    ['E1', '12.4–20', '60'],
    ['E2', '2–5', '30'],
  ]);
}

// ── labels ─────────────────────────────────────────────────────────────────
{
  const base = {
    simple_name: 'Litsea cubeba',
    name_author: '(Lour.) Pers.',
    kingdom: 'Plantae',
    rank: 'Species',
    common_name_c: '山胡椒',
    family: 'Lauraceae',
    family_c: '樟科',
    collected_at: Date.UTC(2026, 0, 2, 3, 4, 5),
    locality: '合歡山 & <東峰>',
    lat: 24.1,
    lng: 121.2,
    accuracy: 5,
    recorded_by: 'Collector A',
    identified_by: null,
    notes: null,
  };
  const items = Array.from({ length: 23 }, (_, i) => ({ ...base, record_number: `C-${i + 1}` }));
  const { content } = inspect('labels', buildLabelSheetOdt(items, { title: 'Flora of Taiwan', includeFamily: true }));
  eq('labels: 23 labels → 3 pages', (content.match(/<table:table /g) ?? []).length, 3);
  eq('labels: pages after the first break before', (content.match(/table:style-name="L_tblBreak"/g) ?? []).length, 2);
  eq('labels: every label present', (content.match(/Coll\. No\.: <\/text:span>C-\d+/g) ?? []).length, 23);
  eq('labels: 12 rows (5 + 5 + 2)', (content.match(/<table:table-row /g) ?? []).length, 12);
  ok('labels: name italic, author upright', content.includes('<text:span text:style-name="T_i">Litsea cubeba</text:span><text:s text:c="1"/>(Lour.) Pers.'));
  ok('labels: locality escaped', content.includes('Loc.: </text:span>合歡山 &amp; &lt;東峰&gt;'));
  ok('labels: data fields indented', content.includes('<text:p text:style-name="L_field"><text:span text:style-name="T_b">Alt.: </text:span></text:p>'));
  ok('labels: coordinates on an indented continuation line', content.includes('<text:p text:style-name="L_sub">24.10000, 121.20000 acc. 5 m</text:p>'));
  ok('labels: empty filler cell still has a paragraph', /<table:table-cell table:style-name="L_cell"><text:p text:style-name="L_body"\/><\/table:table-cell>/.test(content));
  const empty = inspect('labels (none)', buildLabelSheetOdt([], { title: '', includeFamily: false }));
  ok('labels (none): no table', !empty.content.includes('<table:table '));
}

// ── format table ───────────────────────────────────────────────────────────
eq('DOC_FORMATS extensions', [DOC_FORMATS.docx.ext, DOC_FORMATS.odt.ext], ['docx', 'odt']);
eq('ODT MIME', DOC_FORMATS.odt.mime, 'application/vnd.oasis.opendocument.text');
eq('report labels (odt, both)', reportFormatLabels('both', 'odt'), ['HTML', 'ODT']);
eq('report labels (odt, docx value)', reportFormatLabels('docx', 'odt'), ['ODT']);
eq('report labels (docx, html)', reportFormatLabels('html', 'docx'), ['HTML']);

if (failures > 0) {
  console.error(`check-odt: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-odt: all assertions passed');
