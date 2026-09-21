import { create } from 'zustand';
import {
  addPerson,
  listPeople,
  removePerson,
  renamePerson,
  reorderPeople,
  setPersonDefault,
  type PersonKind,
  type Surveyor,
} from '~/db';

type PeopleState = {
  items: Surveyor[];
  loading: boolean;
  refresh: () => void;
  add: (name: string) => void;
  rename: (id: number, name: string) => void;
  remove: (id: number) => void;
  toggleDefault: (id: number, on: boolean) => void;
  /** Apply a drag-reordered list: set items immediately + persist sort_order. */
  reorder: (items: Surveyor[]) => void;
};

/**
 * One store per list. Surveyors (recordedBy) and identifiers (identifiedBy) hold
 * different people and are edited on different screens, so sharing a single
 * store would mean one list's refresh clobbering the other's items.
 */
function createPeopleStore(kind: PersonKind) {
  return create<PeopleState>((set, get) => ({
    items: [],
    loading: false,
    refresh: () => {
      set({ loading: true });
      set({ items: listPeople(kind), loading: false });
    },
    add: (name) => {
      addPerson(kind, name);
      get().refresh();
    },
    rename: (id, name) => {
      renamePerson(kind, id, name);
      get().refresh();
    },
    remove: (id) => {
      removePerson(kind, id);
      get().refresh();
    },
    toggleDefault: (id, on) => {
      setPersonDefault(kind, id, on);
      get().refresh();
    },
    reorder: (items) => {
      set({ items });
      reorderPeople(
        kind,
        items.map((s) => s.id),
      );
    },
  }));
}

export const useSurveyors = createPeopleStore('surveyor');
export const useIdentifiers = createPeopleStore('identifier');

/**
 * The store for a kind, for components that serve both lists.
 *
 * NOT named `use*`, because it is not a hook: it picks a store, it does not
 * subscribe to one. The name matters more than usual here. While it was called
 * `usePeopleStore`, call sites did `const store = usePeopleStore(kind)` and
 * then `store(selector)` — and React Compiler (enabled in app.config.ts) reads
 * `store(...)` as an ordinary function call, so it memoised the result on
 * `store`'s identity:
 *
 *     if ($[0] !== store) { t1 = store(_temp); … } else { t1 = $[1]; }
 *
 * `store` is a module constant, so after the first render the call was skipped
 * entirely, zustand's `useSyncExternalStore` went with it, and the hook count
 * changed between renders — every screen using it crashed on open.
 *
 * Callers subscribe with zustand's `useStore(peopleStore(kind), selector)`,
 * which IS a direct, name-visible hook call.
 */
export function peopleStore(kind: PersonKind) {
  return kind === 'identifier' ? useIdentifiers : useSurveyors;
}
