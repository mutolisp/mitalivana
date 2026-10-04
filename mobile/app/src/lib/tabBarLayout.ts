/**
 * Geometry of the floating tab bar, in one place.
 *
 * The bar is a rounded pill that floats over the screens rather than sitting
 * in the layout flow, with the ＋ button as a detached circle beside it. That
 * makes every tab screen responsible for its own bottom clearance, and it
 * breaks the assumption three bottom-docked search boxes were built on:
 *
 *   `useBottomTabBarHeight()` returns `tabBarStyle.height` VERBATIM when that
 *   is a number (see getTabBarHeight in @react-navigation/bottom-tabs). It
 *   knows nothing about `bottom:` or the safe-area inset below the pill.
 *
 * So `tabBarHeight` is no longer the space the bar occupies — it is short by
 * `insets.bottom + BAR_GAP`. Anything positioned against the bottom of a tab
 * screen must use the hooks below instead (`useTabBarInset`, or
 * `useTabBarCorners` for one corner, or `<TabDock>` for a docked search box),
 * which also follow the bar when it is folded into a round button. Getting
 * this wrong is this codebase's most-repeated shipped bug (KeyListView
 * 2026-05-14, favorites 2026-06-07, collection 2026-08-29), which is why
 * `npm run check:dock` enforces the pairing rather than trusting a comment.
 */
import { useWindowDimensions } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { atBottomSlot, bottomClearance } from '~/lib/tabBubbleCore';
import { useSettings } from '~/stores/settings';

/** Pill height. Icon (24) + label (~13) + breathing room, rounded to a value
 *  whose half is a clean corner radius. */
export const BAR_HEIGHT = 58;

/** Gap between the pill's bottom edge and the safe-area inset. */
export const BAR_GAP = 10;

/** Screen-width fraction kept clear on EACH side of the whole assembly
 *  (pill + ＋ circle). A ratio rather than a fixed margin so the bar keeps the
 *  same proportions from a small phone to a tablet. */
export const BAR_SIDE_RATIO = 0.1;

/** The ＋ circle. It rides INSIDE the pill — a detached button was tried and
 *  rejected — so it has to clear the pill's own height rather than being sized
 *  purely as a thumb target. */
export const FAB_SIZE = 42;

/**
 * The bar may be folded into one round button (2026-10-04, tabBubbleCore.ts),
 * so what a screen leaves clear depends on that and on where the button sits.
 */
function useClearance(keyboardUp = false) {
  const insets = useSafeAreaInsets();
  const folded = useSettings((s) => s.tab_bar_mode) === 'bubble';
  const place = useSettings((s) => s.tab_bubble);
  const fabSide = useSettings((s) => s.fab_side);
  return bottomClearance({
    folded,
    insetBottom: insets.bottom,
    barInset: insets.bottom + BAR_GAP + BAR_HEIGHT,
    side: place.side ?? fabSide,
    atBottom: atBottomSlot(place, insets.bottom),
    keyboardUp,
  });
}

/**
 * Bottom clearance for what spans a tab screen's width: everything from the
 * screen's bottom edge up to the top of the floating pill — or, with the bar
 * folded, of the round button when it sits in the bottom slot.
 *
 * Use it for scroll `contentContainerStyle.paddingBottom` and for anything
 * absolutely positioned across the bottom of a tab screen. A docked search
 * box is `<TabDock>` (its list underneath pads by `useTabDock().lift`); a
 * control in one bottom corner uses `useTabBarCorners()`.
 */
export function useTabBarInset(): number {
  return useClearance().inset;
}

/** Bottom clearance in each corner: only the button's corner has to clear it when the bar is folded. */
export function useTabBarCorners(): { left: number; right: number } {
  const c = useClearance();
  return { left: c.left, right: c.right };
}

/**
 * A docked search box: how far it is lifted over the content above it while
 * the keyboard is closed, its own bottom padding down to the screen edge, and
 * the room it leaves at each side for the folded bar's button. `TabDock`
 * applies them; the list above the dock pads its bottom by `lift`.
 */
export function useTabDock(): { lift: number; pad: number; left: number; right: number } {
  const keyboardUp = useKeyboardState((k) => k.isVisible);
  const c = useClearance(keyboardUp);
  return { lift: c.dockLift, pad: c.dockPad, left: c.dockLeft, right: c.dockRight };
}

/**
 * Horizontal placement of the pill, and which end the + sits at.
 *
 * `fabOnLeft` mirrors the whole strip rather than only moving the +: the point
 * of the setting is that a left-handed thumb reaches the + first, and leaving
 * the tabs in their old order would put Settings next to it instead of at the
 * far end. The mirroring is done by reversing the list, not with a transform —
 * a transform would flip the icons and the label text with it.
 */
export function useTabBarMetrics() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const fabSide = useSettings((s) => s.fab_side);

  // The notch is cleared on top of the ratio, not out of it, so a landscape
  // screen does not quietly lose part of the gutter the user asked for.
  const gutter = width * BAR_SIDE_RATIO;

  return {
    fabOnLeft: fabSide === 'left',
    pill: { left: gutter + insets.left, right: gutter + insets.right },
  };
}
