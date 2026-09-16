import { cva } from "class-variance-authority";

import { cn } from "@/utils";
import Spinner from "./Spinner";

/**
 * Button.
 *
 * Every variant carries the same interaction contract:
 *
 *   idle     — resting fill
 *   hover    — lighter fill plus a 1px lift, over the shared duration token
 *   active   — pressed: no lift, scaled down slightly
 *   pending  — spinner in the icon slot, `aria-busy`, still fully opaque so it
 *              never reads as disabled (the old `opacity-50 cursor-wait`
 *              treatment made a working button look broken)
 *   disabled — dimmed, non-interactive, and with no press response
 */
const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-2 rounded-lg font-bold select-none",
    "transition-[background-color,border-color,color,opacity,box-shadow,transform]",
    "duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
    "active:scale-[0.975]",
    "disabled:opacity-45 disabled:active:scale-100 disabled:hover:translate-y-0",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-nile-gold-400 text-neutral-950 shadow-sm shadow-nile-gold-400/25 hover:-translate-y-px hover:bg-nile-gold-300 active:bg-nile-gold-500",
        secondary:
          "border border-white/10 bg-white/[0.06] text-neutral-100 hover:-translate-y-px hover:border-white/20 hover:bg-white/[0.1] active:bg-white/[0.14]",
        outline:
          "border border-nile-gold-500/40 text-nile-gold-400 hover:-translate-y-px hover:border-nile-gold-500 hover:bg-nile-gold-500/10",
        ghost:
          "text-neutral-300 hover:bg-white/[0.07] hover:text-nile-gold-400 active:bg-white/[0.11]",
        danger:
          "bg-red-500 text-white shadow-sm shadow-red-500/20 hover:-translate-y-px hover:bg-red-400 active:bg-red-600",
        link: "text-nile-gold-500 underline-offset-4 hover:underline active:opacity-80",
      },
      size: {
        default: "px-4 py-2.5 text-sm",
        sm: "px-3 py-1.5 text-xs",
        lg: "px-5 py-3 text-base",
        icon: "size-9 p-0",
        block: "w-full px-4 py-2.5 text-sm",
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
