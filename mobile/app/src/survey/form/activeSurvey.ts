/**
 * The open checklist / plot-style survey (fw_surveys, style other than
 * 'individual'), mirroring useActiveMiren, and the unit its screen has
 * selected: species added from elsewhere (species tab, taxonomy tree,
 * favorites, keys) go into that unit (src/survey/form/quickAdd.ts).
 *
 * Tree censuses are exempt from single-active and never show here.
 */
import { create } from 'zustand';
import { getActiveSurvey } from '~/survey/db/surveys';
import type { FwSurveyRow } from '~/survey/db/surveyCore';

type ActiveSurveyState = {
  survey: FwSurveyRow | null;
  /** The unit selected on the survey's screen; null = outside any unit. */
  unit: { surveyId: number; unitId: number | null } | null;
  refresh: () => void;
  setUnit: (surveyId: number, unitId: number | null) => void;
};

export const useActiveSurvey = create<ActiveSurveyState>((set) => ({
  survey: null,
  unit: null,
  refresh: () => set({ survey: getActiveSurvey() }),
  setUnit: (surveyId, unitId) => set({ unit: { surveyId, unitId } }),
}));

/** The unit quick adds go into for this survey (null: outside any unit). */
export function quickAddUnit(surveyId: number): number | null {
  const u = useActiveSurvey.getState().unit;
  return u?.surveyId === surveyId ? u.unitId : null;
}
