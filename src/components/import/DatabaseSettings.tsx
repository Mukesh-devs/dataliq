import { formatCount } from "../../lib/format";
import type { DatabaseInfo, DatabaseOptions, DbTable } from "../../lib/files";

interface DatabaseSettingsProps {
  info: DatabaseInfo;
  onChange: (options: DatabaseOptions) => void;
}

const selectClass =
  "h-6 max-w-[11rem] rounded-[var(--radius)] border border-border bg-bg px-1.5 text-[12px] text-fg outline-none focus:border-accent";

const key = (t: { schema: string; name: string }) => `${t.schema}\u0000${t.name}`;

function label(t: DbTable): string {
  const name = t.schema === "main" ? t.name : `${t.schema}.${t.name}`;
  if (t.kind === "view") return `${name} (view)`;
  return t.rows === null ? name : `${name} (${formatCount(t.rows)} rows)`;
}

/** Table picker for SQLite and DuckDB files. */
export function DatabaseSettings({ info, onChange }: DatabaseSettingsProps) {
  return (
    <label
      className="flex items-center gap-1.5 text-[12px] text-fg-muted"
      title={`In SQL: ${info.alias}.${info.schema === "main" ? "" : `${info.schema}.`}${info.table}`}
    >
      Table
      <select
        aria-label="Table"
        className={selectClass}
        value={key({ schema: info.schema, name: info.table })}
        onChange={(e) => {
          const t = info.tables.find((t) => key(t) === e.target.value);
          if (t) onChange({ schema: t.schema, table: t.name });
        }}
      >
        {info.tables.map((t) => (
          <option key={key(t)} value={key(t)}>
            {label(t)}
          </option>
        ))}
      </select>
    </label>
  );
}
