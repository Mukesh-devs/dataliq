import { useEffect, useState } from "react";

/** Re-renders every `ms` while `on`; returns the current time. */
export function useTicker(on: boolean, ms = 200): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
