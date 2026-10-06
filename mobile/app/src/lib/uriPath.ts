/**
 * A file:// URI as a plain filesystem path, for the APIs that take one:
 * op-sqlite's `open({ location })` (it strips the scheme itself but warns on
 * every call, and does not decode) and SQLite's `VACUUM INTO`. Anything that
 * is not a file:// URI passes through unchanged.
 *
 * Pure: datasets.ts keeps its Node test seam free of Expo imports.
 */
export function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
}
