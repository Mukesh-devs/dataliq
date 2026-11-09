import { describe, expect, it } from "vitest";
import {
  arrowJson,
  buildRecordGraph,
  buildShapeGraph,
  childPath,
  collapsedBelow,
  firstArray,
  freeName,
  graphSvg,
  layoutGraph,
  nestedTarget,
  parsePath,
  recordValue,
  search,
  sqlPath,
  type GraphColors,
  type JsonShape,
  type JsonValue,
} from "./jsonGraph";

const order: JsonValue = {
  id: 7,
  "ship to": { city: "Berlin", zip: "10115" },
  paid: true,
  note: null,
  items: [
    { sku: "a", qty: 2 },
    { sku: "b", qty: 1, opts: [] },
  ],
  tags: ["x", "y"],
};

describe("record graph", () => {
  it("lists plain values on a card and branches nested objects and arrays", () => {
    const { root, nodes, truncated } = buildRecordGraph(order, "Record 1");
    expect(root.title).toBe("Record 1");
    expect(root.subtitle).toBe("6 keys");
    expect(root.lines.map((l) => `${l.key}: ${l.text}`)).toEqual([
      "id: 7",
      "paid: true",
      "note: null",
    ]);
    expect(root.children.map((c) => c.id)).toEqual(['$["ship to"]', "$.items", "$.tags"]);
    const items = root.children[1]!;
    expect(items.subtitle).toBe("2 items");
    expect(items.children[1]!.lines).toContainEqual({
      key: "opts",
      text: "[]",
      kind: "empty",
      path: "$.items[1].opts",
    });
    // An array of plain values is one card of lines.
    expect(root.children[2]!.lines.map((l) => l.text)).toEqual(['"x"', '"y"']);
    expect(nodes).toBe(6);
    expect(truncated).toBe(false);
  });

  it("pages long arrays with a more card, and grows them", () => {
    const long = { rows: Array.from({ length: 120 }, (_, i) => ({ i })) };
    let g = buildRecordGraph(long, "$", { pageSize: 50, shown: {}, maxNodes: 1000 });
    const rows = g.root.children[0]!;
    expect(rows.children).toHaveLength(51);
    expect(rows.children.at(-1)).toMatchObject({ kind: "more", hidden: 70, arrayId: "$.rows" });
    g = buildRecordGraph(long, "$", { pageSize: 50, shown: { "$.rows": 50 }, maxNodes: 1000 });
    expect(g.root.children[0]!.children.at(-1)).toMatchObject({ hidden: 20 });
  });

  it("stops at the card limit and says so", () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, { v: i }]));
    const g = buildRecordGraph(wide, "$", { pageSize: 50, shown: {}, maxNodes: 10 });
    expect(g.nodes).toBe(10);
    expect(g.truncated).toBe(true);
    expect(g.root.lines.at(-1)).toMatchObject({ text: "{…}", kind: "empty" });
  });

  it("writes JSON paths", () => {
    expect(childPath("$", "a")).toBe("$.a");
    expect(childPath("$", "a b")).toBe('$["a b"]');
    expect(childPath("$.x", 3)).toBe("$.x[3]");
  });

  it("reads grid values as JSON", () => {
    const cols = [
      { name: "n", kind: "integer" as const, type: "Int64", nullable: true },
      { name: "big", kind: "integer" as const, type: "Int64", nullable: true },
      { name: "d", kind: "date" as const, type: "Date", nullable: true },
      { name: "obj", kind: "json" as const, type: "Struct", nullable: true },
    ];
    const struct = { toJSON: () => ({ a: [1, 2] }) };
    expect(recordValue(cols, [5n, 12345678901234567890n, 86_400_000, struct])).toEqual({
      n: 5,
      big: "12345678901234567890",
      d: "1970-01-02",
      obj: { a: [1, 2] },
    });
  });
});

describe("structure graph", () => {
  const shape: JsonShape = {
    rows: 4,
    elapsedMs: 3,
    fields: [
      {
        name: "id",
        kind: "value",
        type: "integer",
        present: 4,
        avgLen: null,
        maxLen: null,
        sql: '"id"',
        children: [],
      },
      {
        name: "user",
        kind: "object",
        type: "object",
        present: 3,
        avgLen: null,
        maxLen: null,
        sql: '"user"',
        children: [
          {
            name: "name",
            kind: "value",
            type: "text",
            present: 2,
            avgLen: null,
            maxLen: null,
            sql: "x",
            children: [],
          },
        ],
      },
      {
        name: "items",
        kind: "array",
        type: "object[]",
        present: 4,
        avgLen: 1.25,
        maxLen: 3,
        sql: '"items"',
        children: [
          {
            name: "qty",
            kind: "value",
            type: "integer",
            present: null,
            avgLen: null,
            maxLen: null,
            sql: null,
            children: [],
          },
        ],
      },
    ],
  };

  it("shows types, how often keys appear and array lengths", () => {
    const root = buildShapeGraph(shape);
    expect(root.lines).toEqual([{ key: "id", text: "integer", kind: "type", path: "$.id" }]);
    const [user, items] = root.children;
    expect(user).toMatchObject({ title: "user", subtitle: "in 75% of records", sql: '"user"' });
    expect(user!.lines[0]).toMatchObject({ text: "text · 50% of records", path: "$.user.name" });
    expect(items!.subtitle).toBe("object[] · avg 1.3, max 3 items · in every record");
    expect(items!.lines[0]!.path).toBe("$.items[*].qty");
  });
});

