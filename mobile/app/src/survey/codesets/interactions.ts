/**
 * The built-in interaction types (Phase 2F; docs/planned/Modular_survey.md
 * §5.6, canvas 11c): what an Interaction component offers besides the
 * template's own types. Their names are the app's (i18n
 * `survey.interaction.type.<code>`), so they follow the language of the app
 * (decided 2026-10-03), as the ForestGEO codes do.
 *
 * Relations of the OBO Relation Ontology, checked against the official
 * ro.obo (data-version releases/2026-09-04): id and name of each. ro.obo
 * declares `inverse_of` for visits flowers of (RO:0002623 has flowers
 * visited by) and parasite of (RO:0002445 parasitized by), not for eats; it
 * marks none of them symmetric. `en` is the relation's name, which the
 * export writes (relationshipOfResource).
 *
 * - feeding is eats: RO asks only that A takes B in through its mouth or
 *   another opening; preys on (RO:0002439, killing first) would be a type of
 *   its own.
 * - commensalism: RO says one side benefits and the other is unaffected; the
 *   app takes A as the one that benefits.
 *
 * Pure: check:survey-core and check:templates run it under Node.
 */
export type BuiltinInteraction = { code: string; mutual: boolean; iri: string; en: string };

const RO = 'http://purl.obolibrary.org/obo/';

export const BUILTIN_INTERACTIONS: readonly BuiltinInteraction[] = [
  { code: 'feeding', mutual: false, iri: `${RO}RO_0002470`, en: 'eats' },
  { code: 'flower_visit', mutual: false, iri: `${RO}RO_0002622`, en: 'visits flowers of' },
  { code: 'parasitism', mutual: false, iri: `${RO}RO_0002444`, en: 'parasite of' },
  { code: 'mutualism', mutual: true, iri: `${RO}RO_0002442`, en: 'mutualistically interacts with' },
  { code: 'commensalism', mutual: false, iri: `${RO}RO_0002441`, en: 'commensually interacts with' },
];

export const BUILTIN_INTERACTION_CODES = BUILTIN_INTERACTIONS.map((x) => x.code);

/** An IRI a template may give its own type: an http(s) address without spaces. */
export const INTERACTION_IRI = /^https?:\/\/\S+$/;
