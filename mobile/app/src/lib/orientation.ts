/**
 * Tablets may turn to landscape (the tree census's split view,
 * docs/planned/Modular_survey.md §7.6); phones stay portrait, as
 * app.config.ts declares and the Android manifest starts them. Android's
 * runtime request overrides the manifest; iPad already rotates (Info.plist).
 *
 * Tablet = smallest screen side ≥ 600 dp, Android's sw600dp.
 */
import { Dimensions } from 'react-native';

const TABLET_MIN_DP = 600;

export function unlockOrientationOnTablets(): void {
  const { width, height } = Dimensions.get('screen');
  if (Math.min(width, height) < TABLET_MIN_DP) return;
  // The native module throws at import in a dev client built before it was
  // added; the app then just stays portrait until the next native build.
  let mod: typeof import('expo-screen-orientation');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-screen-orientation');
  } catch {
    return;
  }
  mod.unlockAsync().catch(() => {});
}
