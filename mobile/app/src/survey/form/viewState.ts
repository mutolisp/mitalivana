/**
 * Which tab and unit a survey screen shows, kept while the app runs, so
 * coming back to a survey (or a unit screen sending the user to record
 * species in that unit) lands where the user was.
 */
export type SurveyTab = 'data' | 'units' | 'species';
/** The unit chips: every occurrence, those outside any unit, or one unit. */
export type UnitPick = 'all' | 'none' | number;

const views = new Map<number, { tab: SurveyTab; unit: UnitPick }>();

export const surveyView = (surveyId: number) => views.get(surveyId);

export function setSurveyView(surveyId: number, next: { tab?: SurveyTab; unit?: UnitPick }): void {
  const cur = views.get(surveyId) ?? { tab: 'species', unit: 'all' };
  views.set(surveyId, { tab: next.tab ?? cur.tab, unit: next.unit ?? cur.unit });
}
