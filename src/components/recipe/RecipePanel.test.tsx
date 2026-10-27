import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "../../lib/arrow";
import type { RecipeStep, StepOutcome } from "../../lib/recipe";
import { RecipePanel } from "./RecipePanel";

const col = (name: string, kind: ColumnInfo["kind"]): ColumnInfo => ({
  name,
  kind,
  type: "",
  nullable: true,
});
const columns = [col("name", "text"), col("amount", "number"), col("joined", "text")];
const ok: StepOutcome = { error: null, failed: null, skipped: false };

function setup(props: Partial<Parameters<typeof RecipePanel>[0]> = {}) {
  const onChange = vi.fn<(steps: RecipeStep[]) => void>();
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  render(
    <RecipePanel
      steps={[]}
      running={false}
      columns={columns}
      canUndo={false}
      canRedo={false}
      onChange={onChange}
      onUndo={onUndo}
      onRedo={onRedo}
      onClose={() => {}}
      {...props}
    />,
  );
  return { onChange, onUndo, onRedo, user: userEvent.setup() };
}

const form = () => screen.getByRole("form", { name: "Add a step" });

describe("RecipePanel", () => {
  it("adds steps from the form", async () => {
    const { onChange, user } = setup({ column: "amount" });
    const f = within(form());
    // The column from the column menu is picked.
    expect(f.getByLabelText("Column")).toHaveValue("amount");
    await user.selectOptions(f.getByLabelText("Step"), "fillEmpty");
    expect(f.getByRole("button", { name: "Add step" })).toBeDisabled();
    await user.type(f.getByLabelText("With"), "0");
    await user.click(f.getByRole("button", { name: "Add step" }));
    expect(onChange).toHaveBeenLastCalledWith([{ op: "fillEmpty", column: "amount", value: "0" }]);

    await user.selectOptions(f.getByLabelText("Step"), "changeType");
    await user.selectOptions(f.getByLabelText("Column"), "joined");
    await user.selectOptions(f.getByLabelText("To"), "date");
    await user.type(f.getByLabelText("Date format (optional)"), "%d/%m/%Y");
    await user.click(f.getByRole("button", { name: "Add step" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { op: "changeType", column: "joined", to: "date", format: "%d/%m/%Y" },
    ]);

    await user.selectOptions(f.getByLabelText("Step"), "split");
    await user.selectOptions(f.getByLabelText("Column"), "name");
    expect(f.getByLabelText("Into new columns (comma-separated)")).toHaveValue("name 1, name 2");
    await user.type(f.getByLabelText("At"), " ");
    await user.click(f.getByRole("button", { name: "Add step" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { op: "split", column: "name", delimiter: " ", into: ["name 1", "name 2"], keep: false },
    ]);

    await user.selectOptions(f.getByLabelText("Step"), "removeRows");
    await user.selectOptions(f.getByLabelText("Column"), "amount");
    await user.selectOptions(f.getByLabelText("Where the value"), "lt");
    await user.type(f.getByLabelText("Value"), "0");
    await user.click(f.getByRole("button", { name: "Add step" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { op: "removeRows", filter: { column: "amount", op: "lt", value: 0 } },
    ]);

    await user.selectOptions(f.getByLabelText("Step"), "removeDuplicates");
    await user.selectOptions(f.getByLabelText("Rows are duplicates when"), "name");
    await user.click(f.getByRole("button", { name: "Add step" }));
    expect(onChange).toHaveBeenLastCalledWith([{ op: "removeDuplicates", columns: ["name"] }]);
  });

  it("turns steps off, moves and removes them, and shows what happened", async () => {
    const steps: RecipeStep[] = [
      { op: "trim", column: "name" },
      { op: "changeType", column: "amount", to: "integer" },
      { op: "calculate", name: "x", expression: "nope" },
      { op: "trim", column: "joined" },
    ];
    const { onChange, onUndo, user } = setup({
      steps,
      outcomes: [
        ok,
        { ...ok, failed: 3 },
        { ...ok, error: "column nope not found" },
        { ...ok, skipped: true },
      ],
      canUndo: true,
    });
    const list = within(screen.getByRole("list", { name: "Steps" }));
    expect(list.getAllByRole("listitem")).toHaveLength(4);
    expect(list.getByText("3 values couldn’t be converted (now empty)")).toBeInTheDocument();
    expect(list.getByRole("alert")).toHaveTextContent("column nope not found");
    expect(list.getByText("Not applied: an earlier step fails")).toBeInTheDocument();

    await user.click(list.getByRole("checkbox", { name: "Apply step 1" }));
    expect(onChange).toHaveBeenLastCalledWith([{ ...steps[0], enabled: false }, ...steps.slice(1)]);
    await user.click(list.getByRole("button", { name: "Move step 2 up" }));
    expect(onChange).toHaveBeenLastCalledWith([steps[1], steps[0], steps[2], steps[3]]);
    expect(list.getByRole("button", { name: "Move step 4 down" })).toBeDisabled();
    await user.click(list.getByRole("button", { name: "Remove step 3" }));
    expect(onChange).toHaveBeenLastCalledWith([steps[0], steps[1], steps[3]]);
    await user.click(screen.getByRole("button", { name: /^Undo/ }));
    expect(onUndo).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Redo/ })).toBeDisabled();
  });
});
