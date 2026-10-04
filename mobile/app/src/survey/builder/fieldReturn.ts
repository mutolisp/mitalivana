/**
 * 「新增欄位」 from a template (2026-10-04): the library's field screen opens
 * on top of the builder, and the field made there is added to the template
 * at the place the builder asked for. Module-level, as the builder screen
 * stays mounted under it.
 */
import { router, type Href } from 'expo-router';
import type { ObsFieldDef } from '~/survey/template/obsField';

export const fieldsHref = '/survey/fields' as Href;
/** A field's screen; without a key, a new field. `returning`: made for the template that opened it. */
export const fieldHref = (key?: string, returning = false) =>
  `/survey/fields/edit${key ? `?key=${encodeURIComponent(key)}` : returning ? '?return=1' : ''}` as Href;

let pending: ((def: ObsFieldDef) => void) | null = null;

/** Open a new field's screen; `onCreated` gets the field once it is saved. */
export function newFieldFor(onCreated: (def: ObsFieldDef) => void): void {
  pending = onCreated;
  router.push(fieldHref(undefined, true));
}

/** The waiting template's callback, once (null when none waits or the screen was left). */
export function takeFieldReturn(): ((def: ObsFieldDef) => void) | null {
  const p = pending;
  pending = null;
  return p;
}
