import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getModel } from "../catalog";
import { browserStorage } from "./browser-storage";

/** The estimate request is one server round trip for all of them, so the list
    stays short enough to read side by side. */
export const MAX_COMPARE = 6;

type CompareState = {
  /** Models priced beside the selected one. The panel shows those on the
      active surface, so one list serves image and video. */
  ids: string[];
  open: boolean;
  add: (id: string) => void;
  remove: (id: string) => void;
  setOpen: (open: boolean) => void;
};

export const useCompare = create<CompareState>()(
  persist(
    (set) => ({
      ids: [],
      open: true,
      add: (id) =>
        set((state) => {
          const model = getModel(id);
          if (state.ids.includes(model.id)) return state;
          const sameSurface = state.ids.filter((other) => getModel(other).surface === model.surface);
          if (sameSurface.length >= MAX_COMPARE) return state;
          return { ids: [...state.ids, model.id] };
        }),
      remove: (id) => set((state) => ({ ids: state.ids.filter((other) => other !== id) })),
      setOpen: (open) => set((state) => (state.open === open ? state : { open })),
    }),
    {
      name: "openhiggsfield.compare.v1",
      storage: browserStorage(),
      partialize: (state) => ({ ids: state.ids, open: state.open }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // A model dropped from the catalog would otherwise throw on every render.
        const known = state.ids.filter((id) => {
          try {
            getModel(id);
            return true;
          } catch {
            return false;
          }
        });
        if (known.length !== state.ids.length) state.ids = known;
      },
    },
  ),
);
