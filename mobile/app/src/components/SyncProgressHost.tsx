/**
 * The team-sync progress strip, on every screen while a sync runs
 * (stores/syncProgress.ts): which record, which block of a tree census, and
 * while files move, which file and how many bytes, with a bar. The screen is
 * kept awake while it shows, because an upload stops when the phone locks
 * (the app is suspended). Rendered before ToastHost, so a toast still wins.
 *
 * A long sync (a 25 ha census is tens of blocks) would sit over the header,
 * so a tap on the strip folds it into a round button on the screen edge
 * (decided 2026-10-02): a ring for the progress, a tap to unfold, dragged up
 * or down and to either edge. The right edge by default: map controls sit at
 * the top and bottom right, and iOS's back swipe starts at the left edge.
 * Folded stays folded, and the button where it was put, until the app
 * restarts. While the tab bar is folded into its own round button and that
 * button is on screen, the progress is drawn as its ring instead (TabBubble,
 * 2026-10-04), so there is one button, not two.
 */
import { Ionicons } from '@expo/vector-icons';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { formatBytes } from '~/lib/exportSize';
import { syncRatio, useSyncProgress } from '~/stores/syncProgress';
import { useTabChrome } from '~/stores/tabChrome';

const SIZE = 48;
/** Off the edge: Android's back swipe starts within the first ~20 dp. */
const MARGIN = 12;
const RING = 4;

function KeepAwake() {
  useKeepAwake('team-sync');
  return null;
}

function Bubble({ ratio }: { ratio: number | null }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const bubble = useSyncProgress((s) => s.bubble);
  const setBubble = useSyncProgress((s) => s.setBubble);
  const setCollapsed = useSyncProgress((s) => s.setCollapsed);

  const top = insets.top + MARGIN;
  const bottom = height - insets.bottom - SIZE - MARGIN;
  const clampY = (y: number) => Math.min(bottom, Math.max(top, y));
  const xOf = (side: 'left' | 'right') => (side === 'left' ? MARGIN : width - SIZE - MARGIN);
  const x = useSharedValue(xOf(bubble.side));
  const y = useSharedValue(clampY(bubble.y ?? height * 0.45));
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  // Turning the phone moves the edges.
  useEffect(() => {
    x.value = xOf(bubble.side);
    y.value = clampY(y.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  const pan = Gesture.Pan()
    .minDistance(6)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((e) => {
      x.value = startX.value + e.translationX;
      y.value = Math.min(bottom, Math.max(top, startY.value + e.translationY));
    })
    .onEnd(() => {
      const side = x.value + SIZE / 2 < width / 2 ? 'left' : 'right';
      x.value = withSpring(side === 'left' ? MARGIN : width - SIZE - MARGIN, { damping: 18 });
      runOnJS(setBubble)({ side, y: y.value });
    });
  const tap = Gesture.Tap().onEnd(() => {
    runOnJS(setCollapsed)(false);
  });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }] }));

  const r = (SIZE - RING) / 2;
  const around = 2 * Math.PI * r;
  const pct = ratio == null ? null : Math.round(ratio * 100);
  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <Animated.View
        style={[{ position: 'absolute', left: 0, top: 0, width: SIZE, height: SIZE }, style]}
        className="items-center justify-center rounded-full bg-accent-700 shadow-lg"
        accessible
        accessibilityRole="button"
        accessibilityLabel={pct == null ? t('teamSync.progress.bubble') : t('teamSync.progress.bubblePct', { pct })}
        accessibilityHint={t('teamSync.progress.bubbleHint')}
        accessibilityActions={[{ name: 'activate' }]}
        onAccessibilityAction={() => setCollapsed(false)}
      >
        {pct == null ? (
          <ActivityIndicator color="white" />
        ) : (
          <>
            <Svg width={SIZE} height={SIZE} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
              <Circle cx={SIZE / 2} cy={SIZE / 2} r={r} stroke="white" strokeOpacity={0.3} strokeWidth={RING} fill="none" />
              <Circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={r}
                stroke="white"
                strokeWidth={RING}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${around} ${around}`}
                strokeDashoffset={around * (1 - (ratio ?? 0))}
              />
            </Svg>
            <Text style={{ fontVariant: ['tabular-nums'] }} className="text-[11px] font-bold text-white">
              {pct}%
            </Text>
          </>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

export function SyncProgressHost() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const p = useSyncProgress((s) => s.current);
  const collapsed = useSyncProgress((s) => s.collapsed);
  const setCollapsed = useSyncProgress((s) => s.setCollapsed);
  // The folded tab bar's button draws this progress as its ring while it is on screen.
  const inTabButton = useTabChrome((s) => s.bubbleShown);
  if (!p) return null;
  const ratio = syncRatio(p);

  if (collapsed) {
    return (
      <View pointerEvents="box-none" className="absolute inset-0">
        <KeepAwake />
        {inTabButton ? null : <Bubble ratio={ratio} />}
      </View>
    );
  }

  const record = p.record ?? t('teamSync.progress.unnamed');
  const head =
    p.recordIndex != null && p.recordCount != null
      ? t('teamSync.progress.batch', { i: p.recordIndex, n: p.recordCount, name: record })
      : t('teamSync.progress.one', { name: record });
  const blocks =
    p.blockStage && p.blockIndex != null && p.blockCount != null
      ? t(p.blockStage === 'up' ? 'teamSync.progress.blocksUp' : 'teamSync.progress.blocksDown', { i: p.blockIndex, n: p.blockCount })
      : null;
  const files = p.stage !== 'record' && p.fileCount != null;
  const line = files
    ? t(p.stage === 'upload' ? 'teamSync.progress.upload' : 'teamSync.progress.download', {
        i: p.fileIndex ?? 0,
        n: p.fileCount ?? 0,
        done: formatBytes(p.bytesDone),
        total: formatBytes(p.bytesTotal),
      })
    : null;

  return (
    <View pointerEvents="box-none" className="absolute inset-x-0 top-0" style={{ paddingTop: insets.top }}>
      <KeepAwake />
      <Pressable
        onPress={() => setCollapsed(true)}
        accessibilityRole="button"
        accessibilityLabel={`${head}. ${t('teamSync.progress.collapse')}`}
        className="mx-4 mt-2 flex-row items-start gap-2 rounded-lg bg-accent-700 px-3 py-2 shadow-lg active:opacity-90"
        accessibilityLiveRegion="polite"
      >
        <View className="flex-1 gap-1">
          <Text className="text-xs font-semibold text-white" numberOfLines={1}>
            {head}
          </Text>
          {blocks ? (
            <Text style={{ fontVariant: ['tabular-nums'] }} className="text-[11px] text-white/90" numberOfLines={1}>
              {blocks}
            </Text>
          ) : null}
          {line ? (
            <Text style={{ fontVariant: ['tabular-nums'] }} className="text-[11px] text-white/90" numberOfLines={1}>
              {line}
            </Text>
          ) : null}
          {ratio != null ? (
            <View className="h-1 overflow-hidden rounded-full bg-card/30">
              <View className="h-1 rounded-full bg-card" style={{ width: `${Math.round(ratio * 100)}%` }} />
            </View>
          ) : null}
          {files || blocks ? <Text className="text-[10px] text-white/80">{t('teamSync.progress.keepOpen')}</Text> : null}
        </View>
        <View className="flex-row items-center gap-0.5 pt-0.5">
          <Text className="text-[11px] text-white/90">{t('teamSync.progress.collapse')}</Text>
          <Ionicons name="chevron-up" size={14} color="white" />
        </View>
      </Pressable>
    </View>
  );
}
