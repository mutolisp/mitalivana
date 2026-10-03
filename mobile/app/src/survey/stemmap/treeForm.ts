/**
 * The tree form (design 13c) as plain data: built from what a census sees of
 * a tree, previewed (position), checked (the same rules as the lists), and
 * turned into the draft stemmapCore.saveTreeDraft() writes. Numbers stay text
 * until saved and are read with parseNum (decimal comma accepted).
 *
 * Pure: check:survey-db runs it under Node.
 */
import type { LocationInput, MeasureRow, StemView, TaxonInput, TreeDraft, TreeView } from '../db/stemmapCore';
import type { SurveyTemplate } from '../template/types';
import { parseNum } from '../../lib/parseNum';
import { AMS_CODESET, AMS_VARIABLES, amsField, amsStemDead, type AmsValues } from '../codesets/forestgeoAms2021';
import { componentProblems } from '../componentRules';
import { componentDef, type TraitDef } from '../registry';
import { formatStemTag } from './tags';
import { fromGps, fromGrid, fromPolar, locate, stakeXY, type FrameGeometry, type StakeCorner, type XY } from './coords';
import { treeIssues, type TreeIssue } from './review';
import type { StemCensusInput } from './status';

export type LocMethod = LocationInput['method'];

export type LocForm = {
  method: LocMethod;
  quadrat: string;
  lx: string;
  ly: string;
  x: string;
  y: string;
  refKind: 'stake' | 'tree';
  refQuadrat: string;
  refCorner: StakeCorner;
  refTag: string;
  dist: string;
  az: string;
  azRef: 'magnetic' | 'true';
  slope: string;
  lat: string;
  lng: string;
  acc: string;
};

export type StemForm = {
  /** Stable key for the list (stem number, or `new-n`). */
  key: string;
  /** null: added in this form. */
  stemNo: number | null;
  firstSurveyId: number | null;
  dbh: string;
  pom: string;
  dead: boolean;
  codes: string[];
  notes: string;
  previous: MeasureRow | null;
  previousCodes: string[];
  /** AMS values as typed: numbers stay text until saved (markers like '?' kept). */
  ams: AmsForm;
  /** Codes from the census template's own health code lists, per list id; the previous census's beside them. */
  custom: Readonly<Record<string, readonly string[]>>;
  previousCustom: Readonly<Record<string, readonly string[]>>;
};

/** One stem's AMS entries: a code, a list of codes, or text for a number. */
export type AmsForm = Readonly<Record<string, string | readonly string[]>>;

export type TreeForm = {
  tag: string;
  /** The tag was typed, so a new position does not replace it with a suggestion. */
  tagTyped: boolean;
  taxon: TaxonInput | null;
  loc: LocForm;
  notes: string;
  height: string;
  /** Trait values as typed, per Traits component key and trait id. */
  traits: Readonly<Record<string, Readonly<Record<string, string>>>>;
  treeCodes: string[];
  /** One set of codes for every stem (design 13c "全部分支相同"). */
  same: boolean;
  allCodes: string[];
  stems: StemForm[];
  mainKey: string;
  /** The census template records the AMS code set; stem death then follows AMS survival. */
  amsOn: boolean;
};

const str = (v: number | null | undefined) => (v == null ? '' : String(v));
const round1 = (v: number) => Math.round(v * 10) / 10;

export function emptyLoc(quadrat: string, at?: XY | null, g?: FrameGeometry): LocForm {
  const local = at && g ? locate(at, g) : null;
  return {
    method: 'grid',
    quadrat: local?.code ?? quadrat,
    lx: local ? str(round1(local.localX)) : '',
    ly: local ? str(round1(local.localY)) : '',
    x: at ? str(round1(at.x)) : '',
    y: at ? str(round1(at.y)) : '',
    refKind: 'stake',
    refQuadrat: quadrat,
    refCorner: 'SW',
    refTag: '',
    dist: '',
    az: '',
    azRef: 'magnetic',
    slope: '',
    lat: '',
    lng: '',
    acc: '',
  };
}

