/**
 * Prompts for observation notes (design 18l, ObservationNotes): what to look
 * at and write down, by kind of organism. Shown to volunteers and casual
 * users, never in pro mode (user, 2026-10-05; `observationNotes` in
 * usageMode.ts).
 *
 * Each tip is a question to read and a sentence start that a tap puts into the
 * note (「葉子：」), so the note stays the user's own words. `shot` is the
 * one picture or recording that most helps a later identification.
 *
 * Pure, and the keys are literals: scripts/check-modes.mjs imports this file
 * and checks every key exists in every locale, which `npm run check:i18n`
 * cannot do for keys read out of a table.
 */

export type TipGroup = 'plant' | 'bird' | 'insect' | 'animal' | 'fungi' | 'other';

export type TipSet = {
  /** The group's name in 「依『植物』提示」. */
  name: string;
  placeholder: string;
  tips: { label: string; starter: string }[];
  /** What to photograph or record. A photo tip has a button that opens the
   *  camera; a recording tip has none (the screen's recorder is right there). */
  shot: { text: string; button?: string };
};

export function tipGroupOf(kingdom: string | null | undefined, className: string | null | undefined): TipGroup {
  if (kingdom === 'Plantae') return 'plant';
  if (kingdom === 'Animalia') {
    if (className === 'Aves') return 'bird';
    if (className === 'Insecta') return 'insect';
    return 'animal';
  }
  if (kingdom === 'Fungi') return 'fungi';
  return 'other';
}

const tips = (group: TipGroup, names: string[]) =>
  names.map((n) => ({ label: `obsTips.${group}.${n}`, starter: `obsTips.${group}.${n}Start` }));

export const TIP_SETS: Record<TipGroup, TipSet> = {
  plant: {
    name: 'obsTips.plant.name',
    placeholder: 'obsTips.plant.placeholder',
    tips: tips('plant', ['leaf', 'habitat', 'height', 'smell']),
    shot: { text: 'obsTips.plant.shot', button: 'obsTips.plant.shotButton' },
  },
  bird: {
    name: 'obsTips.bird.name',
    placeholder: 'obsTips.bird.placeholder',
    tips: tips('bird', ['behaviour', 'flock', 'call', 'perch']),
    shot: { text: 'obsTips.bird.shot' },
  },
  insect: {
    name: 'obsTips.insect.name',
    placeholder: 'obsTips.insect.placeholder',
    tips: tips('insect', ['host', 'behaviour', 'size', 'count']),
    shot: { text: 'obsTips.insect.shot', button: 'obsTips.insect.shotButton' },
  },
  animal: {
    name: 'obsTips.animal.name',
    placeholder: 'obsTips.animal.placeholder',
    tips: tips('animal', ['behaviour', 'size', 'where', 'signs']),
    shot: { text: 'obsTips.animal.shot', button: 'obsTips.animal.shotButton' },
  },
  fungi: {
    name: 'obsTips.fungi.name',
    placeholder: 'obsTips.fungi.placeholder',
    tips: tips('fungi', ['substrate', 'underside', 'look', 'count']),
    shot: { text: 'obsTips.fungi.shot', button: 'obsTips.fungi.shotButton' },
  },
  other: {
    name: 'obsTips.other.name',
    placeholder: 'obsTips.other.placeholder',
    tips: tips('other', ['substrate', 'look', 'count']),
    shot: { text: 'obsTips.other.shot', button: 'obsTips.other.shotButton' },
  },
};

/** Every key the table reads, for the locale check. */
export function allTipKeys(): string[] {
  return Object.values(TIP_SETS).flatMap((s) => [
    s.name,
    s.placeholder,
    s.shot.text,
    ...(s.shot.button ? [s.shot.button] : []),
    ...s.tips.flatMap((x) => [x.label, x.starter]),
  ]);
}

/** The note with a tip's sentence start added on a line of its own. */
export function appendStarter(note: string, starter: string): string {
  const head = note.replace(/\s+$/, '');
  return head ? `${head}\n${starter}` : starter;
}
