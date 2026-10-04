/**
 * The collapsed tab bar (decided 2026-10-04): the bar folds into one round
 * button that shows the current tab. A tap opens the tab menu, a drag moves
 * the button to either edge, a long press brings the bar back. This file is
 * the geometry and the menu order; `TabBubble.tsx` draws it.
 *
 * Positions are in the tab area's own coordinates. The button's place is kept
 * as an edge plus the distance of its bottom from the bottom of that area, so
 * a taller or shorter screen (rotation, split view) keeps it where it was put
 * relative to the thumb rather than at an absolute y.
 *
 * Functions used inside gesture callbacks carry the 'worklet' directive; it is
 * a plain string to Node, so check:tab-bubble runs the file as it is.
 */

export const BUBBLE_SIZE = 56;
/** Off the screen edge: Android's back swipe starts within the first ~20 dp (same as the sync button). */
export const BUBBLE_MARGIN = 12;
/** Gap between the button and its open menu. */
export const MENU_GAP = 14;

export type BubbleSide = 'left' | 'right';

/** Where the button was put. `side` null: the ＋ side (`fab_side`); `bottom` null: at the bottom. */
export type TabBubblePlace = { side: BubbleSide | null; bottom: number | null };

/** The tab area: its size and the safe-area insets inside it. */
export type BubbleArea = { width: number; height: number; insetTop: number; insetBottom: number };

/** The lowest and highest `bottom` the button may have. */
export function bottomRange(a: BubbleArea): { min: number; max: number } {
  'worklet';
  const min = a.insetBottom + BUBBLE_MARGIN;
  const max = Math.max(min, a.height - a.insetTop - BUBBLE_MARGIN - BUBBLE_SIZE);
  return { min, max };
}

/** A stored or dragged `bottom`, kept on screen; null is the default (the lowest). */
export function clampBottom(a: BubbleArea, bottom: number | null): number {
  'worklet';
  const r = bottomRange(a);
  return bottom == null ? r.min : Math.min(r.max, Math.max(r.min, bottom));
}

/** The button's left edge on `side`. */
export function xOf(a: BubbleArea, side: BubbleSide): number {
  'worklet';
  return side === 'left' ? BUBBLE_MARGIN : a.width - BUBBLE_SIZE - BUBBLE_MARGIN;
}

/** The edge a button dropped at left edge `x` snaps to: whichever its centre is nearer. */
export function sideOf(a: BubbleArea, x: number): BubbleSide {
  'worklet';
  return x + BUBBLE_SIZE / 2 < a.width / 2 ? 'left' : 'right';
}

/** The menu opens upward from a button in the lower half of the area, downward from one in the upper half. */
export function menuOpensUp(a: BubbleArea, bottom: number): boolean {
  return bottom + BUBBLE_SIZE / 2 < a.height / 2;
}

/**
 * The menu's items, nearest the button first: ＋, then the tabs in the bar's
 * order going away from the ＋ — so the menu reads like the bar folded up at
 * the ＋ end. `barOrder` is the bar's left-to-right order, with 'plus' at
 * one end (TAB_ORDER in app/(tabs)/_layout.tsx).
 */
export function menuOrder(barOrder: readonly string[]): string[] {
  const tabs = barOrder.filter((n) => n !== 'plus');
  return ['plus', ...(barOrder[0] === 'plus' ? tabs : [...tabs].reverse())];
}

/**
 * The button's bottom slot. A button dropped with its bottom within one button
 * height of the lowest place snaps down to it: there it sits beside the
 * docked search boxes and the map's lowest controls, which leave it room
 * (`bottomClearance`). Anywhere higher it floats over the screen and nothing
 * moves for it, so there are two clean states rather than a sliding overlap.
 */
export const SNAP_BAND = BUBBLE_SIZE;

/** Where a button dropped at `bottom` comes to rest: null (the bottom slot) when it is near enough. */
export function snapBottom(a: BubbleArea, bottom: number): number | null {
  'worklet';
  return bottom < bottomRange(a).min + SNAP_BAND ? null : Math.round(bottom);
}

/** The stored place is the bottom slot (a place from an older or taller screen counts by its clamped value). */
export function atBottomSlot(place: TabBubblePlace, insetBottom: number): boolean {
  return place.bottom == null || place.bottom <= insetBottom + BUBBLE_MARGIN;
}

/** Gap kept under a docked search box when the bar is folded. */
export const DOCK_GAP = 4;
/** Gap kept under content that spans the width when nothing sits under it. */
export const BASE_GAP = 8;

/**
 * What a tab screen leaves clear at the bottom, all measured up from the
 * screen's bottom edge.
 *
 *   inset      content across the full width: list padding, full-width cards
 *   left/right controls anchored in that bottom corner
 *   dockLift   how far a docked search box is lifted over the content above it
 *              (that content pads its bottom by as much)
 *   dockPad    the dock's own bottom padding, down to the screen edge
 *   dockLeft/dockRight  room a docked box leaves at that side for the button
 *
 * With the bar, everything clears the bar and the dock floats above it.
 * Folded, the button's corner clears the button when it is in the bottom
 * slot, the rest of the bottom drops to the safe area, and the dock becomes a
 * bar down to the screen edge (in the layout, not lifted) with the button in
 * it: its background runs under the home indicator, rather than leaving a
 * band of the screen showing below a floating box (2026-10-04, from a user
 * screenshot). While the keyboard is up the button is hidden, so the dock
 * takes the full width.
 */
export function bottomClearance(o: {
  folded: boolean;
  insetBottom: number;
  /** The bar's own clearance (tabBarLayout.ts: insets + gap + bar height). */
  barInset: number;
  side: BubbleSide;
  atBottom: boolean;
  keyboardUp: boolean;
}): { inset: number; left: number; right: number; dockLift: number; dockPad: number; dockLeft: number; dockRight: number } {
  if (!o.folded) return { inset: o.barInset, left: o.barInset, right: o.barInset, dockLift: o.barInset, dockPad: 0, dockLeft: 0, dockRight: 0 };
  const base = o.insetBottom + BASE_GAP;
  const zone = o.insetBottom + BUBBLE_MARGIN + BUBBLE_SIZE;
  const room = o.atBottom && !o.keyboardUp ? BUBBLE_MARGIN + BUBBLE_SIZE + DOCK_GAP : 0;
  return {
    inset: o.atBottom ? zone : base,
    left: o.atBottom && o.side === 'left' ? zone : base,
    right: o.atBottom && o.side === 'right' ? zone : base,
    dockLift: 0,
    dockPad: o.insetBottom + DOCK_GAP,
    dockLeft: o.side === 'left' ? room : 0,
    dockRight: o.side === 'right' ? room : 0,
  };
}

/** The stored place, or the default when it is missing or not one. */
export function parsePlace(raw: string | undefined): TabBubblePlace {
  const none: TabBubblePlace = { side: null, bottom: null };
  if (!raw) return none;
  try {
    const p = JSON.parse(raw) as Partial<TabBubblePlace> | null;
    if (!p || typeof p !== 'object') return none;
    return {
      side: p.side === 'left' || p.side === 'right' ? p.side : null,
      bottom: typeof p.bottom === 'number' && Number.isFinite(p.bottom) ? p.bottom : null,
    };
  } catch {
    return none;
  }
}
