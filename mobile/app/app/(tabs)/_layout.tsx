import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';

import { HapticTab } from '@/components/haptic-tab';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSettings, type FabSide, type RecordTypeDefault } from '~/stores/settings';
import { showActionSheet } from '~/components/ActionSheet';
import {
  createPlotPromptAndOpen,
  importRecordPromptAndOpen,
  showCreateChooser,
  startCollectionAndOpen,
  startSessionAndOpen,
} from '~/lib/recordCreate';
import { perf } from '~/lib/perf';
import { BAR_GAP, BAR_HEIGHT, FAB_SIZE, useTabBarMetrics } from '~/lib/tabBarLayout';
import i18n from '~/i18n';


async function showLongPressMenu(): Promise<void> {
  const updateDefault = (v: RecordTypeDefault) =>
    useSettings.getState().set('record_type_default', v);
  const idx = await showActionSheet({
    title: i18n.t('record.createMenuTitle'),
    message: i18n.t('record.createMenuMsg'),
    options: [
      { label: i18n.t('record.kindSession') },
      { label: i18n.t('record.kindPlot') },
      { label: i18n.t('record.kindCollection') },
      // Also here: with a record_type_default set, the ＋ button skips the
      // chooser entirely, so this menu is the only way in.
      { label: i18n.t('record.kindImport') },
      { label: i18n.t('record.defaultAsk') },
      { label: i18n.t('record.defaultSession') },
      { label: i18n.t('record.defaultPlot') },
      { label: i18n.t('record.defaultCollection') },
    ],
  });
  if (idx === 0) startSessionAndOpen();
  else if (idx === 1) createPlotPromptAndOpen();
  else if (idx === 2) startCollectionAndOpen();
  else if (idx === 3) importRecordPromptAndOpen();
  else if (idx === 4) updateDefault('ask');
  else if (idx === 5) updateDefault('session');
  else if (idx === 6) updateDefault('plot');
  else if (idx === 7) updateDefault('collection');
}

function PlusButton() {
  const recordTypeDefault = useSettings((s) => s.record_type_default);

  const onPress = () => {
    if (recordTypeDefault === 'session') startSessionAndOpen();
    else if (recordTypeDefault === 'plot') createPlotPromptAndOpen();
    else if (recordTypeDefault === 'collection') startCollectionAndOpen();
    else showCreateChooser();
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={showLongPressMenu}
      delayLongPress={350}
      // Brand color #008F51. NativeWind 4 supports `bg-[#xxx]` arbitrary
      // hex as long as the literal appears verbatim in source so the JIT
      // scanner can pick it up. Press state darkens by ~20%.
      //
      // Sized to sit INSIDE the pill rather than overhang its top edge the way
      // it did on the old square bar: a circle straddling a rounded edge reads
      // as a mistake, and `overflow: 'hidden'` on the pill would clip it.
      className="items-center justify-center rounded-full bg-[#008F51] active:bg-[#007241]"
      style={{ width: FAB_SIZE, height: FAB_SIZE, borderRadius: FAB_SIZE / 2 }}
    >
      <Ionicons name="add" size={26} color="white" />
    </Pressable>
  );
}

/**
 * Tab order per + side, spelled out for both.
 *
 * The left-handed arrangement is NOT the right-handed one reversed — Records
 * and Map keep their relative order while Settings moves to the far end — so
 * deriving one from the other would quietly produce the wrong strip.
 */
const TAB_ORDER = {
  right: ['menu', 'map', 'index', 'taxonomy', 'plus'],
  left: ['plus', 'index', 'map', 'taxonomy', 'menu'],
} as const satisfies Record<FabSide, readonly string[]>;

/** Wraps PlusButton as a tab slot: centred in the slot, no label, no haptic
 *  double-up (the button has its own press handling). */
function PlusTabButton() {
  return (
    <View className="flex-1 items-center justify-center">
      <PlusButton />
    </View>
  );
}

