import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useConnect } from "../../stores/connect";
import { useSql } from "../../stores/sql";
import { ConnectDialog } from "./ConnectDialog";

type Args = Record<string, unknown>;

function backend(fail?: string) {
  const calls: { cmd: string; args: Args }[] = [];
  mockIPC((cmd, a) => {
    const args = (a ?? {}) as Args;
    calls.push({ cmd, args });
    if (cmd === "list_connections") return [];
    if (cmd === "connect_database") {
      if (fail) throw { kind: "query", message: fail };
      return {
        name: (args.request as { connection: { name: string } }).connection.name,
        tables: [
          { schema: "cdr_prod", name: "calls", kind: "BASE TABLE" },
          { schema: "cdr_prod", name: "totals", kind: "VIEW" },
        ],
      };
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return calls;
}

async function fill() {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("Database type"), "postgres");
  expect(screen.getByLabelText("Port")).toHaveValue("5432");
  await user.clear(screen.getByLabelText("Server"));
  await user.type(screen.getByLabelText("Server"), "db.dsnl");
  await user.type(screen.getByLabelText("Database"), "CDR Prod");
  await user.type(screen.getByLabelText("User"), "report");
  await user.type(screen.getByLabelText("Password"), "s3cret");
  return user;
}

describe("ConnectDialog", () => {
  afterEach(() => {
    clearMocks();
    act(() => useConnect.getState().close());
  });

  it("connects with a name made from the database and lists its tables", async () => {
    const calls = backend();
    render(<ConnectDialog />);
    act(() => useConnect.getState().show());
    await screen.findByRole("dialog", { name: "Connect to a database" });
    const user = await fill();
    expect(screen.getByLabelText(/Name in SQL/)).toHaveValue("cdr_prod");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const tables = await screen.findByRole("list", { name: "Tables" });
    expect(tables).toHaveTextContent("calls");
    expect(tables).toHaveTextContent("totalsview");
    expect(calls.find((c) => c.cmd === "connect_database")!.args.request).toEqual({
      connection: {
        name: "cdr_prod",
        driver: "postgres",
        host: "db.dsnl",
        port: 5432,
        database: "CDR Prod",
        user: "report",
      },
      password: "s3cret",
      remember: true,
    });
    // "SQL" puts a query over the table in the SQL panel.
    const load = useSql.getState().load;
    let loaded = "";
    useSql.setState({ load: (t: string) => void (loaded = t) });
    await user.click(screen.getAllByRole("button", { name: "SQL" })[0]!);
    expect(loaded).toBe('SELECT * FROM "cdr_prod"."cdr_prod"."calls"\nLIMIT 100;');
    useSql.setState({ load });
  });

  it("says why a connection failed", async () => {
    backend("Couldn't connect to PostgreSQL at db.dsnl:5432: password authentication failed");
    render(<ConnectDialog />);
    act(() => useConnect.getState().show());
    await screen.findByRole("dialog", { name: "Connect to a database" });
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("password authentication failed");
  });
});
