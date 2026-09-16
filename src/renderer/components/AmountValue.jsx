import { useEffect, useRef, useState } from "react";

import { cn } from "@/utils";
import { formatAmount } from "@/lib/amount";

/** Ease-out cubic — fast start, gentle settle. */
const easeOut = (t) => 1 - (1 - t) ** 3;

/**
 * Animated amount.
 *
 * Balances, totals and token holdings previously jumped from "…" to a string in
 * one frame, and every 30s poll produced another visible pop. This interpolates
 * the raw base-unit value between the previous and the new figure, so a change
 * reads as a change rather than a flicker, and formats through the single shared
 * formatter at every frame.
 *
 * Values too large to interpolate as a Number, or when the user has asked for
 * reduced motion, render directly.
 */
export default function AmountValue({
  value,
  decimals = 9,
  maxFraction = 4,
  suffix = "",
  className,
  animate = true,
}) {
  const target = (() => {
    try {
      return BigInt(value ?? 0);
    } catch {
      return 0n;
    }
  })();

  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const frameRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (!animate || from === target) {
      fromRef.current = target;
      setDisplay(target);
      return undefined;
    }

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const delta = target - from;
    const deltaMagnitude = delta < 0n ? -delta : delta;
    if (reduceMotion || deltaMagnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
      fromRef.current = target;
      setDisplay(target);
      return undefined;
    }

    const start = performance.now();
    const duration = 420;
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const next = from + BigInt(Math.round(Number(delta) * easeOut(progress)));
      if (progress < 1) {
        setDisplay(next);
        frameRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, animate]);

  return (
    <span className={cn("tabular-nums", className)}>
      {formatAmount(display, { decimals, maxFraction })}
      {suffix}
    </span>
  );
}
