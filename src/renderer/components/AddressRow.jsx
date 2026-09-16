import { useCallback, useEffect, useRef, useState } from "react";
import copyToClipboard from "copy-to-clipboard";
import { HiOutlineCheck, HiOutlineClipboard } from "react-icons/hi2";

import { cn } from "@/utils";

/**
 * AddressRow — a full-width, click-anywhere-to-copy address.
 *
 * These rows previously had no hover state, no press response and no visual
 * confirmation: the address just sat there and a toast appeared somewhere else.
 * Now the whole row responds, the icon tints on hover, and copying swaps it for
 * a check in place.
 *
 * The address itself opts back into text selection (`data-selectable`) so it can
 * still be highlighted by hand.
 */
export default function AddressRow({
  address,
  display,
  className,
  icon = true,
  title = "Copy address",
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(() => {
    if (!address) return;
    copyToClipboard(String(address));
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1400);
  }, [address]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied" : title}
      aria-label={copied ? "Address copied" : title}
      className={cn(
        "group flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-2.5 text-left",
        "transition-[border-color,background-color,transform] duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
        "hover:border-nile-gold-500/40 hover:bg-white/[0.07] active:scale-[0.99]",
        className,
      )}
    >
      <span
        data-selectable
        className="nc-mono grow truncate font-bold text-neutral-200"
      >
        {display || address || "—"}
      </span>
      {icon ? (
        copied ? (
          <HiOutlineCheck className="nc-anim-scale size-4 shrink-0 text-emerald-400" />
        ) : (
          <HiOutlineClipboard className="size-4 shrink-0 text-neutral-500 transition-colors duration-[var(--nc-dur)] group-hover:text-nile-gold-400" />
        )
      ) : null}
    </button>
  );
}
