import { forwardRef } from "react";

import { cn } from "@/utils";
import Spinner from "./Spinner";

/**
 * Icon-only button.
 *
 * Icon controls previously had no hover fill, no press response and no
 * accessible name (a screen reader announced them as "button"). `label` is
 * therefore required and doubles as the native tooltip.
 */
const IconButton = forwardRef(function IconButton(
  { label, className, variant = "ghost", size = "size-8", loading = false, disabled = false, children, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label={label}
      title={props.title ?? label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg",
        "transition-[background-color,color,transform] duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
        "active:scale-90 disabled:active:scale-100 disabled:opacity-40",
        variant === "ghost" &&
          "text-neutral-400 hover:bg-white/[0.09] hover:text-nile-gold-400",
        variant === "muted" && "text-neutral-500 hover:bg-white/[0.07] hover:text-neutral-200",
        variant === "danger" &&
          "text-neutral-400 hover:bg-red-500/15 hover:text-red-400",
        variant === "gold" && "text-nile-gold-500 hover:bg-nile-gold-500/15",
        size,
        className,
      )}
    >
      {loading ? <Spinner size={14} /> : children}
    </button>
  );
});

export default IconButton;
