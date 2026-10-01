/**
 * The tables of a census export (docs/planned/Modular_survey.md §7.4, §9 1D),
 * built from the export document (censusExportCore.ts):
 *
 * - trees.csv — the permanent data, one row per tree: Condit 1998 Table 3.2.2 A
 *   (book p.139, PDF p.150: tag, species, quadrat, subquadrat, x, y), plus the
 *   tree's uuid and the census it was first recorded in.
 * - census.csv — one row per tree per census: Table 3.2.2 B (tag, dbh in mm,
 *   POM number, stem number, status code, census date, general codes). Every
 *   census lists every tree ever recorded (book p.166, PDF p.177): P before it
 *   was first recorded, D while dead. A tree with nothing recorded yet in a
 *   census still under way has an empty status. dbh is the largest live stem
 *   (Condit's Program 3.2.1, book p.143, PDF p.154), stems are the live stems.
 * - stems.csv — one row per stem per census it was measured in (Condit keeps
 *   these in the multiple-stem and big-tree databases), dbh in cm and mm.
 * - a vegan wide table per census: quadrat × species, the basal area (cm²) of
 *   live stems (dead trees excluded, §7.4).
 *
 * Pure: check:census-export runs it under Node.
 */
import { basalArea } from '../../lib/dwcAbundanceCore';
import { isoDate } from '../../lib/datetime';
import type { Row } from '../../lib/mergeEngine';
import type { CensusExportDoc } from '../db/censusExportCore';
import { fgQuadratCounts, formatFgQuadratCode, subquadratOf, type FrameGeometry } from './coords';
import { stemIsDead, treeStatus, type StemCensusInput } from './status';

export type Names = (taxonId: string) => { scientific: string | null; vernacular: string | null };

export type Table = { header: string[]; rows: string[][] };

