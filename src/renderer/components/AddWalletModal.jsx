import Button from "@/components/Button";
import Input from "@/components/Input";
import nileWalletClient from "@/lib/nileWalletClient";
import toast from "react-hot-toast";
import { cn } from "@/utils";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

const CARD =
  "border bg-white/70 dark:bg-white/[0.06] backdrop-blur-md shadow-sm rounded-xl";

/**
 * Add a NileWallet instance.
 *
 * NileVault only names the instance here — the seed is created or imported
 * *inside* the wallet (NileWallet's own WalletSetup), so this no longer
 * derives keys itself. On create it hands the new registry entry back to the
 * picker, which opens it straight into setup.
 */
export default function AddWalletModal({ onClose, onCreated }) {
  const [name, setName] = useState("");

  const createMutation = useMutation({
    mutationFn: (value) => nileWalletClient.createWallet(value),
  });

  const submit = (ev) => {
    ev.preventDefault();
    const value = name.trim();
    if (!value) return;
    createMutation
      .mutateAsync(value)
      .then((res) => onCreated(res.wallet))
      .catch((error) =>
        toast.error(error?.message || "Failed to create wallet"),
      );
  };

  const pending = createMutation.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={pending ? undefined : onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className={cn(CARD, "flex flex-col gap-3 p-5 w-full max-w-sm")}
      >
        <h2 className="text-lg font-bold font-turret-road text-nile-gold-500">
          Add NileWallet
        </h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Give this wallet a name. You'll create a new recovery phrase or import
          an existing one inside it.
        </p>
        <Input
          autoFocus
          value={name}
          placeholder="e.g. Main"
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? "Creating…" : "Create"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
