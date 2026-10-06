/**
 * Colours of what the split map draws (SplitMapView, design 18j / 18m). Map
 * data keeps one colour in light and dark mode: it sits on map tiles, not on
 * the app's paper, so it does not follow the theme or the accent.
 */
export const MAP_DATA = {
  /** The walked track; stretches alternate the two so their ends show. */
  track: '#00A2A5',
  trackAlt: '#5CC3C5',
  /** The stretch whose records the list is showing. */
  trackPicked: '#00686A',
  /** A record's pin, and the white ring around it. */
  pin: '#2F6B3E',
  pinRing: '#FFFFFF',
  /** A pin outside the stretch being shown. */
  pinDim: 'rgba(47,107,62,0.35)',
  /** Point count: the counting circle and its centre. */
  circle: '#00A2A5',
  circleFill: 'rgba(0,162,165,0.10)',
  countPoint: '#97561A',
  /** Inside / outside the circle, on the status pill. */
  inside: '#2F6B3E',
  outside: '#A8321F',
  /** Track pill dot: recording, paused. */
  recording: '#A8321F',
  paused: '#B9A88F',
} as const;
