import * as Popover from "@radix-ui/react-popover";
import { CircleAlert, Database, LoaderCircle, Plug, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DRIVERS,
  connectDatabase,
  connectionName,
  disconnectDatabase,
  forgetConnection,
  listConnections,
  openTableSql,
  type Connected,
  type DbConnection,
  type Driver,
  type SavedConnection,
} from "../../lib/connect";
import { useConnect } from "../../stores/connect";
import { useNotice } from "../../stores/notice";
import { useSql } from "../../stores/sql";
import { Button } from "../ui/Button";
import { openQueryTab } from "./run";
import { fieldClass, labelClass } from "./ToolDialog";

/** Rows a table opens with at most, unless "All rows" is picked. */
const OPEN_LIMIT = 100_000;

/** "Connect to a database…": MySQL or PostgreSQL, read-only. */
export function ConnectDialog() {
  const open = useConnect((s) => s.open);
  const close = useConnect((s) => s.close);
  return (
    <Popover.Root open={open} onOpenChange={(o) => !o && close()}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Connect to a database"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 flex max-h-[85vh] w-[30rem] max-w-[92vw] flex-col gap-3 overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {open && <ConnectForm onClose={close} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const EMPTY: DbConnection = {
  name: "",
  driver: "mysql",
  host: "localhost",
  port: 3306,
  database: "",
  user: "",
};

function ConnectForm({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  const [form, setForm] = useState<DbConnection>(EMPTY);
  const [nameTouched, setNameTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState<Connected | null>(null);

  const refresh = () => listConnections().then(setSaved, () => setSaved([]));
  useEffect(() => {
    void refresh();
  }, []);

  const name = nameTouched ? form.name : connectionName(form.database);
  const set = (changes: Partial<DbConnection>) => setForm({ ...form, ...changes });

  const connect = async (c: DbConnection, pw: string | undefined, keep: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setConnected(await connectDatabase(c, pw, keep));
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return <TablesView connected={connected} onBack={() => setConnected(null)} onClose={onClose} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-fg">Connect to a database</h2>
      {saved.length > 0 && (
        <section aria-label="Saved connections" className="flex flex-col gap-1">
          <span className={labelClass}>Saved</span>
          {saved.map((c) => (
            <div key={c.name} className="flex items-center gap-2 text-fg">
              <Database className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span
                className="min-w-0 flex-1 truncate"
                title={`${c.user}@${c.host}:${c.port}/${c.database}`}
              >
                <span className="font-medium">{c.name}</span>{" "}
                <span className="text-fg-subtle">
                  {c.user}@{c.host}/{c.database}
                </span>
              </span>
              {c.connected && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void disconnectDatabase(c.name).then(refresh, (e: unknown) =>
                      setError(e instanceof Error ? e.message : String(e)),
                    )
                  }
                >
                  <Unplug className="size-3" aria-hidden /> Disconnect
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (c.hasPassword) void connect(c, undefined, false);
                  else {
                    setForm(c);
                    setNameTouched(true);
                    setError("Type the password to connect.");
                  }
                }}
              >
                <Plug className="size-3" aria-hidden /> {c.connected ? "Tables" : "Connect"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void forgetConnection(c.name).then(refresh)}
              >
                Forget
              </Button>
            </div>
          ))}
        </section>
      )}
      <form
        className="grid grid-cols-[1fr_6rem] gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void connect({ ...form, name }, password, remember);
        }}
      >
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Database type</span>
          <select
            className={fieldClass}
            value={form.driver}
            onChange={(e) => {
              const driver = e.target.value as Driver;
              const port = DRIVERS.find((d) => d.driver === driver)!.port;
              set({ driver, port });
            }}
          >
            {DRIVERS.map((d) => (
              <option key={d.driver} value={d.driver}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <span />
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Server</span>
          <input
            className={fieldClass}
            value={form.host}
            autoComplete="off"
            onChange={(e) => set({ host: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Port</span>
          <input
            className={fieldClass}
            inputMode="numeric"
            value={form.port}
            onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className={labelClass}>Database</span>
          <input
            className={fieldClass}
            value={form.database}
            autoComplete="off"
            onChange={(e) => set({ database: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>User</span>
          <input
            className={fieldClass}
            value={form.user}
            autoComplete="username"
            onChange={(e) => set({ user: e.target.value })}
          />
        </label>
        <span />
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Password</span>
          <input
            className={fieldClass}
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <span />
        <label className="col-span-2 flex flex-col gap-1">
          <span className={labelClass}>Name in SQL (its tables are name.table)</span>
          <input
            className={`${fieldClass} font-mono`}
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              set({ name: e.target.value });
            }}
          />
        </label>
        <label className="col-span-2 flex items-center gap-1.5 text-fg">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Save this connection (the password goes to the system keychain)
        </label>
        <p className="col-span-2 text-fg-subtle">
          Read-only: nothing is ever written to the database. The first connection downloads
          DuckDB’s {form.driver === "mysql" ? "mysql" : "postgres"} extension.
        </p>
        {error && (
          <p role="alert" className="col-span-2 flex gap-1.5 text-fg-muted">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
        <div className="col-span-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy || !form.host.trim() || !form.user.trim() || !name || !form.port}
          >
            {busy && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
            Connect
          </Button>
        </div>
      </form>
    </div>
  );
}

/** A connected database's tables: open one as a tab or query it in SQL. */
function TablesView({
  connected,
  onBack,
  onClose,
}: {
  connected: Connected;
  onBack: () => void;
  onClose: () => void;
}) {
  const notice = useNotice((s) => s.show);
  const loadSql = useSql((s) => s.load);
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const q = filter.trim().toLowerCase();
  const tables = connected.tables.filter(
    (t) => !q || `${t.schema}.${t.name}`.toLowerCase().includes(q),
  );
  const schemas = new Set(connected.tables.map((t) => t.schema));
  const label = (t: { schema: string; name: string }) =>
    schemas.size > 1 ? `${t.schema}.${t.name}` : t.name;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold text-fg">
        Connected as <span className="font-mono">{connected.name}</span>
      </h2>
      <p className="text-fg-muted">
        Query it in the SQL panel, e.g.{" "}
        <code className="font-mono">
          SELECT * FROM {connected.name}.{tables[0]?.name ?? "my_table"} LIMIT 10
        </code>
        , or open a table as a tab.
      </p>
      <input
        aria-label="Find tables"
        placeholder="Find tables"
        className={fieldClass}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul aria-label="Tables" className="flex max-h-64 flex-col overflow-y-auto">
        {tables.length === 0 && <li className="text-fg-subtle">No tables.</li>}
        {tables.map((t) => {
          const key = `${t.schema}.${t.name}`;
          return (
            <li
              key={key}
              className="flex items-center gap-2 rounded-[var(--radius)] px-1 hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-fg" title={key}>
                {label(t)}
                {t.kind === "VIEW" && <span className="ml-1 text-fg-subtle">view</span>}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  loadSql(`${openTableSql(connected.name, t, 100)};`);
                  onClose();
                }}
              >
                SQL
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={opening !== null}
                onClick={() => {
                  setOpening(key);
                  void openQueryTab(
                    openTableSql(connected.name, t, all ? undefined : OPEN_LIMIT),
                    `${connected.name}.${label(t)}`,
                  ).then(
                    () => onClose(),
                    (e: unknown) => {
                      setOpening(null);
                      notice(`Couldn't open ${key}: ${e instanceof Error ? e.message : String(e)}`);
                    },
                  );
                }}
              >
                {opening === key && <LoaderCircle className="size-3 animate-spin" aria-hidden />}
                Open
              </Button>
            </li>
          );
        })}
      </ul>
      <label className="flex items-center gap-1.5 text-fg">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        Open every row (otherwise the first {OPEN_LIMIT.toLocaleString("en-US")})
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
