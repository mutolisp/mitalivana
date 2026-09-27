#!/usr/bin/env node
/**
 * The privacy policy, bundled for the in-app screen (app/privacy.tsx), so it
 * reads offline in the field. Source of truth: mobile/PRIVACY.md (zh-TW) and
 * mobile/PRIVACY.en.md; copied verbatim, never edited here.
 *
 *   node scripts/gen-privacy.mjs           # write src/generated/privacy.json
 *   node scripts/gen-privacy.mjs --check   # exit 1 if that file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'src/generated/privacy.json';
const next = JSON.stringify({ zh: readFileSync('../PRIVACY.md', 'utf8'), en: readFileSync('../PRIVACY.en.md', 'utf8') }) + '\n';

if (process.argv.includes('--check')) {
  let cur = '';
  try {
    cur = readFileSync(OUT, 'utf8');
  } catch {}
  if (cur !== next) {
    console.error(`✖ ${OUT} is stale — PRIVACY.md or PRIVACY.en.md changed.\n  Run: npm run privacy`);
    process.exit(1);
  }
  // The screen's parser: every section heading survives, links keep their URL.
  const { parsePolicy, inAppBlocks, isOpenableUrl } = await import('../src/lib/policyMarkdown.ts');
  const { zh, en } = JSON.parse(next);
  for (const [name, md] of [['zh', zh], ['en', en]]) {
    const blocks = parsePolicy(md);
    const h2 = md.split('\n').filter((l) => /^## /.test(l)).length;
    const got = blocks.filter((b) => b.type === 'h' && b.level === 2).length;
    const links = blocks.flatMap((b) => ('spans' in b ? b.spans : [])).filter((s) => s.url?.startsWith('https://')).length;
    if (got !== h2 || got < 5 || links < 3) {
      console.error(`✖ ${name}: parsed ${got}/${h2} section headings, ${links} links`);
      process.exit(1);
    }
    // In the app: no leftover link to the other language's file, and the
    // contact address opens the mail app (Device_test 43-44).
    const shown = inAppBlocks(blocks).flatMap((b) => ('spans' in b ? b.spans : []));
    // A link the app cannot open, or Markdown link syntax left as plain text.
    const dead = shown.filter((s) => (s.url ? !isOpenableUrl(s.url) : /\]\(/.test(s.text)));
    const mail = shown.some((s) => s.url?.startsWith('mailto:'));
    if (dead.length || !mail) {
      console.error(`✖ ${name}: ${dead.length} link(s) the app cannot open (${dead.map((s) => s.url ?? s.text).join(', ')}); mailto link ${mail ? 'present' : 'missing'}`);
      process.exit(1);
    }
  }
  console.log('✓ privacy: bundled policy matches PRIVACY.md / PRIVACY.en.md, and parses');
} else {
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT}`);
}
