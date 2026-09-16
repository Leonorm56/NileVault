import { useCallback, useEffect, useRef, useState } from "react";
import copyToClipboard from "copy-to-clipboard";
import { HiOutlineCheck, HiOutlineClipboard } from "react-icons/hi2";

import { cn } from "@/utils";

/**
 * Copy control with inline confirmation.
 *
 * The copyable rows previously gave no visual response at all — the only signal
 * was a toast, which is easy to miss and says nothing about *which* field was
 * copied. The icon morphs to a check for a moment instead, and the label
 * changes with it.
 */
export default function CopyButton({
  value,
  label,
  copiedLabel = "Copied",
  className,
  iconSize = "size-4",
  variant = "ghost",
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(
    (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (!value) return;
      copyToClipboard(String(value));
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1400);
    },
    [value],
  );

  const showLabel = Boolean(label || copied);

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={!value}
      aria-label={copied ? copiedLabel : label ? `Copy ${label}` : "Copy"}
      title={copied ? copiedLabel : "Copy"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg",
        "transition-[background-color,color,transform] duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
        "active:scale-90 disabled:opacity-40 disabled:active:scale-100",
        showLabel ? "px-2 py-1 text-xs font-bold" : "size-8 justify-center",
        copied
          ? "text-emerald-400"
          : variant === "ghost"
            ? "text-neutral-400 hover:bg-white/[0.09] hover:text-nile-gold-400"
            : "text-neutral-500 hover:text-neutral-200",
        className,
      )}
    >
      <span className="relative inline-flex items-center justify-center">
        {copied ? (
          <HiOutlineCheck className={cn(iconSize, "nc-anim-scale")} />
        ) : (
          <HiOutlineClipboard className={iconSize} />
        )}
      </span>
      {showLabel ? (
        <span key={copied ? "copied" : "idle"} className="nc-anim-fade">
          {copied ? copiedLabel : label}
        </span>
      ) : null}
    </button>
  );
}
