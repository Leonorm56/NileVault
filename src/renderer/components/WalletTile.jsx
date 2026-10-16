import copyToClipboard from "copy-to-clipboard";
import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  HiOutlineArrowDownTray,
  HiOutlineArrowUpTray,
  HiOutlineBars3,
  HiOutlineCheck,
  HiOutlineDocumentDuplicate,
  HiOutlineEllipsisHorizontal,
} from "react-icons/hi2";

import { cn } from "@/utils";
import { truncateAddress } from "@/lib/address.js";
import AmountValue from "./AmountValue";
import { Skeleton } from "./Skeleton";

/*
 * A wallet tile in the picker grid — sortable by drag or keyboard.
 *
 * The tile is a <button> (open the wallet) and the drag handle is a sibling
 * button. That split matters: putting dnd-kit's listeners on the tile itself
 * would nest interactive roles and make a click ambiguous, and putting them on
 * the tile would also make every click a potential drag. A dedicated handle
 * keeps "open" and "move" as two unambiguous actions, and gives keyboard users
 * a focusable target for the sortable sensor.
 *
 * Two signals, deliberately different in kind:
 *   - the dot, derived from the wallet id, is decoration (stable, meaningless);
 *   - the balance colour is information (green when funded, muted at zero).
 *
 * A funded tile gets full weight; a zero-balance tile is dimmed so a wall of
 * identical empty wallets cannot hide the one holding value.
 */

/**
 * Deterministic dot colour for a wallet.
 *
 * Derived from the id so it is stable across renders, restarts, and filter
 * changes — the dot must not move when the list is reordered or filtered.
 */
export function dotFor(id) {
  const key = String(id || "");
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 100000;
  }
  return `var(--nc-dot-${(hash % 8) + 1})`;
}

