/**
 * GLORIA reports: one survey (a summit × one monitoring cycle) and a
 * project's GLORIA summits. Pure — the statistics come from
 * src/modules/gloria/model/stats.ts and the DB reads from reportData.ts.
 *
 * Filters (directions, unit types, summits) are part of the input, and the
 * report prints them, so a shared document says what it covers.
 */
import {
  compareSurveys,
  comparisonAllowed,
  GLORIA_TO_BB,
  sasPercent,
  summitSpecies,
  typeStats,
  type SpeciesFieldRow,
  type StatsFilter,
  type TypeStats,
  type UnitKind,
} from '../modules/gloria/model/stats';
import type { Direction } from '../modules/gloria/model/units';
import { DASH, int, isoDateTime, num } from './reportFormat';
import type { Report, ReportSection, Translate } from './reportTypes';

export type GloriaCycle = {
  id: number;
  mocy: number;
  year: number | null;
  status: 'active' | 'done';
  start_ts: number;
  stop_ts: number | null;
  recorded_by: string | null;
  rows: SpeciesFieldRow[];
};

type SummitInfo = { id: number; full_code: string; name: string | null; target_region: string; country: string };

export type GloriaReportInput = { summit: SummitInfo; survey: GloriaCycle; prev: GloriaCycle | null };
export type GloriaProjectReportInput = {
  projectName: string;
  summits: Array<{ summit: SummitInfo; cycles: GloriaCycle[] }>;
};

export type GloriaReportFilter = {
  dirs: Direction[];
  types: UnitKind[];
  /** Project report only; all summits when empty. */
  summitIds: number[];
};

export const ALL_TYPES: UnitKind[] = ['quadrat', 'sas', 'square'];
const DIRS: Direction[] = ['E', 'N', 'S', 'W'];
const TOP = 15;

const typeLabel = (t: Translate, k: UnitKind) =>
  t(k === 'quadrat' ? 'report.gloria.typeQuadrat' : k === 'sas' ? 'report.gloria.typeSas' : 'report.gloria.typeSquare');
