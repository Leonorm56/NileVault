import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";
import { cn } from "@/utils";

/**
 * Brand block — logo, wordmark and a one-line subtitle.
 *
 * The network-check and unlock screens each had their own copy of this markup,
 * which drifted. One component keeps them identical.
 */
export default function ScreenHeader({ subtitle, className }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 text-center", className)}>
      <img
        src={NileVaultLogo}
        className="size-14 rounded-2xl border border-white/10 shadow-lg"
        alt=""
      />
      <h1 className="nc-title text-2xl">NileVault</h1>
      {subtitle ? (
        <p className="nc-body max-w-xs text-neutral-400">{subtitle}</p>
      ) : null}
    </div>
  );
}
