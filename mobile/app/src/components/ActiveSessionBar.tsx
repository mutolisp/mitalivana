/**
 * Top bar shown while a checklist, plot survey, GLORIA or MIREN survey is in
 * progress.
 *
 * Filename kept as ActiveSessionBar for backward compat; the bar covers every
 * record kind under the single-active rule and picks whichever started most
 * recently if a stale store still holds two.
 */
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActiveRecordSummary } from '~/lib/useActiveRecordSummary';
import { useShows } from '~/lib/useUsageMode';

export function ActiveSessionBar() {
  const router = useRouter();
  const pathname = usePathname();
  const active = useActiveRecordSummary();
  const insets = useSafeAreaInsets();
  // Casual mode's records tab is 我的觀察, which has no ActiveRecordCard: a
  // record left open from another mode needs the full bar there (code review M41).
  const recordsTabHasCard = !useShows('casualObservations');

  if (!active) return null;
  const { kind: shown, barLabel: label, targetPath } = active;
  const showPlot = shown === 'plot';
  // This bar is persistent chrome rendered above the stack on EVERY screen,
  // including the record's own detail page. Tapping it must not push a second
  // copy of a screen already on the stack (that turned exiting into many
  // back-presses). Guard the no-op case, then use `navigate` (pops back to an
  // existing instance) instead of `push` (always adds a new one).
  const href: Href = targetPath as Href;

  // On the record's OWN detail page the full bar is 36pt spent restating what
  // the screen already says: the title is the record, and the header carries
  // its stop button. That screen is also the one with the least room to spare
  // — the species list there was down to about three rows. So it degrades to a
  // hairline: still a persistent "recording" cue, at a twelfth of the height.
  //
  // It keeps filling `insets.top` because nothing else does: _layout.tsx only
  // renders <TopSafeAreaSpacer> when NOTHING is active. And it must stay
  // accent there — `<SystemBars style={hasActive ? 'light' : …}>` in
  // _layout.tsx paints the status-bar icons white while any record is running,
  // so a pale inset would hide the clock and battery entirely.
  //
  // The records tab ('/') gets the hairline too: its ActiveRecordCard already
  // says what is recording, with more room to say it.
  if (pathname === targetPath || (pathname === '/' && recordsTabHasCard)) {
    return (
      <View className="bg-accent-600" style={{ paddingTop: insets.top }}>
        <View className="h-1" />
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => {
        if (pathname === targetPath) return;
        router.navigate(href);
      }}
      className="bg-accent-600 active:bg-accent-700"
      style={{ paddingTop: insets.top }}
    >
      <View className="flex-row items-center px-4 py-2">
        <View className="mr-2 h-2 w-2 rounded-full bg-card dark:bg-gray-900" />
        <Ionicons
          name={shown === 'miren' ? 'trail-sign' : shown === 'gloria' ? 'triangle' : showPlot ? 'grid' : 'list'}
          size={14}
          color="white"
          style={{ marginRight: 6 }}
        />
        <Text className="flex-1 text-sm font-medium text-white" numberOfLines={1}>
          {label}
        </Text>
        <Ionicons name="chevron-forward" size={16} color="white" />
      </View>
    </Pressable>
  );
}
