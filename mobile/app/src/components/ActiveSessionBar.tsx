/**
 * Top bar shown while a checklist, plot survey, GLORIA or MIREN survey is in
 * progress.
 *
 * Filename kept as ActiveSessionBar for backward compat; the bar covers every
 * record kind under the single-active rule and picks whichever started most
 * recently if a stale store still holds two.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { usePathname, useRouter, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveMiren } from '~/modules/miren/store';

export function ActiveSessionBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const session = useActiveSession((s) => s.session);
  const plot = useActivePlot((s) => s.plot);
  const gloria = useActiveGloria((s) => s.survey);
  const miren = useActiveMiren((s) => s.survey);
  const insets = useSafeAreaInsets();

  if (!session && !plot && !gloria && !miren) return null;

  // Pick the most recently started record to display in the bar. Only one
  // should be active (single-active invariant); if a stale store still holds
  // two, surface whichever was last touched.
  const sessionTs = session?.started_at ?? 0;
  const plotTs = plot ? (plot.start_ts ?? plot.created_at ?? 0) : -1;
  const gloriaTs = gloria ? gloria.start_ts : -1;
  const mirenTs = miren ? miren.start_ts : -1;
  const shown: 'miren' | 'gloria' | 'plot' | 'session' =
    miren && mirenTs >= gloriaTs && mirenTs >= plotTs && mirenTs >= sessionTs
      ? 'miren'
      : gloria && gloriaTs >= plotTs && gloriaTs >= sessionTs
        ? 'gloria'
        : plot && plotTs >= sessionTs
          ? 'plot'
          : 'session';
  const showPlot = shown === 'plot';

  const label =
    shown === 'miren'
      ? t('activeBar.mirenRecording', { year: miren!.year })
      : shown === 'gloria'
        ? t('activeBar.gloriaRecording', { mocy: gloria!.mocy })
        : showPlot
          ? t('activeBar.plotRecording', { id: plot!.plotid })
          : t('activeBar.recording', { name: session!.name });
  // This bar is persistent chrome rendered above the stack on EVERY screen,
  // including the record's own detail page. Tapping it must not push a second
  // copy of a screen already on the stack (that turned exiting into many
  // back-presses). Guard the no-op case, then use `navigate` (pops back to an
  // existing instance) instead of `push` (always adds a new one).
  const targetPath =
    shown === 'miren'
      ? `/miren/survey/${miren!.id}`
      : shown === 'gloria'
        ? `/gloria/${gloria!.id}`
        : showPlot
          ? `/plot/${plot!.id}`
          : `/session/${session!.id}`;
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
  if (pathname === targetPath) {
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
        <View className="mr-2 h-2 w-2 rounded-full bg-white dark:bg-gray-900" />
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
