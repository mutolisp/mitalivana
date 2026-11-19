/**
 * Stand-in for `@op-engineering/op-sqlite`, for reused modules that open a
 * database themselves (regionpacks.ts) or import its types.
 *
 * `open({ name, location })` returns a synchronous in-memory database. When a
 * snapshot for that name has been registered (persist.ts / datasetsHost.ts),
 * it is opened from those bytes; writes call the registered dirty hook.
 */
import { openMemoryDbSync, type BindValue, type QueryResult, type SyncDb } from './sqlite';

export type DB = SyncDb;
export type Scalar = BindValue;
export type { QueryResult };

type Source = { bytes: () => Uint8Array | null; onWrite?: () => void };
const sources = new Map<string, Source>();

/** Register where `open({ name })` gets its bytes and whom it tells about writes. */
export function registerDbSource(name: string, src: Source): void {
  sources.set(name, src);
}

export function open(params: { name: string; location?: string }): DB {
  const src = sources.get(params.name);
  return openMemoryDbSync(src?.bytes() ?? null, src?.onWrite);
}
