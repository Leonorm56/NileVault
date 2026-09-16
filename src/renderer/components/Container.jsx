import { forwardRef } from "react";

import { cn } from "@/utils";

/**
 * Content container.
 *
 * Widths come from one scale so screens can't fight over `max-w-*` (the picker
 * used to pass `max-w-[1440px]` purely to override the default, relying on
 * tailwind-merge's last-wins behaviour). `size` picks the intended column width;
 * `className` is left for layout only.
 */
const WIDTHS = {
  sm: "max-w-lg", // 32rem — single-column forms (network check, unlock)
  md: "max-w-6xl", // 72rem — the wallet screen (needs to exceed lg breakpoint for 2-col)
  lg: "max-w-3xl",
  xl: "max-w-6xl", // 72rem — the picker grid
};

const Container = forwardRef(function Container(
  { className, size = "sm", ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={cn("mx-auto w-full px-5 py-5", WIDTHS[size] || WIDTHS.sm, className)}
    />
  );
});

export { WIDTHS };
export default Container;
