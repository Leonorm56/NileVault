import { useQuery, useQueryClient } from "@tanstack/react-query";

import Container from "@/components/Container";
import ScreenHeader from "@/components/ScreenHeader";
import UnlockForm from "@/components/UnlockForm";
import nileWalletClient from "@/lib/nileWalletClient";

/**
 * App-level lock screen.
 *
 * The single vault passphrase gates every wallet. When the vault has never been
 * configured this doubles as the "set a passphrase" step (UnlockForm shows a
 * confirm field). Unlocking invalidates the shared vault-status query, which
 * flips App over to the picker.
 *
 * Shares the network-check screen's composition — lockup, one line of context,
 * then a single card — so the two pre-vault screens no longer look like two
 * different apps.
 */
export default function Unlock() {
  const queryClient = useQueryClient();

  const vaultQuery = useQuery({
    queryKey: ["nile-vault-status"],
    queryFn: () => nileWalletClient.vaultStatus(),
  });
  const configured = Boolean(vaultQuery.data?.configured);

  return (
    <Container
      size="auth"
      className="flex min-h-screen flex-col items-center justify-center gap-7"
    >
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
