/**
 * Just enough Markdown for the bundled privacy policy (app/privacy.tsx):
 * headings, paragraphs, bullet and numbered lists, rules, and inline bold,
 * code and links. Pure, so the parse is testable; anything else is shown as
 * plain text rather than dropped.
 */

export type Inline = { text: string; bold?: boolean; code?: boolean; url?: string; italic?: boolean };
export type Block =
  | { type: 'h'; level: 1 | 2 | 3; spans: Inline[] }
  | { type: 'p'; spans: Inline[] }
  | { type: 'li'; marker: string; depth: number; spans: Inline[] }
  | { type: 'hr' };

/** `**bold**`, `*italic*`, `` `code` ``, `[text](url)`, `<https://…>`. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    if (m[1] != null) out.push({ text: m[1], bold: true });
    else if (m[2] != null) out.push({ text: m[2], code: true });
    else if (m[3] != null) out.push({ text: m[3], url: m[4] });
    else if (m[5] != null) out.push({ text: m[5], url: m[5] });
    else if (m[6] != null) out.push({ text: m[6], italic: true });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

export function parsePolicy(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', spans: parseInline(para.join(' ')) });
    para = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ type: 'h', level: h[1].length as 1 | 2 | 3, spans: parseInline(h[2]) });
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      flush();
      blocks.push({ type: 'hr' });
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      blocks.push({ type: 'li', marker: /\d/.test(li[2]) ? li[2] : '•', depth: Math.floor(li[1].length / 2), spans: parseInline(li[3]) });
      continue;
    }
    // A wrapped continuation of the previous list item.
    const prev = blocks[blocks.length - 1];
    if (!para.length && prev?.type === 'li' && /^\s+/.test(raw)) {
      prev.spans.push({ text: ' ' }, ...parseInline(line.trim()));
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** A link the app can open: web pages and e-mail. */
export const isOpenableUrl = (url: string): boolean => /^(https?:\/\/|mailto:)/.test(url);

/** A link to a file next to this one (the other language's .md), as a span or as raw text. */
const RELATIVE_LINK = /^\[[^\]]+\]\((?!https?:|mailto:)[^)\s]+\)$/;

/**
 * In the app, drop paragraphs that are only a link to the other language's
 * file (「*[English version](PRIVACY.en.md)*」): the .md files keep them for
 * readers on the web, but in the app the language follows the UI and the
 * relative link leads nowhere. Wrapped in *…* the parser keeps the link as
 * literal text, which is how it showed up raw on screen (Device_test 43-44).
 */
export function inAppBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => {
    if (b.type !== 'p') return true;
    const deadLinkOnly = b.spans.every((s) => (s.url ? !isOpenableUrl(s.url) : !s.text.trim() || RELATIVE_LINK.test(s.text.trim())));
    return !(b.spans.length > 0 && deadLinkOnly);
  });
}