describe("layout", () => {
  const { root } = buildRecordGraph(order, "Record");

  it("never overlaps cards, and hides collapsed children", () => {
    for (const orient of ["LR", "TB"] as const) {
      const l = layoutGraph(root, new Set(), orient);
      expect(l.nodes).toHaveLength(6);
      expect(l.edges).toHaveLength(5);
      for (const a of l.nodes)
        for (const b of l.nodes) {
          if (a === b) continue;
          const apart =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${a.node.id} / ${b.node.id} (${orient})`).toBe(true);
        }
      // Children sit after their parent along the tree.
      const parent = l.nodes.find((n) => n.node.id === "$.items")!;
      const child = l.nodes.find((n) => n.node.id === "$.items[0]")!;
      expect(orient === "LR" ? child.x > parent.x + parent.w : child.y > parent.y + parent.h).toBe(
        true,
      );
    }
    const closed = layoutGraph(root, new Set(["$.items"]));
    expect(closed.nodes.map((n) => n.node.id)).not.toContain("$.items[0]");
    expect(closed.nodes.find((n) => n.node.id === "$.items")!.collapsed).toBe(true);
  });

  it("starts deep branches collapsed and opens the way to search matches", () => {
    expect([...collapsedBelow(root, 1)]).toEqual(["$.items"]);
    const found = search(root, "berlin");
    expect([...found.matches]).toEqual(['$["ship to"]']);
    expect([...found.open]).toEqual(["$"]);
    expect(search(root, "sku").matches).toEqual(new Set(["$.items[0]", "$.items[1]"]));
    expect(search(root, " ").matches.size).toBe(0);
  });

  it("exports the same layout as SVG", () => {
    const colors = Object.fromEntries(
      [
        "bg",
        "card",
        "border",
        "accent",
        "fg",
        "muted",
        "string",
        "number",
        "keyword",
        "key",
        "font",
      ].map((k) => [k, k === "font" ? "Mono <x>" : `#${k}`]),
    ) as unknown as GraphColors;
    const svg = graphSvg(layoutGraph(root, new Set()), colors);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("&quot;Berlin&quot;");
    expect(svg).toContain('font-family="Mono &lt;x&gt;"');
    expect(svg.match(/<rect /g)).toHaveLength(7);
  });
});

describe("nested values from Arrow", () => {
  it("formats dates, timestamps, decimals and big integers inside structs and lists", async () => {
    const {
      Field,
      List,
      Struct,
      DateDay,
      TimestampMillisecond,
      Int64,
      Utf8,
      vectorFromArray,
      Table,
    } = await import("apache-arrow");
    const type = new Struct([
      new Field("when", new DateDay(), true),
      new Field("events", new List(new Field("item", new TimestampMillisecond(), true)), true),
      new Field("big", new Int64(), true),
      new Field("name", new Utf8(), true),
    ]);
    const vec = vectorFromArray(
      [
        {
          when: new Date(Date.UTC(2024, 0, 31)),
          events: [Date.UTC(2024, 1, 1, 10, 30), null],
          big: 9007199254740993n,
          name: "a",
        },
      ],
      type,
    );
    const table = new Table({ obj: vec });
    const { describeColumns, cellValue } = await import("./arrow");
    const cols = describeColumns(table);
    expect(recordValue(cols, [cellValue(table, 0, 0)])).toEqual({
      obj: {
        when: "2024-01-31",
        events: ["2024-02-01 10:30:00", null],
        big: "9007199254740993",
        name: "a",
      },
    });
  });
});

describe("binary values", () => {
  it("are one value, not an array of bytes", async () => {
    const { Binary } = await import("apache-arrow");
    expect(arrowJson(new Uint8Array([170, 187]), new Binary())).toBe("\\xaabb");
  });
});

describe("paths for flattening and filtering", () => {
  it("parses paths and finds the column and keys", () => {
    expect(parsePath('$.user["first name"].tags[2]')).toEqual(["user", "first name", "tags", 2]);
    expect(nestedTarget("$.user.address.city")).toEqual({
      column: "user",
      keys: ["address", "city"],
    });
    expect(nestedTarget("$.id")).toEqual({ column: "id", keys: [] });
    expect(nestedTarget("$.items[0].sku")).toBeNull();
    expect(nestedTarget("$.items[*].sku")).toBeNull();
    expect(firstArray("$.order.items[3].sku")).toBe("$.order.items");
    expect(firstArray("$.items[*].qty")).toBe("$.items");
    expect(firstArray("$.user.name")).toBeNull();
  });

  it("writes SQL and free column names", () => {
    expect(sqlPath("user", ["it's", "city"])).toBe(
      `struct_extract(struct_extract("user", 'it''s'), 'city')`,
    );
    expect(freeName("city", ["id", "City", "city_2"])).toBe("city_3");
    expect(freeName("zip", ["id"])).toBe("zip");
  });

  it("counts keys inside arrays against the array's items", () => {
    const shape: JsonShape = {
      rows: 10,
      elapsedMs: 1,
      fields: [
        {
          name: "items",
          kind: "array",
          type: "object[]",
          present: 10,
          avgLen: 2,
          maxLen: 4,
          sql: '"items"',
          items: 20,
          children: [
            {
              name: "sku",
              kind: "value",
              type: "text",
              present: 20,
              avgLen: null,
              maxLen: null,
              sql: null,
              children: [],
            },
            {
              name: "qty",
              kind: "value",
              type: "integer",
              present: 5,
              avgLen: null,
              maxLen: null,
              sql: null,
              children: [],
            },
          ],
        },
      ],
    };
    const items = buildShapeGraph(shape).children[0]!;
    expect(items.lines.map((l) => l.text)).toEqual(["text", "integer · 25% of items"]);
  });
});
