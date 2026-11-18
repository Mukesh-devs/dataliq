import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

interface ModalProps {
  open: boolean;
  /** Called with false for ✕, Esc and the dialog's own Cancel. */
  onOpenChange: (open: boolean) => void;
  /** Shown in the title bar. */
  title: ReactNode;
  /** The dialog's accessible name, when it differs from the title text. */
  label?: string;
  /** Tailwind width class, e.g. "w-[30rem]". */
  width?: string;
  /** Leaves out ✕ and Esc, e.g. while something can't be stopped. */
  dismissable?: boolean;
  /** Extra classes for the body. */
  className?: string;
  children: ReactNode;
}

/**
 * A dialog for an action (export, convert, connect …): centred over a dimmed
 * window, with a title bar and ✕. It closes with ✕, Esc or the dialog's own
 * buttons, never from a stray click outside, and the keyboard stays inside
 * until it closes.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  label,
  width = "w-[30rem]",
  dismissable = true,
  className,
  children,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o || dismissable) && onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)]" />
        <Dialog.Content
          // With a label, it names the dialog instead of the title.
          {...(label ? { "aria-label": label, "aria-labelledby": undefined } : {})}
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-lg)] border border-border bg-bg text-[13px] shadow-[0_16px_48px_rgb(0_0_0/0.22)] outline-none",
            width,
          )}
        >
          <Dialog.Title className="shrink-0 border-b border-border py-2.5 pr-11 pl-4 text-[13px] font-semibold text-fg">
            {title}
          </Dialog.Title>
          <div className={cn("min-h-0 overflow-y-auto p-4", className)}>{children}</div>
          {/* Last in the Tab order, so the first field gets the focus. */}
          {dismissable && (
            <Dialog.Close
              aria-label="Close dialog"
              title="Close (Esc)"
              className="absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-[var(--radius)] text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
