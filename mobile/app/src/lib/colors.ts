/**
 * App accent, in one place.
 *
 * Since the UI redesign the accent is moss (`accent-*` in tailwind.config.js)
 * and glyph colours come from `useThemeColors()` in src/theme/colors.ts, which
 * has a dark-mode value a single constant could not. The history of the old
 * teal is kept for context:
 *
 * `#00A2A5` arrived for the export swipe action and then spread to the header
 * icon buttons and the filled primary actions. It was redefined at each of
 * those sites, which is how a palette drifts — so it lives here now.
 *
 * `ACTION_FILL` is a Tailwind class string rather than a hex because the
 * buttons it styles differ in shape and padding; only the fill and its pressed
 * state are shared. NativeWind's scanner reads it as a literal from this file
 * (the same mechanism that makes `SwipeRowActions`' colour map work), so the
 * classes are compiled even though call sites interpolate it.
 */

/** Filled primary action: the button that completes what the user started. */
export const ACTION_FILL = 'bg-accent-600 active:bg-accent-700';
