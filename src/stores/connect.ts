import { create } from "zustand";

/** Whether the "Connect to a database" dialog is open. */
interface ConnectState {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useConnect = create<ConnectState>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
