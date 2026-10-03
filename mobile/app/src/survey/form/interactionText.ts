/**
 * How an interaction reads on screen (2F; canvas 14a–14c): from the
 * occurrence the screen is on, it is something this one does (→), something
 * done to it (←), or both (↔). Built-in types are named in the app's
 * language, the template's own as the template names them.
 */
import type { TFunction } from 'i18next';
import { labelText } from '~/survey/components/editors/shared';
import { asSeenFrom, type Direction, type InteractionRow, type InteractionType } from '~/survey/db/interactionCore';

export const ARROW: Readonly<Record<Direction, string>> = { forward: '→', backward: '←', mutual: '↔' };

export const typeLabel = (t: TFunction, lang: string, ty: InteractionType | undefined, code: string) => (ty ? labelText(t, lang, ty.label, code) : code);

const verbOf = (t: TFunction, lang: string, ty: InteractionType | undefined, code: string) => (ty ? labelText(t, lang, ty.verb, code) : code);

/** One line on an occurrence's page: the arrow, and what happens with whom. */
export function seenLine(
  t: TFunction,
  lang: string,
  ty: InteractionType | undefined,
  r: Pick<InteractionRow, 'subject_occurrence_id' | 'object_occurrence_id' | 'mutual' | 'type_code'>,
  occurrenceId: number,
  partner: string,
): { direction: Direction; text: string } {
  const { direction } = asSeenFrom(r, occurrenceId);
  const verb = verbOf(t, lang, ty, r.type_code);
  if (direction !== 'backward') return { direction, text: t('survey.interaction.line.forward', { verb, partner }) };
  return ty?.inverse
    ? { direction, text: t('survey.interaction.line.backward', { inverse: labelText(t, lang, ty.inverse, verb), partner }) }
    : { direction, text: t('survey.interaction.line.byPartner', { verb, partner }) };
}

/** The whole event in one sentence, as it will be stored (the add screen's summary). */
export function sentence(t: TFunction, lang: string, ty: InteractionType | undefined, code: string, direction: Direction, a: string, b: string): string {
  const verb = verbOf(t, lang, ty, code);
  return t(`survey.interaction.sentence.${direction}`, { a, b, verb });
}
