import { cn } from "@/utils";
import { Dialog } from "radix-ui";
import { HiOutlineGlobeAlt, HiOutlineShieldCheck } from "react-icons/hi2";
import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";

/**
 * NileWalletConnectModal
 *
 * NileChain's own TON Connect approval screen. Visual layout is inspired by
 * MyTonWallet's connect sheet (dark surface, gold accent, app card, address
 * row, Approve/Reject) but is written fresh against NileChain's own theme —
 * no MyTonWallet code is reused.
 *
 * Presentational only: parent owns open state and the approve/reject actions.
 */
export default function NileWalletConnectModal({
  open,
  onOpenChange,
  request,
  address,
  busy = false,
  onApprove,
  onReject,
}) {
  const manifest = request?.manifest || {};
  const appName = manifest.name || "Unknown app";
  const appHost = (() => {
    try {
      return new URL(manifest.url || request?.manifestUrl).host;
    } catch {
      return manifest.url || request?.manifestUrl || "";
    }
  })();

  const wantsProof = (request?.items || []).some((i) => i.name === "ton_proof");
  const truncated = address
    ? `${address.slice(0, 6)}…${address.slice(-6)}`
    : "";

  return (
    <Dialog.Root open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-50",
            "flex items-center justify-center",
            "p-4 overflow-auto bg-black/70 backdrop-blur-sm",
          )}
        >
          <Dialog.Content
            onOpenAutoFocus={(ev) => ev.preventDefault()}
            className={cn(
              "my-auto flex flex-col w-full max-w-sm gap-4 p-5",
              "rounded-2xl border border-nile-gold-500/30",
              "bg-neutral-950 text-neutral-100 shadow-2xl",
            )}
          >
            {/* Header */}
            <div className="flex flex-col items-center gap-2 text-center">
              <div
                className={cn(
                  "flex items-center justify-center size-14 rounded-full",
                  "bg-nile-gold-500/10 border border-nile-gold-500/40",
                )}
              >
                <img src={NileVaultLogo} className="size-8 rounded-lg" alt="NileVault" />
              </div>
              <Dialog.Title className="text-lg font-bold text-nile-gold-400 font-turret-road">
                Connect Wallet
              </Dialog.Title>
              <Dialog.Description className="text-sm text-neutral-400">
                A dApp wants to connect to your NileWallet.
              </Dialog.Description>
            </div>

            {/* Requesting app */}
            <div
              className={cn(
                "flex items-center gap-3 p-3 rounded-xl",
                "bg-white/[0.04] border border-white/10",
              )}
            >
              {manifest.iconUrl ? (
                <img
                  src={manifest.iconUrl}
                  className="size-10 rounded-lg shrink-0 bg-white/10 object-cover"
                  alt={appName}
                />
              ) : (
                <div className="flex items-center justify-center size-10 rounded-lg shrink-0 bg-white/10">
                  <HiOutlineGlobeAlt className="size-5 text-neutral-300" />
                </div>
              )}
              <div className="flex flex-col min-w-0 grow">
                <span className="font-bold truncate">{appName}</span>
                <span className="text-xs text-neutral-400 truncate">
                  {appHost}
                </span>
              </div>
            </div>

            {/* Account row */}
            <div
              className={cn(
                "flex items-center gap-3 p-3 rounded-xl",
                "bg-white/[0.04] border border-white/10",
              )}
            >
              <div className="flex items-center justify-center size-10 rounded-full shrink-0 bg-nile-gold-500/10 border border-nile-gold-500/30">
                <img src={NileVaultLogo} className="size-5 rounded-md" alt="" />
              </div>
              <div className="flex flex-col min-w-0 grow">
                <span className="text-xs text-neutral-400">
                  Connecting as
                </span>
                <span className="font-mono font-bold truncate">
                  {truncated || "—"}
                </span>
              </div>
            </div>

            {/* Proof notice */}
            {wantsProof ? (
              <div className="flex items-start gap-2 text-xs text-neutral-400">
                <HiOutlineShieldCheck className="size-4 shrink-0 mt-0.5 text-nile-gold-400" />
                <span>
                  This app requests a signed proof of ownership. NileWallet will
                  sign it with this account's key — no funds are moved.
                </span>
              </div>
            ) : null}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={onReject}
                className={cn(
                  "grow px-4 py-3 rounded-xl font-bold",
                  "bg-white/[0.06] border border-white/10",
                  "hover:bg-white/[0.10] disabled:opacity-50",
                )}
              >
                Reject
              </button>
              <button
                type="button"
                disabled={busy || !address}
                onClick={onApprove}
                className={cn(
                  "grow px-4 py-3 rounded-xl font-bold",
                  "bg-nile-gold-500 text-neutral-950",
                  "hover:bg-nile-gold-400 disabled:opacity-50",
                )}
              >
                {busy ? "Connecting…" : "Approve"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
