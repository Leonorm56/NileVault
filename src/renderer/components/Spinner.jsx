import { cn } from "@/utils";

/**
 * Indeterminate progress ring.
 *
 * Inherits `currentColor` so it works on a gold fill and on a dark surface
 * alike, and is the one spinner every pending state uses — previously
 * `animate-spin` was hand-applied to whichever icon happened to be nearby,
 * which meant some pending states had no indicator at all.
 */
export default function Spinner({ className, size = 16 }) {
  return (
    <svg
      className={cn("animate-spin shrink-0", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
