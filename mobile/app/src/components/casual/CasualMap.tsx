/**
 * The map tab in casual mode (design 18i): today's track and observations on
 * the map with the list beside it (SplitMapView, as on a quick checklist). No
 * header: the map and list run under the floating tab bar and the status bar
 * (app/_layout.tsx leaves the top to the map; SplitMapView keeps the status
 * bar legible while the list is open). The list's heading switches between today
 * and every day; the round button at the map's top right picks the basemap.
 * 記在這裡 opens 記一筆觀察; the track belongs to today's checklist.
 */
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { showActionSheet } from '~/components/ActionSheet';
import { FieldMap } from '~/components/map/FieldMap';
import { SplitMapView, SplitRecordList, useSplitAxis } from '~/components/map/SplitMapView';
import { useFieldMapData, type MapRecord } from '~/components/map/useFieldMapData';
import {
  dayKey,
  getSession,
  listDailyRecords,
  listPending,
  resolveTaxa,
  todaysDailySessionId,
  type DailyRecord,
  type PendingObservation,
} from '~/db';
import { showCaptureSheet } from '~/lib/captureSheet';
import { openTodaysChecklist } from '~/lib/casualDaily';
import { errText } from '~/lib/errText';
import { parseTrackSegments, withLiveSegment } from '~/lib/track';
import { pauseRecording, startRecording, useTrackRecorder } from '~/lib/trackRecorder';
import { useTabBarInset } from '~/lib/tabBarLayout';
import { useToast } from '~/stores/toast';
import { useTopChrome } from '~/stores/topChrome';

type Data = {
  records: DailyRecord[];
  pending: PendingObservation[];
  todayId: number | null;
  track: string | null;
};

function load(): Data {
  const todayId = todaysDailySessionId();
  return {
    records: listDailyRecords(),
    pending: listPending(),
    todayId,
    track: todayId != null ? (getSession(todayId)?.track_geojson ?? null) : null,
  };
}

export function CasualMap() {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const tabBarInset = useTabBarInset();
  const safeTop = useSafeAreaInsets().top;
  // Nothing above the screen (no status-bar spacer, no recording bar): the map
  // reaches the top edge and its controls clear the status bar themselves.
  const topInset = useTopChrome((s) => s.height) === 0 ? safeTop : 0;
  // Side by side the map runs down to the tab bar; with the map above the list
  // its bottom edge is the divider (or the folded list's heading).
  const mapReachesTabBar = useSplitAxis() === 'row';
  const [data, setData] = useState<Data>(load);
  const [allDays, setAllDays] = useState(false);
  const reload = useCallback(() => setData(load()), []);
  useFocusEffect(reload);

  const recordingTarget = useTrackRecorder((s) => s.recordingTarget);
  const livePoints = useTrackRecorder((s) => s.livePoints);
  const tracking = recordingTarget?.kind === 'session' && recordingTarget.id === data.todayId;
  const savedTrack = useMemo(() => parseTrackSegments(data.track), [data.track]);
  // The saved track may already hold an earlier copy of the live segment.
  const track = useMemo(
    () => (tracking ? withLiveSegment(savedTrack, livePoints) : savedTrack),
    [tracking, savedTrack, livePoints],
  );

  const today = dayKey(Date.now());
  const taxa = useMemo(
    () => resolveTaxa([...new Set(data.records.map((r) => r.taxon_id))]),
    [data.records],
  );
  // Pending observations take negative ids: one list, one id space for the pins.
  const mapRecords = useMemo<MapRecord[]>(() => {
    const shown = (ts: number) => allDays || dayKey(ts) === today;
    const named: MapRecord[] = data.records
      .filter((r) => shown(r.observed_at))
      .map((r) => {
        const tx = taxa.get(r.taxon_id);
        return {
          id: r.id,
          lat: r.lat,
          lng: r.lng,
          title: tx?.common_name_c || tx?.simple_name || r.taxon_id,
          quantity: r.organism_quantity,
          quantityType: r.organism_quantity != null ? 'individuals' : null,
          observedAt: r.observed_at,
        };
      });
    const pending: MapRecord[] = data.pending
      .filter((p) => shown(p.observed_at))
      .map((p) => ({
        id: -p.id,
        lat: p.lat,
        lng: p.lng,
        title: t('casual.pendingOf', { kingdom: t(`casual.kingdom.${p.kingdom}`) }),
        quantity: p.quantity,
        quantityType: p.quantity != null ? 'individuals' : null,
        observedAt: p.observed_at,
      }));
    return [...named, ...pending].sort((a, b) => b.observedAt - a.observedAt);
  }, [data, taxa, allDays, today, t]);
  const fieldMap = useFieldMapData(mapRecords, track);

  const open = (id: number) => {
    if (id < 0) {
      router.push(`/observe?pending=${-id}` as Href);
      return;
    }
    const r = data.records.find((x) => x.id === id);
    if (r) router.push(`/observe?record=${r.id}&session=${r.session_id}` as Href);
  };

  const toggleTrack = async () => {
    if (tracking) {
      pauseRecording();
      reload();
      toast(t('gnss.trackSaved'));
      return;
    }
    if (recordingTarget) {
      Alert.alert(t('gnss.trackBusyTitle'), t('gnss.trackBusyMsg'));
      return;
    }
    const id = await openTodaysChecklist();
    if (id == null) return;
    try {
      await startRecording({ kind: 'session', id });
      reload();
      toast(t('gnss.trackStarted'));
    } catch (e) {
      Alert.alert(t('gnss.trackStartFail'), errText(e));
    }
  };

  const pickDays = async () => {
    const idx = await showActionSheet({
      options: [
        { label: t('casual.mapTodayOnly'), icon: 'today-outline', selected: !allDays },
        { label: t('casual.mapAllDays'), icon: 'calendar-outline', selected: allDays },
      ],
      cancelLabel: t('common.cancel'),
    });
    if (idx >= 0) setAllDays(idx === 1);
  };

  return (
    <View className="flex-1 bg-paper dark:bg-paper-dark">
      <SplitMapView
        title={
          fieldMap.pickedStretch != null
            ? fieldMap.title
            : t(allDays ? 'casual.listAllDays' : 'casual.listToday', { count: mapRecords.length })
        }
        count={mapRecords.length}
        onShowAll={fieldMap.pickedStretch != null ? () => fieldMap.setStretch(null) : undefined}
        onTitlePress={() => void pickDays()}
        topInset={topInset}
        bottomInset={tabBarInset}
        map={
          <FieldMap
            track={track}
            stretches={fieldMap.stretches}
            pickedStretch={fieldMap.pickedStretch}
            onPickStretch={fieldMap.setStretch}
            points={fieldMap.points}
            dimmed={fieldMap.dimmed}
            picked={fieldMap.picked}
            onPick={fieldMap.setPicked}
            callout={fieldMap.callout}
            status={{
              kind: 'track',
              recording: tracking,
              lengthM: fieldMap.lengthM,
              onToggle: () => void toggleTrack(),
            }}
            onRecordHere={showCaptureSheet}
            basemapPicker
            insets={{ top: topInset, bottom: mapReachesTabBar ? tabBarInset : 0 }}
          />
        }
        list={
          <SplitRecordList
            rows={fieldMap.rows}
            picked={fieldMap.picked}
            onPick={fieldMap.setPicked}
            onOpen={open}
            empty={t('casual.mapEmpty')}
            bottomInset={tabBarInset}
          />
        }
      />
    </View>
  );
}
