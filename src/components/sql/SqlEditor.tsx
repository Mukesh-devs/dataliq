import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { HighlightStyle, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { SqlTable } from "../../stores/sql";

export interface SqlEditorHandle {
  /** The selected text and where it starts, or the whole text when nothing is selected. */
  runnable(): { script: string; base: number };
  /** Replaces the whole text (undoable). */
  replace(text: string): void;
  /** Types `text` at the cursor (over the selection). */
  insert(text: string): void;
  focus(): void;
}

interface SqlEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** Tables and their columns, for autocomplete. */
  tables: SqlTable[];
  /** Ctrl+Enter. */
  onRun: () => void;
  /** Marks an error at this offset (null clears it). */
  error?: { offset: number | null; message: string };
}

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syntax-comment)" },
  { tag: [tags.special(tags.name), tags.typeName], color: "var(--syntax-name)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--font-data)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--fg-subtle)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-tooltip": {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--fg)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--fg)",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--danger)",
    textUnderlineOffset: "3px",
  },
  ".cm-placeholder": { color: "var(--fg-subtle)" },
});

/** `{ table: [columns] }` for lang-sql's completion. */
function schemaOf(tables: SqlTable[]): Record<string, string[]> {
  return Object.fromEntries(tables.map((t) => [t.name, t.columns]));
}

const sqlLanguage = (tables: SqlTable[]) =>
  sql({ dialect: PostgreSQL, schema: schemaOf(tables), upperCaseKeywords: true });

/** CodeMirror 6 SQL editor: highlighting, completion of tables and columns, Ctrl+Enter to run. */
export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, onChange, tables, onRun, error },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // The latest callbacks, for the editor's long-lived listeners.
  const handlers = useRef({ onChange, onRun });
  useEffect(() => {
    handlers.current = { onChange, onRun };
  }, [onChange, onRun]);

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          placeholder("SELECT * FROM … — Ctrl+Enter runs the query (or the selection)"),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  handlers.current.onRun();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          language.current.of(sqlLanguage([])),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ "aria-label": "SQL query" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The document is owned by the editor after creation; `value` only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(sqlLanguage(tables)) });
  }, [tables]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const len = v.state.doc.length;
    const diagnostics =
      error && error.offset !== null
        ? [
            {
              from: Math.min(error.offset, len),
              // Underline the word at the error.
              to: Math.min(
                len,
                error.offset +
                  Math.max(
                    1,
                    /^[\w"]+/.exec(v.state.doc.sliceString(error.offset))?.[0].length ?? 1,
                  ),
              ),
              severity: "error" as const,
              message: error.message,
            },
          ]
        : [];
    v.dispatch(setDiagnostics(v.state, diagnostics));
  }, [error]);

  useImperativeHandle(
    ref,
    () => ({
      runnable() {
        const v = view.current;
        if (!v) return { script: "", base: 0 };
        const sel = v.state.selection.main;
        return sel.empty
          ? { script: v.state.doc.toString(), base: 0 }
          : { script: v.state.sliceDoc(sel.from, sel.to), base: sel.from };
      },
      replace(text: string) {
        const v = view.current;
        if (!v) return;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      },
      insert(text: string) {
        const v = view.current;
        if (!v) return;
        v.dispatch(v.state.replaceSelection(text));
        v.focus();
      },
      focus() {
        view.current?.focus();
      },
    }),
    // Reads the live editor, so one handle serves for its whole life.
    [],
  );

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="sql-editor" />;
});
