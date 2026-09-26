/**
 * The privacy policy, readable offline. The text is mobile/PRIVACY.md (or
 * PRIVACY.en.md for any other UI language — only those two exist), bundled
 * by scripts/gen-privacy.mjs; check:privacy fails when it is stale.
 */
import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeaderLeft } from '~/lib/goBack';
import { parsePolicy, type Inline } from '~/lib/policyMarkdown';

const policy = require('~/generated/privacy.json') as { zh: string; en: string };

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.url ? (
          // Relative links (the other language's .md) have nowhere to go in the app.
          /^https?:\/\//.test(s.url) ? (
            <Text key={i} className="text-[#00797b] underline dark:text-cyan-300" onPress={() => void Linking.openURL(s.url!)}>
              {s.text}
            </Text>
          ) : (
            <Text key={i}>{s.text}</Text>
          )
        ) : (
          <Text
            key={i}
            className={`${s.bold ? 'font-semibold text-gray-900 dark:text-gray-100' : ''} ${s.italic ? 'italic' : ''} ${
              s.code ? 'font-mono text-[13px] text-gray-800 dark:text-gray-200' : ''
            }`}
          >
            {s.text}
          </Text>
        ),
      )}
    </>
  );
}

export default function PrivacyScreen() {
  const { t, i18n } = useTranslation();
  const blocks = useMemo(() => parsePolicy(i18n.language.startsWith('zh') ? policy.zh : policy.en), [i18n.language]);
  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-white dark:bg-gray-950">
      <Stack.Screen options={{ title: t('nav.privacy'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-2 px-4 py-4 pb-12">
        {blocks.map((b, i) => {
          if (b.type === 'hr') return <View key={i} className="my-2 h-px bg-gray-200 dark:bg-gray-800" />;
          if (b.type === 'h')
            return (
              <Text
                key={i}
                className={`${b.level === 1 ? 'text-xl' : b.level === 2 ? 'mt-2 text-lg' : 'mt-1 text-base'} font-bold text-gray-900 dark:text-gray-100`}
              >
                <Spans spans={b.spans} />
              </Text>
            );
          if (b.type === 'li')
            return (
              <View key={i} className="flex-row gap-2" style={{ paddingLeft: b.depth * 16 }}>
                <Text className="text-sm leading-6 text-gray-500">{b.marker}</Text>
                <Text className="flex-1 text-sm leading-6 text-gray-700 dark:text-gray-300">
                  <Spans spans={b.spans} />
                </Text>
              </View>
            );
          return (
            <Text key={i} className="text-sm leading-6 text-gray-700 dark:text-gray-300">
              <Spans spans={b.spans} />
            </Text>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
