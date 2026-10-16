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
        "inline-flex shrink-0 items-center justify-center rounded-md",
        // Same press + hover contract as Button.
        "nc-press",
        "disabled:opacity-40",
        variant === "ghost" &&
          "text-neutral-400 hover:bg-accent hover:text-accent-foreground",
        variant === "muted" && "text-neutral-500 hover:bg-accent hover:text-neutral-200",
        variant === "danger" &&
          "text-neutral-400 hover:bg-destructive/15 hover:text-destructive",
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
