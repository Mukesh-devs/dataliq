import { ChevronLeft, ChevronRight, Lightbulb, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useOnboarding } from "../../stores/onboarding";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";

const TIPS: { title: string; body: ReactNode }[] = [
  {
    title: "Open files of any size",
    body: (
      <>
        Drop a file or a folder here. The first rows show at once, even for gigabytes; the rest is
        read in the background, and opening it again is instant.
      </>
    ),
  },
  {
    title: "Sort, filter and look closer",
    body: (
      <>
        Click a column title to sort, or open its menu to filter it. <Kbd shortcut="Mod+F" />{" "}
        searches every column, and <Kbd shortcut="Mod+Alt+B" /> shows a column&apos;s profile.
      </>
    ),
  },
  {
    title: "Everything is a command",
    body: (
      <>
        <Kbd shortcut="Mod+K" /> finds any action by name, and <Kbd shortcut="Mod+J" /> opens SQL
        over your files, each one a table. Charts, cleaning and exports are in the toolbar.
      </>
    ),
  },
];

/** The tips one at a time, with Back / Next and "Got it" on the last. */
export function TipSteps({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const last = i === TIPS.length - 1;
  return (
    <>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
        <Lightbulb className="size-3.5" aria-hidden /> Tip {i + 1} of {TIPS.length}
      </p>
      <div aria-live="polite" className="flex flex-col gap-1 pr-6">
        <h2 className="font-semibold text-fg">{TIPS[i]!.title}</h2>
        <p className="text-fg-muted">{TIPS[i]!.body}</p>
      </div>
      <div className="flex items-center justify-end gap-2">
        {i > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setI(i - 1)}>
            <ChevronLeft className="size-3.5" aria-hidden /> Back
          </Button>
        )}
        {/* One button that turns into "Got it", so the keyboard focus stays on it. */}
        <Button size="sm" variant="secondary" onClick={last ? onDone : () => setI(i + 1)}>
          {last ? (
            "Got it"
          ) : (
            <>
              Next <ChevronRight className="size-3.5" aria-hidden />
            </>
          )}
        </Button>
      </div>
    </>
  );
}

/** The tips on the start screen, until they're closed (Help › Show tips has them too). */
export function Tips() {
  const hidden = useOnboarding((s) => s.tipsHidden);
  const hide = useOnboarding((s) => s.hideTips);
  if (hidden) return null;
  return (
    <section
      aria-label="Getting started"
      className="relative flex w-full max-w-xl flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3"
    >
      <button
        type="button"
        onClick={hide}
        aria-label="Close the tips"
        className="absolute top-2 right-2 rounded-[var(--radius)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" aria-hidden />
      </button>
      <TipSteps onDone={hide} />
    </section>
  );
}
