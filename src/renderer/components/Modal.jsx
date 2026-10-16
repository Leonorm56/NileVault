import { useCallback, useEffect, useRef, useState } from "react";
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

/*
 * How long the shell stays mounted after `open` goes false, so the exit can
 * play. Kept just above --nc-dur (170ms) — the animation sets the pace, this
 * only has to outlast it.
 */
const EXIT_MS = 180;

/**
 * Modal.
 *
 * One shell for every dialog in the app — previously three different treatments
 * existed (a solid surface, a glass card and a Radix dialog), each with
 * different behaviour. This one carries the behaviour the Radix dialog already
 * had and the hand-rolled ones lacked: Esc to dismiss, a real focus trap, focus
 * restored to whatever opened it, and an animated entrance.
 *
 * The panel and scrim take the glass treatment (.nc-panel-glass /
 * .nc-overlay-glass). Glass was removed here once, when the app was being
 * flattened; it is back deliberately, and only for floating surfaces, where
 * there is real page content behind the blur to justify it.
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
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  // True once the body has been scrolled, so the boundary under the header can
  // fade — and only then, because there is nothing to separate until content
  // actually passes beneath the title.
  const [scrolled, setScrolled] = useState(false);

  /*
   * Enter and exit travel the same path.
   *
   * A dialog that scales up on entry and then vanishes on the very next frame
   * reads as a glitch: the user never sees it leave, so it is not obvious the
   * surface is gone rather than the click having missed. Keeping it mounted for
   * the length of the exit lets it dissolve the way it arrived.
   */
  useEffect(() => {
    if (open) {
      setLeaving(false);
      setMounted(true);
      setScrolled(false);
      return undefined;
    }
    if (!mounted) return undefined;

    setLeaving(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, EXIT_MS);
    // Re-opening mid-exit cancels the unmount, so a hurried user never loses
    // the dialog they just reopened.
    return () => clearTimeout(timer);
  }, [open, mounted]);

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

  if (!mounted) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] flex items-center justify-center p-4",
        // On the way out the shell stops taking clicks: the app behind it is
        // live again the moment the dialog is dismissed.
        leaving && "pointer-events-none",
      )}
    >
      <div
        className={cn(
          "nc-overlay-glass absolute inset-0 bg-background/70",
          leaving ? "nc-anim-fade-out" : "nc-anim-fade",
        )}
        onClick={dismissible && !leaving ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cn(
          "nc-panel-glass relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden",
          leaving ? "nc-anim-scale-out" : "nc-anim-scale",
          "rounded-xl",
          size,
        )}
      >
        {/*
          No rule under the title. The boundary only appears once the body has
          actually scrolled under it, and it fades rather than cutting the
          panel in half.
        */}
        <div
          className={cn(
            "relative flex items-start gap-3 p-4",
            scrolled && "nc-scroll-edge",
          )}
        >
          {icon ? (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-accent text-muted-foreground">
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

        <div
          className="grow overflow-y-auto p-4"
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
