import { Plus, X } from "lucide-react";
import { useState } from "react";
import { suggestKeys } from "../../lib/compare";
import { JOIN_KINDS, type JoinKind } from "../../lib/tools";
import type { CompareSide } from "../compare/CompareDialog";
import { Button, IconButton } from "../ui/Button";
import { ToolDialog, ViewToggle, fieldClass, labelClass } from "./ToolDialog";

export interface JoinRequest {
  rightTabId: string;
  kind: JoinKind;
  keys: { left: string; right: string }[];
  withView: boolean;
}

interface JoinDialogProps {
  current: CompareSide;
  others: CompareSide[];
  hasView: boolean;
  onClose: () => void;
  onRun: (request: JoinRequest) => Promise<void>;
}

/** Key pairs to start with: columns of the same name (likely ids). */
function startKeys(left: CompareSide, right: CompareSide | undefined) {
  if (!right) return [];
  const same = suggestKeys(left.columns, right.columns);
  if (same.length > 0) return same.map((k) => ({ left: k, right: k }));
  return [{ left: left.columns[0]?.name ?? "", right: right.columns[0]?.name ?? "" }];
}

/** Joins this tab (left) with another (right) on key columns. */
export function JoinDialog({ current, others, hasView, onClose, onRun }: JoinDialogProps) {
  const [rightId, setRightId] = useState(others[0]?.tabId ?? "");
  const right = others.find((o) => o.tabId === rightId);
  const [kind, setKind] = useState<JoinKind>("left");
  const [keys, setKeys] = useState(() => startKeys(current, right));
  const [withView, setWithView] = useState(hasView);
  const pickRight = (id: string) => {
    setRightId(id);
    setKeys(
      startKeys(
        current,
        others.find((o) => o.tabId === id),
      ),
    );
  };
  const setKey = (i: number, k: { left: string; right: string }) =>
    setKeys(keys.map((x, j) => (j === i ? k : x)));
  return (
    <ToolDialog
      title="Join with another tab"
      runLabel="Join"
      width="w-[28rem]"
      onClose={onClose}
      blocked={
        !right
          ? "Open another file first"
          : keys.length === 0 || keys.some((k) => !k.left || !k.right)
            ? "Pick the key columns"
            : undefined
      }
      onRun={() => onRun({ rightTabId: rightId, kind, keys, withView })}
    >
      {others.length === 0 ? (
        <p className="text-fg-muted">Open the other file in a tab first (once its data is read).</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className={labelClass}>Left</span>
              <span className="truncate py-1 text-fg" title={current.title}>
                {current.title}
              </span>
            </div>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={labelClass}>Right</span>
              <select
                className={fieldClass}
                value={rightId}
                onChange={(e) => pickRight(e.target.value)}
              >
                {others.map((o) => (
                  <option key={o.tabId} value={o.tabId}>
                    {o.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className={`mb-1 ${labelClass}`}>Keep</legend>
            {JOIN_KINDS.map((k) => (
              <label key={k.kind} className="flex items-start gap-1.5 text-fg">
                <input
                  type="radio"
                  name="join-kind"
                  className="mt-0.5"
                  checked={kind === k.kind}
                  onChange={() => setKind(k.kind)}
                />
                <span>
                  {k.label} <span className="text-fg-subtle">— {k.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className={`mb-1 ${labelClass}`}>Match rows where</legend>
            {keys.map((k, i) => (
              <div key={i} className="flex items-center gap-1">
                <select
                  aria-label={`Key ${i + 1}: left column`}
                  className={fieldClass}
                  value={k.left}
                  onChange={(e) => setKey(i, { ...k, left: e.target.value })}
                >
                  {current.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span className="text-fg-subtle">=</span>
                <select
                  aria-label={`Key ${i + 1}: right column`}
                  className={fieldClass}
                  value={k.right}
                  onChange={(e) => setKey(i, { ...k, right: e.target.value })}
                >
                  {right?.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <IconButton
                  label={`Remove key ${i + 1}`}
                  className="size-6 shrink-0"
                  onClick={() => setKeys(keys.filter((_, j) => j !== i))}
                >
                  <X className="size-3.5" aria-hidden />
                </IconButton>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() =>
                setKeys([
                  ...keys,
                  { left: current.columns[0]?.name ?? "", right: right?.columns[0]?.name ?? "" },
                ])
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add a key
            </Button>
          </fieldset>
          {hasView && <ViewToggle value={withView} onChange={setWithView} />}
        </>
      )}
    </ToolDialog>
  );
}