const signed = (v: number | null, digits = 2) => (v == null ? DASH : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`);
const delta = (a: number | null, b: number | null) => (a == null || b == null ? null : b - a);
const typesOf = (f: GloriaReportFilter) => (f.types.length ? f.types : ALL_TYPES);
const dirsOf = (f: GloriaReportFilter) => (f.dirs.length ? f.dirs : DIRS);

function filterSection(f: GloriaReportFilter, t: Translate, summits?: string[]): ReportSection {
  return {
    id: 'filter',
    heading: t('report.gloria.filterHeading'),
    meta: [
      ...(summits ? [{ key: t('report.gloria.summits'), value: summits.join('、') }] : []),
      { key: t('report.gloria.directions'), value: dirsOf(f).join(' ') },
      { key: t('report.gloria.types'), value: typesOf(f).map((k) => typeLabel(t, k)).join('、') },
    ],
  };
}

function indexRow(label: string, s: TypeStats): string[] {
  return [
    label,
    int(s.units),
    int(s.richness),
    num(s.shannonH, 3),
    num(s.simpson1mD, 3),
    num(s.invSimpson, 2),
    num(s.pielouJ, 3),
    num(s.bergerParker, 3),
  ];
}

function indexColumns(t: Translate, first: string): string[] {
  return [
    first,
    t('report.gloria.colUnits'),
    'S',
    'H′',
    '1−D',
    '1/D',
    'J′',
    t('report.gloria.colDominance'),
  ];
}

const RIGHT8: Array<'left' | 'right'> = ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'];

function methodsSection(t: Translate): ReportSection {
  return {
    id: 'methods',
    heading: t('report.gloria.methodsHeading'),
    paras: [t('report.gloria.methodsBasis'), t('report.gloria.methodsBlind')],
    table: {
      columns: [t('report.gloria.colSasClass'), 'Br.-Bl.', '%'],
      rows: Object.entries(GLORIA_TO_BB).map(([k, bb]) => [k, bb, int(sasPercent(k))]),
      align: ['left', 'left', 'right'],
    },
    note: t('report.gloria.methodsSasNote'),
  };
}

export function buildGloriaReport(input: GloriaReportInput, f: GloriaReportFilter, t: Translate): Report {
  const { summit, survey, prev } = input;
  const filter: StatsFilter = { dirs: f.dirs };
  const types = typesOf(f);
  const sections: ReportSection[] = [];

  sections.push({
    id: 'basics',
    heading: t('report.gloria.basicsHeading'),
    meta: [
      { key: t('report.gloria.summit'), value: `${summit.full_code}${summit.name ? ` ${summit.name}` : ''}` },
      { key: t('report.gloria.targetRegion'), value: `${summit.country}-${summit.target_region}` },
      { key: 'mocy', value: String(survey.mocy) },
      { key: t('report.gloria.year'), value: survey.year != null ? String(survey.year) : DASH },
      { key: t('report.metaStart'), value: isoDateTime(survey.start_ts) },
      { key: t('report.metaEnd'), value: isoDateTime(survey.stop_ts) },
      { key: t('report.gloria.researchers'), value: survey.recorded_by || DASH },
      { key: t('report.gloria.summitRichness'), value: int(summitSpecies(survey.rows, filter).size) },
      { key: t('report.gloria.previous'), value: prev ? `mocy ${prev.mocy}${prev.year ? ` (${prev.year})` : ''}` : DASH },
    ],
  });
  sections.push(filterSection(f, t));

  sections.push({
    id: 'indices',
    heading: t('report.gloria.indicesHeading'),
    table: {
      columns: indexColumns(t, t('report.gloria.types')),
      rows: types.map((k) => indexRow(typeLabel(t, k), typeStats(survey.rows, k, filter))),
      align: RIGHT8,
    },
    note: t('report.gloria.indicesNote'),
  });

  sections.push({
    id: 'directions',
    heading: t('report.gloria.directionsHeading'),
    table: {
      columns: indexColumns(t, t('report.gloria.colDirType')),
      rows: types.flatMap((k) =>
        dirsOf(f).map((d) => indexRow(`${d} · ${typeLabel(t, k)}`, typeStats(survey.rows, k, { dirs: [d] }))),
      ),
      align: RIGHT8,
    },
  });

  if (!comparisonAllowed(survey.status)) {
    sections.push({ id: 'compare', heading: t('report.gloria.compareHeadingPlain'), paras: [t('report.gloria.compareBlind')] });
  } else if (!prev) {
    sections.push({ id: 'compare', heading: t('report.gloria.compareHeadingPlain'), paras: [t('report.gloria.compareNone')] });
  } else {
    const deltaRow = (label: string, a: TypeStats, b: TypeStats) => [
      label,
      `${int(a.richness)} → ${int(b.richness)}`,
      signed(b.richness - a.richness, 0),
      signed(delta(a.shannonH, b.shannonH), 3),
      signed(delta(a.simpson1mD, b.simpson1mD), 3),
      signed(delta(a.pielouJ, b.pielouJ), 3),
      signed(delta(a.bergerParker, b.bergerParker), 3),
    ];
    const deltaCols = (first: string) => [first, 'S', 'ΔS', 'ΔH′', 'Δ(1−D)', 'ΔJ′', t('report.gloria.colDeltaDominance')];
    const R7: Array<'left' | 'right'> = ['left', 'right', 'right', 'right', 'right', 'right', 'right'];
    sections.push({
      id: 'compare',
      heading: t('report.gloria.compareHeading', { prev: prev.mocy, cur: survey.mocy }),
      table: {
        columns: deltaCols(t('report.gloria.types')),
        rows: types.map((k) => deltaRow(typeLabel(t, k), typeStats(prev.rows, k, filter), typeStats(survey.rows, k, filter))),
        align: R7,
      },
    });
    const cmp = compareSurveys(survey.rows, prev.rows, types, filter);
    sections.push({
      id: 'turnover',
      heading: t('report.gloria.turnoverHeading'),
      meta: [
        { key: t('report.gloria.gained', { n: cmp.gained.length }), value: cmp.gained.map((x) => x.name).join('、') || DASH },
        { key: t('report.gloria.lost', { n: cmp.lost.length }), value: cmp.lost.map((x) => x.name).join('、') || DASH },
      ],
      note: t('report.gloria.turnoverNote'),
    });
    if (types.includes('quadrat')) {
      const changeTable = (list: typeof cmp.cover, digits: number) => ({
        columns: [t('report.gloria.colSpecies'), t('report.gloria.colBefore'), t('report.gloria.colAfter'), 'Δ'],
        rows: list.slice(0, TOP).map((c) => [c.name, num(c.before, digits), num(c.after, digits), signed(c.delta, digits)]),
        align: ['left', 'right', 'right', 'right'] as Array<'left' | 'right'>,
      });
      sections.push({ id: 'coverChange', heading: t('report.gloria.coverChangeHeading', { n: TOP }), table: changeTable(cmp.cover, 1) });
      sections.push({
        id: 'freqChange',
        heading: t('report.gloria.freqChangeHeading', { n: TOP }),
        table: changeTable(cmp.frequency, 0),
      });
    }
    sections.push({
      id: 'directionsChange',
      heading: t('report.gloria.directionsChangeHeading'),
      table: {
        columns: deltaCols(t('report.gloria.colDirType')),
        rows: types.flatMap((k) =>
          dirsOf(f).map((d) =>
            deltaRow(`${d} · ${typeLabel(t, k)}`, typeStats(prev.rows, k, { dirs: [d] }), typeStats(survey.rows, k, { dirs: [d] })),
          ),
        ),
        align: R7,
      },
    });
  }
  sections.push(methodsSection(t));

  return {
    kind: 'gloria',
    title: `${summit.full_code} · mocy ${survey.mocy}`,
    subtitle: t('report.gloria.subtitle'),
    generatedAt: isoDateTime(Date.now()),
    sections,
  };
}

export function buildGloriaProjectReport(input: GloriaProjectReportInput, f: GloriaReportFilter, t: Translate): Report {
  const summits = input.summits.filter((s) => f.summitIds.length === 0 || f.summitIds.includes(s.summit.id));
  const filter: StatsFilter = { dirs: f.dirs };
  const types = typesOf(f);
  const regions = new Set(summits.map((s) => `${s.summit.country}-${s.summit.target_region}`));
  const surveys = summits.reduce((n, s) => n + s.cycles.length, 0);
  const sections: ReportSection[] = [];

  sections.push({
    id: 'overview',
    heading: t('report.gloria.overviewHeading'),
    meta: [
      { key: t('report.gloria.targetRegions'), value: `${regions.size}（${[...regions].join('、')}）` },
      { key: t('report.gloria.summitCount'), value: int(summits.length) },
      { key: t('report.gloria.surveyCount'), value: int(surveys) },
      { key: t('report.gloria.resurveyCount'), value: int(summits.reduce((n, s) => n + Math.max(0, s.cycles.length - 1), 0)) },
    ],
    table: {
      columns: [
        t('report.gloria.summit'),
        t('report.gloria.targetRegion'),
        'mocy',
        t('report.gloria.year'),
        t('report.gloria.colResurveys'),
      ],
      rows: summits.map((s) => [
        `${s.summit.full_code}${s.summit.name ? ` ${s.summit.name}` : ''}`,
        s.summit.target_region,
        s.cycles.map((c) => c.mocy).join(', '),
        s.cycles.map((c) => c.year ?? DASH).join(', '),
        int(Math.max(0, s.cycles.length - 1)),
      ]),
      align: ['left', 'left', 'left', 'left', 'right'],
    },
  });
  sections.push(filterSection(f, t, summits.map((s) => s.summit.full_code)));

  // Latest finished cycle of each summit: an active one is still blind.
  const latest = summits
    .map((s) => ({ s, done: s.cycles.filter((c) => comparisonAllowed(c.status)) }))
    .map(({ s, done }) => ({ s, cur: done[done.length - 1] ?? null, prev: done[done.length - 2] ?? null }));

  sections.push({
    id: 'latest',
    heading: t('report.gloria.latestHeading'),
    table: {
      columns: indexColumns(t, t('report.gloria.colSummitType')),
      rows: latest.flatMap(({ s, cur }) =>
        cur
          ? [
              [`${s.summit.full_code} · ${t('report.gloria.summitRichness')}`, DASH, int(summitSpecies(cur.rows, filter).size), DASH, DASH, DASH, DASH, DASH],
              ...types.map((k) => indexRow(`${s.summit.full_code} m${cur.mocy} · ${typeLabel(t, k)}`, typeStats(cur.rows, k, filter))),
            ]
          : [],
      ),
      align: RIGHT8,
    },
    note: t('report.gloria.latestNote'),
  });

  sections.push({
    id: 'compare',
    heading: t('report.gloria.projectCompareHeading'),
    table: {
      columns: [t('report.gloria.colSummitType'), 'mocy', 'ΔS', 'ΔH′', 'ΔJ′', t('report.gloria.colGained'), t('report.gloria.colLost')],
      rows: latest.flatMap(({ s, cur, prev }) => {
        if (!cur || !prev) return [];
        return types.map((k) => {
          const a = typeStats(prev.rows, k, filter);
          const b = typeStats(cur.rows, k, filter);
          const cmp = compareSurveys(cur.rows, prev.rows, [k], filter);
          return [
            `${s.summit.full_code} · ${typeLabel(t, k)}`,
            `${prev.mocy} → ${cur.mocy}`,
            signed(b.richness - a.richness, 0),
            signed(delta(a.shannonH, b.shannonH), 3),
            signed(delta(a.pielouJ, b.pielouJ), 3),
            int(cmp.gained.length),
            int(cmp.lost.length),
          ];
        });
      }),
      align: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
    },
    note: t('report.gloria.projectCompareNote'),
  });
  sections.push(methodsSection(t));

  return {
    kind: 'gloriaProject',
    title: t('report.gloria.projectTitle', { name: input.projectName || t('plot.uncategorized') }),
    subtitle: t('report.gloria.subtitle'),
    generatedAt: isoDateTime(Date.now()),
    sections,
  };
}
