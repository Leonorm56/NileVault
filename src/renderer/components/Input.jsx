import { cn } from "@/utils";
import { memo } from "react";

export default memo(function Input(props) {
  return (
    <input
      {...props}
      className={cn(
        "border bg-white/70 dark:bg-white/[0.06] backdrop-blur-md shadow-sm",
        "p-2.5 rounded-lg font-bold w-full min-w-0",
        "focus:outline-hidden focus:ring-3 focus:ring-nile-gold-400",
        "disabled:opacity-50",
        props.className
      )}
    />
  );
});
