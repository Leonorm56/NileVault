import NileVaultMark from "@/assets/images/nilevault-mark.png";
import { cn } from "@/utils";

/**
 * Brand block — lockup plus a one-line subtitle, for the pre-vault screens.
 *
 * The network-check and unlock screens each had their own copy of this markup,
 * which drifted. One component keeps them identical.
 *
 * The lockup is two stacked elements: the mark, then the wordmark — which is
 * the only place the name is written. There used to be a letter-spaced
 * "NILE VAULT" caption between them, so the same name appeared twice in one
 * block, once in muted caps and once in gold, competing for the same read.
 * The subtitle below changes tone — success for a reachable network, muted for
 * everything else — so "Network reachable." reads as a *status*, not body copy.
 */
export default function ScreenHeader({ subtitle, tone = "muted", className }) {
  return (
    <div className={cn("flex flex-col items-center text-center", className)}>
      {/*
        Just the mark. The source artwork had the "NILEVAULT" wordmark and a
        tagline baked into its lower third, so this box used to scale the image
        128% and crop the bottom away — a workaround every call site had to
        repeat. The asset itself is cropped to the blue N now.
      */}
      <img
        src={NileVaultMark}
        className="size-24 rounded-2xl shadow-[var(--nc-shadow-2)]"
        alt=""
      />

      <h1 className="nc-wordmark mt-4 text-4xl leading-none">NileVault</h1>

      {subtitle ? (
        <p
          className={cn(
            "mt-3 max-w-md text-sm",
            tone === "success"
              ? "font-medium text-success"
              : tone === "danger"
                ? "text-destructive"
                : "text-neutral-400",
          )}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
