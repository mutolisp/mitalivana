/**
 * The formatted-document formats the app writes, and everything that differs
 * between them. Every export entry point (record bundles, project bundle,
 * favorites, single report, specimen labels) goes through this table instead
 * of branching on the format itself, so a format is added or changed in one
 * place.
 *
 * UTIs are the system-declared ones (`org.oasis-open.opendocument.text` read
 * back from macOS Launch Services for an .odt this writer produced).
 */
import { DOCX_MIME, markdownToDocx } from './docx';
import { buildLabelSheetDocx, type LabelOptions, type LabelSpecimen } from './docxLabels';
import { ODT_MIME, markdownToOdt } from './odt';
import { buildLabelSheetOdt } from './odtLabels';
import { buildReportDocx } from './reportDocx';
import { buildReportOdt } from './reportOdt';
import type { Report } from './reportTypes';
import type { DocFormat, ReportFormat } from '~/stores/settings';

export type DocWriter = {
  ext: DocFormat;
  /** Shown to the user: "DOCX" / "ODT". */
  label: string;
  mime: string;
  uti: string;
  fromMarkdown: (md: string) => Uint8Array;
  report: (report: Report) => Uint8Array;
  labels: (items: LabelSpecimen[], opts: LabelOptions) => Uint8Array;
};

export const DOC_FORMATS: Record<DocFormat, DocWriter> = {
  docx: {
    ext: 'docx',
    label: 'DOCX',
    mime: DOCX_MIME,
    uti: 'org.openxmlformats.wordprocessingml.document',
    fromMarkdown: (md) => markdownToDocx(md),
    report: buildReportDocx,
    labels: buildLabelSheetDocx,
  },
  odt: {
    ext: 'odt',
    label: 'ODT',
    mime: ODT_MIME,
    uti: 'org.oasis-open.opendocument.text',
    fromMarkdown: markdownToOdt,
    report: buildReportOdt,
    labels: buildLabelSheetOdt,
  },
};

/** The file formats a report setting produces, for display:
 *  `['HTML']`, `['ODT']`, `['HTML', 'ODT']`, … */
export function reportFormatLabels(report: ReportFormat, doc: DocFormat): string[] {
  const docLabel = DOC_FORMATS[doc].label;
  if (report === 'html') return ['HTML'];
  if (report === 'docx') return [docLabel];
  return ['HTML', docLabel];
}
