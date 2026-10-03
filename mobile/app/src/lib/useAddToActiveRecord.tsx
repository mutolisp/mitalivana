/**
 * Shared "add this species to whatever record is active" smart router.
 *
 * Single source of truth for the decision the identification-key runner
 * (`app/key/[id].tsx::addTaxonToActiveRecord`) already makes correctly, so the
 * taxonomy tree and search entry points stop blindly adding to a session
 * (which, via single-active enforcement, would silently end an active plot
 * survey).
 *
 * Priority: active GLORIA → its roster; active plot → open
 * PlotSpeciesValueModal (enter abundance) → addPlotSpecies; an open checklist /
 * plot-style survey takes it or refuses it (takenByActiveSurvey). Otherwise
 * active session (or a freshly started one) → addRecord — except while a MIREN
 * survey is active, which blocks with a prompt (blockIfMirenActive). Returns
 * the modal element so the host screen can render it.
 */
import { useState } from 'react';
import { useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  addPlotSpecies,
  addRecord,
  addSpecimen,
  createCollectionTrip,
  getActiveCollectionTrip,
  isTaxonInSession,
  listPlotSpecies,
  nextRecordNumber,
  withTransaction,
  type Layer,
  type SearchResult,
} from '~/db';
import type { AdoptionInput } from '~/db';
import { blockIfMirenActive } from '~/lib/mirenGuard';
import { takenByActiveSurvey } from '~/survey/form/quickAdd';
import { useActiveSurvey } from '~/survey/form/activeSurvey';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { useActiveGloria } from '~/modules/gloria/store';
import { ensureRosterTaxon } from '~/modules/gloria/db';
import { useToast } from '~/stores/toast';
import { defaultQuantityTypeFor } from './dwcAbundance';
import { serializeMultiAttribute } from './dwcAttributes';
import { showActionSheet } from '~/components/ActionSheet';
import {
  PlotSpeciesValueModal,
  type PlotModalHeader,
  type PlotValueDraft,
} from '~/components/PlotSpeciesValueModal';
import type { PlotType } from '~/db';
import { stampNewRecord } from './recordFix';

type PlotTarget = {
  sp: SearchResult;
  plotId: number;
  plotType: PlotType;
  layer: Layer;
  /** Survives the trip through the abundance modal. */
  adopted?: AdoptionInput | null;
};

function headerOf(sp: SearchResult): PlotModalHeader {
  return {
    taxonId: sp.taxon_id,
    cname: sp.cname ?? '',
    name: sp.name,
    author: sp.fullname.replace(sp.name, '').trim(),
    kingdom: sp.kingdom ?? '',
    phylum: sp.phylum ?? '',
    class_name: sp.class_name ?? '',
    order: sp.order ?? '',
    family: sp.family ?? '',
    family_c: sp.family_cname ?? '',
    genus: sp.genus ?? '',
    rank: sp.rank ?? '',
  };
}

