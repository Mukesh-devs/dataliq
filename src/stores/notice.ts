import { create } from "zustand";

/** How long a notice stays in the status bar. */
export const NOTICE_MS = 4000;

interface NoticeState {
  /** A short message replacing the status bar text for a few seconds. */
  text: string | null;
  show: (text: string) => void;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useNotice = create<NoticeState>()((set) => ({
  text: null,
  show: (text) => {
    clearTimeout(timer);
    set({ text });
    timer = setTimeout(() => set({ text: null }), NOTICE_MS);
  },
  clear: () => {
    clearTimeout(timer);
    set({ text: null });
  },
}));
