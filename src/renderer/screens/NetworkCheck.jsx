import { useCallback, useEffect, useState } from "react";
import {
  HiOutlineArrowPath,
  HiOutlineCheck,
  HiOutlineXMark,
} from "react-icons/hi2";

import Button from "@/components/Button";
import Container from "@/components/Container";
import ScreenHeader from "@/components/ScreenHeader";
import { Skeleton } from "@/components/Skeleton";
import { cn } from "@/utils";

/**
 * Informational connectivity probe.
 *
 * The main process runs each fetch with a 3s timeout, so this never hangs — and
 * it is *advisory only*: a Continue button is always offered (worded "Continue
 * anyway" if an endpoint is down) so a flaky probe can never trap the user out
 * of the app.
 *
 * Rows arrive as skeletons and then stagger in, instead of a single pop when the
 * probe resolves. Each result is a filled badge rather than a bare glyph: a
 * green circle reads as "passed" at a glance, where an outline icon does not.
 */
export default function NetworkCheck({ onContinue }) {
  const [state, setState] = useState("loading"); // loading | done
  const [results, setResults] = useState([]);

  const runCheck = useCallback(() => {
    setState("loading");
    window.nilevault
      .checkConnectivity()
      .then((res) => setResults(res?.results || []))
      .catch(() => setResults([]))
      .finally(() => setState("done"));
  }, []);

  useEffect(() => {
    runCheck();
  }, [runCheck]);

  const loading = state === "loading";
  const anyOk = results.some((result) => result.ok);
  const subtitle = loading
    ? "Checking network connectivity…"
    : anyOk
      ? "Network reachable."
      : "Some endpoints are unreachable — you can still continue.";
  const tone = loading ? "muted" : anyOk ? "success" : "danger";

  return (
    <Container
      size="auth"
      className="flex min-h-screen flex-col items-center justify-center gap-7"
    >
      <ScreenHeader subtitle={subtitle} tone={tone} />

      <div className="nc-card w-full overflow-hidden p-0">
        <div className="flex flex-col divide-y divide-border/60">
          {loading && results.length === 0
            ? [0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 px-4 py-3.5"
                  aria-hidden="true"
                >
                  <Skeleton className="size-6" rounded="rounded-full" />
                  <Skeleton className="h-3 grow" />
                  <Skeleton className="h-3 w-12" />
                </div>
              ))
            : results.map((result, index) => (
                <div
                  key={result.name}
                  className="nc-anim-rise flex items-center gap-3 px-4 py-3.5"
                  style={{ animationDelay: `${index * 60}ms` }}
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full",
                      result.ok
                        ? "bg-success text-success-foreground"
                        : "bg-destructive/15 text-destructive",
                    )}
                  >
                    {result.ok ? (
                      <HiOutlineCheck className="size-3.5" />
                    ) : (
                      <HiOutlineXMark className="size-3.5" />
                    )}
                  </span>

                  <span className="grow truncate text-sm">{result.name}</span>

                  <span
                    className={cn(
                      "shrink-0 text-sm font-medium tabular-nums",
                      result.ok ? "text-success" : "text-destructive",
                    )}
                  >
                    {result.ok ? `${result.latency}ms` : "unreachable"}
                  </span>
                </div>
              ))}
        </div>

        {/* Equal halves, inside the card: an outline Retry beside the one gold
            action. Continue is never disabled — a failed probe is advisory. */}
        <div className="flex gap-3 border-t border-border/60 p-4">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={runCheck}
            disabled={loading}
            loading={loading}
          >
            {loading ? null : <HiOutlineArrowPath className="size-4" />}
            Retry
          </Button>
          <Button className="flex-1" onClick={onContinue} disabled={loading}>
            {anyOk ? "Continue" : "Continue anyway"}
          </Button>
        </div>
      </div>
    </Container>
  );
}
