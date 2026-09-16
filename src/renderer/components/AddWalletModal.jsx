import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { HiOutlinePlus } from "react-icons/hi2";

import Button from "@/components/Button";
import Field from "@/components/Field";
import Input from "@/components/Input";
import Modal from "@/components/Modal";
import nileWalletClient from "@/lib/nileWalletClient";
import toast from "react-hot-toast";

/**
 * Add a NileWallet instance.
 *
 * NileVault only names the instance here — the seed is created or imported
 * *inside* the wallet (NileWallet's own WalletSetup), so this does not derive
 * keys itself. On create it hands the new registry entry back to the picker,
 * which opens it straight into setup.
 */
export default function AddWalletModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const createMutation = useMutation({
    mutationFn: (value) => nileWalletClient.createWallet(value),
  });

  const pending = createMutation.isPending;
  const trimmed = name.trim();

  const submit = (event) => {
    event.preventDefault();
    if (!trimmed || pending) return;
    setError("");
    createMutation
      .mutateAsync(trimmed)
      .then((res) => onCreated(res.wallet))
      .catch((failure) => {
        const message = failure?.message || "Failed to create wallet";
        setError(message);
        toast.error(message);
      });
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!pending}
      title="Add NileWallet"
      description="Give this wallet a name. You'll create a new recovery phrase or import an existing one inside it."
      icon={<HiOutlinePlus className="size-4" />}
      size="max-w-sm"
    >
      <form onSubmit={submit} className="nc-stack">
        <Field label="Wallet name" error={error}>
          <Input
            autoFocus
            value={name}
            placeholder="e.g. Main"
            maxLength={42}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError("");
            }}
            disabled={pending}
            invalid={Boolean(error)}
          />
        </Field>

        <div className="flex gap-2">
          <Button type="submit" size="block" loading={pending} disabled={!trimmed}>
            Create
          </Button>
          <Button
            variant="secondary"
            size="block"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
