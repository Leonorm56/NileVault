import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HiOutlineArrowLeft, HiOutlineCheckCircle, HiOutlineLockClosed, HiOutlineExclamationTriangle } from "react-icons/hi2";

import Button from "./components/Button";
import NetworkCheck from "./screens/NetworkCheck.jsx";
import Unlock from "./screens/Unlock.jsx";
import WalletPicker from "./screens/WalletPicker.jsx";
import NileWallet from "./app/NileWallet.jsx";
import AccountContext from "./contexts/AccountContext.js";
import nileWalletClient from "./lib/nileWalletClient.js";
import { cn } from "./utils/index.js";

/** Screen order, used to decide which way a transition should travel. */
const ORDER = ["network", "loading", "unlock", "picker", "wallet"];

/**
 * NileVault shell.
 *
 * Router: network → unlock → picker → wallet. The picker and wallet are
 * unreachable until the vault is unlocked; the header Lock button clears the
 * in-memory vault key (there is no idle timer — lock happens on restart or
 * manually). Each opened wallet is the full NileWallet screen rendered inside an
 * AccountContext.Provider.
 *
 * Screens are swapped with a directional entrance animation instead of the
 * previous hard cut, and every screen is wrapped in the same centred frame as
 * the header so the layout stays coherent at any window size.
 */
export default function App() {
  const queryClient = useQueryClient();
  const [networkPassed, setNetworkPassed] = useState(false);
  const [selected, setSelected] = useState(null); // { id, name }
  const [version, setVersion] = useState("");
  const [locking, setLocking] = useState(false);
  const [networkStatus, setNetworkStatus] = useState(null); // null | "ok" | "degraded"
  const previousScreenRef = useRef("network");
  const [transition, setTransition] = useState("nc-anim-rise");

  useEffect(() => {
    window.nilevault?.getVersion?.().then(setVersion).catch(() => {});
  }, []);

  /* Network status — checked once on mount and after each network screen pass. */
  const checkNetwork = useCallback(() => {
    window.nilevault
      ?.checkConnectivity()
      .then((res) => {
        const anyOk = res?.results?.some((r) => r.ok);
        setNetworkStatus(anyOk ? "ok" : "degraded");
      })
      .catch(() => setNetworkStatus(null));
  }, []);

  useEffect(() => {
    if (networkPassed) checkNetwork();
  }, [networkPassed, checkNetwork]);

  const vaultQuery = useQuery({
    queryKey: ["nile-vault-status"],
    queryFn: () => nileWalletClient.vaultStatus(),
    enabled: networkPassed,
  });
  const unlocked = Boolean(vaultQuery.data?.unlocked);

  const screen = useMemo(() => {
    if (!networkPassed) return "network";
    if (vaultQuery.isLoading && !vaultQuery.data) return "loading";
    if (!unlocked) return "unlock";
    if (selected) return "wallet";
    return "picker";
  }, [networkPassed, vaultQuery.isLoading, vaultQuery.data, unlocked, selected]);

  /* Pick a transition direction whenever the screen changes. */
  useEffect(() => {
    const from = ORDER.indexOf(previousScreenRef.current);
    const to = ORDER.indexOf(screen);
    if (from !== to) {
      if (previousScreenRef.current === "picker" && screen === "wallet") {
        setTransition("nc-anim-slide-left");
      } else if (previousScreenRef.current === "wallet" && screen === "picker") {
        setTransition("nc-anim-slide-right");
      } else {
        setTransition(to < from ? "nc-anim-slide-right" : "nc-anim-rise");
      }
    }
    previousScreenRef.current = screen;
  }, [screen]);

  const lock = useCallback(() => {
    setLocking(true);
    nileWalletClient
      .lock()
      .catch(() => {})
      .finally(() => {
        setSelected(null);
        setLocking(false);
        queryClient.invalidateQueries({ queryKey: ["nile-vault-status"] });
      });
  }, [queryClient]);

  const goToPicker = useCallback(() => setSelected(null), []);

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Header chrome ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-neutral-950/80 backdrop-blur-xl">
        <div className="mx-auto flex w-full items-center gap-3 px-5 py-2.5">
          {screen === "wallet" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={goToPicker}
              className="-ml-2"
            >
              <HiOutlineArrowLeft className="size-4" />
              Wallets
            </Button>
          ) : (
            <span className="nc-title select-none text-lg leading-none">
              NileVault
            </span>
          )}

          {/* Version — next to logo, not pushed to the far right */}
          {version ? (
            <span className="nc-caption tabular-nums opacity-50">
              v{version}
            </span>
          ) : null}

          {/* Network status indicator */}
          {networkPassed && networkStatus ? (
            <span
              className={cn(
                "ml-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold",
                networkStatus === "ok"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400",
              )}
            >
              {networkStatus === "ok" ? (
                <HiOutlineCheckCircle className="size-3" />
              ) : (
                <HiOutlineExclamationTriangle className="size-3" />
              )}
              {networkStatus === "ok" ? "Connected" : "Degraded"}
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {unlocked ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={lock}
                loading={locking}
                title="Lock the vault"
              >
                {locking ? null : <HiOutlineLockClosed className="size-3.5" />}
                {locking ? "Locking" : "Lock"}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {/* ── Screen ────────────────────────────────────────────────────── */}
      <main className="grow">
        <div key={screen} className={transition}>
          {screen === "network" ? (
            <NetworkCheck onContinue={() => setNetworkPassed(true)} />
          ) : null}

          {screen === "loading" ? (
            <div className="mx-auto w-full max-w-md px-5 py-16 text-center">
              <p className="nc-body text-neutral-400">Opening your vault…</p>
            </div>
          ) : null}

          {screen === "unlock" ? <Unlock /> : null}

          {screen === "picker" ? (
            <WalletPicker onSelect={(wallet) => setSelected(wallet)} />
          ) : null}

          {screen === "wallet" && selected ? (
            <AccountContext.Provider
              value={{ id: selected.id, name: selected.name }}
            >
              <NileWallet />
            </AccountContext.Provider>
          ) : null}
        </div>
      </main>
    </div>
  );
}
