import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HiOutlineArrowLeft, HiOutlineCheckCircle, HiOutlineCog6Tooth, HiOutlineLockClosed, HiOutlineExclamationTriangle, HiOutlinePaperAirplane, HiOutlineQrCode, HiOutlineStar, HiOutlineWallet } from "react-icons/hi2";

import AppShell from "./components/AppShell";
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
  // Section a wallet tap asked to land on ("send" / "receive" from a tile).
  const [pendingSection, setPendingSection] = useState(null);
  const [locking, setLocking] = useState(false);
  const [networkStatus, setNetworkStatus] = useState(null); // null | "ok" | "degraded"
  const previousScreenRef = useRef("network");
  const [transition, setTransition] = useState("nc-anim-rise");

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

  const scrollToSection = useCallback((id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /*
   * Open a wallet, optionally at a section.
   *
   * The wallet view mounts only once `selected` is set, so the scroll cannot
   * happen on the same tick — scrolling immediately finds no element and does
   * nothing at all. The pending id is consumed by the effect below, after the
   * wallet has rendered.
   */
  const openWallet = useCallback((wallet) => {
    setSelected(wallet);
    setPendingSection(wallet?.section || null);
  }, []);

  useEffect(() => {
    if (screen !== "wallet" || !pendingSection) return undefined;
    const id = pendingSection;
    setPendingSection(null);
    const frame = requestAnimationFrame(() => scrollToSection(id));
    return () => cancelAnimationFrame(frame);
  }, [screen, pendingSection, scrollToSection]);

  /*
   * The pre-vault screens are a single centered composition — lockup, line of
   * context, one card — matching the target design. The app chrome (connection
   * pill, Lock) only belongs once there is a vault to act on, so it is not
   * rendered before unlock.
   */
  const showChrome = screen === "picker" || screen === "wallet";

  const walletNav = useMemo(
    () => [
      { id: "overview", label: "Wallet", icon: HiOutlineWallet },
      { id: "send", label: "Send", icon: HiOutlinePaperAirplane },
      { id: "receive", label: "Receive", icon: HiOutlineQrCode },
      { id: "tokens", label: "Tokens", icon: HiOutlineStar },
      { id: "settings", label: "Settings", icon: HiOutlineCog6Tooth, disabled: true },
    ],
    [],
  );

  return (
    <div className="flex min-h-full flex-col">
      {/*
        ── Header chrome ─────────────────────────────────────────────────

        Floating chrome: translucent, and its boundary is *faded* rather than
        drawn as a 1px rule, so content dims into the bar as it scrolls under
        instead of stopping at a line.
      */}
      {showChrome ? (
      <header className="nc-scroll-edge sticky top-0 z-40 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full items-center gap-3 px-5 py-2.5">
          {/*
            The left edge belongs to wayfinding, never to branding.

            The wordmark and the version number were spending the most valuable
            slot in the layout on a name the user just launched and a build
            number nobody reads mid-task. What earns that slot instead is where
            you are and how to get out, and the vault's own state.
          */}
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
          ) : null}

          {/* Network status leads the bar, so the vault's state is the first
              thing read rather than something appended after the brand. */}
          {networkPassed && networkStatus ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold",
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
      ) : null}

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
            <WalletPicker networkStatus={networkStatus} onSelect={openWallet} />
          ) : null}

          {screen === "wallet" && selected ? (
            <AccountContext.Provider
              value={{ id: selected.id, name: selected.name }}
            >
              <AppShell
                items={walletNav}
                activeId="overview"
                onSelect={scrollToSection}
              >
                <NileWallet />
              </AppShell>
            </AccountContext.Provider>
          ) : null}
        </div>
      </main>
    </div>
  );
}
