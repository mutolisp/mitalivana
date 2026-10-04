/**
 * Pick one taxon (src/survey/form/pickTaxon.ts): the species search docked at
 * the bottom, as on the interaction screen. A pick returns at once; going back
 * returns nothing.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import { BackHeaderLeft } from '~/lib/goBack';
import { settleTaxonPick } from '~/survey/form/pickTaxon';
import { useThemeColors } from '~/theme/colors';

export default function PickTaxonScreen() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const insets = useSafeAreaInsets();
  const { title } = useLocalSearchParams<{ title?: string }>();
  const rootRef = useRef<View>(null);
  const [rootTop, setRootTop] = useState<number | undefined>(undefined);
  // Left without a pick (back, swipe): the caller gets null.
  useEffect(() => () => settleTaxonPick(null), []);

  return (
    <SafeAreaView
      ref={rootRef}
      onLayout={() => rootRef.current?.measureInWindow((_x, y) => setRootTop(y))}
      edges={['bottom']}
      className="flex-1 bg-paper dark:bg-paper-dark"
    >
      <Stack.Screen options={{ title: title || t('fieldLib.pickTaxon'), headerLeft: BackHeaderLeft }} />
      <View className="flex-1 items-center justify-center px-8">
        <Ionicons name="leaf-outline" size={40} color={c.ink3} />
        <Text className="mt-3 text-center text-sm text-ink-3 dark:text-gray-400">{t('fieldLib.pickTaxonHint')}</Text>
      </View>
      <KeyboardStickyView offset={{ opened: insets.bottom }}>
        <SearchBox
          onSelect={(r) => {
            settleTaxonPick({ taxonId: r.taxon_id, name: r.name, cname: r.cname || null, rank: r.rank ?? '', kingdom: r.kingdom ?? '' });
            // Back with the keyboard closed: arriving with it open latches a docked search.
            Keyboard.dismiss();
            router.back();
          }}
          afterSelect="dismiss"
          topLimit={rootTop}
        />
      </KeyboardStickyView>
    </SafeAreaView>
  );
}
