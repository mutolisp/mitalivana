/**
 * State and imperative API of the 建立新記錄 sheet (src/components/
 * CreateRecordSheet.tsx, whose host is mounted in app/_layout.tsx).
 *
 * Kept apart from the component so src/lib/recordCreate.ts can open the sheet
 * (the plot-type page) without importing the component that imports it.
 */
import { create } from 'zustand';

/** 'survey': the survey framework's forms, side by side (每木調查, and the test templates). */
export type CreateSheetPage = 'main' | 'plot' | 'survey';

type SheetState = {
  /** Non-null while open; resolves the pending showCreateSheet(). */
  resolve: (() => void) | null;
  page: CreateSheetPage;
  open: (page: CreateSheetPage, resolve: () => void) => void;
  setPage: (page: CreateSheetPage) => void;
  close: () => void;
};

export const useCreateSheet = create<SheetState>((set, get) => ({
  resolve: null,
  page: 'main',
  open: (page, resolve) => set({ page, resolve }),
  setPage: (page) => set({ page }),
  close: () => {
    get().resolve?.();
    set({ resolve: null });
  },
}));

/**
 * Opens the sheet — on the plot-type page when `page: 'plot'` (the ＋ button
 * with 樣區 as its default). Resolves once the sheet has closed, with or
 * without a choice.
 */
export function showCreateSheet(opts: { page?: CreateSheetPage } = {}): Promise<void> {
  return new Promise<void>((resolve) => useCreateSheet.getState().open(opts.page ?? 'main', resolve));
}
