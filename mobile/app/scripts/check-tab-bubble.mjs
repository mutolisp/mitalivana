/**
 * The folded tab bar (src/lib/tabBubbleCore.ts, 2026-10-04): where its round
 * button may sit, which edge it snaps to, which way its menu opens, the
 * menu's order against the bar's real order (TAB_ORDER in
 * app/(tabs)/_layout.tsx), and the stored place.
 *
 * Also checks the wiring that a refactor could drop without a type error:
 * the team-sync button steps aside while the tab button is on screen, and
 * the tab button is the navigator's bar while folded.
 *
 * Run: npm run check:tab-bubble
 */
import { readFileSync } from 'node:fs';
import {
  BASE_GAP,
  BUBBLE_MARGIN,
  BUBBLE_SIZE,
  DOCK_GAP,
  MENU_GAP,
  SNAP_BAND,
  atBottomSlot,
  bottomClearance,
  bottomRange,
  clampBottom,
  menuMaxHeight,
  menuOpensUp,
  menuOrder,
  parsePlace,
  sideOf,
  snapBottom,
  xOf,
} from '../src/lib/tabBubbleCore.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A phone's tab area: 390 × 800 with a 47 top and 34 bottom inset.
const A = { width: 390, height: 800, insetTop: 47, insetBottom: 34 };

// ── where it may sit ──
const r = bottomRange(A);
ok(r.min === 34 + BUBBLE_MARGIN, `lowest bottom clears the home indicator (${r.min})`);
ok(r.max === 800 - 47 - BUBBLE_MARGIN - BUBBLE_SIZE, `highest bottom stays under the status bar (${r.max})`);
ok(clampBottom(A, null) === r.min, 'no stored place: at the bottom');
ok(clampBottom(A, 5) === r.min, 'below the range: raised to the lowest');
ok(clampBottom(A, 5000) === r.max, 'above the range (a taller screen before): lowered to the highest');
ok(clampBottom(A, 300) === 300, 'inside the range: kept');
const tiny = { width: 390, height: 60, insetTop: 0, insetBottom: 0 };
ok(bottomRange(tiny).max >= bottomRange(tiny).min, 'an area shorter than the button: the range does not invert');

// ── edges ──
ok(xOf(A, 'left') === BUBBLE_MARGIN, 'left edge, off the back-swipe strip');
ok(xOf(A, 'right') === 390 - BUBBLE_SIZE - BUBBLE_MARGIN, 'right edge');
ok(sideOf(A, 0) === 'left' && sideOf(A, 300) === 'right', 'dropped near an edge: that edge');
const mid = 390 / 2 - BUBBLE_SIZE / 2;
ok(sideOf(A, mid - 1) === 'left' && sideOf(A, mid) === 'right', 'the centre line decides');

// ── the menu opens away from the near screen edge ──
ok(menuOpensUp(A, r.min), 'at the bottom: the menu opens upward');
ok(!menuOpensUp(A, r.max), 'at the top: the menu opens downward');
// It fits in the room on that side, inside the safe area (code review L27: a short screen cut the sync row off).
{
  const short = { width: 640, height: 360, insetTop: 0, insetBottom: 21 };
  const rs = bottomRange(short);
  for (const b of [rs.min, (rs.min + rs.max) / 2, rs.max]) {
    const h = menuMaxHeight(short, b);
    const top = menuOpensUp(short, b) ? short.height - (b + BUBBLE_SIZE + MENU_GAP) - h : short.height - b + MENU_GAP;
    ok(top >= short.insetTop && top + h <= short.height - short.insetBottom, `menu room: within the screen at ${b} (top ${top}, height ${h})`);
  }
  ok(menuMaxHeight(A, r.min) > 600, 'menu room: a tall screen leaves the menu its full height');
}

