import {
  Database,
  FileBraces,
  FileSpreadsheet,
  FileText,
  Folder,
  GitCompareArrows,
  Globe,
  Layers,
  SquareTerminal,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import type { FileKind } from "../../lib/fileKind";

const ICONS: Record<FileKind, LucideIcon> = {
  csv: FileText,
  excel: FileSpreadsheet,
  json: FileBraces,
  parquet: Layers,
  database: Database,
  folder: Folder,
  url: Globe,
  sql: SquareTerminal,
  compare: GitCompareArrows,
  table: Table2,
};

/**
 * A file's kind at a glance, in the sidebar's Files list and the tabs: its
 * own shape and colour (`--file-*` tokens, for the light and dark themes),
 * so kinds differ even without colour.
 */
export function FileIcon({ kind, className }: { kind: FileKind; className?: string }) {
  const Icon = ICONS[kind];
  return (
    <Icon
      data-file-kind={kind}
      className={cn("size-3.5 shrink-0", className)}
      style={{ color: `var(--file-${kind})` }}
      aria-hidden
    />
  );
}
