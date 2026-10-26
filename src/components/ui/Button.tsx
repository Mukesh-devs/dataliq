import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
}

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "border border-border bg-bg text-fg hover:bg-hover",
  ghost: "text-fg-muted hover:bg-hover hover:text-fg",
};

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium transition-colors duration-[var(--duration)] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-6 px-2 text-xs" : "h-8 px-3 text-[13px]",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

/** Square icon-only button. `label` is required for screen readers and the tooltip. */
export function IconButton({
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-[var(--radius)] text-fg-muted transition-colors duration-[var(--duration)] hover:bg-hover hover:text-fg",
        className,
      )}
      {...props}
    />
  );
}