/**
 * The pill behind the tabs.
 *
 * `tabBarStyle` carries the shadow and `tabBarBackground` the fill, because a
 * single view cannot do both: the rounded fill needs `overflow: 'hidden'` to
 * clip the blur to the corners, and that would clip the shadow away too.
 *
 * `BlurView` gets a translucent tint underneath rather than being left bare —
 * on Android the blur is an approximation, and over a dark map a wholly
 * unfilled pill leaves the 10pt labels hard to read. The two knobs below are
 * the ones to turn when it looks too milky or too thin: `BLUR_INTENSITY` is
 * how frosted the backdrop gets, `TINT_ALPHA` how much flat colour sits on top
 * of it. Legibility comes almost entirely from the second.
 *
 * The hairline border is not decoration. iOS derives a layer's shadow from its
 * shape, and the bar it is set on has `backgroundColor: 'transparent'`, so the
 * shadow may not draw at all there; giving it an opaque background instead is
 * not an option, because that is what the blur would then be sampling. A
 * border always renders, costs nothing, and reads as intentional on both a
 * pale list and a dark map.
 */
/** 0-100. Lower reads as clearer glass. */
const BLUR_INTENSITY = 30;

/** Flat wash over the blur, per scheme. */
const TINT_ALPHA = { light: 0.3, dark: 0.28 };

/**
 * Tab foreground, deliberately darker than the app's usual icon grey.
 *
 * Over the map the pill is a thin translucent film, so its colour is whatever
 * the tiles underneath happen to be — pale green, grey, pale brown. The theme's
 * `#687076` sat close enough to that to be hard to pick out, and raising
 * TINT_ALPHA to fix it would undo the transparency this bar is for. Darkening
 * the foreground instead buys the contrast without touching the glass.
 *
 * Active stays a colour rather than just darker, so which tab is selected is
 * still legible to someone who cannot rely on the weight difference alone.
 */
const TAB_FG = {
  light: { active: '#075E7A', inactive: '#374151' },
  dark: { active: '#FFFFFF', inactive: '#D1D5DB' },
};

