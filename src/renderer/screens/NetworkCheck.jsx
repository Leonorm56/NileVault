import Button from "@/components/Button";
import Container from "@/components/Container";
import { cn } from "@/utils";
import { useCallback, useEffect, useState } from "react";
import {
  HiOutlineArrowPath,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
} from "react-icons/hi2";
import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";

const CARD =
  "border bg-white/70 dark:bg-white/[0.06] backdrop-blur-md shadow-sm rounded-xl";

/**
 * Informational connectivity probe. The main process already runs each fetch
 * with a 3s timeout, so this never hangs — and it is *advisory only*: a
 * Continue button is always offered (worded "Continue anyway" if an endpoint
 * is down) so a flaky probe can never trap the user out of the app.
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

  const anyOk = results.some((r) => r.ok);
  const loading = state === "loading";

  return (
    <Container className="flex flex-col gap-4 pt-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <img src={NileVaultLogo} className="size-14 rounded-xl" alt="" />
        <h1 className="text-2xl font-bold font-turret-road text-nile-gold-500">
          NileVault
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {loading
            ? "Checking network connectivity…"
            : anyOk
              ? "Network reachable."
              : "Some endpoints are unreachable — you can still continue."}
        </p>
      </div>

      <div className={cn(CARD, "flex flex-col gap-2 p-4")}>
        {loading && results.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-4 text-neutral-400">
            <HiOutlineArrowPath className="size-4 animate-spin" />
            Testing endpoints…
          </div>
        ) : (
          results.map((r) => (
            <div key={r.name} className="flex items-center gap-2 text-sm">
              {r.ok ? (
                <HiOutlineCheckCircle className="size-4 shrink-0 text-green-500" />
              ) : (
                <HiOutlineXCircle className="size-4 shrink-0 text-red-500" />
              )}
              <span className="grow truncate">{r.name}</span>
              <span
                className={cn(
                  "font-mono text-xs shrink-0",
                  r.ok ? "text-green-500" : "text-red-500",
                )}
              >
                {r.ok ? `${r.latency}ms` : "unreachable"}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" onClick={runCheck} disabled={loading}>
          <HiOutlineArrowPath
            className={cn("size-4", loading && "animate-spin")}
          />
          Retry
        </Button>
        <Button className="grow" onClick={onContinue} disabled={loading}>
          {anyOk ? "Continue" : "Continue anyway"}
        </Button>
      </div>
    </Container>
  );
}
