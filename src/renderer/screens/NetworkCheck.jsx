import { useCallback, useEffect, useState } from "react";
import {
  HiOutlineArrowPath,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
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
 * probe resolves.
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

  const anyOk = results.some((result) => result.ok);
  const loading = state === "loading";

  return (
    <Container size="sm" className="flex flex-col gap-4 pt-8">
      <ScreenHeader
        subtitle={
          loading
            ? "Checking network connectivity…"
            : anyOk
              ? "Network reachable."
              : "Some endpoints are unreachable — you can still continue."
        }
      />

      <div className="nc-card flex flex-col gap-2 p-4">
        {loading && results.length === 0 ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-2 py-1">
                <Skeleton className="size-4" rounded="rounded-full" />
                <Skeleton className="h-3 grow" />
                <Skeleton className="h-3 w-12" />
              </div>
            ))}
          </div>
        ) : (
          results.map((result, index) => (
            <div
              key={result.name}
              className="nc-anim-rise flex items-center gap-2 text-sm"
              style={{ animationDelay: `${index * 60}ms` }}
            >
              {result.ok ? (
                <HiOutlineCheckCircle className="size-4 shrink-0 text-emerald-500" />
              ) : (
                <HiOutlineXCircle className="size-4 shrink-0 text-red-500" />
              )}
              <span className="grow truncate">{result.name}</span>
              <span
                className={cn(
                  "nc-mono shrink-0 tabular-nums",
                  result.ok ? "text-emerald-500" : "text-red-500",
                )}
              >
                {result.ok ? `${result.latency}ms` : "unreachable"}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={runCheck}
          disabled={loading}
          loading={loading}
        >
          {loading ? null : <HiOutlineArrowPath className="size-4" />}
          Retry
        </Button>
        <Button className="grow" onClick={onContinue} disabled={loading}>
          {anyOk ? "Continue" : "Continue anyway"}
        </Button>
      </div>
    </Container>
  );
}