function TabBarPill() {
  const scheme = useColorScheme() ?? 'light';
  const dark = scheme === 'dark';
  return (
    <View
      style={[
        StyleSheet.absoluteFillObject,
        {
          borderRadius: BAR_HEIGHT / 2,
          overflow: 'hidden',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)',
        },
      ]}
    >
      <BlurView
        intensity={BLUR_INTENSITY}
        tint={dark ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: dark
              ? `rgba(17,24,39,${TINT_ALPHA.dark})`
              : `rgba(255,255,255,${TINT_ALPHA.light})`,
          },
        ]}
      />
    </View>
  );
}

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const fg = TAB_FG[colorScheme === 'dark' ? 'dark' : 'light'];
  const { t } = useTranslation();

  // ActiveSessionBar + status-bar + safe-area spacer + StaleWatchers were
  // lifted to app/_layout.tsx so they persist across stack screens (檢索表
  // runner, session/plot detail, etc.). Tabs-only chrome stays here.
  //
  // The bar floats: `position: 'absolute'` takes it out of the layout flow so
  // content shows through the blur. Two consequences, both deliberate:
  //
  //  - The height IS hard-coded now, which the previous in-flow bar avoided on
  //    purpose (a fixed height used to reproduce the Samsung 3-button nav-bar
  //    overlap). That is safe here only because `bottom` is derived from
  //    `insets.bottom`, so the system nav is cleared by measurement rather
  //    than by hoping a constant is tall enough.
  //  - Screens no longer get the bar's space reserved for them, so every tab
  //    screen owes itself `useTabBarInset()` of bottom clearance. See
  //    src/lib/tabBarLayout.ts; `npm run check:dock` enforces the dock half.
  const insets = useSafeAreaInsets();
  const { pill, fabOnLeft } = useTabBarMetrics();

  return (
    <View className="flex-1">
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: fg.active,
          tabBarInactiveTintColor: fg.inactive,
          headerShown: false,
          tabBarButton: HapticTab,
          tabBarBackground: () => <TabBarPill />,
          // Four items in a pill that stops short of the ＋ circle, rather than
          // five spread over the full width — which is what makes the icons sit
          // closer together.
          tabBarStyle: {
            position: 'absolute',
            // `start`/`end`, not `left`/`right`: BottomTabBar's own base style
            // pins the bar with `start: 0, end: 0` (styles.bottom), and RN
            // resolves those logical properties ahead of left/right — so a
            // left/right override here is silently ignored and the pill stays
            // full-bleed. Both are set so the result does not depend on which
            // pair wins.
            start: pill.left,
            end: pill.right,
            left: pill.left,
            right: pill.right,
            bottom: insets.bottom + BAR_GAP,
            height: BAR_HEIGHT,
            borderRadius: BAR_HEIGHT / 2,
            backgroundColor: 'transparent',
            borderTopWidth: 0,
            // BottomTabBar sets paddingBottom: insets.bottom on itself (see
            // BottomTabBar.tsx:378) for a bar flush with the screen edge. This
            // one floats above the inset already, so keeping that padding would
            // squash a 58pt pill's contents into its top 24pt on a device with
            // a home indicator. tabBarStyle is applied last, so this wins.
            paddingTop: 0,
            paddingBottom: 0,
            paddingHorizontal: 0,
            // Default elevation would paint an opaque Material surface behind
            // the blur on Android; the pill draws its own shadow instead.
            elevation: 0,
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
          },
          tabBarItemStyle: { paddingVertical: 6 },
          // 600 rather than the default: at 10pt a heavier stroke does as much
          // for legibility over busy tiles as the colour change does.
          tabBarLabelStyle: { fontSize: 10, marginTop: 1, fontWeight: '600' },
        }}
      >
        {/* `plots` is not a tab (href: null) and stays out of the order. */}
        {TAB_ORDER[fabOnLeft ? 'left' : 'right'].map((name) =>
          name === 'plus' ? (
            <Tabs.Screen
              key="plus"
              name="plus"
              options={{ title: '', tabBarButton: () => <PlusTabButton /> }}
            />
          ) : name === 'menu' ? (
            <Tabs.Screen
              key="menu"
              name="menu"
              options={{
                title: t('tab.menu'),
                tabBarIcon: ({ color }) => (
                  <Ionicons name="settings-outline" size={22} color={color} />
                ),
              }}
            />
          ) : name === 'map' ? (
            <Tabs.Screen
              key="map"
              name="map"
              options={{
                title: t('tab.map'),
                tabBarIcon: ({ color }) => (
                  <Ionicons name="map-outline" size={22} color={color} />
                ),
              }}
            />
          ) : name === 'index' ? (
            <Tabs.Screen
              key="index"
              name="index"
              options={{
                title: t('tab.records'),
                tabBarIcon: ({ color }) => <Ionicons name="list" size={22} color={color} />,
              }}
            />
          ) : (
            <Tabs.Screen
              key="taxonomy"
              name="taxonomy"
              options={{
                title: t('tab.species'),
                tabBarIcon: ({ color }) => (
                  <Ionicons name="leaf-outline" size={22} color={color} />
                ),
                // Eager-mount: taxonomy tree is the heaviest tab
                // (TaxonomySearchBox + segment subtree + cascade hydration of
                // persisted expansion). With default lazy=true, the first tap
                // pays mount + first-render + useEffect cost serially before
                // the in-screen spinner can paint, so the user sees a frozen
                // tab bar for several hundred ms. Mounting eagerly during app
                // launch shifts that cost to splash (where the user already
                // expects to wait) so subsequent taps are instant. The mount
                // itself is cheap; the cascade SQL still runs inside the
                // screen's chunked-async hydration with its own spinner.
                lazy: false,
              }}
              listeners={{
                // Fires the instant the user taps the tab button — the gap
                // between this and taxonomy:focus / taxonomy:render-start tells
                // us whether the perceived lag is the native tab transition (no
                // JS in the gap) or post-focus JS work.
                tabPress: () => perf.mark('taxonomy:tab-press'),
              }}
            />
          ),
        )}
        <Tabs.Screen name="plots" options={{ href: null }} />
      </Tabs>
    </View>
  );
}
