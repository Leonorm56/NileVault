import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HiOutlineArrowLeft,
  HiOutlineLockClosed,
} from "react-icons/hi2";
import NetworkCheck from "./screens/NetworkCheck.jsx";
import Unlock from "./screens/Unlock.jsx";
import WalletPicker from "./screens/WalletPicker.jsx";
import NileWallet from "./app/NileWallet.jsx";
import AccountContext from "./contexts/AccountContext.js";
import nileWalletClient from "./lib/nileWalletClient.js";
import { cn } from "./utils/index.js";

/**
 * NileVault shell.
 *
 * Router: network → unlock → picker → wallet. The picker and wallet are
 * unreachable until the vault is unlocked; a header Lock button clears the
 * in-memory vault key (there is no idle timer — lock happens on restart or
 * manually, matching the NileWallet reference). Each opened wallet is the full
 * NileWallet screen rendered inside an AccountContext.Provider.
 */
export default function App() {
  const queryClient = useQueryClient();
  const [networkPassed, setNetworkPassed] = useState(false);
  const [selected, setSelected] = useState(null); // { id, name }
  const [version, setVersion] = useState("");

  useEffect(() => {
    window.nilevault?.getVersion?.().then(setVersion).catch(() => {});
  }, []);

  const vaultQuery = useQuery({
    queryKey: ["nile-vault-status"],
    queryFn: () => nileWalletClient.vaultStatus(),
    enabled: networkPassed,
  });
  const unlocked = Boolean(vaultQuery.data?.unlocked);

  const lock = useCallback(() => {
    nileWalletClient
      .lock()
      .catch(() => {})
      .finally(() => {
        setSelected(null);
        queryClient.invalidateQueries({ queryKey: ["nile-vault-status"] });
      });
  }, [queryClient]);

  let screen;
  if (!networkPassed) screen = "network";
  else if (vaultQuery.isLoading && !vaultQuery.data) screen = "loading";
  else if (!unlocked) screen = "unlock";
  else if (selected) screen = "wallet";
  else screen = "picker";

  return (
    <div className="min-h-screen flex flex-col text-neutral-900 dark:text-neutral-100">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-black/10 dark:border-white/10">
        {screen === "wallet" ? (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="inline-flex items-center gap-1 text-sm font-bold text-neutral-500 hover:text-nile-gold-500"
          >
            <HiOutlineArrowLeft className="size-4" />
            Wallets
          </button>
        ) : (
          <span className="font-bold font-turret-road text-nile-gold-500">
            NileVault
          </span>
        )}

        <span className="ml-auto text-xs text-neutral-400">
          {version ? `v${version}` : ""}
        </span>

        {unlocked ? (
          <button
            type="button"
            onClick={lock}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold",
              "border border-black/10 dark:border-white/10",
              "text-neutral-500 hover:text-nile-gold-500",
            )}
            title="Lock the vault"
          >
            <HiOutlineLockClosed className="size-3.5" />
            Lock
          </button>
        ) : null}
      </header>

      <main className="grow">
        {screen === "network" ? (
          <NetworkCheck onContinue={() => setNetworkPassed(true)} />
        ) : null}

        {screen === "loading" ? (
          <div className="flex items-center justify-center py-16 text-neutral-400">
            Loading…
          </div>
        ) : null}

        {screen === "unlock" ? <Unlock /> : null}

        {screen === "picker" ? (
          <WalletPicker onSelect={(w) => setSelected(w)} />
        ) : null}

        {screen === "wallet" && selected ? (
          <AccountContext.Provider
            value={{ id: selected.id, name: selected.name }}
          >
            <NileWallet />
          </AccountContext.Provider>
        ) : null}
      </main>
    </div>
  );
}