/** The form as it opens: an existing tree's current values, or a blank new tree. */
export function formFromView(v: TreeView | null, opts: { quadrat: string; at?: XY | null; geometry: FrameGeometry; amsOn?: boolean }): TreeForm {
  const amsOn = opts.amsOn ?? false;
  if (!v) {
    const stem = newStem('new-1');
    return {
      tag: '',
      tagTyped: false,
      taxon: null,
      loc: emptyLoc(opts.quadrat, opts.at, opts.geometry),
      notes: '',
      height: '',
      traits: {},
      treeCodes: [],
      same: true,
      allCodes: [],
      stems: [stem],
      mainKey: stem.key,
      amsOn,
    };
  }
  const i = v.individual;
  const loc = emptyLoc(i.quadrat_code, { x: i.x_m, y: i.y_m }, opts.geometry);
  const stems = v.stems.map((s: StemView): StemForm => ({
    key: String(s.stem.stem_no),
    stemNo: s.stem.stem_no,
    firstSurveyId: s.stem.first_survey_id,
    dbh: str(s.measure?.dbh_cm),
    pom: str(s.measure?.pom_m ?? s.previous?.pom_m ?? 1.3),
    dead: s.measure?.stem_dead === 1,
    codes: [...s.codes],
    notes: s.measure?.notes ?? '',
    previous: s.previous,
    previousCodes: s.previousCodes,
    ams: amsToForm(s.ams),
    custom: s.custom,
    previousCustom: s.previousCustom,
  }));
  const main = v.stems.find((s) => (s.measure ?? s.previous)?.is_main === 1) ?? v.stems[0];
  const first = stems[0]?.codes ?? [];
  const same = stems.every((s) => s.codes.length === first.length && s.codes.every((c) => first.includes(c)));
  return {
    tag: i.tag,
    tagTyped: true,
    taxon: { taxonId: i.taxon_id, usedNameId: i.used_name_id, usedScientificName: i.used_scientific_name, verbatimIdentification: i.verbatim_identification },
    loc,
    notes: i.notes ?? '',
    height: str(v.heightM),
    traits: Object.fromEntries(Object.entries(v.traits).map(([k, vals]) => [k, Object.fromEntries(Object.entries(vals).map(([id, n]) => [id, String(n)]))])),
    treeCodes: [...v.treeCodes],
    same,
    allCodes: same ? [...first] : [],
    stems,
    mainKey: main ? String(main.stem.stem_no) : (stems[0]?.key ?? ''),
    amsOn,
  };
}

/** A stem added in the form. */
export function newStem(key: string): StemForm {
  return { key, stemNo: null, firstSurveyId: null, dbh: '', pom: '1.3', dead: false, codes: [], notes: '', previous: null, previousCodes: [], ams: {}, custom: {}, previousCustom: {} };
}

