import * as Popover from "@radix-ui/react-popover";
import { cloneElement, useEffect, useState, type ReactElement } from "react";
import {
  clearS3Settings,
  getS3Settings,
  isUrl,
  saveS3Settings,
  type S3Settings,
  type S3Summary,
} from "../../lib/remote";
import { Button } from "../ui/Button";

interface OpenUrlProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens an `https://…` or `s3://…` file. */
  onOpen: (url: string) => void;
  /** Start with the S3 settings shown. */
  showS3?: boolean;
}

const inputClass =
  "h-7 w-full min-w-0 rounded-[var(--radius)] border border-border bg-bg px-2 font-mono text-[12px] text-fg outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = `s3-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
      <label htmlFor={id} className="text-fg-muted">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** S3-compatible storage credentials, kept in the OS keychain. */
function S3Form() {
  const [stored, setStored] = useState<S3Summary | null | undefined>(undefined);
  const [draft, setDraft] = useState<S3Settings>({ keyId: "", secret: "" });
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getS3Settings()
      .then((s) => {
        if (!live) return;
        setStored(s);
        if (s) setDraft({ ...s, secret: "" });
      })
      .catch((e: unknown) => live && setStatus(messageOf(e)));
    return () => {
      live = false;
    };
  }, []);
  const update = (changes: Partial<S3Settings>) => setDraft((d) => ({ ...d, ...changes }));
  const canSave = draft.keyId.trim() !== "" && (draft.secret !== "" || Boolean(stored));

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
      <p className="text-[12px] text-fg-subtle">
        For private <code className="font-mono">s3://</code> files: AWS S3, or a compatible service
        such as MinIO or R2. Stored in your system's keychain, never in a file.
      </p>
      <Field label="Access key ID">
        <input
          className={inputClass}
          autoComplete="off"
          value={draft.keyId}
          onChange={(e) => update({ keyId: e.target.value })}
        />
      </Field>
      <Field label="Secret key">
        <input
          type="password"
          className={inputClass}
          autoComplete="off"
          placeholder={stored ? "Stored (leave empty to keep)" : ""}
          value={draft.secret}
          onChange={(e) => update({ secret: e.target.value })}
        />
      </Field>
      <Field label="Region">
        <input
          className={inputClass}
          placeholder="us-east-1"
          value={draft.region ?? ""}
          onChange={(e) => update({ region: e.target.value || null })}
        />
      </Field>
      <Field label="Endpoint">
        <input
          className={inputClass}
          placeholder="AWS (or minio.local:9000)"
          value={draft.endpoint ?? ""}
          onChange={(e) => update({ endpoint: e.target.value || null })}
        />
      </Field>
      <Field label="URL style">
        <select
          className={inputClass}
          value={draft.urlStyle ?? ""}
          onChange={(e) => update({ urlStyle: e.target.value || null })}
        >
          <option value="">Default (virtual host)</option>
          <option value="path">Path (most self-hosted services)</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-fg-muted">
        <input
          type="checkbox"
          checked={draft.useSsl !== false}
          onChange={(e) => update({ useSsl: e.target.checked ? null : false })}
        />
        Use HTTPS to the endpoint
      </label>
      <div className="flex items-center justify-end gap-2">
        {status && (
          <span role="status" className="mr-auto min-w-0 text-[12px] text-fg-muted">
            {status}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!stored}
          onClick={() =>
            void clearS3Settings().then(
              () => {
                setStored(null);
                setDraft({ keyId: "", secret: "" });
                setStatus("S3 settings removed.");
              },
              (e: unknown) => setStatus(messageOf(e)),
            )
          }
        >
          Remove
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canSave}
          onClick={() =>
            void saveS3Settings({ ...draft, keyId: draft.keyId.trim() }).then(
              () => {
                setStored({
                  keyId: draft.keyId.trim(),
                  region: draft.region,
                  endpoint: draft.endpoint,
                  urlStyle: draft.urlStyle,
                  useSsl: draft.useSsl,
                });
                setDraft((d) => ({ ...d, secret: "" }));
                setStatus("S3 settings saved.");
              },
              (e: unknown) => setStatus(messageOf(e)),
            )
          }
        >
          Save S3 settings
        </Button>
      </div>
    </div>
  );
}

/** "Open URL": a file on the web or in S3, read in place by DuckDB's httpfs. */
export function OpenUrl({ open, onOpenChange, onOpen, showS3 = false }: OpenUrlProps) {
  const [text, setText] = useState("");
  const [s3, setS3] = useState(showS3);
  const url = text.trim();
  const valid = isUrl(url);
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Open URL"
          sideOffset={4}
          className="z-50 w-[30rem] rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              onOpen(url);
              onOpenChange(false);
            }}
          >
            <label htmlFor="open-url" className="font-medium text-fg">
              Open a file from the web or S3
            </label>
            <input
              id="open-url"
              autoFocus
              className={inputClass}
              placeholder="https://example.com/data.parquet or s3://bucket/data.csv.gz"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="text-[12px] text-fg-subtle">
              CSV, TSV, JSON and Parquet, gzipped or not; Parquet is read in place, a page at a
              time. The first URL downloads DuckDB's httpfs extension (once), so it needs the
              internet. Files from a URL aren't cached.
            </p>
            {url && !valid && (
              <p role="alert" className="text-[12px] text-danger">
                Start with https://, http:// or s3://.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="mr-auto"
                aria-expanded={s3}
                onClick={() => setS3((v) => !v)}
              >
                {s3 ? "Hide S3 settings" : "S3 settings…"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="primary" disabled={!valid}>
                Open URL
              </Button>
            </div>
          </form>
          {s3 && <S3Form />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
