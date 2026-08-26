import Button from "./Button";
import PasswordInput from "./PasswordInput";
import nileWalletClient from "@/lib/nileWalletClient";
import toast from "react-hot-toast";
import { cn } from "@/utils";
import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";

const CARD =
  "border bg-white/70 dark:bg-white/[0.06] backdrop-blur-md shadow-sm rounded-xl";

/**
 * Vault unlock / passphrase form.
 *
 * Extracted from NileWallet.jsx so both the in-wallet locked banner and the
 * app-level Unlock screen render the same control. When `configured` is false
 * it doubles as the "set a passphrase" step (with a confirm field).
 */
export default function UnlockForm({ configured, submitLabel, onUnlocked, busy }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const unlockMutation = useMutation({
    mutationFn: (pass) => nileWalletClient.unlock(pass),
  });

  const submit = useCallback(
    (ev) => {
      ev.preventDefault();
      if (!password) return;
      if (!configured && password !== confirm) {
        toast.error("Passphrases do not match");
        return;
      }
      unlockMutation
        .mutateAsync(password)
        .then(() => {
          setPassword("");
          setConfirm("");
          onUnlocked?.();
        })
        .catch((error) => {
          toast.error(
            error?.code === "bad-passphrase"
              ? "Wrong passphrase"
              : error?.message || "Failed to unlock",
          );
        });
    },
    [password, confirm, configured, unlockMutation, onUnlocked],
  );

  const pending = busy || unlockMutation.isPending;

  return (
    <form onSubmit={submit} className={cn(CARD, "flex flex-col gap-2 p-4")}>
      <h3 className="font-bold">
        {configured ? "Unlock NileWallet" : "Set a vault passphrase"}
      </h3>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {configured
          ? "Enter your vault passphrase to continue."
          : "One passphrase secures every wallet on this device. It is never stored — you'll re-enter it after NileVault restarts."}
      </p>

      <PasswordInput
        autoFocus
        value={password}
        placeholder="Vault passphrase"
        onChange={(e) => setPassword(e.target.value)}
        disabled={pending}
      />
      {!configured ? (
        <PasswordInput
          value={confirm}
          placeholder="Confirm passphrase"
          onChange={(e) => setConfirm(e.target.value)}
          disabled={pending}
        />
      ) : null}

      <Button type="submit" disabled={pending || !password}>
        {pending ? "Please wait…" : submitLabel || "Unlock"}
      </Button>
    </form>
  );
}
