/** Which survey and unit a path belongs to (desktop sidebar and shortcuts). */
import { describe, expect, it } from 'vitest';
import { surveyRoute } from '../src/shell/Desktop';

describe('surveyRoute', () => {
  it('reads survey, unit and sub-page', () => {
    expect(surveyRoute('/gloria/12')).toEqual({ id: 12, code: null, rest: null });
    expect(surveyRoute('/gloria/12/E11')).toEqual({ id: 12, code: 'E11', rest: null });
    expect(surveyRoute('/gloria/12/N05/frequency')).toEqual({ id: 12, code: 'N05', rest: 'frequency' });
    expect(surveyRoute('/gloria/12/W')).toEqual({ id: 12, code: 'W', rest: null });
  });
  it('is not a unit for fixed pages or other routes', () => {
    expect(surveyRoute('/gloria/12/points-import')?.code).toBeNull();
    expect(surveyRoute('/gloria/new')).toBeNull();
    expect(surveyRoute('/gloria/summit/3')).toBeNull();
    expect(surveyRoute('/')).toBeNull();
  });
});
