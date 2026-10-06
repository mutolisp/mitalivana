/**
 * First-launch choice of usage mode (design 18a; docs/planned/UI_modes_impl.md M1).
 *
 * Shown only while `usage_mode` is null, which only a fresh install (or one
 * just cleared) can be: `useSettings().load()` sets an existing install to pro
 * before this ever renders. Mounted in app/_layout.tsx outside
 * DatasetSetupGate, so the mode comes first and the checklist download second.
 *
 * Nothing is written until the button: leaving the app here asks again on the
 * next launch.
 */
import { Ionicons } from '@expo/vector-icons';
import type { TFunction } from 'i18next';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '~/components/ui/Button';
import { Radio } from '~/components/ui/Radio';
import { hasAnyNamesDataset } from '~/db';
import { USAGE_MODES_OFFERED, type UsageMode } from '~/lib/usageMode';
import { applyUsageMode } from '~/lib/useUsageMode';
import { useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

type ModeText = { name: string; desc: string; gets: string[]; icon: ComponentProps<typeof Ionicons>['name'] };

/** Name, one-line description and what the mode gives, for the gate and the settings card. */
export function modeTexts(t: TFunction): Record<UsageMode, ModeText> {
  return {
    casual: {
      name: t('mode.casual'),
      desc: t('mode.casualDesc'),
      gets: [t('mode.casualGet1'), t('mode.casualGet2'), t('mode.casualGet3')],
      icon: 'camera-outline',
    },
    vol: {
      name: t('mode.vol'),
      desc: t('mode.volDesc'),
      gets: [t('mode.volGet1'), t('mode.volGet2'), t('mode.volGet3')],
      icon: 'people-outline',
    },
    pro: {
      name: t('mode.pro'),
      desc: t('mode.proDesc'),
      gets: [t('mode.proGet1'), t('mode.proGet2'), t('mode.proGet3')],
      icon: 'grid-outline',
    },
  };
}

/** Simplest first: most people installing from the store want to note what they see. */
const ORDER: UsageMode[] = ['casual', 'vol', 'pro'];

export function ModeSetupGate({ children }: { children: ReactNode }) {
  const mode = useSettings((s) => s.usage_mode);
  if (!USAGE_MODES_OFFERED || mode !== null) return <>{children}</>;
  return <ModeChooser />;
}

function ModeChooser() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const [pick, setPick] = useState<UsageMode>('casual');
  const texts = modeTexts(t);
  // The next screen is the checklist download only when none is installed.
  const [needsDataset] = useState(() => !hasAnyNamesDataset());
  // Outside the navigator nothing sets the status bar yet, and its default
  // light icons vanish on the paper background. expo-status-bar, not RN's:
  // RN's turns off the edge-to-edge translucency and paints the bar black.
  const dark = useColorScheme().colorScheme === 'dark';

  return (
    <SafeAreaView className="flex-1 bg-paper dark:bg-paper-dark">
      <StatusBar style={dark ? 'light' : 'dark'} />
      <ScrollView contentContainerClassName="grow px-5 pb-6 pt-10">
        <Text className="text-xs font-bold text-acorn-deep dark:text-acorn" style={{ letterSpacing: 1.6 }}>
          MITALIVANA
        </Text>
        <Text accessibilityRole="header" className="mt-2 text-3xl font-bold text-gray-900 dark:text-gray-100">
          {t('mode.gateTitle')}
        </Text>
        <Text className="mt-2 text-base text-gray-600 dark:text-gray-400">{t('mode.gateIntro')}</Text>

        <View accessibilityRole="radiogroup" className="mt-6 gap-3">
          {ORDER.map((m) => {
            const on = pick === m;
            const x = texts[m];
            return (
              <Pressable
                key={m}
                onPress={() => setPick(m)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                className={`rounded-card p-4 ${
                  on
                    ? 'border-[1.5px] border-accent-600 bg-accent-50 dark:border-accent-400 dark:bg-accent-950'
                    : 'border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800'
                }`}
              >
                <View className="flex-row items-center">
                  <View
                    className={`mr-3 h-12 w-12 items-center justify-center rounded-xl ${
                      on ? 'bg-accent-600 dark:bg-accent-400' : 'bg-acorn-tint dark:bg-gray-800'
                    }`}
                  >
                    <Ionicons name={x.icon} size={24} color={on ? c.onAccent : c.acornDeep} />
                  </View>
                  <View className="mr-3 flex-1">
                    <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">{x.name}</Text>
                    <Text className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{x.desc}</Text>
                  </View>
                  <Radio selected={on} />
                </View>
                {/* What the mode gives, only for the one chosen: three cards of
                    bullets at once is a wall of text. */}
                {on ? (
                  <View className="mt-3 gap-1.5" style={{ paddingLeft: 60 }}>
                    {x.gets.map((g) => (
                      <View key={g} className="flex-row">
                        <Ionicons name="checkmark" size={16} color={c.accent} style={{ marginTop: 3 }} />
                        <Text className="ml-2 flex-1 text-sm text-gray-900 dark:text-gray-100">{g}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <View className="mt-auto pt-6">
          <Button
            label={t('mode.gateStart', { mode: texts[pick].name })}
            onPress={() => applyUsageMode(pick)}
            size="lg"
            fullWidth
          />
          {needsDataset ? (
            <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">{t('mode.gateNext')}</Text>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
