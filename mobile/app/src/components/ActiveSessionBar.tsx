/**
 * Top bar shown while a checklist session or plot survey is in progress.
 *
 * Filename kept as ActiveSessionBar for backward compat; the bar now covers
 * both record kinds and picks whichever started most recently when both are
 * active simultaneously.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { usePathname, useRouter, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';

export function ActiveSessionBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const session = useActiveSession((s) => s.session);
  const plot = useActivePlot((s) => s.plot);
  const insets = useSafeAreaInsets();

  if (!session && !plot) return null;

  // Pick the most recently started record to display in the bar. Both may be
  // active at the same time; we surface whichever was last touched.
  const sessionTs = session?.started_at ?? 0;
  const plotTs = plot?.start_ts ?? plot?.created_at ?? 0;
  const showPlot = plot && plotTs >= sessionTs;

  const label = showPlot ? t('activeBar.plotRecording', { id: plot!.plotid }) : t('activeBar.recording', { name: session!.name });
  // This bar is persistent chrome rendered above the stack on EVERY screen,
  // including the record's own detail page. Tapping it must not push a second
  // copy of a screen already on the stack (that turned exiting into many
  // back-presses). Guard the no-op case, then use `navigate` (pops back to an
  // existing instance) instead of `push` (always adds a new one).
  const targetPath = showPlot ? `/plot/${plot!.id}` : `/session/${session!.id}`;
  const href: Href = targetPath as Href;

  // On the record's OWN detail page the full bar is 36pt spent restating what
  // the screen already says: the title is the record, and the header carries
  // its stop button. That screen is also the one with the least room to spare
  // — the species list there was down to about three rows. So it degrades to a
  // hairline: still a persistent "recording" cue, at a twelfth of the height.
  //
  // It keeps filling `insets.top` because nothing else does: _layout.tsx only
  // renders <TopSafeAreaSpacer> when NOTHING is active. And it must stay
  // emerald there — `<SystemBars style={hasActive ? 'light' : …}>` in
  // _layout.tsx paints the status-bar icons white while any record is running,
  // so a pale inset would hide the clock and battery entirely.
  if (pathname === targetPath) {
    return (
      <View className="bg-emerald-600" style={{ paddingTop: insets.top }}>
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
      className="bg-emerald-600 active:bg-emerald-700"
      style={{ paddingTop: insets.top }}
    >
      <View className="flex-row items-center px-4 py-2">
        <View className="mr-2 h-2 w-2 rounded-full bg-white dark:bg-gray-900" />
        <Ionicons
          name={showPlot ? 'grid' : 'list'}
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
