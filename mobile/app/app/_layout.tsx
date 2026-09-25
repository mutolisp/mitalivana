import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { SystemBars } from 'react-native-edge-to-edge';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PortalHost } from '@rn-primitives/portal';
import { basemapIsDark } from '~/lib/basemap';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import 'react-native-reanimated';
import '../global.css';

import { ActionSheetHost } from '~/components/ActionSheet';
import { ActiveSessionBar } from '~/components/ActiveSessionBar';
import { DBProvider } from '~/components/DBProvider';
import { DatasetSetupGate } from '~/components/DatasetSetupGate';
import { FontScaleProvider } from '~/components/FontScaleProvider';
import { StalePlotWatcher } from '~/components/StalePlotWatcher';
import { StaleSessionWatcher } from '~/components/StaleSessionWatcher';
import { GbifLookupHost } from '~/components/GbifLookupHost';
import { GoogleDeviceCodeHost } from '~/components/GoogleDeviceCodeHost';
import { InatTokenHost } from '~/components/InatTokenHost';
import { TextPromptHost } from '~/components/TextPromptModal';
import { ToastHost } from '~/components/ToastHost';
import { useThemeSync } from '~/hooks/useThemeSync';
import { useI18nSync } from '~/hooks/useI18nSync';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveSession } from '~/stores/activeSession';
import { useSettings } from '~/stores/settings';

// Keep the native splash visible until DBProvider signals ready (see below).
// Done at module-evaluation time so the splash doesn't auto-hide between
// "JS bundle finishes parsing" and "DB init finishes".
SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden / already prevented; ignore.
});

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <DBProvider>
            {/* Checklists do not ship with the app: with no module installed at all,
                stand in front and guide the download. Once installed (or the
                user chooses later) it steps aside and takes no further part in
                render. */}
            <DatasetSetupGate>
              <ThemedShell />
            </DatasetSetupGate>
          </DBProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Inner shell that consumes the user's theme setting. Mounted *inside*
 * <DBProvider> so `useThemeSync` can read `settings.theme` from the user DB
 * (the store loads after DB init). Until the store has loaded, `theme`
 * defaults to 'auto' → follows the OS, which matches what a first-time user
 * expects.
 */
function ThemedShell() {
  const scheme = useThemeSync();
  useI18nSync();
  const { t } = useTranslation();
  const isDark = scheme === 'dark';
  const session = useActiveSession((s) => s.session);
  const plot = useActivePlot((s) => s.plot);
  const gloria = useActiveGloria((s) => s.survey);
  const hasActive = Boolean(session || plot || gloria);
  // The map draws to the top edge. Its overlays already position themselves at
  // `insets.top + 8`, so the spacer was not just letterboxing the map — it was
  // pushing those controls down by a second full inset. The recording bar still
  // wins when it is showing: it is information the surveyor needs, and it
  // carries its own inset padding.
  const fullBleedTop = usePathname() === '/map';
  // Full-bleed puts the system clock straight onto the tiles, so the icon
  // colour has to follow what is actually underneath rather than the app theme.
  const mapBasemap = useSettings((s) => s.map_view.basemap);

  return (
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      <FontScaleProvider>
        <View style={{ flex: 1 }}>
          {/* Persistent top chrome — visible across ALL stack screens
              (tabs / session detail / plot detail / key runner / etc.)
              so the recording indicator never disappears mid-task. When
              no record is active a safe-area spacer fills the notch so
              tab content / stack headers don't sit under the status bar. */}
          {hasActive ? <ActiveSessionBar /> : fullBleedTop ? null : <TopSafeAreaSpacer />}
          {/* Stale watchers run app-wide, not just on tabs, so a 13h
              session left unattended in the key runner still gets nagged. */}
          <StaleSessionWatcher />
          <StalePlotWatcher />
          {/* `minimal` shows the chevron alone. The word cost most of the header's
                width in the longer languages and repeated what the glyph
                already says; screens with a custom `headerLeft` carry the
                label on the button's accessibility label instead. */}
          <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="session/[id]" options={{ title: t('nav.session') }} />
            <Stack.Screen name="plot/[id]" options={{ title: t('nav.plot') }} />
            <Stack.Screen name="gloria/new" options={{ title: t('gloria.new.title') }} />
            <Stack.Screen name="key/[id]" options={{ title: t('nav.key') }} />
            <Stack.Screen name="projects" options={{ title: t('nav.projects') }} />
            <Stack.Screen name="sites" options={{ title: t('nav.sites') }} />
            {/* Titles reuse the keys the rows already carry, so the header is
                right before the screen mounts (no flash) and exportPref.title's
                existing es-419 override keeps working. */}
            <Stack.Screen name="settings/language" options={{ title: t('settings.language') }} />
            <Stack.Screen name="settings/vernacular" options={{ title: t('vernacular.title') }} />
            <Stack.Screen name="settings/collection" options={{ title: t('settings.sectionCollection') }} />
            <Stack.Screen name="settings/export" options={{ title: t('exportPref.title') }} />
            <Stack.Screen name="settings/provenance" options={{ title: t('nav.provenance') }} />
            <Stack.Screen name="surveyors" options={{ title: t('nav.surveyors') }} />
            <Stack.Screen name="about" options={{ title: t('nav.about') }} />
            <Stack.Screen name="favorites" options={{ title: t('nav.favorites') }} />
            <Stack.Screen name="backup" options={{ title: t('nav.backup') }} />
            <Stack.Screen name="regionpacks" options={{ title: t('nav.regionPacks') }} />
            <Stack.Screen name="settings/offlinemap" options={{ title: t('offlinemap.title') }} />
            <Stack.Screen name="inaturalist" options={{ title: t('nav.inaturalist') }} />
            <Stack.Screen name="gdrive" options={{ title: t('nav.gdrive') }} />
            <Stack.Screen name="inat-upload" options={{ title: t('nav.inatUpload') }} />
            <Stack.Screen name="report/[kind]/[id]" options={{ title: t('report.navTitle') }} />
          </Stack>
        </View>
        {/* Select popovers render here, NOT via React.createPortal: the portal
            stores the element globally and renders it at THIS position, so the
            popover inherits context from here — which is why it must stay
            inside <FontScaleProvider> (it needs the --ts-* vars) while sitting
            outside the <View> that holds <Stack> (so it paints above every
            screen, its native header, and the ActiveSessionBar). Before
            <ToastHost> so a toast fired with a popover open still wins. */}
        <PortalHost />
        <ToastHost />
        <TextPromptHost />
        <GbifLookupHost />
        <InatTokenHost />
        <GoogleDeviceCodeHost />
        <ActionSheetHost />
      </FontScaleProvider>
      {/* Active record → green ActiveSessionBar covers status bar → need
          'light' icons. On the full-bleed map the aerial basemaps put dark
          imagery there instead, so they force 'light' too — `standard` and
          `terrain` are pale (or already theme-following) and are left to the
          theme. Otherwise follow theme. Edge-to-edge mode makes both status
          AND nav bars transparent overlays, so we use `<SystemBars>` (from
          react-native-edge-to-edge) which controls icon colour on BOTH bars
          at once. */}
      <SystemBars
        style={
          hasActive
            ? 'light'
            : fullBleedTop && basemapIsDark(mapBasemap)
              ? 'light'
              : isDark
                ? 'light'
                : 'dark'
        }
      />
    </ThemeProvider>
  );
}

function TopSafeAreaSpacer() {
  const insets = useSafeAreaInsets();
  return <View style={{ height: insets.top }} className="bg-white dark:bg-gray-900" />;
}
