/**
 * What the split map shows for a list of records (quick checklist or plot):
 * the pins, the narrow list's rows, the stretches of the track and which one
 * is picked, the picked record. Both screens hand their records over in the
 * same shape and keep only their own actions.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { alongTrackSegments } from '~/lib/alongTrack';
import { isoTime } from '~/lib/datetime';
import { formatQuantityBadge, kindForType } from '~/lib/dwcAbundance';
import { detectionLabel } from '~/lib/dwcAttributes';
import type { TrackSegment } from '~/lib/track';
import type { FieldMapPoint } from './FieldMap';
import type { SplitRow } from './SplitMapView';

export type MapRecord = {
  id: number;
  lat: number | null;
  lng: number | null;
  title: string;
  quantity: string | null;
  quantityType: string | null;
  detection?: string | null;
  observedAt: number;
};

const kmText = (m: number) => `${(m / 1000).toFixed(2)} km`;

export function useFieldMapData(records: MapRecord[], track: TrackSegment[]) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<number | null>(null);
  const [stretch, setStretch] = useState<number | null>(null);

  const along = useMemo(() => alongTrackSegments(track, records), [track, records]);
  // A stretch index from a longer track may no longer exist.
  const pickedStretch = stretch != null && stretch < along.stretches.length ? stretch : null;

  const countOf = (r: MapRecord) =>
    r.quantity && kindForType(r.quantityType ?? 'individuals') === 'count' ? r.quantity : null;

  const metaOf = (r: MapRecord) => {
    const count = countOf(r);
    const amount = count ? `×${count}` : r.quantity ? formatQuantityBadge(r.quantity, r.quantityType) : null;
    const m = along.alongM.get(r.id);
    return [
      amount,
      r.detection ? detectionLabel(r.detection) : null,
      m != null ? t('splitMap.alongKm', { km: kmText(m) }) : null,
      isoTime(r.observedAt),
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const shown = pickedStretch == null ? records : records.filter((r) => along.stretchOf.get(r.id) === pickedStretch);
  const rows: SplitRow[] = shown.map((r) => ({ id: r.id, title: r.title, meta: metaOf(r) }));
  const points: FieldMapPoint[] = records
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => {
      const count = countOf(r);
      return { id: r.id, lat: r.lat as number, lng: r.lng as number, glyph: count ? (Number(count) > 99 ? '99+' : count) : '' };
    });
  const dimmed =
    pickedStretch == null ? undefined : new Set(records.filter((r) => along.stretchOf.get(r.id) !== pickedStretch).map((r) => r.id));
  const pickedRecord = picked == null ? null : (records.find((r) => r.id === picked) ?? null);

  return {
    picked: pickedRecord ? picked : null,
    setPicked,
    stretches: along.stretches,
    lengthM: along.totalM,
    pickedStretch,
    setStretch: (i: number | null) => {
      setStretch(i);
      setPicked(null);
    },
    rows,
    points,
    dimmed,
    callout: pickedRecord ? { title: pickedRecord.title, meta: metaOf(pickedRecord) } : null,
    title:
      pickedStretch == null
        ? t('splitMap.listAll', { count: records.length })
        : t('splitMap.listStretch', { count: shown.length }),
  };
}
