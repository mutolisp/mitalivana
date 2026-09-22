/**
 * Message text for an unknown throw.
 *
 * A function rather than the inline `e instanceof Error ? e.message : String(e)`
 * it replaces, and the reason is not style.
 *
 * React Compiler bails out of an ENTIRE component when a `try`/`catch` block
 * contains a value block — a ternary, `??`, or optional chaining. The message
 * is the one from "Support value blocks within a try/catch". So every `catch`
 * that formatted its own error silently cost that component all of its
 * memoisation, and nothing reported it: types pass, lint passes, the app
 * behaves identically and just re-renders more than it needs to.
 *
 * A plain call is not a value block, so the same code inside `catch (e) { …
 * errText(e) … }` compiles normally.
 *
 * Keep it a function call at the call site. Writing `errText(e) ?? 'x'` inside
 * a catch would reintroduce exactly the bail-out this exists to avoid.
 */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
