import { create } from "zustand";
import { persist } from "zustand/middleware";

interface OnboardingState {
  /** The getting-started tips on the start screen were closed. */
  tipsHidden: boolean;
  hideTips: () => void;
}

/** First-run tips. Persisted in the webview's local storage. */
export const useOnboarding = create<OnboardingState>()(
  persist(
    (set) => ({
      tipsHidden: false,
      hideTips: () => set({ tipsHidden: true }),
    }),
    { name: "dataliq.onboarding" },
  ),
);
