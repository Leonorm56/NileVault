import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { HiOutlineKey } from "react-icons/hi2";

import Button from "./Button";
import Field from "./Field";
import PasswordInput from "./PasswordInput";
import nileWalletClient from "@/lib/nileWalletClient";
import toast from "react-hot-toast";

/**
 * Vault unlock / passphrase form.
 *
 * Shared by the in-wallet locked banner and the app-level Unlock screen. When
 * `configured` is false it doubles as the "set a passphrase" step (with a
 * confirm field).
 *
 * Mismatched confirmation is now reported inline as you type rather than as a
 * toast after you submit, and the submit button shows a spinner while scrypt
 * runs (it is deliberately slow, which previously looked like a frozen button).
 */
export default function UnlockForm({ configured, submitLabel, onUnlocked, busy }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const unlockMutation = useMutation({
    mutationFn: (pass) => nileWalletClient.unlock(pass),
  });

  const mismatch = !configured && confirm.length > 0 && password !== confirm;
  const canSubmit =
    password.length > 0 && (configured || (confirm.length > 0 && !mismatch));

  const submit = useCallback(
    (event) => {
      event.preventDefault();
      if (!canSubmit || unlockMutation.isPending) return;
      setError("");
      unlockMutation
        .mutateAsync(password)
        .then(() => {
          setPassword("");
          setConfirm("");
          toast.success(configured ? "Vault unlocked" : "Vault created");
          onUnlocked?.();
        })
        .catch((failure) => {
          setPassword("");
          setConfirm("");
          const message =
            failure?.code === "bad-passphrase"
              ? "Wrong passphrase"
              : failure?.message || "Failed to unlock";
          setError(message);
          toast.error(message);
        });
    },
    [password, canSubmit, configured, unlockMutation, onUnlocked],
  );

  const pending = Boolean(busy) || unlockMutation.isPending;

  return (
    <form onSubmit={submit} className="nc-card nc-stack p-4">
      <div className="flex items-center gap-2">
        <HiOutlineKey className="size-4 text-nile-gold-500" />
        <h3 className="font-bold">
          {configured ? "Unlock NileVault" : "Set a vault passphrase"}
        </h3>
      </div>

      <p className="nc-caption leading-relaxed">
        {configured
          ? "Enter your vault passphrase to continue."
          : "One passphrase secures every wallet on this device. It is never stored — you'll re-enter it after NileVault restarts."}
      </p>

      <Field label="Vault passphrase" error={error}>
        <PasswordInput
          autoFocus
          value={password}
          placeholder="Vault passphrase"
          onChange={(event) => {
            setPassword(event.target.value);
            if (error) setError("");
          }}
          disabled={pending}
          invalid={Boolean(error)}
        />
      </Field>

      {!configured ? (
        <Field
          label="Confirm passphrase"
          error={mismatch ? "Passphrases do not match" : ""}
          success={!mismatch && confirm.length > 0 ? "Passphrases match" : ""}
        >
          <PasswordInput
            value={confirm}
            placeholder="Confirm passphrase"
            onChange={(event) => setConfirm(event.target.value)}
            disabled={pending}
            invalid={mismatch}
          />
        </Field>
      ) : null}

      <Button type="submit" size="block" loading={pending} disabled={!canSubmit}>
        {configured ? submitLabel || "Unlock" : "Set passphrase"}
      </Button>
    </form>
  );
}
