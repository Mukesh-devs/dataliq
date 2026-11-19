import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names, skipping falsy values. When two Tailwind classes set the
 * same thing (`size-7` and `size-5`), the later one wins and the earlier is
 * dropped: a component's defaults come first, so what its caller passes
 * replaces them. Without this both stay, and whichever comes later in the
 * stylesheet wins, not the one the caller asked for.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
