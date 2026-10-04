/**
 * The extension a photo is written under in an export: its own when it is a
 * photo extension, else jpg (a library asset `ph://…` has none). Pure, so
 * check:survey-export names files with this very rule.
 */
export function guessExt(uri: string): string {
  const m = uri.toLowerCase().match(/\.(jpg|jpeg|png|heic|webp)(?:\?|$)/);
  return m ? m[1] : 'jpg';
}
