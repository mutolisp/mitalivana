/**
 * A plot-style survey's units as the screens show them: a tree in walking
 * order (each unit followed by its sub-units), with the path of codes that
 * names a unit in a list ("A / A1").
 *
 * A unit whose parent is gone (deleted, SET NULL) or sits on a level the
 * template no longer has is shown at the top. Levels come from the template
 * snapshot, top first.
 *
 * Pure: check:survey-core runs it under Node.
 */

export type UnitLike = { id: number; parent_id: number | null; level_key: string; code: string; sort: number };

export type UnitRowOf<U> = { unit: U; depth: number; path: string };

const byOrder = <U extends UnitLike>(a: U, b: U) => a.sort - b.sort || a.code.localeCompare(b.code, undefined, { numeric: true });

/** Units depth-first: roots in level then code order, each followed by its sub-units. */
export function unitRows<U extends UnitLike>(levelKeys: readonly string[], units: readonly U[]): UnitRowOf<U>[] {
  const ids = new Set(units.map((u) => u.id));
  const level = (u: U) => {
    const i = levelKeys.indexOf(u.level_key);
    return i < 0 ? levelKeys.length : i;
  };
  const children = new Map<number, U[]>();
  const roots: U[] = [];
  for (const u of units) {
    if (u.parent_id != null && ids.has(u.parent_id) && u.parent_id !== u.id) {
      const list = children.get(u.parent_id) ?? [];
      list.push(u);
      children.set(u.parent_id, list);
    } else roots.push(u);
  }
  const out: UnitRowOf<U>[] = [];
  const seen = new Set<number>();
  const walk = (u: U, depth: number, prefix: string) => {
    // A parent cycle cannot come from the core (parents sit on a higher level); guard anyway.
    if (seen.has(u.id)) return;
    seen.add(u.id);
    const path = prefix ? `${prefix} / ${u.code}` : u.code;
    out.push({ unit: u, depth, path });
    for (const c of [...(children.get(u.id) ?? [])].sort(byOrder)) walk(c, depth + 1, path);
  };
  for (const r of [...roots].sort((a, b) => level(a) - level(b) || byOrder(a, b))) walk(r, 0, '');
  return out;
}

/** The unit's path of codes from the top ("A / A1"), or '' for none. */
export function unitPath<U extends UnitLike>(units: readonly U[], id: number | null): string {
  const byId = new Map(units.map((u) => [u.id, u]));
  const parts: string[] = [];
  const seen = new Set<number>();
  let u = id == null ? undefined : byId.get(id);
  while (u && !seen.has(u.id)) {
    seen.add(u.id);
    parts.unshift(u.code);
    u = u.parent_id == null ? undefined : byId.get(u.parent_id);
  }
  return parts.join(' / ');
}

/** The level a new sub-unit of `parent` goes on (the next one down), or null at the bottom. */
export function childLevel(levelKeys: readonly string[], parentLevel: string): string | null {
  const i = levelKeys.indexOf(parentLevel);
  return i >= 0 && i + 1 < levelKeys.length ? levelKeys[i + 1] : null;
}

/** A unit and every unit below it (the unit first): what deleting a quadrat takes. */
export function unitSubtree<U extends { id: number; parent_id: number | null }>(units: readonly U[], id: number): number[] {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const u of units) if (u.parent_id === ids[i]) ids.push(u.id);
  return ids;
}
