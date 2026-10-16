import { HiOutlineStar, HiOutlineTrash } from "react-icons/hi2";

import { cn } from "@/utils";

/**
 * AssetRow — one token holding (S03 assets list).
 *
 * Renders a pre-computed buildHomeModel row: `balanceDisplay` is already
 * masked or formatted by the model, so this component can never leak a
 * figure in hidden mode. Remove control stays with the token manager.
 */
export default function AssetRow({ row, sub, onRemove, removing }) {
  return (
    <div className="nc-card-interactive flex items-center justify-between gap-2 p-2.5">
      <div className="flex min-w-0 grow items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-accent text-sm font-semibold text-muted-foreground"
        >
          {(row.symbol || "?").slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 grow">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <span className="truncate">{row.symbol || "Unknown"}</span>
            {row.pinned ? (
              <HiOutlineStar
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label="Pinned"
              />
            ) : null}
          </p>
          {sub ? (
            <p className="nc-mono nc-caption truncate">{sub}</p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            // Figure tier: a holding's amount should out-weigh its label but
            // stay under the wallet balance.
            "text-lg font-semibold tabular-nums",
            row.balanceDisplay === "••••" ? "tracking-widest" : undefined,
          )}
        >
          {row.balanceDisplay}
        </span>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={removing}
            className="nc-card-interactive p-1.5 text-destructive"
            title="Remove token"
            aria-label={`Remove ${row.symbol || "token"}`}
          >
            <HiOutlineTrash className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
