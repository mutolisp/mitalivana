#!/usr/bin/env node
/**
 * Guard the unified selection marks and navigation controls
 * (docs/planned/ui-redesign/05-controls.md §4).
 *
 * Fails on:
 *   - `arrow-back`: back is always chevron-back (IconDisc / BackHeaderLeft);
 *   - `#d1d5db`: the old disabled grey — a disabled control fades instead;
 *   - a `›` / `‹` typed as text where an icon belongs;
 *   - the checkbox / radio / check-circle glyphs outside src/components/ui/,
 *     where SelectMark (round, selection), Checkbox (square, a value), Radio
 *     and DoneMark (status tick) own them. `accessibilityRole="checkbox"` is
 *     a role, not a glyph, and is allowed.
 * Warns (does not fail) on `chevron-forward` outside ui/, so the remaining
 * hand-drawn row chevrons can be moved to `Chevron` bit by bit.
 *
 * A file opts out with a header comment `// check-controls-ignore: <reason>`
 * in its first five lines.
 *
 * Deliberately a text scan: every failure here is a literal in the source.
 *
 * Usage: node scripts/check-controls.mjs   (exit 1 on violation)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', 'app'];
const UI_DIR = 'src/components/ui/';
const SKIP_DIRS = ['src/i18n'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP_DIRS.some((d) => p.startsWith(d))) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const GLYPHS = ['checkbox', 'square-outline', 'checkmark-circle', 'ellipse-outline', 'radio-button-on', 'radio-button-off'];
const GLYPH_RE = new RegExp(`(['"])(${GLYPHS.join('|')})\\1`, 'g');
const TEXT_ARROW_RES = [
  />\s*[›‹]\s*[<{]/, // <Text>›</Text>, <Text>‹ {…}
  /\}\s*[›‹]\s*</, // {label} ›</Text>
  /\s[›‹]['"`]/, // 'Next ›'
  /['"`][›‹]\s/, // '‹ Prev'
];

const errors = [];
const warnings = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative('.', file);
    const src = readFileSync(file, 'utf8');
    if (/check-controls-ignore:\s*\S/.test(src.split('\n').slice(0, 5).join('\n'))) continue;
    const inUi = rel.startsWith(UI_DIR);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      const code = line.replace(/\/\/.*$/, ''); // ignore trailing line comments
      if (/['"]arrow-back['"]/.test(code)) errors.push(`${at}  arrow-back — use chevron-back (IconDisc icon="back")`);
      if (/#d1d5db/i.test(code)) errors.push(`${at}  #d1d5db — fade the control (opacity) or use a theme token`);
      if (TEXT_ARROW_RES.some((re) => re.test(code))) errors.push(`${at}  text ›/‹ used as an icon — use Chevron / LinkChevron`);
      if (!inUi) {
        for (const m of code.matchAll(GLYPH_RE)) {
          const before = code.slice(Math.max(0, m.index - 24), m.index);
          if (/accessibilityRole=\s*\{?\s*$/.test(before) || /role:\s*$/.test(before)) continue;
          errors.push(`${at}  '${m[2]}' — use SelectMark / Checkbox / Radio / DoneMark from src/components/ui`);
        }
        if (/['"]chevron-forward['"]/.test(code)) warnings.push(at);
      }
    });
  }
}

if (warnings.length) {
  console.log(`ℹ  controls: ${warnings.length} chevron-forward outside src/components/ui (move to Chevron when touched)`);
}
if (errors.length) {
  console.error(`✗ controls: ${errors.length} problem(s)`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log('✓ controls: selection marks, back buttons and disabled steps follow 05-controls');
