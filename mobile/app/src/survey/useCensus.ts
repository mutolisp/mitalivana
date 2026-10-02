/**
 * What the census screens read: the census, its plot, every tree's state and
 * one quadrat's trees with names, flags, problems and chips — loaded into
 * state on focus and on reload(), never during render (React Compiler would
 * keep a stale read).
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { resolveTaxa } from '~/db/taxonLookup';
import {
  censusTreeStates,
  frameGeometry,
  getFrame,
  getSurvey,
  listFgQuadrats,
  loadFgQuadrat,
  previousCensusId,
  type FgQuadratRow,
  type FrameRow,
  type CensusRow,
  type TreeState,
  type TreeView,
} from '~/survey/db/stemmap';
import { fgQuadratCounts, formatFgQuadratCode, locate, type FrameGeometry } from '~/survey/stemmap/coords';
import { treeChip, treeFlags, treeIssues, type TreeChip, type TreeFlags, type TreeIssue } from '~/survey/stemmap/review';
import { sortByWalk } from '~/survey/stemmap/walkOrder';

export type CensusData = {
  survey: CensusRow;
  frame: FrameRow;
  geometry: FrameGeometry;
  firstCensus: boolean;
  states: TreeState[];
  quadrats: FgQuadratRow[];
};

export type TreeRowData = {
  view: TreeView;
  cname: string;
  sci: string;
  flags: TreeFlags;
  issues: TreeIssue[];
  chip: TreeChip;
};

export function loadCensusData(surveyId: number): CensusData | null {
  const survey = getSurvey(surveyId);
  if (!survey) return null;
  const frame = getFrame(survey.frame_id);
  if (!frame) return null;
  return {
    survey,
    frame,
    geometry: frameGeometry(frame),
    firstCensus: previousCensusId(surveyId) == null,
    states: censusTreeStates(surveyId),
    quadrats: listFgQuadrats(surveyId),
  };
}

/** One quadrat's trees in walking order (Condit Fig. 2.2.2), with what the list shows. */
export function loadQuadratRows(d: CensusData, code: string): TreeRowData[] {
  const views = loadFgQuadrat(d.survey.id, code);
  const names = resolveTaxa(views.map((v) => v.individual.taxon_id));
  const placed = views.map((v) => {
    const at = locate({ x: v.individual.x_m, y: v.individual.y_m }, d.geometry);
    return { v, localX: at.localX, localY: at.localY };
  });
  return sortByWalk(placed, d.geometry).map(({ v }) => {
    const f = names.get(v.individual.taxon_id);
    const flags = treeFlags(v, d.survey.id, !d.firstCensus);
    const issues = treeIssues(v, { surveyId: d.survey.id, firstCensus: d.firstCensus, thresholdCm: d.frame.dbh_min_cm });
    const qualifier = v.individual.verbatim_identification ? ` ${v.individual.verbatim_identification}` : '';
    return {
      view: v,
      cname: (f?.common_name_c || '') + qualifier,
      sci: v.individual.used_scientific_name || f?.simple_name || v.individual.taxon_id,
      flags,
      issues,
      chip: treeChip(flags, issues),
    };
  });
}

/** Every quadrat code of the plot, column by column (CCRR order). */
export function allQuadratCodes(g: FrameGeometry): string[] {
  const { cols, rows } = fgQuadratCounts(g);
  const out: string[] = [];
  for (let col = 0; col < cols; col++) for (let row = 0; row < rows; row++) out.push(formatFgQuadratCode(col, row));
  return out;
}

export function useCensus(surveyId: number) {
  const [data, setData] = useState<CensusData | null>(() => loadCensusData(surveyId));
  const reload = useCallback(() => setData(loadCensusData(surveyId)), [surveyId]);
  useFocusEffect(reload);
  return { data, reload };
}
