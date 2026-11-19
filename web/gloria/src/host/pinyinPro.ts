/**
 * Web stand-in for `pinyin-pro` (≈550 KB). fuzzy.ts only converts to pinyin
 * for the voice-input phonetic fallback (`phonetic: true`), which the GLORIA
 * web app never asks for; its caller catches the throw and skips the
 * phonetic pass.
 */
export function pinyin(_text: string, _opts?: unknown): never {
  throw new Error('pinyin is not available in the GLORIA web app');
}
