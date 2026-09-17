import { Dialog } from "radix-ui";
import { HiOutlineGlobeAlt, HiOutlineShieldCheck } from "react-icons/hi2";

import Button from "./Button";
import { cn } from "@/utils";
import { truncateAddress } from "@/lib/address.js";
import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";

/**
 * NileWalletConnectModal — the TON Connect approval sheet.
 *
 * Presentational only: the parent owns open state and the approve/reject
 * actions. Radix supplies the focus trap and Esc handling; the styling uses the
 * same surfaces, radius and motion tokens as every other dialog so the app has
 * one dialog language rather than three.
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

  // `items` comes straight from the link, so it is only an array by convention —
  // a malformed value must not take the approval sheet down with it.
  const requestedItems = Array.isArray(request?.items) ? request.items : [];
  const wantsProof = requestedItems.some((item) => item?.name === "ton_proof");
  const truncated = truncateAddress(address);

  return (
    <Dialog.Root open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "nc-anim-fade fixed inset-0 z-[60] flex items-center justify-center overflow-auto",
            "bg-neutral-950/80 p-4 backdrop-blur-sm",
          )}
        >
          <Dialog.Content
            onOpenAutoFocus={(event) => event.preventDefault()}
            className={cn(
              "nc-anim-scale my-auto flex w-full max-w-sm flex-col gap-4 p-5",
              "rounded-2xl border border-nile-gold-500/25 bg-neutral-900/95 shadow-2xl backdrop-blur-xl",
            )}
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex size-14 items-center justify-center rounded-full border border-nile-gold-500/40 bg-nile-gold-500/10">
                <img
                  src={NileVaultLogo}
                  className="size-8 rounded-lg"
                  alt="NileVault"
                />
              </div>
              <Dialog.Title className="nc-title text-lg">
                Connect Wallet
              </Dialog.Title>
              <Dialog.Description className="nc-body text-center text-neutral-400">
                A dApp wants to connect to your NileWallet.
              </Dialog.Description>
            </div>

            {/* Requesting app */}
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3">
              {manifest.iconUrl ? (
                <img
                  src={manifest.iconUrl}
                  className="size-10 shrink-0 rounded-lg bg-white/10 object-cover"
                  alt={appName}
                />
              ) : (
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <HiOutlineGlobeAlt className="size-5 text-neutral-300" />
                </div>
              )}
              <div className="flex min-w-0 grow flex-col">
                <span className="truncate font-bold">{appName}</span>
                <span className="nc-caption truncate">{appHost}</span>
              </div>
            </div>

            {/* Account row */}
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-nile-gold-500/30 bg-nile-gold-500/10">
                <img src={NileVaultLogo} className="size-5 rounded-md" alt="" />
              </div>
              <div className="flex min-w-0 grow flex-col">
                <span className="nc-caption">Connecting as</span>
                <span
                  data-selectable
                  className="nc-mono truncate font-bold text-neutral-100"
                >
                  {truncated || "—"}
                </span>
              </div>
            </div>

            {wantsProof ? (
              <div className="flex items-start gap-2 text-xs text-neutral-400">
                <HiOutlineShieldCheck className="mt-0.5 size-4 shrink-0 text-nile-gold-400" />
                <span>
                  This app requests a signed proof of ownership. NileWallet signs
                  it with this account's key — no funds move.
                </span>
              </div>
            ) : null}

            <div className="flex gap-2 pt-1">
              <Button
                variant="secondary"
                size="block"
                onClick={onReject}
                disabled={busy}
              >
                Reject
              </Button>
              <Button
                size="block"
                onClick={onApprove}
                loading={busy}
                disabled={busy || !address}
              >
                Approve
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