export function useAddToActiveRecord(): {
  addSpecies: (sp: SearchResult, adopted?: AdoptionInput | null) => void;
  /** Batch form of `addSpecies` (taxonomy-tree select mode): same destination
   *  rule, but no per-species abundance modal. */
  addMany: (list: SearchResult[]) => void;
  /** Explicit collection route, reached by long-pressing the add button.
   *  Never taken by `addSpecies` — collections stay off the default path so the
   *  existing plot → session behaviour is unchanged. */
  addToCollection: (sp: SearchResult) => void;
  modal: React.ReactNode;
  /** Dynamic button label reflecting where the next add will land. */
  targetLabel: string;
  /** Long-press companion to `addSpecies`: asks which record the species should
   *  go to. Wire it to the add button's `onLongPress` so a plain tap keeps its
   *  existing, unchanged behaviour.
   *
   *  Await it before dismissing any host sheet — iOS cannot present this over a
   *  Modal that is being torn down in the same tick. Resolves true when the
   *  species was added, false when the chooser was cancelled, so the host can
   *  keep itself open on cancel. */
  promptAddDestination: (sp: SearchResult) => Promise<boolean>;
} {
  const router = useRouter();
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const plot = useActivePlot((s) => s.plot);
  const gloria = useActiveGloria((s) => s.survey);
  const session = useActiveSession((s) => s.session);
  const fwSurvey = useActiveSurvey((s) => s.survey);
  const startSession = useActiveSession((s) => s.start);
  const [plotTarget, setPlotTarget] = useState<PlotTarget | null>(null);

  const targetLabel = gloria
    ? t('addToRecord.toGloria')
    : fwSurvey
      ? t('addToRecord.toSurvey')
      : plot
      ? t('addToRecord.toPlot') : session ? t('addToRecord.toSession') : t('addToRecord.newSession');

  const addSpecies = (sp: SearchResult, adopted?: AdoptionInput | null) => {
    if (!sp.taxon_id) {
      toast(t('addToRecord.noTaxonId'));
      return;
    }
    if (addToGloria([sp])) return;
    // Read the active plot fresh to avoid a stale closure.
    const activePlot = useActivePlot.getState().plot;
    if (activePlot) {
      // Non-stratified plots (transect / point count) store every row under
      // 'T'; fixed plots default to E2 (the herb layer), matching the key runner.
      const layer: Layer = activePlot.plot_type === 'fixed' ? 'E2' : 'T';
      setPlotTarget({ sp, plotId: activePlot.id, plotType: activePlot.plot_type, layer, adopted });
      return;
    }
    if (takenByActiveSurvey([sp], adopted)) return;
    // Session path (or start a fresh one — never over a MIREN survey).
    if (!session && blockIfMirenActive()) return;
    const target = session ?? startSession();
    if (isTaxonInSession(target.id, sp.taxon_id)) {
      toast(t('addToRecord.alreadyInRecord', { name: sp.cname || sp.name }));
      return;
    }
    const recordId = addRecord({ session_id: target.id, taxon_id: sp.taxon_id, adopted });
    stampNewRecord('session', recordId, target.id, () => useActiveSession.getState().refresh());
    useActiveSession.getState().refresh();
    toast(t('session.added', { name: sp.cname || sp.name }), {
      action: { label: t('addToRecord.goTo'), onPress: () => router.push(`/session/${target.id}`) },
    });
  };

  /**
   * Same routing as `addSpecies`, for many species at once.
   *
   * An active plot takes them into the default layer with NO values — asking
   * for abundance species by species is exactly what a batch add avoids; the
   * rows are filled in on the plot screen. Taxa already there (same layer) or
   * already in the checklist are skipped, and the toast says how many.
   */
  /**
   * An active GLORIA survey takes species into the summit roster only: which
   * quadrat or section they belong to is decided on the unit screens, never
   * guessed here. Returns false when no GLORIA survey is active.
   */
  const addToGloria = (list: SearchResult[]): boolean => {
    const survey = useActiveGloria.getState().survey;
    if (!survey) return false;
    withTransaction(() => {
      for (const sp of list) if (sp.taxon_id) ensureRosterTaxon(survey.id, sp.taxon_id);
    });
    toast(t('addToRecord.addedToGloria', { count: list.length }), {
      action: { label: t('addToRecord.goTo'), onPress: () => router.push(`/gloria/${survey.id}` as Href) },
    });
    return true;
  };

  const withSkipped = (msg: string, skipped: number) =>
    skipped > 0 ? `${msg}\n${t('addToRecord.skippedExisting', { count: skipped })}` : msg;

  const addMany = (list: SearchResult[]) => {
    const seen = new Set<string>();
    const valid = list.filter((sp) => {
      if (!sp.taxon_id || seen.has(sp.taxon_id)) return false;
      seen.add(sp.taxon_id);
      return true;
    });
    if (valid.length === 0) return;
    if (addToGloria(valid)) return;
    const activePlot = useActivePlot.getState().plot;
    if (activePlot) {
      const layer: Layer = activePlot.plot_type === 'fixed' ? 'E2' : 'T';
      const have = new Set(
        listPlotSpecies(activePlot.id)
          .filter((r) => r.layer === layer)
          .map((r) => r.taxon_id),
      );
      const fresh = valid.filter((sp) => !have.has(sp.taxon_id));
      withTransaction(() => {
        for (const sp of fresh) {
          addPlotSpecies({ plot_survey_id: activePlot.id, taxon_id: sp.taxon_id, layer });
        }
      });
      useActivePlot.getState().refresh();
      toast(
        withSkipped(t('addToRecord.addedManyToPlot', { count: fresh.length }), valid.length - fresh.length),
        {
          action: {
            label: t('addToRecord.goTo'),
            onPress: () => router.push(`/plot/${activePlot.id}`),
          },
        },
      );
      return;
    }
    if (takenByActiveSurvey(valid)) return;
    if (!session && blockIfMirenActive()) return;
    const target = session ?? startSession();
    const fresh = valid.filter((sp) => !isTaxonInSession(target.id, sp.taxon_id));
    withTransaction(() => {
      for (const sp of fresh) addRecord({ session_id: target.id, taxon_id: sp.taxon_id });
    });
    useActiveSession.getState().refresh();
    toast(
      withSkipped(t('addToRecord.addedManyToSession', { count: fresh.length }), valid.length - fresh.length),
      { action: { label: t('addToRecord.goTo'), onPress: () => router.push(`/session/${target.id}`) } },
    );
  };

  /**
   * Add a specimen to the open collection trip, starting one if none is open.
   * Number / time / collector are prefilled; the rest is filled in afterwards on
   * the specimen sheet, mirroring how a checklist record is added then detailed.
   */
  const addToCollection = (sp: SearchResult) => {
    if (!sp.taxon_id) {
      toast(t('addToRecord.noTaxonId'));
      return;
    }
    const trip = getActiveCollectionTrip();
    const tripId = trip?.id ?? createCollectionTrip();
    const number = nextRecordNumber().text;
    addSpecimen({ trip_id: tripId, taxon_id: sp.taxon_id, record_number: number });
    toast(t('addToRecord.addedToCollection', { number, name: sp.cname || sp.name }), {
      action: { label: t('addToRecord.goTo'), onPress: () => router.push(`/collection/${tripId}`) },
    });
  };

  const promptAddDestination = async (sp: SearchResult): Promise<boolean> => {
    // Resolved here rather than during render: this is a synchronous SQLite
    // read, and the hook is mounted by the taxonomy tree, which re-renders on
    // every scroll and expand.
    const activeTrip = getActiveCollectionTrip();
    const idx = await showActionSheet({
      title: sp.cname || sp.name,
      options: [
        { label: targetLabel },
        {
          label: activeTrip
            ? t('addToRecord.toCollection', { name: activeTrip.name })
            : t('addToRecord.newCollection'),
        },
      ],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) {
      addSpecies(sp);
      return true;
    }
    if (idx === 1) {
      addToCollection(sp);
      return true;
    }
    return false; // cancelled — the host stays open
  };

  const handlePlotSave = (v: PlotValueDraft) => {
    if (!plotTarget) return;
    const { sp, plotId, layer, adopted } = plotTarget;
    const recordId = addPlotSpecies({
      plot_survey_id: plotId,
      taxon_id: sp.taxon_id,
      layer,
      adopted,
      organism_quantity: v.organism_quantity,
      organism_quantity_type: v.organism_quantity_type,
      notes: v.notes,
      sex: v.sex,
      life_stage: v.life_stage,
      reproductive_condition: serializeMultiAttribute(v.reproductive_condition),
      leaf_phenology: serializeMultiAttribute(v.leaf_phenology),
      degree_of_establishment: v.degree_of_establishment,
      detection_type: v.detection_type,
      verbatim_identification: v.verbatim_identification,
    });
    stampNewRecord('plot', recordId, plotId, () => useActivePlot.getState().refresh());
    setPlotTarget(null);
    useActivePlot.getState().refresh();
    toast(t('addToRecord.addedToPlot', { name: sp.cname || sp.name }), {
      action: { label: t('addToRecord.goTo'), onPress: () => router.push(`/plot/${plotId}`) },
    });
  };

  const modal = plotTarget ? (
    <PlotSpeciesValueModal
      visible
      layer={plotTarget.layer}
      title={`${plotTarget.sp.cname || ''} ${plotTarget.sp.name}`.trim()}
      header={headerOf(plotTarget.sp)}
      kingdom={plotTarget.sp.kingdom ?? null}
      className={plotTarget.sp.class_name ?? null}
      defaultType={defaultQuantityTypeFor(plotTarget.sp.kingdom)}
      showDetection={plotTarget.plotType === 'point_count' || plotTarget.sp.kingdom === 'Animalia'}
      onCancel={() => setPlotTarget(null)}
      onSave={handlePlotSave}
    />
  ) : null;

  return {
    addSpecies,
    addMany,
    addToCollection,
    promptAddDestination,
    modal,
    targetLabel,
  };
}
