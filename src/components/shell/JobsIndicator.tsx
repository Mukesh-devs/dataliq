import { LoaderCircle } from "lucide-react";
import { useTicker } from "../../lib/useTicker";
import { formatElapsed, useJobs } from "../../stores/jobs";
import { Button } from "../ui/Button";

/**
 * The newest running tool query in the status bar: what it does, how long
 * it has run, and Stop. Others running meanwhile are counted.
 */
export function JobsIndicator() {
  const jobs = useJobs((s) => s.jobs);
  const cancel = useJobs((s) => s.cancel);
  const now = useTicker(jobs.length > 0);
  const job = jobs.at(-1);
  if (!job) return null;
  const others = jobs.length - 1;
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-testid="jobs">
      <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden />
      <span className="tabular truncate" aria-live="off">
        {job.title}… {formatElapsed(Math.max(0, now - job.startedAt))}
        {others > 0 && ` (+${others} more)`}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-1.5"
        aria-label={`Stop: ${job.title}`}
        onClick={() => cancel(job.id)}
      >
        Stop
      </Button>
    </span>
  );
}
