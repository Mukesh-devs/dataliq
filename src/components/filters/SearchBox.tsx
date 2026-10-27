import { Search, X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Kbd } from "../ui/Kbd";

interface SearchBoxProps {
  /** The search applied to the view. */
  value: string;
  onChange: (value: string) => void;
  /** Wait this long after typing stops before searching. */
  debounceMs?: number;
}

/**
 * Searches every text column of the file (case-insensitive). Typing is
 * debounced; Enter searches at once; Escape clears.
 */
export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(function SearchBox(
  { value, onChange, debounceMs = 300 },
  ref,
) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Follow outside changes (e.g. "Clear filters") once the user stops typing.
  useEffect(() => {
    if (timer.current === undefined) setDraft(value);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (next: string) => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (next !== value) onChange(next);
  };
  const type = (next: string) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(next), debounceMs);
  };

  return (
    <label className="relative ml-auto flex h-6 w-64 items-center">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-fg-subtle" aria-hidden />
      <input
        ref={ref}
        type="search"
        aria-label="Search text columns"
        placeholder="Search text columns"
        className="h-6 w-full rounded-[var(--radius)] border border-border bg-bg pr-14 pl-7 text-[12px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent [&::-webkit-search-cancel-button]:hidden"
        value={draft}
        onChange={(e) => type(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Escape" && draft) {
            e.preventDefault();
            setDraft("");
            commit("");
          }
        }}
      />
      {draft ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-1.5 inline-flex size-4 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg"
          onClick={() => {
            setDraft("");
            commit("");
          }}
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : (
        <span className="pointer-events-none absolute right-1.5">
          <Kbd shortcut="Mod+F" />
        </span>
      )}
    </label>
  );
});
