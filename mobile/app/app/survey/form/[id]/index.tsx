/**
 * A checklist / plot-style survey (Modular_survey.md; 2G): drawn with the
 * screen of the record it matches — a checklist-style one with 快速名錄's
 * (ChecklistSurveyScreen.tsx; `?open=<occurrence>` opens one's detail sheet),
 * a plot-style one with the fixed plot's (PlotSurveyScreen.tsx). The
 * template decides what those screens show (moduleMap.ts).
 */
import { useLocalSearchParams } from 'expo-router';
import { getFwSurvey } from '~/survey/db/surveys';
import { ChecklistSurveyScreen } from '~/survey/form/ChecklistSurveyScreen';
import { PlotSurveyScreen } from '~/survey/form/PlotSurveyScreen';

export default function SurveyFormScreen() {
  const params = useLocalSearchParams<{ id: string; open?: string }>();
  const id = Number(params.id);
  // A survey keeps its style.
  if (getFwSurvey(id)?.style === 'checklist') return <ChecklistSurveyScreen id={id} openId={params.open ? Number(params.open) : undefined} />;
  return <PlotSurveyScreen id={id} />;
}
