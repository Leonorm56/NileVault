import { forwardRef } from "react";

import { cn } from "@/utils";

/**
 * Text input.
 *
 * Focus and invalid states are both driven by tokens so the transition between
 * them is a smooth tint rather than a hard border swap, and `invalid` also sets
 * `aria-invalid` for assistive tech.
 */
const Input = forwardRef(function Input({ className, invalid, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full min-w-0 rounded-xl border bg-white/[0.05] px-3 py-2.5 text-sm text-neutral-100",
        "placeholder:text-neutral-500",
        "outline-none",
        "transition-[border-color,box-shadow,background-color] duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
        "focus:bg-white/[0.07] focus:ring-2",
        "disabled:opacity-50",
        invalid
          ? "border-red-500/50 focus:border-red-500/70 focus:ring-red-500/20"
          : "border-white/10 focus:border-nile-gold-500/60 focus:ring-nile-gold-500/20",
        className,
      )}
    />
  );
});

export default Input;
