/**
 * Navigation-back with a guaranteed fallback.
 *
 * `router.back()` is a no-op when there is no history (e.g. the screen was
 * reached via `router.replace`, or via a deep link / state restore). The
 * native header's default back button has the same problem — it just sits
 * there doing nothing. This helper falls back to the home tab so the user is
 * never stuck.
 */
import i18n from '~/i18n';
import { router } from 'expo-router';
import { IconDisc } from '~/components/ui/IconDisc';
import { useSelectBack } from '~/lib/selectBack';

export function goBackOrHome(): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/');
}

/** Drop-in `headerLeft` for `<Stack.Screen options={{ headerLeft }} />` that
 *  always lands somewhere — falls back to home when the navigation stack has
 *  no history (e.g. screen reached via `router.replace` or a deep link). */
export function BackHeaderLeft() {
  // Callers pass this as `headerLeft: BackHeaderLeft`, which the navigator
  // CALLS as a plain function inside its own render. So it must hold no hooks
  // itself (a hook here changed the header's hook order and crashed every
  // screen that used it); it only returns the element that does.
  return <BackHeaderButton />;
}

function BackHeaderButton() {
  // Chevron only. The word "back" cost a third of the header's width in the
  // longer European languages and said nothing the glyph does not; it lives on
  // as the accessibility label, which is where a screen reader looks for it.
  // In select mode, back leaves select mode first (05-controls.md §2.1).
  const exitSelect = useSelectBack((s) => s.exit);
  return (
    <IconDisc
      icon="back"
      onPress={exitSelect ?? goBackOrHome}
      accessibilityLabel={i18n.t(exitSelect ? 'common.exitSelect' : 'nav.back')}
      edge="left"
    />
  );
}
