/**
 * A search box docked to the bottom of a tab screen (the taxonomy tree's, the
 * key list's, the species search's).
 *
 * With the tab bar it floats: lifted clear of the bar while the keyboard is
 * closed. With the bar folded into its round button it is a bar down to the
 * screen edge, its background running under the home indicator, and when the
 * button sits in the bottom slot the bar leaves the button's width free beside
 * the box, carrying its top rule across so the button sits inside the bar
 * (src/lib/tabBubbleCore.ts `bottomClearance`). With the keyboard up the
 * button hides and the box takes the full width; the bottom padding then
 * hides behind the keyboard (`opened`), so the box sits on the keyboard.
 *
 * The list above it pads its bottom by `useTabDock().lift`, the part of it the
 * lifted box covers. `npm run check:dock` sends tab-screen docks here.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { useTabDock } from '~/lib/tabBarLayout';

export function TabDock({ children }: { children: ReactNode }) {
  const dock = useTabDock();
  const filled = dock.pad > 0 || dock.left > 0 || dock.right > 0;
  // The boxes draw their own 1 pt top rule (border-t gray-200 / gray-700);
  // the strip left for the button gets the same rule so the bar reads as one.
  const rule = 'absolute top-0 h-px bg-gray-200 dark:bg-gray-700';
  return (
    <KeyboardStickyView offset={{ closed: -dock.lift, opened: dock.pad }}>
      <View
        style={{ paddingLeft: dock.left, paddingRight: dock.right, paddingBottom: dock.pad }}
        // The dock's own colour, so the strip and the padding read as the dock.
        className={filled ? 'bg-card dark:bg-gray-900' : undefined}
      >
        {children}
        {dock.left > 0 ? <View pointerEvents="none" className={`${rule} left-0`} style={{ width: dock.left }} /> : null}
        {dock.right > 0 ? <View pointerEvents="none" className={`${rule} right-0`} style={{ width: dock.right }} /> : null}
      </View>
    </KeyboardStickyView>
  );
}
