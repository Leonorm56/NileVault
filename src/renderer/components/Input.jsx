import { forwardRef } from "react";

import { cn } from "@/utils";

/**
 * Text input (shadcn structure).
 *
 * Flat transparent surface, hairline border, ring on focus. `invalid` also
 * sets `aria-invalid` for assistive tech.
 */
const Input = forwardRef(function Input({ className, invalid, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm text-foreground",
        "placeholder:text-muted-foreground",
        "outline-none transition-[border-color,box-shadow] duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
        "focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:opacity-50",
        invalid
          ? "border-destructive/60 focus-visible:border-destructive focus-visible:ring-destructive/25"
          : "border-input focus-visible:border-ring/60",
        className,
      )}
    />
  );
});

export default Input;
