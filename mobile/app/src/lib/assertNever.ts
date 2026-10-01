/**
 * Ends an exhaustive `switch` over a union: adding a member to the union makes
 * every switch that forgot it a type error, instead of falling into a default
 * branch that quietly treats the new kind as an old one
 * (docs/planned/Modular_survey.md §7.3).
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unhandled ${what}: ${String(value)}`);
}