const str = (v: unknown) => (v == null ? '' : String(v));
const parseList = (v: unknown): string[] => {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : null;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const round = (v: number, places: number) => String(Math.round(v * 10 ** places) / 10 ** places);

/**
 * Items in tag order as people read it — digit runs by value (2 before 10,
 * 12 before 12A), other runs by code unit. Keys are made once: localeCompare
 * with `numeric` cost a collator call per comparison on Hermes, about a
 * million for a 20 000-tree census (1E).
 */
function byTag<T>(items: readonly T[], tagOf: (x: T) => string): T[] {
  const keyed = items.map((it) => {
    const tag = tagOf(it);
    return { it, tag, key: (tag.match(/\d+|\D+/g) ?? []).map((c) => (/^\d/.test(c) ? Number(c) : c)) };
  });
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
  keyed.sort((a, b) => {
    for (let i = 0; i < Math.min(a.key.length, b.key.length); i++) {
      const x = a.key[i];
      const y = b.key[i];
      if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
      if (x !== y) return cmp(x, y);
    }
    return a.key.length - b.key.length || cmp(a.tag, b.tag);
  });
  return keyed.map((k) => k.it);
}

function geometryOf(frame: Row): FrameGeometry {
  return {
    sizeXM: Number(frame.size_x_m),
    sizeYM: Number(frame.size_y_m),
    quadratM: Number(frame.quadrat_m),
    subquadratM: Number(frame.subquadrat_m),
  } as FrameGeometry;
}

/** Everything about one census, by tree and stem uuid. */
function censusIndex(doc: CensusExportDoc, i: number) {
  const c = doc.censuses[i];
  const measureOf = new Map(c.measures.map((m) => [m.stem_uuid as string, m]));
  const stemCodes = new Map<string, string[]>();
  for (const v of c.stemValues) if (v.component === 'health' && v.field === 'census_codes') stemCodes.set(v.stem_uuid as string, parseList(v.value_text));
  const treeCodes = new Map<string, string[]>();
  const height = new Map<string, number>();
  for (const v of c.treeValues) {
    if (v.component === 'health' && v.field === 'census_tree_codes') treeCodes.set(v.tree_uuid as string, parseList(v.value_text));
    if (v.component === 'height' && v.field === 'height_m' && v.value_num != null) height.set(v.tree_uuid as string, Number(v.value_num));
  }
  const quadratDate = new Map(c.quadrats.map((q) => [q.quadrat_code as string, (q.started_at as number | null) ?? null]));
  return { c, measureOf, stemCodes, treeCodes, height, quadratDate };
}

export function treesTable(doc: CensusExportDoc, names: Names): Table {
  const g = geometryOf(doc.frame);
  const noOf = new Map(doc.censuses.map((c) => [c.survey.uuid as string, Number(c.survey.census_no)]));
  const header = ['tag', 'individual_uuid', 'taxon_id', 'scientific_name', 'vernacular_name', 'quadrat', 'subquadrat', 'x_m', 'y_m', 'local_x_m', 'local_y_m', 'first_census', 'coord_method', 'notes'];
  const rows = byTag(doc.trees, (t) => str(t.tag)).map((t) => {
    const n = names(str(t.taxon_id));
    const x = Number(t.x_m);
    const y = Number(t.y_m);
    const lx = x - Math.floor(x / g.quadratM + 1e-9) * g.quadratM;
    const ly = y - Math.floor(y / g.quadratM + 1e-9) * g.quadratM;
    const sub = subquadratOf(lx, ly, g);
    return [
      str(t.tag),
      str(t.uuid),
      str(t.taxon_id),
      str(t.used_scientific_name ?? n.scientific),
      str(n.vernacular),
      str(t.quadrat_code),
      `${sub.i}${sub.j}`,
      str(t.x_m),
      str(t.y_m),
      round(lx, 2),
      round(ly, 2),
      str(noOf.get(str(t.first_survey_uuid)) ?? ''),
      str(t.coord_method),
      str(t.notes),
    ];
  });
  return { header, rows };
}

export function censusTable(doc: CensusExportDoc): Table {
  const header = ['census_no', 'tag', 'individual_uuid', 'dbh_mm', 'pom', 'pom_m', 'stems', 'status', 'date', 'codes', 'height_m'];
  const threshold = Number(doc.frame.dbh_min_cm);
  const noOf = new Map(doc.censuses.map((c) => [c.survey.uuid as string, Number(c.survey.census_no)]));
  const stemsOf = new Map<string, Row[]>();
  for (const st of doc.stems) {
    const list = stemsOf.get(str(st.tree_uuid));
    if (list) list.push(st);
    else stemsOf.set(str(st.tree_uuid), [st]);
  }
  const trees = byTag(doc.trees, (t) => str(t.tag));
  const rows: string[][] = [];
  doc.censuses.forEach((_, i) => {
    const ix = censusIndex(doc, i);
    const n = Number(ix.c.survey.census_no);
    const start = ix.c.survey.start_ts as number | null;
    for (const t of trees) {
      const first = noOf.get(str(t.first_survey_uuid));
      const existed = first == null || first <= n;
      const stems = (stemsOf.get(str(t.uuid)) ?? []).filter((st) => {
        const f = noOf.get(str(st.first_survey_uuid));
        return f == null || f <= n;
      });
      const measured = stems.flatMap((st) => {
        const m = ix.measureOf.get(str(st.uuid));
        return m ? [{ st, m }] : [];
      });
      const treeCodes = ix.treeCodes.get(str(t.uuid)) ?? [];
      const inputs: StemCensusInput[] = measured.map(({ st, m }) => ({
        censusCodes: ix.stemCodes.get(str(st.uuid)) ?? [],
        stemDead: m.stem_dead === 1 || m.stem_dead === true,
        dbhCm: m.dbh_cm == null ? null : Number(m.dbh_cm),
        pending: m.pending === 'big_tree' ? 'big_tree' : null,
      }));
      const recorded = measured.length > 0 || treeCodes.length > 0;
      const status = !existed ? 'P' : recorded ? treeStatus({ treeCodes, stems: inputs, existed: true, thresholdCm: threshold }) : '';
      const live = measured.filter((x, k) => !stemIsDead(inputs[k], treeCodes));
      const biggest = [...live].sort((a, b) => Number(b.m.dbh_cm ?? -1) - Number(a.m.dbh_cm ?? -1))[0];
      const main = measured.find((x) => x.m.is_main === 1 || x.m.is_main === true) ?? biggest;
      const when = (main?.m.measured_at as number | null) ?? ix.quadratDate.get(str(t.quadrat_code)) ?? start;
      const codes = [...new Set([...treeCodes, ...measured.flatMap(({ st }) => ix.stemCodes.get(str(st.uuid)) ?? [])])];
      const dbh = status === 'A' || status === 'F' ? (biggest?.m.dbh_cm as number | null | undefined) : null;
      rows.push([
        String(n),
        str(t.tag),
        str(t.uuid),
        dbh != null ? String(Math.round(Number(dbh) * 10)) : '',
        str(main?.m.pom_seq),
        str(main?.m.pom_m),
        status === 'P' ? '' : String(live.length),
        status,
        when != null ? isoDate(when) : '',
        codes.join(';'),
        str(ix.height.get(str(t.uuid))),
      ]);
    }
  });
  return { header, rows };
}

export function stemsTable(doc: CensusExportDoc): Table {
  const header = ['census_no', 'tag', 'stem_no', 'stem_tag', 'stem_uuid', 'dbh_cm', 'dbh_mm', 'pom_m', 'pom_seq', 'main', 'stem_dead', 'codes', 'pending', 'date', 'recorded_by'];
  const treeOf = new Map(doc.trees.map((t) => [str(t.uuid), t]));
  // Stable sort: stems of one tree stay in stem order.
  const stems = byTag(
    [...doc.stems].sort((a, b) => Number(a.stem_no) - Number(b.stem_no)),
    (st) => str(treeOf.get(str(st.tree_uuid))?.tag),
  );
  const rows: string[][] = [];
  doc.censuses.forEach((_, i) => {
    const ix = censusIndex(doc, i);
    for (const st of stems) {
      const m = ix.measureOf.get(str(st.uuid));
      if (!m) continue;
      const tag = str(treeOf.get(str(st.tree_uuid))?.tag);
      const dbh = m.dbh_cm == null ? null : Number(m.dbh_cm);
      rows.push([
        str(ix.c.survey.census_no),
        tag,
        str(st.stem_no),
        `${tag}-${str(st.stem_no)}`,
        str(st.uuid),
        dbh == null ? '' : String(dbh),
        dbh == null ? '' : String(Math.round(dbh * 10)),
        str(m.pom_m),
        str(m.pom_seq),
        m.is_main === 1 || m.is_main === true ? '1' : '0',
        m.stem_dead === 1 || m.stem_dead === true ? '1' : '0',
        (ix.stemCodes.get(str(st.uuid)) ?? []).join(';'),
        str(m.pending),
        m.measured_at != null ? isoDate(Number(m.measured_at)) : '',
        str(m.recorded_by),
      ]);
    }
  });
  return { header, rows };
}

/**
 * One census as a vegan community matrix: a row per quadrat (every quadrat of
 * the plot), a column per species (scientific name), the basal area in cm² of
 * its live stems there.
 */
export function veganBasalArea(doc: CensusExportDoc, censusIndexNo: number, names: Names): Table {
  const ix = censusIndex(doc, censusIndexNo);
  const g = geometryOf(doc.frame);
  const { cols, rows: rr } = fgQuadratCounts(g);
  const treeOf = new Map(doc.trees.map((t) => [str(t.uuid), t]));
  const area = new Map<string, Map<string, number>>(); // quadrat → taxon → cm²
  const stemsOfTree = new Map<string, Row[]>();
  for (const st of doc.stems) {
    const list = stemsOfTree.get(str(st.tree_uuid));
    if (list) list.push(st);
    else stemsOfTree.set(str(st.tree_uuid), [st]);
  }
  for (const [treeUuid, stems] of stemsOfTree) {
    const t = treeOf.get(treeUuid);
    if (!t) continue;
    const treeCodes = ix.treeCodes.get(treeUuid) ?? [];
    const dbhs = stems.flatMap((st) => {
      const m = ix.measureOf.get(str(st.uuid));
      if (!m || m.dbh_cm == null) return [];
      const input: StemCensusInput = { censusCodes: ix.stemCodes.get(str(st.uuid)) ?? [], stemDead: m.stem_dead === 1 || m.stem_dead === true, dbhCm: Number(m.dbh_cm) };
      return stemIsDead(input, treeCodes) || Number(m.dbh_cm) <= 0 ? [] : [Number(m.dbh_cm)];
    });
    if (!dbhs.length) continue;
    const q = str(t.quadrat_code);
    const byTaxon = area.get(q) ?? new Map<string, number>();
    byTaxon.set(str(t.taxon_id), (byTaxon.get(str(t.taxon_id)) ?? 0) + basalArea(dbhs));
    area.set(q, byTaxon);
  }
  const taxa = [...new Set([...area.values()].flatMap((m) => [...m.keys()]))];
  const label = (id: string) => names(id).scientific ?? doc.taxa[id] ?? id;
  const labels = taxa.map(label);
  // Two ids under one name keep apart: the id goes after the name.
  const unique = labels.map((l, k) => (labels.indexOf(l) !== labels.lastIndexOf(l) ? `${l} (${taxa[k]})` : l));
  const order = taxa.map((_, k) => k).sort((a, b) => unique[a].localeCompare(unique[b]));
  const header = ['quadrat', ...order.map((k) => unique[k])];
  const rows: string[][] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rr; r++) {
      const code = formatFgQuadratCode(c, r);
      const m = area.get(code);
      rows.push([code, ...order.map((k) => round(m?.get(taxa[k]) ?? 0, 2))]);
    }
  }
  return { header, rows };
}