// ── the menu's order against the bar's real order ──
const layout = readFileSync('app/(tabs)/_layout.tsx', 'utf8');
const orderOf = (side) => {
  const m = layout.match(new RegExp(`${side}: \\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
};
const right = orderOf('right');
const left = orderOf('left');
ok(right && left, 'TAB_ORDER found in app/(tabs)/_layout.tsx');
if (right && left) {
  for (const [name, o] of [['right', right], ['left', left]]) {
    ok(o[0] === 'plus' || o[o.length - 1] === 'plus', `TAB_ORDER.${name}: ＋ at one end (the menu folds the bar at the ＋ end)`);
    const menu = menuOrder(o);
    ok(menu[0] === 'plus', `${name}: ＋ nearest the button`);
    ok(eq([...menu].sort(), [...o].sort()), `${name}: every tab in the menu, once`);
  }
  ok(eq(menuOrder(right), ['plus', 'taxonomy', 'index', 'map', 'menu']), `right-handed: 物種 next to ＋, 設定 farthest (${menuOrder(right)})`);
  ok(eq(menuOrder(left), ['plus', 'index', 'map', 'taxonomy', 'menu']), `left-handed: the bar's order from the ＋ (${menuOrder(left)})`);
}

// ── the bottom slot ──
ok(snapBottom(A, r.min) === null, 'dropped at the lowest place: the bottom slot');
ok(snapBottom(A, r.min + SNAP_BAND - 1) === null, 'dropped within one button of it: snaps down');
ok(snapBottom(A, r.min + SNAP_BAND) === r.min + SNAP_BAND, 'dropped higher: stays where it was dropped');
ok(atBottomSlot({ side: 'right', bottom: null }, 34), 'no height stored: the bottom slot');
ok(atBottomSlot({ side: 'right', bottom: 34 + BUBBLE_MARGIN }, 34), 'stored at the lowest place: the bottom slot');
ok(!atBottomSlot({ side: 'right', bottom: 300 }, 34), 'stored higher: not the bottom slot');

// ── what the screens leave clear ──
const BAR = 34 + 10 + 58;
const clr = (o) => bottomClearance({ folded: true, insetBottom: 34, barInset: BAR, side: 'right', atBottom: true, keyboardUp: false, ...o });
const bar = clr({ folded: false });
ok(eq(bar, { inset: BAR, left: BAR, right: BAR, dockLift: BAR, dockPad: 0, dockLeft: 0, dockRight: 0 }), 'the bar: everything clears the bar, docks float above it at full width');
const zone = 34 + BUBBLE_MARGIN + BUBBLE_SIZE;
const low = clr({});
ok(low.inset === zone && low.right === zone, 'folded, button in the bottom slot: full-width content and its corner clear the button');
ok(low.left === 34 + BASE_GAP, 'folded: the other corner drops to the safe area (the map scale bar)');
ok(low.dockLift === 0 && low.dockPad === 34 + DOCK_GAP, 'folded: a docked search box is a bar down to the screen edge (not lifted, padded over the home indicator)');
ok(low.dockRight === BUBBLE_MARGIN + BUBBLE_SIZE + DOCK_GAP && low.dockLeft === 0, 'folded: the dock leaves the button room on its side only');
const leftLow = clr({ side: 'left' });
ok(leftLow.left === zone && leftLow.right === 34 + BASE_GAP && leftLow.dockLeft > 0 && leftLow.dockRight === 0, 'button on the left: the left corner and the dock\'s left side');
const high = clr({ atBottom: false });
ok(high.inset === 34 + BASE_GAP && high.left === high.inset && high.right === high.inset, 'button above the bottom slot: nothing at the bottom moves for it');
ok(high.dockLeft === 0 && high.dockRight === 0, 'button above the bottom slot: the dock takes the full width');
const typing = clr({ keyboardUp: true });
ok(typing.dockRight === 0 && typing.dockLeft === 0, 'keyboard up: the button hides, the dock takes the full width');
ok(low.dockLift < low.inset && BAR > low.dockLift, 'folding gives the docked screens their room back');

// ── the stored place ──
ok(eq(parsePlace(undefined), { side: null, bottom: null }), 'nothing stored: the default');
ok(eq(parsePlace('{"side":"left","bottom":120}'), { side: 'left', bottom: 120 }), 'a stored place read back');
ok(eq(parsePlace('{"side":"top","bottom":"x"}'), { side: null, bottom: null }), 'a bad side or bottom: the default for that part');
ok(eq(parsePlace('{"side":"right","bottom":null}'), { side: 'right', bottom: null }), 'an edge without a height');
ok(eq(parsePlace('not json'), { side: null, bottom: null }), 'a corrupt setting: the default');
ok(eq(parsePlace('null'), { side: null, bottom: null }), 'null: the default');

// ── wiring ──
const host = readFileSync('src/components/SyncProgressHost.tsx', 'utf8');
ok(/useTabChrome\(/.test(host) && /inTabButton \? null : <Bubble/.test(host), 'SyncProgressHost leaves its button out while the tab button shows the sync');
ok(/<KeepAwake \/>\s*\{inTabButton/.test(host), 'SyncProgressHost still keeps the screen awake then');
const bubble = readFileSync('src/components/TabBubble.tsx', 'utf8');
ok(/useTabChrome\.setState\(\{ bubbleShown: shown \}\)/.test(bubble), 'TabBubble says when it is on screen');
ok(/menuOrder\(order\)/.test(bubble), 'TabBubble lists the menu in menuOrder');
ok(
  /Gesture\.Exclusive\(Gesture\.Race\(pan, longPress\), tap\)/.test(bubble) && !/Gesture\.Exclusive\(pan, longPress/.test(bubble),
  'TabBubble: the long press races the drag (fires while held, not on release); the tap waits for both (code review M23)',
);
// An `active:` class makes NativeWind turn that view into its own touch target: a tap on a
// menu row's icon then never reaches the row (2026-10-04). The pressed look comes from the Pressable.
const bubbleCode = bubble.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/\bactive:/.test(bubbleCode), 'TabBubble: no active: classes (the row icon must pass taps to the row)');
ok(/tabBar=\{\(props\) => \(folded \? <TabBubble/.test(layout), 'the tab navigator draws TabBubble while folded');
const mapSrc = readFileSync('app/(tabs)/map.tsx', 'utf8');
ok(/compassInset=\{\{ bottom: corner\.right \+ 12/.test(mapSrc) && /bottom: corner\.right \+ 12 \+/.test(mapSrc), 'map: compass and locate follow the right corner');
ok(/<MapScaleBar[^>]*bottom=\{corner\.left \+ 6\}/.test(mapSrc), 'map: the scale bar (left) follows the left corner');
ok(!/useTabBarInset/.test(mapSrc), 'map: no corner control uses the full-width clearance');
ok(/useTabBarInset\(\)/.test(readFileSync('src/components/MapFeatureCard.tsx', 'utf8')), 'map feature card (full width) clears the button');
ok(/snapBottom\(area,/.test(bubble), 'TabBubble settles a low drop into the bottom slot');
ok(/tabLongPress:/.test(layout) && /setSetting\('tab_bar_mode', 'bubble'\)/.test(layout), 'a long press on a tab folds the bar');

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ tab-bubble: place, edges, bottom slot, clearances, menu direction and order, stored place, wiring');
