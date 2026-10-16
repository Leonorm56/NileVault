import { cva } from "class-variance-authority";

import { cn } from "@/utils";
import Spinner from "./Spinner";

/**
 * Button (shadcn structure, NileVault tokens).
 *
 * Gold appears on `default` and nowhere else — the link and danger variants used
 * to borrow it, which is what made the accent feel like decoration instead of a
 * signal. Every variant shares one contract:
 *
 *   pending  — spinner in the icon slot, `aria-busy`, still fully opaque so it
 *              never reads as disabled (the old `opacity-50 cursor-wait`
 *              treatment made a working button look broken)
 *   disabled — dimmed, non-interactive
 */
const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-2 rounded-md font-medium select-none",
    // Press and hover tempo both come from .nc-press, so a button answers the
    // instant it is pressed and on the same clock as the rest of the app.
    "nc-press",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:pointer-events-none disabled:opacity-45",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-nile-gold-400 active:bg-nile-gold-600",
        secondary:
          "border border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent",
        outline:
          "border border-input bg-transparent text-neutral-200 hover:bg-accent hover:text-accent-foreground active:bg-accent",
        ghost:
          "text-neutral-300 hover:bg-accent hover:text-accent-foreground active:bg-accent",
        danger:
          "bg-danger text-on-danger hover:bg-red-500 active:bg-red-700",
        // A link is text, not a surface: it dims on press instead of scaling.
        link: "text-neutral-200 underline underline-offset-4 decoration-neutral-500 hover:text-neutral-100 hover:decoration-neutral-300 active:opacity-80 active:scale-100",
      },
      size: {
        default: "h-9 px-4 text-sm",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-5 text-sm",
        icon: "size-9 p-0",
        block: "h-9 w-full px-4 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export default function Button({
  as: Component = "button",
  variant,
  size,
  className,
  children,
  loading = false,
  disabled = false,
  type,
  ...props
}) {
  const isButton = Component === "button";
  const inert = disabled || loading;

  return (
    <Component
      {...props}
      {...(isButton ? { type: type ?? "button" } : {})}
      disabled={isButton ? inert : undefined}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
    >
      {loading ? <Spinner size={15} /> : null}
      {children}
    </Component>
  );
}

export { buttonVariants };
