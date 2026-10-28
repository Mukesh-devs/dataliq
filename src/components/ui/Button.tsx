import { forwardRef, type ButtonHTMLAttributes } from "react";
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

// forwardRef so Radix triggers (`asChild`) can measure and focus the button.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium whitespace-nowrap transition-colors duration-[var(--duration)] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-6 px-2 text-xs" : "h-8 px-3 text-[13px]",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
});

/** Square icon-only button. `label` is required for screen readers and the tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }
>(function IconButton({ label, className, ...props }, ref) {
  return (
    <button
      ref={ref}
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
});
