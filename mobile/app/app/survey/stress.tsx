/**
 * 1E stress test (docs/planned/Modular_survey.md §9): build a 20 000- or
 * 50 000-tree test plot, time what a census of that size costs, delete it.
 * Reached from the permanent plot list while STRESS_TEST_OFFERED (release
 * builds too until the user's testing is done); its text is not translated
 * (a testing tool, like app/settings/team-media-test.tsx).
 */
import { Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { Checkbox } from '~/components/ui/Checkbox';
import { Platform, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeaderLeft } from '~/lib/goBack';
import { errText } from '~/lib/errText';
import { buildStressData, deleteStressData, runBench, runBreakdown, stressPlot, stressPlotHasAms, type BenchLine } from '~/survey/stress/stressBench';
import { STRESS_SIZES, type StressSize } from '~/survey/stress/stressCore';

/** System and, where React Native knows it, the device (Android: maker and model; iOS: phone or pad only). */
function deviceLabel(): string {
  const k = Platform.constants as { Manufacturer?: string; Model?: string; interfaceIdiom?: string };
  const what = Platform.OS === 'android' ? [k.Manufacturer, k.Model].filter(Boolean).join(' ') : (k.interfaceIdiom ?? '');
  return `${Platform.OS} ${String(Platform.Version)}${what ? ` ${what}` : ''}`;
}

function Btn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      className={`rounded-xl px-4 py-3 ${disabled ? 'bg-gray-300 dark:bg-gray-700' : 'bg-accent-600 active:bg-accent-700'}`}
    >
      <Text className="text-center text-base font-semibold text-white">{label}</Text>
    </Pressable>
  );
}

export default function StressScreen() {
  const [size, setSize] = useState<StressSize>('20k');
  // Every stem also gets every AMS variable (2B): the most an AMS census stores, for the sync block sizes.
  const [withAms, setWithAms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [lines, setLines] = useState<BenchLine[]>([]);
  const [, refresh] = useState(0);
  const plot = stressPlot(size);

  const progress = useCallback((label: string, done?: number, total?: number) => setStatus(done != null && total ? `${label} ${done} / ${total}` : label), []);
  const go = (fn: () => Promise<BenchLine[] | void>) => async () => {
    setBusy(true);
    try {
      const out = await fn();
      if (out) setLines((l) => [...l, ...out]);
      setStatus('完成');
    } catch (e) {
      setStatus(`失敗：${errText(e)}`);
    } finally {
      setBusy(false);
      refresh((n) => n + 1);
    }
  };
  const report = [
    `Mitalivana 每木壓力測試 · ${STRESS_SIZES[size].code}${stressPlotHasAms(size) ? '（含 AMS）' : ''} · ${__DEV__ ? '開發版' : 'release'} · ${deviceLabel()} · ${new Date().toISOString().slice(0, 16)}`,
    ...lines.map((l) => `${l.label}：${l.ms != null ? `${l.ms} ms` : ''}${l.detail ? ` ${l.detail}` : ''}`),
  ].join('\n');

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: '每木壓力測試（測試用）', headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4">
        <Text className="text-xs leading-5 text-ink-2 dark:text-gray-400">
          建立測試樣區（固定亂數，每台結果相同），量測回合載入、存檔、版本、檢查清單、同步區塊、匯出、備份與啟動清理的耗時。只動測試樣區；刪除時不進「最近刪除」。
        </Text>
        <View className="flex-row gap-2">
          {(['20k', '50k'] as const).map((s) => (
            <Pressable
              key={s}
              onPress={() => setSize(s)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected: size === s }}
              className={`flex-1 rounded-xl border px-3 py-2 ${size === s ? 'border-accent-600 bg-accent-tint dark:bg-accent-950' : 'border-line dark:border-line-dark'}`}
            >
              <Text className="text-center text-sm text-ink dark:text-gray-100">
                {(STRESS_SIZES[s].xM * STRESS_SIZES[s].yM) / 10000} ha · {STRESS_SIZES[s].trees / 10000} 萬株
              </Text>
            </Pressable>
          ))}
        </View>
        {!plot ? <Checkbox checked={withAms} onChange={setWithAms} label="每個分支也填 AMS 全部變數" /> : null}
        <Text className="text-sm text-ink dark:text-gray-100">
          {plot ? `已建立：${STRESS_SIZES[size].code}${plot.census2 ? '（2 回合）' : ''}${stressPlotHasAms(size) ? '，含 AMS' : ''}` : '尚未建立'}
        </Text>
        <Btn label="建立測試樣區" disabled={busy || !!plot} onPress={go(() => buildStressData(size, progress, withAms))} />
        <Btn label="執行量測" disabled={busy || !plot?.census2} onPress={go(() => runBench(size, progress))} />
        <Btn label="匯出／匯入分解（數分鐘）" disabled={busy || !plot?.census2} onPress={go(() => runBreakdown(size, progress))} />
        <Btn label="刪除測試樣區" disabled={busy || !plot} onPress={go(() => deleteStressData(size, progress))} />
        {status ? <Text className="text-sm text-accent-700 dark:text-accent-300">{status}</Text> : null}
        {lines.length ? (
          <View className="gap-1 rounded-xl border border-line bg-card p-3 dark:border-line-dark dark:bg-card-dark">
            {lines.map((l, i) => (
              <Text key={i} style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink dark:text-gray-100">
                {l.label}：{l.ms != null ? `${l.ms} ms` : ''}
                {l.detail ? ` ${l.detail}` : ''}
              </Text>
            ))}
          </View>
        ) : null}
        {lines.length ? <Btn label="分享結果" onPress={() => void Share.share({ message: report })} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