export default function WalletTile({
  wallet,
  label,
  detail,
  loading = false,
  opening = false,
  onOpen,
  onMenu,
  onSend,
  onReceive,
}) {
  const [copied, setCopied] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: wallet.id,
    /*
     * dnd-kit animates neighbours into their new slots with a CSS transition
     * of its own choosing. Pinning it to the app's slow token and ease-out
     * means a reorder settles at the same tempo as every other surface here —
     * dnd-kit takes plain values, so these cannot read the CSS custom
     * properties and are kept in step with them by hand.
     */
    transition: { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  });

  const address = detail?.address || null;
  const balanceNano = detail?.balanceNano ?? null;
  // A malformed balance must never take the grid down, so this cannot throw.
  const funded = (() => {
    try {
      return balanceNano != null && BigInt(balanceNano) > 0n;
    } catch {
      return false;
    }
  })();
  const unreadable = Boolean(detail?.balanceError);

  const copy = (event) => {
    event.stopPropagation();
    if (!address) return;
    copyToClipboard(String(address));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  /*
   * Pointer drags are taken from the *whole tile*, because that is what people
   * actually try to grab — a handle-only drag reads as "the tiles don't move".
   * Keyboard activation stays on the focusable grip, so the two do not fight:
   * every pointerdown would otherwise start two drags at once.
   */
  const pointerListeners = listeners?.onPointerDown
    ? { onPointerDown: listeners.onPointerDown }
    : listeners || {};
  const keyboardListeners = listeners?.onKeyDown
    ? { onKeyDown: listeners.onKeyDown }
    : {};

  return (
    <div
      ref={setNodeRef}
      {...pointerListeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Above its neighbours while lifted, so the drop target shows through.
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn(
        "group relative cursor-grab touch-none active:cursor-grabbing",
        isDragging && "cursor-grabbing",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(wallet)}
        aria-label={`Open ${label}`}
        className={cn(
          "flex min-h-[8.5rem] w-full flex-col items-start gap-1.5 rounded-xl border border-border p-3.5 pt-9 text-left",
          "nc-press-surface",
          /*
            Gold marks the wallet you are acting on. This ring used to be the
            cool blue border, which is also what keyboard focus and the active
            nav marker use — so "the wallet in play" and "where the keyboard
            is" looked the same, and neither read as the subject.
          */
          "hover:border-[var(--nc-gold)] focus-visible:border-[var(--nc-gold)]",
          "hover:ring-1 hover:ring-[var(--nc-gold)]/35",
          "focus-visible:ring-1 focus-visible:ring-[var(--nc-gold)]/55 focus-visible:outline-[var(--nc-gold)]",
          funded ? "bg-card" : "bg-card/60 opacity-75 hover:opacity-100",
          opening && "opacity-60",
          // The lifted state: elevated surface, shadow, slight scale.
          isDragging &&
            "border-[var(--nc-gold)] ring-1 ring-[var(--nc-gold)]/55 bg-[image:var(--nc-surface-2)] shadow-[var(--nc-shadow-2)] backdrop-blur-[var(--nc-glass-2)] scale-[1.02]",
        )}
      >
        <span className="flex w-full items-center gap-2">
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: dotFor(wallet.id) }}
            aria-hidden="true"
          />
          <span
            className={cn(
              "min-w-0 grow truncate text-sm font-semibold",
              funded ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
        </span>

        <span
          className={cn(
            "nc-figure tabular-nums",
            funded ? "text-success" : "text-foreground/70",
          )}
        >
          {unreadable ? (
            <span className="text-muted-foreground" title={detail.balanceError}>
              —
            </span>
          ) : loading && balanceNano == null ? (
            <Skeleton className="h-5 w-24" />
          ) : balanceNano == null ? (
            "—"
          ) : (
            <AmountValue value={balanceNano} suffix=" TON" />
          )}
        </span>

        <span className="nc-mono mt-auto w-full truncate text-muted-foreground">
          {truncateAddress(address) || "—"}
        </span>

        {/* Inline actions: on hover/focus for every tile, never only the first. */}
        <span className="mt-1 flex w-full gap-1.5 opacity-0 transition-opacity duration-[var(--nc-dur)] group-hover:opacity-100 group-focus-within:opacity-100">
          <TileAction
            label={copied ? "Copied" : "Copy address"}
            onClick={copy}
            disabled={!address}
          >
            {copied ? (
              <HiOutlineCheck className="size-3.5 text-success" />
            ) : (
              <HiOutlineDocumentDuplicate className="size-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </TileAction>

          {/* Send is meaningless with nothing to send, but stays in the layout
              (disabled) so the row cannot reflow between tiles. */}
          <TileAction
            label={`Send from ${label}`}
            onClick={() => onSend?.(wallet)}
            disabled={!funded}
          >
            <HiOutlineArrowUpTray className="size-3.5" />
            Send
          </TileAction>

          <TileAction
            label={`Receive to ${label}`}
            onClick={() => onReceive?.(wallet)}
          >
            <HiOutlineArrowDownTray className="size-3.5" />
            Receive
          </TileAction>
        </span>
      </button>

      {/*
        Drag handle. Faint until the tile is hovered, but always focusable so the
        keyboard sensor can reach it — this is the whole reason reordering is not
        mouse-only.
      */}
      <button
        type="button"
        {...attributes}
        {...keyboardListeners}
        className={cn(
          "absolute left-2 top-2 flex size-6 items-center justify-center rounded",
          "text-muted-foreground/50 transition-opacity duration-[var(--nc-dur)]",
          "group-hover:text-foreground focus-visible:text-foreground",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--nc-focus)]",
        )}
        aria-label={`Reorder ${label}`}
      >
        <HiOutlineBars3 className="size-3.5" />
      </button>

      <div className="absolute right-2.5 top-2.5 opacity-0 transition-opacity duration-[var(--nc-dur)] group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onMenu(event, wallet);
          }}
          aria-label={`Actions for ${label}`}
          className={cn(
            "flex size-7 items-center justify-center rounded-md border border-transparent",
            "bg-popover/80 text-muted-foreground hover:border-border hover:text-foreground",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--nc-focus)]",
          )}
        >
          <HiOutlineEllipsisHorizontal className="size-4" />
        </button>
      </div>
    </div>
  );
}

function TileAction({ children, label, onClick, disabled = false }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
      className={cn(
        "nc-press flex flex-1 items-center justify-center gap-1 rounded-lg border border-border bg-secondary/60 px-1.5 py-1.5",
        "text-[10px] font-medium text-muted-foreground",
        "hover:border-[var(--nc-border-active)] hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--nc-focus)]",
      )}
    >
      {children}
    </button>
  );
}
