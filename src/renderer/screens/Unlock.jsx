import Container from "@/components/Container";
import ScreenHeader from "@/components/ScreenHeader";
import UnlockForm from "@/components/UnlockForm";
import nileWalletClient from "@/lib/nileWalletClient";
import { useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * App-level lock screen.
 *
 * The single vault passphrase gates every wallet. When the vault has never been
 * configured this doubles as the "set a passphrase" step (UnlockForm shows a
 * confirm field). Unlocking invalidates the shared vault-status query, which
 * flips App over to the picker.
 */
export default function Unlock() {
  const queryClient = useQueryClient();

  const vaultQuery = useQuery({
    queryKey: ["nile-vault-status"],
    queryFn: () => nileWalletClient.vaultStatus(),
  });
  const configured = Boolean(vaultQuery.data?.configured);

  return (
    <Container size="sm" className="flex flex-col gap-4 pt-8">
      <ScreenHeader
        subtitle={
          configured
            ? "Unlock your vault to access your wallets."
            : "Set one passphrase to secure every wallet on this device."
        }
      />

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
