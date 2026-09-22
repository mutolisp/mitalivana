#!/usr/bin/env node
/**
 * Guard the bottom-sticky search dock invariant.
 *
 * `KeyboardStickyView`'s `offset.opened` must equal the chrome sitting BELOW
 * the dock, because that chrome is what pushes the dock up out of the keyboard's
 * way. Two valid pairings exist in this app:
 *
 *   offset={{ opened: insets.bottom }}  ⟺  screen root is <SafeAreaView edges={['bottom']}>
 *   offset={{ closed: -tabBarInset }}   ⟺  screen is inside the bottom tab navigator
 *
 * The tab-screen pairing INVERTED when the tab bar started floating (2026-09-18).
 * An in-flow bar ends the scene above itself, so the dock sat too high with the
 * keyboard open and `opened: tabBarHeight` pushed it back down. A floating bar
 * overlays the scene instead: the dock now rests at the screen bottom, behind
 * the pill, so it must be lifted while the keyboard is CLOSED and needs nothing
 * once the keyboard is open. `useBottomTabBarHeight()` is also no longer the
 * right number — it returns `tabBarStyle.height` verbatim, knowing nothing about
 * the pill's bottom offset — so `useTabBarInset()` from src/lib/tabBarLayout.ts
 * is the only correct source and the old spelling is rejected outright.
 *
 * Copy one half without the other and the box is shoved *behind* the keyboard.
 * That has shipped three times now (KeyListView 2026-05-14, favorites 2026-06-07,
 * collection 2026-08-29), each time by copying a working screen's offset onto a
 * screen with different chrome — so the pairing is checked rather than just
 * documented in CLAUDE.md / memory.
 *
 * Deliberately a text check, not an AST one: the failure mode is always
 * "the two halves disagree", which is visible lexically per file.
 *
 * Usage: node scripts/check-bottom-dock.mjs   (exit 1 on violation)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', 'app'];
const SELF = 'src/components/KeyboardAvoidingView.tsx'; // re-export site, not a caller

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const problems = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative('.', file);
    if (rel === SELF) continue;
    const src = readFileSync(file, 'utf8');
    if (!/<KeyboardStickyView/.test(src)) continue;

    const usesInsets = /offset=\{\{\s*opened:\s*insets\.bottom\s*\}\}/.test(src);
    const usesTabBar = /offset=\{\{\s*closed:\s*-tabBarInset\s*\}\}/.test(src);
    // Kept as an explicit rejection rather than just falling into "unrecognised":
    // this is the exact shape every previous regression had, so it earns a
    // message that names the replacement.
    const usesStaleTabBar =
      /offset=\{\{\s*opened:\s*tabBarHeight\s*\}\}/.test(src) ||
      /useBottomTabBarHeight/.test(src);

    if (usesInsets && !/edges=\{\['bottom'\]\}/.test(src)) {
      problems.push(
        `${rel}\n    offset={{ opened: insets.bottom }} but no <SafeAreaView edges={['bottom']}>.\n` +
          `    Nothing to compensate for → the dock is pushed ~insets.bottom BEHIND the keyboard.\n` +
          `    Fix: make the screen root <SafeAreaView edges={['bottom']}> (see app/session/[id].tsx).`,
      );
    }
    if (usesStaleTabBar) {
      problems.push(
        `${rel}\n    Uses the pre-floating-tab-bar pairing (offset={{ opened: tabBarHeight }}\n` +
          `    and/or useBottomTabBarHeight()). The bar now floats over the scene, so that\n` +
          `    offset is both the wrong direction and the wrong magnitude.\n` +
          `    Fix: const tabBarInset = useTabBarInset()  // ~/lib/tabBarLayout\n` +
          `         offset={{ closed: -tabBarInset }}`,
      );
    }
    if (usesTabBar && !/useTabBarInset/.test(src)) {
      problems.push(
        `${rel}\n    offset={{ closed: -tabBarInset }} without useTabBarInset().`,
      );
    }
    // The other half of the same number. Lifting the dock does not shrink the
    // content above it — the dock is translated, so it OVERLAYS exactly
    // `tabBarInset` px of whatever was laid out above. The content therefore
    // has to reserve that much too. Shipped twice on 2026-09-22 (the species
    // tab's Search and Key segments both hid their last element, the
    // add-to-record button and the last key row), which is why the pairing is
    // checked on the content side as well and not only on the dock's offset.
    if (usesTabBar && !/paddingBottom:\s*tabBarInset/.test(src)) {
      problems.push(
        `${rel}\n    offset={{ closed: -tabBarInset }} but nothing reserves paddingBottom:\n` +
          `    tabBarInset. The dock is translated up over the content, so the\n` +
          `    bottom tabBarInset px of that content are hidden behind the search box.\n` +
          `    Fix: contentContainerStyle={{ paddingBottom: tabBarInset }} on the list,\n` +
          `         or style={{ paddingBottom: tabBarInset }} on the content container.`,
      );
    }
    if (!usesInsets && !usesTabBar && !usesStaleTabBar) {
      problems.push(
        `${rel}\n    <KeyboardStickyView> with an unrecognised offset. The two supported\n` +
          `    pairings are insets.bottom (+ SafeAreaView edges) and -tabBarInset (+ tab screen).\n` +
          `    If this dock genuinely has no chrome below it, use offset={{ opened: 0 }} and say why.`,
      );
    }
  }
}

if (problems.length) {
  console.error('✗ bottom-dock invariant violated:\n');
  for (const p of problems) console.error('  ' + p + '\n');
  process.exit(1);
}
console.log('✓ bottom-dock invariant holds for every KeyboardStickyView caller');
