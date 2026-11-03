import { create } from "zustand";

/** Whether the "Convert files" dialog is open (an app-level tool). */
interface ConvertState {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useConvert = create<ConvertState>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
