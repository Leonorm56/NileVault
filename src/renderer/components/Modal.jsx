import { useCallback, useEffect, useRef } from "react";
import { HiOutlineXMark } from "react-icons/hi2";

import { cn } from "@/utils";
import IconButton from "./IconButton";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Modal.
 *
 * One shell for every dialog in the app — previously three different treatments
 * existed (a solid surface, a glass card and a Radix dialog), each with
 * different behaviour. This one carries the behaviour the Radix dialog already
 * had and the hand-rolled ones lacked: Esc to dismiss, a real focus trap, focus
 * restored to whatever opened it, and an animated entrance.
 */
export default function Modal({
  open = true,
  onClose,
  title,
  description,
  icon,
  children,
  size = "max-w-sm",
  dismissible = true,
  initialFocusRef,
}) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);

  /* Move focus in on open, and back to the trigger on close. */
  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const panel = panelRef.current;
    const target =
      initialFocusRef?.current ||
      panel?.querySelector(FOCUSABLE) ||
      panel;
    target?.focus?.({ preventScroll: true });

    return () => {
      restoreFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [open, initialFocusRef]);

  /* Esc closes; Tab cycles inside the panel. */
  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Escape") {
        if (!dismissible) return;
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null,
      );
      if (!nodes.length) return;

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [dismissible, onClose],
  );

  useEffect(() => {
    if (!open) return undefined;
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="nc-anim-fade absolute inset-0 bg-neutral-950/80 backdrop-blur-sm"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cn(
          "nc-anim-scale relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden",
          "rounded-2xl border border-nile-gold-500/25 bg-neutral-900/95 shadow-2xl backdrop-blur-xl",
          size,
        )}
      >
        <div className="flex items-start gap-3 border-b border-white/[0.07] p-4">
          {icon ? (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-nile-gold-500/30 bg-nile-gold-500/10 text-nile-gold-400">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0 grow">
            <h2 className="nc-title text-base">{title}</h2>
            {description ? (
              <p className="nc-caption mt-1 leading-relaxed">{description}</p>
            ) : null}
          </div>
          {dismissible ? (
            <IconButton label="Close" onClick={onClose}>
              <HiOutlineXMark className="size-4" />
            </IconButton>
          ) : null}
        </div>

        <div className="grow overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