/** A stored AMS value as the form shows it. */
function amsToForm(ams: AmsValues): AmsForm {
  return Object.fromEntries(Object.entries(ams).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
}

const AMS_MARKERS = new Set(['?', '<POM', 'NA']);

/** The form's AMS entries as stored: numbers read with parseNum (unreadable text kept, so the check flags it), empties left out. */
export function amsFromForm(ams: AmsForm): AmsValues {
  const out: Record<string, string | number | readonly string[]> = {};
  for (const v of AMS_VARIABLES) {
    const x = ams[v.field];
    if (x == null || x === '' || (Array.isArray(x) && x.length === 0)) continue;
    if (v.kind === 'number' && typeof x === 'string') {
      const t = x.trim();
      out[v.field] = AMS_MARKERS.has(t) ? t : (parseNum(t) ?? t);
    } else {
      out[v.field] = x;
    }
  }
  return out;
}

/** A stem's death: from AMS survival when the AMS code set is on, else the stem-death switch. */
const stemDeadOf = (form: TreeForm, s: StemForm) => (form.amsOn ? amsStemDead(amsFromForm(s.ams)) : s.dead);

/** The position as the core takes it, or null while a needed field is empty. */
export function locationInput(l: LocForm): LocationInput | null {
  const n = parseNum;
  switch (l.method) {
    case 'grid': {
      const lx = n(l.lx);
      const ly = n(l.ly);
      return l.quadrat.trim().length === 4 && lx != null && ly != null ? { method: 'grid', quadrat: l.quadrat.trim(), localX: lx, localY: ly } : null;
    }
    case 'xy': {
      const x = n(l.x);
      const y = n(l.y);
      return x != null && y != null ? { method: 'xy', x, y } : null;
    }
    case 'polar': {
      const d = n(l.dist);
      const az = n(l.az);
      if (d == null || az == null) return null;
      const ref = l.refKind === 'stake' ? (l.refQuadrat.trim().length === 4 ? { kind: 'stake' as const, quadrat: l.refQuadrat.trim(), corner: l.refCorner } : null) : l.refTag.trim() ? { kind: 'tree' as const, tag: l.refTag.trim() } : null;
      return ref ? { method: 'polar', ref, distanceM: d, azimuthDeg: az, azimuthRef: l.azRef, slopeDeg: n(l.slope) } : null;
    }
    case 'gps': {
      const lat = n(l.lat);
      const lng = n(l.lng);
      return lat != null && lng != null ? { method: 'gps', lat, lng, accuracy: n(l.acc) } : null;
    }
  }
}

export type LocPreview = { x: number; y: number; quadrat: string; sub: { i: number; j: number }; inside: boolean };

/** Plot x,y, quadrat and subquadrat of what is typed, as the save will compute them. */
export function previewLocation(l: LocForm, g: FrameGeometry, treeAt: (tag: string) => XY | null): LocPreview | null {
  const input = locationInput(l);
  if (!input) return null;
  let p: XY | null = null;
  switch (input.method) {
    case 'grid': {
      const r = fromGrid(input.quadrat, input.localX, input.localY, g);
      p = r && r.warnings.length === 0 ? r : null;
      break;
    }
    case 'xy':
      p = { x: input.x, y: input.y };
      break;
    case 'polar': {
      const ref = input.ref.kind === 'stake' ? stakeXY(input.ref.quadrat, input.ref.corner, g) : treeAt(input.ref.tag);
      p = ref ? fromPolar(ref, input.distanceM, input.azimuthDeg, input.azimuthRef, input.slopeDeg ?? null, g) : null;
      break;
    }
    case 'gps':
      p = fromGps(input.lat, input.lng, g);
      break;
  }
  if (!p) return null;
  const at = locate(p, g);
  return { x: p.x, y: p.y, quadrat: at.code, sub: at.sub, inside: at.inside };
}

const unreadable = (text: string) => text.trim() !== '' && parseNum(text) == null;

/**
 * Fields holding text that is not a number. parseNum reads such text as
 * empty, so saving it would silently drop the entry; the form refuses
 * instead. Stems are named by their tag; the rest by key.
 */
export type UnreadableField = { stemTag: string | null; field: 'dbh' | 'pom' | 'height' | 'position' | 'trait'; trait?: { key: string; id: string } };

export function unreadableFields(form: TreeForm, treeTag: string): UnreadableField[] {
  const out: UnreadableField[] = [];
  const numbers = stemNumbers(form);
  for (const s of form.stems) {
    const tag = stemTagOf(treeTag, numbers.get(s.key)!);
    if (unreadable(s.dbh)) out.push({ stemTag: tag, field: 'dbh' });
    if (unreadable(s.pom)) out.push({ stemTag: tag, field: 'pom' });
  }
  if (unreadable(form.height)) out.push({ stemTag: null, field: 'height' });
  for (const [key, vals] of Object.entries(form.traits)) {
    for (const [id, text] of Object.entries(vals)) if (unreadable(text)) out.push({ stemTag: null, field: 'trait', trait: { key, id } });
  }
  const l = form.loc;
  const loc = l.method === 'grid' ? [l.lx, l.ly] : l.method === 'xy' ? [l.x, l.y] : l.method === 'polar' ? [l.dist, l.az, l.slope] : [l.lat, l.lng, l.acc];
  if (loc.some(unreadable)) out.push({ stemTag: null, field: 'position' });
  return out;
}

/** Number each form stem would carry: existing ones keep theirs, added ones follow. */
export function stemNumbers(form: TreeForm): Map<string, number> {
  const out = new Map<string, number>();
  let next = Math.max(0, ...form.stems.map((s) => s.stemNo ?? 0));
  for (const s of form.stems) out.set(s.key, s.stemNo ?? ++next);
  return out;
}

export const stemTagOf = (treeTag: string, stemNo: number) => formatStemTag(treeTag || '?', stemNo);

const codesOf = (form: TreeForm, s: StemForm) => (form.same ? form.allCodes : s.codes);

/** What the form would store, as the view the checks read. */
function asView(form: TreeForm, v: TreeView | null, surveyId: number): TreeView {
  const numbers = stemNumbers(form);
  const ind = v?.individual ?? {
    id: 0,
    uuid: '',
    frame_id: 0,
    tag: form.tag,
    taxon_id: form.taxon?.taxonId ?? '',
    used_name_id: null,
    used_scientific_name: null,
    verbatim_identification: null,
    x_m: 0,
    y_m: 0,
    quadrat_code: '0000',
    coord_method: 'grid' as const,
    local_x_m: null,
    local_y_m: null,
    ref_kind: null,
    ref_code: null,
    distance_m: null,
    azimuth_deg: null,
    azimuth_ref: null,
    slope_deg: null,
    lat: null,
    lng: null,
    accuracy: null,
    first_survey_id: surveyId,
    notes: null,
    created_at: 0,
    updated_at: 0,
  };
  return {
    individual: ind,
    treeCodes: form.treeCodes,
    previousTreeCodes: v?.previousTreeCodes ?? [],
    heightM: parseNum(form.height),
    traits: traitNumbers(form),
    stems: form.stems.map((s, i): StemView => {
      const codes = codesOf(form, s);
      const dbh = parseNum(s.dbh);
      const dead = stemDeadOf(form, s);
      const ams = form.amsOn ? amsFromForm(s.ams) : {};
      const touched = dbh != null || dead || codes.length > 0 || Object.keys(ams).length > 0;
      const no = numbers.get(s.key)!;
      return {
        stem: { id: -1 - i, uuid: '', individual_id: ind.id, stem_no: no, first_survey_id: s.stemNo == null ? surveyId : s.firstSurveyId, notes: null },
        measure: touched
          ? {
              id: -1 - i,
              uuid: '',
              survey_id: surveyId,
              stem_id: -1 - i,
              dbh_cm: dbh,
              pom_m: parseNum(s.pom) ?? 1.3,
              pom_seq: (s.previous?.pom_seq ?? 1) + (s.previous && codes.includes('C') ? 1 : 0),
              is_main: s.key === form.mainKey ? 1 : 0,
              stem_dead: dead ? 1 : 0,
              pending: codes.includes('B') && dbh == null && !dead ? 'big_tree' : null,
              // Only order matters to the checks (growth is not computed here).
              measured_at: (s.previous?.measured_at ?? 0) + 1,
              recorded_by: null,
              notes: s.notes || null,
              updated_at: 0,
            }
          : null,
        previous: s.previous,
        codes,
        previousCodes: s.previousCodes,
        ams,
        custom: s.custom,
        previousCustom: s.previousCustom,
      };
    }),
  };
}

/** The trait values as numbers; an empty entry is null (it clears the stored value). */
function traitNumbers(form: TreeForm): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [key, vals] of Object.entries(form.traits)) {
    for (const [id, text] of Object.entries(vals)) {
      const n = parseNum(text);
      if (n != null) (out[key] ??= {})[id] = n;
    }
  }
  return out;
}

