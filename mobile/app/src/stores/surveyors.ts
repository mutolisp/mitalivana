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

/** The store for a kind, for components that serve both lists. */
export function usePeopleStore(kind: PersonKind) {
  return kind === 'identifier' ? useIdentifiers : useSurveyors;
}
