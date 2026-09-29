/**
 * Which record is in progress, for the two places that say so: the bar over
 * every screen (ActiveSessionBar) and the card on the records tab
 * (ActiveRecordCard). One copy of the choice so the two never disagree.
 *
 * Only one record should be active (single-active invariant); if a stale store
 * still holds two, the most recently started one wins.
 */
import { useTranslation } from 'react-i18next';

import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveMiren } from '~/modules/miren/store';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';

export type ActiveRecordKind = 'session' | 'plot' | 'gloria' | 'miren';

export type ActiveRecordSummary = {
  kind: ActiveRecordKind;
  id: number;
  /** One line for the bar: "記錄中：<name>" and its per-kind variants. */
  barLabel: string;
  startedAt: number;
  /** The record's own screen. */
  targetPath: string;
};

export function useActiveRecordSummary(): ActiveRecordSummary | null {
  const { t } = useTranslation();
  const session = useActiveSession((s) => s.session);
  const plot = useActivePlot((s) => s.plot);
  const gloria = useActiveGloria((s) => s.survey);
  const miren = useActiveMiren((s) => s.survey);

  if (!session && !plot && !gloria && !miren) return null;

  const sessionTs = session?.started_at ?? 0;
  const plotTs = plot ? (plot.start_ts ?? plot.created_at ?? 0) : -1;
  const gloriaTs = gloria ? gloria.start_ts : -1;
  const mirenTs = miren ? miren.start_ts : -1;

  if (miren && mirenTs >= gloriaTs && mirenTs >= plotTs && mirenTs >= sessionTs) {
    return {
      kind: 'miren',
      id: miren.id,
      barLabel: t('activeBar.mirenRecording', { year: miren.year }),
      startedAt: mirenTs,
      targetPath: `/miren/survey/${miren.id}`,
    };
  }
  if (gloria && gloriaTs >= plotTs && gloriaTs >= sessionTs) {
    return {
      kind: 'gloria',
      id: gloria.id,
      barLabel: t('activeBar.gloriaRecording', { mocy: gloria.mocy }),
      startedAt: gloriaTs,
      targetPath: `/gloria/${gloria.id}`,
    };
  }
  if (plot && plotTs >= sessionTs) {
    return {
      kind: 'plot',
      id: plot.id,
      barLabel: t('activeBar.plotRecording', { id: plot.plotid }),
      startedAt: plotTs,
      targetPath: `/plot/${plot.id}`,
    };
  }
  return {
    kind: 'session',
    id: session!.id,
    barLabel: t('activeBar.recording', { name: session!.name }),
    startedAt: sessionTs,
    targetPath: `/session/${session!.id}`,
  };
}