/** The census template's Traits components on the tree, with their traits (the form's trait card). */
export function treeTraits(t: SurveyTemplate | null): { key: string; label: unknown; traits: TraitDef[] }[] {
  return (t?.components ?? [])
    .filter((c) => c.type === 'traits' && c.level === 'individual')
    .map((c) => ({ key: c.key, label: c.label, traits: Array.isArray(c.params.traits) ? (c.params.traits as TraitDef[]) : [] }));
}

/**
 * Trait values outside their trait's range (or not whole where it must be),
 * by the registry's own rules: an error each, blocking the save.
 */
export function traitIssues(form: TreeForm, t: SurveyTemplate | null): { key: string; id: string; code: string }[] {
  const def = componentDef('traits')!;
  const values = traitNumbers(form);
  const out: { key: string; id: string; code: string }[] = [];
  for (const c of (t?.components ?? []).filter((x) => x.type === 'traits' && x.level === 'individual')) {
    for (const p of componentProblems(def, c.params, 'individual', c.key, values[c.key] ?? {})) {
      if (p.severity === 'error' && p.field != null) out.push({ key: c.key, id: p.field, code: p.code });
    }
  }
  return out;
}

/**
 * Problems of the form as it stands. On top of the list checks, every stem
 * new in this census must be handled: a recruit below the threshold is not
 * recorded at all (decided 2026-10-01), so an empty new stem is an error.
 */
