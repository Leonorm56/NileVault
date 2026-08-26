import Container from "@/components/Container";
import UnlockForm from "@/components/UnlockForm";
import nileWalletClient from "@/lib/nileWalletClient";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";

/**
 * App-level lock screen.
 *
 * The single vault passphrase gates every wallet. When the vault has never
 * been configured this doubles as the "set a passphrase" step (UnlockForm
 * shows a confirm field). Unlocking invalidates the shared vault-status query,
 * which flips App over to the picker.
 */
export default function Unlock() {
  const queryClient = useQueryClient();

  const vaultQuery = useQuery({
    queryKey: ["nile-vault-status"],
    queryFn: () => nileWalletClient.vaultStatus(),
  });
  const configured = Boolean(vaultQuery.data?.configured);

  return (
    <Container className="flex flex-col gap-4 pt-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <img src={NileVaultLogo} className="size-14 rounded-xl" alt="" />
        <h1 className="text-2xl font-bold font-turret-road text-nile-gold-500">
          NileVault
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {configured
            ? "Unlock your vault to access your wallets."
            : "Set one passphrase to secure every wallet on this device."}
        </p>
      </div>

      <UnlockForm
        configured={configured}
        submitLabel={configured ? "Unlock" : "Set passphrase"}
        busy={vaultQuery.isLoading}
        onUnlocked={() =>
          queryClient.invalidateQueries({ queryKey: ["nile-vault-status"] })
        }
      />
    </Container>
  );
}
