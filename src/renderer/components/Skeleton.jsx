import { cn } from "@/utils";

/**
 * Skeleton placeholder.
 *
 * Loading states previously printed bare text ("Loading wallets…") which then
 * reflowed into real content. A shimmer shaped like the final layout keeps the
 * page stable and reads as progress rather than as an empty screen.
 */
export function Skeleton({ className, rounded = "rounded-md" }) {
  return (
    <div
      aria-hidden="true"
      className={cn("nc-skeleton", rounded, className)}
    />
  );
}

/** A block of placeholder lines, e.g. for a list of rows. */
export function SkeletonRows({ rows = 3, className, rowClassName }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className={cn(
            "flex items-center gap-3 rounded-lg bg-white/[0.03] p-2",
            rowClassName,
          )}
        >
          <Skeleton className="size-8" rounded="rounded-full" />
          <div className="flex grow flex-col gap-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-2.5 w-16" />
          </div>
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder grid matching the wallet tiles. */
export function SkeletonTiles({ count = 4 }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="nc-card flex min-h-[7.5rem] flex-col gap-2 p-4">
          <Skeleton className="size-8" rounded="rounded-lg" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-auto h-2.5 w-28" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