export function formIssues(form: TreeForm, v: TreeView | null, opts: { surveyId: number; firstCensus: boolean; thresholdCm: number }): TreeIssue[] {
  const view = asView(form, v, opts.surveyId);
  const out = treeIssues(view, opts);
  if (form.amsOn) {
    // The AMS code set's own rules (registry Health): codes, numbers, B with S, U without leaning, OK with damage.
    const health = componentDef('health')!;
    view.stems.forEach((s) => {
      if (Object.keys(s.ams).length === 0) return;
      const stored = Object.fromEntries(Object.entries(s.ams).map(([k, x]) => [amsField(k), x]));
      for (const p of componentProblems(health, { codesets: [AMS_CODESET] }, 'stem', 'health', stored)) {
        if (p.field != null && !p.field.startsWith('ams_')) continue;
        out.push({ stemNo: s.stem.stem_no, code: p.code === 'not_a_number' || p.code === 'not_allowed' || p.code === 'below_min' || p.code === 'above_max' ? `ams_${p.code}` : p.code, severity: p.severity });
      }
    });
  }
  view.stems.forEach((s) => {
    const isNew = s.stem.first_survey_id === opts.surveyId;
    const handled = s.measure != null && (s.measure.dbh_cm != null || s.measure.stem_dead === 1 || s.measure.pending != null);
    if (isNew && !handled && form.treeCodes.length === 0 && !out.some((i) => i.stemNo === s.stem.stem_no && i.code === 'dbh_required')) {
      out.push({ stemNo: s.stem.stem_no, code: 'dbh_required', severity: 'error' });
    }
  });
  return out;
}

/** Each live stem's DBH as typed (else last census's), for the size line. */
export function formDbhs(form: TreeForm): (number | null)[] {
  return form.stems.map((s) => (stemDeadOf(form, s) ? null : (parseNum(s.dbh) ?? (s.previous && s.previous.stem_dead === 0 ? s.previous.dbh_cm : null))));
}

/** The stems as the status rules read them (for the derived code M). */
export function formStemInputs(form: TreeForm): StemCensusInput[] {
  return form.stems.map((s) => ({
    censusCodes: form.same ? form.allCodes : s.codes,
    stemDead: stemDeadOf(form, s),
    dbhCm: parseNum(s.dbh),
    ...(form.amsOn ? { amsSurvival: (amsFromForm(s.ams).survival_status as StemCensusInput['amsSurvival']) ?? null } : {}),
  }));
}

/** The draft to save. Taxon / position / tag go in only for a tree first
 *  recorded in this census (older trees are corrected, with history). */
export function formToDraft(form: TreeForm, v: TreeView | null, opts: { surveyId: number; recordedBy: string | null }): TreeDraft {
  const recruit = v == null || v.individual.first_survey_id === opts.surveyId;
  const numbers = stemNumbers(form);
  return {
    individualId: v?.individual.id ?? null,
    tag: recruit ? form.tag.trim() || null : null,
    taxon: recruit ? form.taxon : null,
    location: recruit ? locationInput(form.loc) : null,
    notes: form.notes.trim() || null,
    heightM: parseNum(form.height),
    traits: Object.fromEntries(Object.entries(form.traits).map(([k, vals]) => [k, Object.fromEntries(Object.entries(vals).map(([id, text]) => [id, parseNum(text)]))])),
    treeCodes: form.treeCodes,
    mainStemNo: numbers.get(form.mainKey) ?? 1,
    stems: form.stems.map((s) => ({
      stemNo: s.stemNo,
      dbhCm: parseNum(s.dbh),
      pomM: parseNum(s.pom) ?? 1.3,
      stemDead: stemDeadOf(form, s),
      codes: codesOf(form, s),
      notes: s.notes.trim() || null,
      ...(form.amsOn ? { ams: amsFromForm(s.ams) } : {}),
      custom: s.custom,
    })),
    recordedBy: opts.recordedBy,
  };
}
