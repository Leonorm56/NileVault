/**
 * NileWallet — single-wallet detail screen.
 *
 * Sections use the five-level card hierarchy defined in index.css:
 *   Level 0 (Hero)    — balance display
 *   Level 1 (Primary) — send form, confirm
 *   Level 2 (Secondary) — tokens, backup, connect, passphrase
 *   Level 3 (Destructive) — danger zone, reveal seed
 *   Level 4 (Inline)  — status badges
 */

import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  HiOutlineArrowDownTray,
  HiOutlineArrowLeft,
  HiOutlineArrowPath,
  HiOutlineArrowUpTray,
  HiOutlineCheckCircle,
  HiOutlineDocumentDuplicate,
  HiOutlineEllipsisHorizontal,
  HiOutlineExclamationTriangle,
  HiOutlineEye,
  HiOutlineEyeSlash,
  HiOutlineKey,
  HiOutlineLink,
  HiOutlineLockClosed,
  HiOutlineLockOpen,
  HiOutlinePaperAirplane,
  HiOutlineQrCode,
  HiOutlineShieldCheck,
  HiOutlineTrash,
  HiOutlineWifi,
} from "react-icons/hi2";

import AddressRow from "@/components/AddressRow";
import AmountValue from "@/components/AmountValue";
import Button from "@/components/Button";
import ConfirmDialog from "@/components/ConfirmDialog";
import Container from "@/components/Container";
import Field from "@/components/Field";
import IconButton from "@/components/IconButton";
import Input from "@/components/Input";
import Modal from "@/components/Modal";
import NileWalletConnectModal from "@/components/NileWalletConnectModal";
import PasswordInput from "@/components/PasswordInput";
import { Skeleton, SkeletonRows } from "@/components/Skeleton";
import nileWalletClient, {
  MIN_BACKUP_PASSWORD_LENGTH,
  NileWalletLockedError,
} from "@/lib/nileWalletClient";
import { openTextFile, saveTextFile } from "@/lib/files.js";
import { parseTransferInput, truncateAddress } from "@/lib/address.js";
import { decToRaw } from "@/lib/amount.js";
import AccountContext from "@/contexts/AccountContext.js";
import UnlockForm from "@/components/UnlockForm";
import { cn } from "@/utils";
import TonCoinIcon from "@/assets/images/toncoin-ton-logo.svg";
import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";

/* ────────────────────────────────────────────────────────────────────────── */
/* Receive section — Level 2 (Secondary)                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function ReceiveSection({ address }) {
  if (!address) return null;
  return (
    <section id="receive" className="nc-card-secondary nc-stack">
      <h3 className="font-bold">Receive</h3>
      <AddressRow address={address} />
      <p className="nc-caption leading-relaxed">
        The address to receive TON and Jettons. Tap the row to copy.
      </p>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Tokens section — Level 2 (Secondary)                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function TokensSection({ accountId }) {
  const [addOpen, setAddOpen] = useState(false);
  const [tokenAddr, setTokenAddr] = useState("");
  const [error, setError] = useState("");

  const queryClient = useQueryClient();

  const tokensQuery = useQuery({
    queryKey: ["nile-wallet-tokens", accountId],
    queryFn: () => nileWalletClient.listTokens(accountId),
    enabled: !!accountId,
  });

  const jettonQuery = useQuery({
    queryKey: ["nile-wallet-token-balances", accountId],
    queryFn: () => nileWalletClient.jettonBalances(accountId),
    enabled: !!accountId && Boolean(tokensQuery.data?.length),
  });

  const addMutation = useMutation({
    mutationFn: (addr) => nileWalletClient.addToken(accountId, addr),
  });

  const removeMutation = useMutation({
    mutationFn: (addr) => nileWalletClient.removeToken(accountId, addr),
  });

  const handleAdd = async (event) => {
    event.preventDefault();
    if (!tokenAddr.trim() || addMutation.isPending) return;
    setError("");
    try {
      await addMutation.mutateAsync(tokenAddr.trim());
      toast.success("Token added");
      setTokenAddr("");
      setAddOpen(false);
      queryClient.invalidateQueries({
        queryKey: ["nile-wallet-tokens", accountId],
      });
    } catch (err) {
      setError(err?.message || "Failed to add token");
    }
  };

  const handleRemove = async (addr) => {
    try {
      await removeMutation.mutateAsync(addr);
      toast.success("Token removed");
      queryClient.invalidateQueries({
        queryKey: ["nile-wallet-tokens", accountId],
      });
      queryClient.invalidateQueries({
        queryKey: ["nile-wallet-token-balances", accountId],
      });
    } catch (err) {
      toast.error(err?.message || "Failed to remove token");
    }
  };

  const tokens = tokensQuery.data?.tokens || [];
  const balances = jettonQuery.data?.balances || {};

  return (
    <section className="nc-card-secondary nc-stack">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">Tokens</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setAddOpen(!addOpen);
            setError("");
          }}
        >
          {addOpen ? "Cancel" : "+ Add"}
        </Button>
      </div>

      {addOpen ? (
        <form onSubmit={handleAdd} className="nc-stack">
          <Field label="Jetton master address" error={error}>
            <Input
              autoFocus
              value={tokenAddr}
              onChange={(e) => {
                setTokenAddr(e.target.value);
                if (error) setError("");
              }}
              placeholder="EQ... or UQ..."
              disabled={addMutation.isPending}
            />
          </Field>
          <Button
            type="submit"
            size="block"
            loading={addMutation.isPending}
            disabled={!tokenAddr.trim()}
          >
            Add token
          </Button>
        </form>
      ) : tokens.length === 0 ? (
        <p className="nc-caption">No custom tokens added yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {tokens.map((token) => {
            const bal = balances[token.jetton_master_address];
            return (
              <div
                key={token.jetton_master_address}
                className="nc-card-interactive flex items-center justify-between p-2.5"
              >
                <div className="min-w-0 grow">
                  <p className="text-sm font-bold">{token.symbol || "Unknown"}</p>
                  <p className="nc-mono nc-caption truncate">
                    {token.jetton_master_address}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {bal != null ? (
                    <span className="text-sm font-bold tabular-nums">
                      {Number(bal).toLocaleString()}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleRemove(token.jetton_master_address)}
                    className="nc-card-interactive p-1.5 text-red-400"
                    title="Remove token"
                  >
                    <HiOutlineTrash className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tokens.length > 0 ? (
        <p className="nc-caption text-neutral-500">
          Token balances refresh every 30 seconds. Adding a token only adds it
          to this wallet and will have to request a new connection.
        </p>
      ) : null}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Token picker — asset pills (TON + added Jettons, balance per asset) ─────── */
/* ────────────────────────────────────────────────────────────────────────── */

function TokenSelect({ accountId, value, onChange, tonBalanceNano }) {
  const tokensQuery = useQuery({
    queryKey: ["nile-wallet-tokens", accountId],
    queryFn: () => nileWalletClient.listTokens(accountId),
    enabled: !!accountId,
  });

  const balancesQuery = useQuery({
    queryKey: ["nile-wallet-token-balances", accountId],
    queryFn: () => nileWalletClient.jettonBalances(accountId),
    enabled: !!accountId,
  });

  const tokens = tokensQuery.data?.tokens || [];
  const balances = balancesQuery.data?.balances || {};

  const fmt = (raw, decimals) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const human = n / 10 ** (Number(decimals) || 0);
    return human.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };

  const tonHuman =
    tonBalanceNano != null
      ? (Number(tonBalanceNano) / 1e9).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })
      : null;

  const isCustom = value.trim() !== "" && !tokens.some((t) => t.jetton_master_address === value.trim());

  const pick = (master) => {
    const token = tokens.find((t) => t.jetton_master_address === master) || null;
    onChange(master, token);
  };

  return (
    <div className="nc-stack">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => pick("")}
          className={
            "rounded-full border px-3 py-1.5 text-xs font-bold transition-colors " +
            (value.trim() === ""
              ? "border-nile-gold-500/60 bg-nile-gold-500/15 text-neutral-100"
              : "border-white/10 bg-white/[0.05] text-neutral-400")
          }
        >
          TON{tonHuman != null ? ` · ${tonHuman}` : ""}
        </button>
        {tokens.map((token) => {
          const master = token.jetton_master_address;
          const bal = fmt(balances[master], token.decimals);
          const active = value.trim() === master;
          return (
            <button
              type="button"
              key={master}
              onClick={() => pick(master)}
              className={
                "rounded-full border px-3 py-1.5 text-xs font-bold transition-colors " +
                (active
                  ? "border-nile-gold-500/60 bg-nile-gold-500/15 text-neutral-100"
                  : "border-white/10 bg-white/[0.05] text-neutral-400")
              }
            >
              {token.symbol || "Jetton"}{bal != null ? ` · ${bal}` : ""}
            </button>
          );
        })}
      </div>
      {(tokens.length === 0 || isCustom) ? (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            tokens.length > 0
              ? "Or paste a Jetton master address"
              : "Jetton master address for Jetton sends"
          }
        />
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Send section — Level 1 (Primary)                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function SendSection({ accountId, balanceNano, balanceError, unlocked, onNeedsUnlock, onSent }) {
  const queryClient = useQueryClient();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [comment, setComment] = useState("");
  const [tokenAddr, setTokenAddr] = useState("");
  const [selectedToken, setSelectedToken] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const estimateMutation = useMutation({
    mutationFn: (params) => nileWalletClient.estimateTransfer(accountId, params),
  });

  const sendMutation = useMutation({
    mutationFn: (params) => nileWalletClient.sendTransfer(accountId, params),
  });

  const reset = useCallback(() => {
    setTo("");
    setAmount("");
    setComment("");
    setTokenAddr("");
    setSelectedToken(null);
    setConfirmOpen(false);
    setEstimate(null);
    setSending(false);
    setError("");
  }, []);

  const jettonBalancesQuery = useQuery({
    queryKey: ["nile-wallet-token-balances", accountId],
    queryFn: () => nileWalletClient.jettonBalances(accountId),
    enabled: !!accountId,
  });

  const handleTokenSelect = useCallback((master, token) => {
    setTokenAddr(master);
    setSelectedToken(token);
  }, []);

  const activeSymbol = selectedToken?.symbol || "TON";
  const activeDecimals = selectedToken ? Number(selectedToken.decimals) || 9 : 9;

  /** Human-readable balance of the currently selected asset. */
  const activeBalanceHuman = (() => {
    if (!selectedToken) {
      return balanceNano != null ? Number(balanceNano) / 1e9 : null;
    }
    const raw = jettonBalancesQuery.data?.balances?.[selectedToken.jetton_master_address];
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n / 10 ** activeDecimals;
  })();

  const handleMax = useCallback(() => {
    if (activeBalanceHuman == null || !(activeBalanceHuman > 0)) {
      setAmount("0");
      return;
    }
    setAmount(String(activeBalanceHuman));
  }, [activeBalanceHuman]);

  const tokenUnresolved =
    tokenAddr.trim() !== "" &&
    selectedToken?.jetton_master_address !== tokenAddr.trim();

  const buildParams = () => {
    const params = {
      to: to.trim(),
      amount,
      comment: comment || undefined,
    };
    const master = tokenAddr.trim();
    if (master) {
      const token = selectedToken?.jetton_master_address === master
        ? selectedToken
        : null;
      if (!token) throw new Error("Add the token first (Tokens section), then pick its pill");
      params.kind = "jetton";
      params.token = token;
    } else {
      params.kind = "ton";
    }
    return params;
  };

  const handleEstimate = async () => {
    if (!to.trim() || !amount.trim() || !unlocked) return;
    setError("");
    try {
      const result = await estimateMutation.mutateAsync(buildParams());
      setEstimate(result);
      setConfirmOpen(true);
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else setError(err?.message || "Estimation failed");
    }
  };

  const handleSend = async () => {
    if (!estimate || sending) return;
    setSending(true);
    setError("");
    try {
      await sendMutation.mutateAsync(buildParams());
      toast.success("Transfer sent");
      reset();
      onSent?.();
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else setError(err?.message || "Send failed");
    } finally {
      setSending(false);
    }
  };

  if (!unlocked) {
    return (
      <section className="nc-card-primary nc-stack" id="send">
        <h3 className="font-bold">Send</h3>
        <p className="nc-caption">Unlock the vault to send.</p>
      </section>
    );
  }

  return (
    <section className="nc-card-primary nc-stack" id="send">
      <h3 className="font-bold">Send</h3>

      {balanceError ? (
        <p className="nc-caption text-amber-400">{balanceError}</p>
      ) : null}

      <Field label="Recipient">
        <Input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="EQ… or UQ… address"
        />
      </Field>

      <Field label={`Amount (${activeSymbol})`}>
        <div className="flex gap-2">
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            type="text"
            inputMode="decimal"
          />
          {activeBalanceHuman != null ? (
            <Button variant="ghost" size="sm" onClick={handleMax}>
              MAX
            </Button>
          ) : null}
        </div>
      </Field>

      <Field label="Token (optional)">
        <TokenSelect
          accountId={accountId}
          value={tokenAddr}
          onChange={handleTokenSelect}
          tonBalanceNano={balanceNano}
        />
      </Field>

      <Field label="Comment (optional)">
        <Input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Text comment"
        />
      </Field>

      {tokenUnresolved ? (
        <p className="nc-message text-amber-400">
          Unknown token address — pick one of your added tokens above.
        </p>
      ) : null}

      {error ? <p className="nc-message text-red-400">{error}</p> : null}

      <Button
        variant="primary"
        size="block"
        onClick={handleEstimate}
        loading={estimateMutation.isPending}
        disabled={!to.trim() || !amount.trim() || tokenUnresolved || estimateMutation.isPending}
      >
        Review and send
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title="Confirm transfer"
        confirmLabel="Send"
        busy={sending}
        onCancel={() => {
          setConfirmOpen(false);
          setEstimate(null);
        }}
        onConfirm={handleSend}
        detail={
          estimate ? (
            <div className="nc-stack text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-400">To</span>
                <span className="nc-mono font-bold">{truncateAddress(to, 8, 6)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Amount</span>
                <span className="font-bold">{amount} {activeSymbol}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Fee</span>
                <span className="font-bold">
                  {estimate.feeNano
                    ? `${(Number(estimate.feeNano) / 1e9).toFixed(6)} TON`
                    : "calculating…"}
                </span>
              </div>
              {estimate.jettonWalletAddress ? (
                <div className="flex justify-between">
                  <span className="text-neutral-400">Token contract being called</span>
                  <span className="nc-mono font-bold">
                    {truncateAddress(estimate.jettonWalletAddress, 8, 6)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null
        }
        description={
          estimate?.sufficient === false
            ? `Insufficient balance. Required: ${
                estimate.requiredTonNano
                  ? `${(Number(estimate.requiredTonNano) / 1e9).toFixed(6)} TON`
                  : "—"
              }`
            : undefined
        }
      />
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Change passphrase section — Level 2 (Secondary)                             */
/* ────────────────────────────────────────────────────────────────────────── */

function ChangePassphraseSection({ onNeedsUnlock, onChanged }) {
  const [open, setOpen] = useState(false);
  const [oldPass, setOldPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit =
    oldPass.length > 0 &&
    newPass.length >= MIN_BACKUP_PASSWORD_LENGTH &&
    !busy;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      await nileWalletClient.changePassphrase(oldPass, newPass);
      toast.success("Passphrase changed");
      setOldPass("");
      setNewPass("");
      setOpen(false);
      onChanged?.();
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else {
        const message =
          err?.code === "bad-passphrase"
            ? "Wrong current passphrase"
            : err?.message || "Failed to change passphrase";
        setError(message);
        toast.error(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nc-card-secondary nc-stack">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">Vault passphrase</h3>
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "Change"}
        </Button>
      </div>

      {open ? (
        <form onSubmit={handleSubmit} className="nc-stack">
          <Field label="Current passphrase" error={error}>
            <PasswordInput
              autoFocus
              value={oldPass}
              onChange={(e) => {
                setOldPass(e.target.value);
                if (error) setError("");
              }}
              placeholder="Current passphrase"
              disabled={busy}
            />
          </Field>
          <Field
            label="New passphrase"
            hint={`At least ${MIN_BACKUP_PASSWORD_LENGTH} characters`}
          >
            <PasswordInput
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder={`At least ${MIN_BACKUP_PASSWORD_LENGTH} characters`}
              disabled={busy}
            />
          </Field>
          <Button type="submit" size="block" loading={busy} disabled={!canSubmit}>
            Change passphrase
          </Button>
        </form>
      ) : (
        <p className="nc-caption">
          Encrypts the vault at rest. Changing it re-encrypts all stored wallets
          with the new key.
        </p>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Connect via link — Level 2 (Secondary)                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function ConnectViaLink({ accountId, onPrepared, onNeedsUnlock }) {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDanger, setConfirmDanger] = useState(false);

  const handleConnect = async () => {
    if (!link.trim() || busy) return;
    setError("");
    setBusy(true);
    try {
      const prepared = await nileWalletClient.parseLink(accountId, link.trim());
      onPrepared?.(prepared);
      setLink("");
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else setError(err?.message || "Invalid link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nc-card-secondary nc-stack">
      <div className="flex items-center gap-2">
        <HiOutlineLink className="size-4 text-neutral-400" />
        <h3 className="font-bold">Connect via link</h3>
      </div>
      <p className="nc-caption leading-relaxed">
        Paste a TON Connect link from a dApp to approve a connection.
      </p>
      <Field error={error}>
        <Input
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            if (error) setError("");
          }}
          placeholder="tc://..."
        />
      </Field>
      <Button
        size="block"
        onClick={handleConnect}
        loading={busy}
        disabled={!link.trim() || busy}
      >
        Connect
      </Button>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Connected apps — Level 2 (Secondary)                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function ConnectedApps({ accountId }) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(null);

  const sessionsQuery = useQuery({
    queryKey: ["nile-wallet-sessions", accountId],
    queryFn: () => nileWalletClient.sessions(accountId),
    enabled: !!accountId,
  });

  const handleDisconnect = async (dAppPubKey) => {
    setRemoving(dAppPubKey);
    try {
      await nileWalletClient.disconnect(accountId, dAppPubKey);
      toast.success("Disconnected");
      queryClient.invalidateQueries({
        queryKey: ["nile-wallet-sessions", accountId],
      });
    } catch (err) {
      toast.error(err?.message || "Failed to disconnect");
    } finally {
      setRemoving(null);
    }
  };

  const sessions = sessionsQuery.data?.sessions || [];

  return (
    <section className="nc-card-secondary nc-stack">
      <div className="flex items-center gap-2">
        <HiOutlineWifi className="size-4 text-neutral-400" />
        <h3 className="font-bold">Connected apps</h3>
      </div>
      {sessions.length === 0 ? (
        <p className="nc-caption">No dApps connected.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sessions.map((session) => (
            <div
              key={session.dAppPubKey}
              className="nc-card-interactive flex items-center justify-between p-2.5"
            >
              <div className="min-w-0 grow">
                {/*
                  The session record carries the dApp's *manifest*, not flat
                  name/url fields — reading `session.name` labelled every
                  connected app "Unknown dApp", leaving the user unable to tell
                  which one they were disconnecting.
                */}
                <p className="text-sm font-bold">
                  {session.manifest?.name || "Unknown dApp"}
                </p>
                <p className="nc-mono nc-caption truncate">
                  {session.manifest?.url || session.dAppPubKey}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDisconnect(session.dAppPubKey)}
                loading={removing === session.dAppPubKey}
              >
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Reveal recovery phrase — Level 3 (Destructive)                             */
/* ────────────────────────────────────────────────────────────────────────── */

function RevealPhrase({ accountId, unlocked, onNeedsUnlock }) {
  const [revealed, setRevealed] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleReveal = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const seed = await nileWalletClient.revealSeed(accountId);
      setRevealed(seed);
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else toast.error(err?.message || "Failed to reveal seed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nc-card-danger nc-stack">
      <div className="flex items-center gap-2">
        {revealed ? (
          <HiOutlineEyeSlash className="size-4 text-red-400" />
        ) : (
          <HiOutlineEye className="size-4 text-red-400" />
        )}
        <h3 className="font-bold text-red-400">Reveal recovery phrase</h3>
      </div>
      <p className="nc-caption leading-relaxed text-red-300/80">
        Shows the 24-word seed phrase. Anyone with this phrase controls the
        wallet. Never share it.
      </p>
      {revealed ? (
        <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3">
          <p
            className="nc-mono text-sm leading-relaxed break-all text-red-200"
            data-selectable
          >
            {revealed}
          </p>
        </div>
      ) : (
        <Button
          variant="danger"
          size="block"
          onClick={handleReveal}
          loading={busy}
          disabled={!unlocked || busy}
        >
          {unlocked ? "Reveal recovery phrase" : "Unlock to reveal"}
        </Button>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Backup section — Level 2 (Secondary)                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function RestoreSection({ onNeedsUnlock, onRestored, onBack }) {
  const [passphrase, setPassphrase] = useState("");
  const [backupPass, setBackupPass] = useState("");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);

  const handlePreview = async () => {
    if (!passphrase || busy) return;
    setBusy(true);
    setError("");
    try {
      // Read file first
      const file = await openTextFile();
      if (!file?.content) {
        setBusy(false);
        return;
      }
      const result = await nileWalletClient.restorePreview(passphrase, file.content);
      setPreview(result);
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else setError(err?.message || "Invalid backup");
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      const file = await openTextFile();
      if (!file?.content) {
        setBusy(false);
        return;
      }
      const result = await nileWalletClient.restoreApply(
        passphrase,
        file.content,
        overwrite
      );
      toast.success(`Restored ${result.count} wallet(s)`);
      onRestored?.();
      onBack?.();
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else setError(err?.message || "Restore failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nc-stack">
      {error ? <p className="nc-message text-red-400">{error}</p> : null}

      {!preview ? (
        <div className="nc-stack">
          <Field label="Vault passphrase" hint="Proves you own this vault.">
            <PasswordInput
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                if (error) setError("");
              }}
              placeholder="Vault passphrase"
              disabled={busy}
            />
          </Field>
          <Button
            size="block"
            onClick={handlePreview}
            loading={busy}
            disabled={!passphrase || busy}
          >
            <HiOutlineArrowUpTray className="size-4" />
            Load backup file
          </Button>
        </div>
      ) : (
        <div className="nc-stack">
          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
            <p className="text-sm font-bold">
              {preview.count} wallet(s) found
            </p>
            {preview.wallets?.length ? (
              <ul className="mt-1 text-xs text-neutral-400">
                {preview.wallets.map((w, i) => (
                  <li key={i}>{w.name || w.address}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {preview.existing?.length ? (
            <label className="flex items-center gap-2 text-sm text-neutral-400">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                className="accent-nile-gold-500"
              />
              Overwrite {preview.existing.length} existing wallet(s)
            </label>
          ) : null}

          <div className="flex gap-2">
            <Button
              size="block"
              onClick={handleApply}
              loading={busy}
              disabled={busy}
            >
              Restore
            </Button>
            <Button variant="secondary" size="block" onClick={onBack} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BackupSection({ onNeedsUnlock, onRestored }) {
  const [mode, setMode] = useState(null); // null | "backup" | "restore"
  const [passphrase, setPassphrase] = useState("");
  const [backupPass, setBackupPass] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = useCallback(() => {
    setMode(null);
    setPassphrase("");
    setBackupPass("");
    setError("");
    setBusy(false);
  }, []);

  const tooShort =
    backupPass.length > 0 && backupPass.length < MIN_BACKUP_PASSWORD_LENGTH;
  const canBackup =
    passphrase.length > 0 && backupPass.length >= MIN_BACKUP_PASSWORD_LENGTH;

  const doBackup = async (event) => {
    event.preventDefault();
    if (!canBackup || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await nileWalletClient.backup(passphrase, backupPass);
      const saved = await saveTextFile({
        defaultPath: res.filename,
        content: res.json,
      });
      if (saved?.canceled) toast("Backup cancelled", { icon: "•" });
      else toast.success(`Backup saved — ${res.count} wallet(s)`);
      reset();
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else {
        const message =
          err?.code === "bad-passphrase"
            ? "Wrong vault passphrase"
            : err?.message || "Backup failed";
        setError(message);
        if (err?.code === "bad-passphrase") toast.error(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nc-card-secondary nc-stack">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">Backup &amp; restore</h3>
        {mode ? (
          <Button variant="ghost" size="sm" onClick={reset}>
            Close
          </Button>
        ) : null}
      </div>

      {mode === null ? (
        <>
          <p className="nc-caption leading-relaxed">
            Export every wallet to an encrypted file, or restore from one. The file
            is useless without its backup password.
          </p>
          <div className="flex flex-col gap-2">
            <Button
              variant="secondary"
              size="block"
              onClick={() => {
                setError("");
                setMode("backup");
              }}
            >
              <HiOutlineArrowDownTray className="size-4" />
              Backup wallets
            </Button>
            <Button
              variant="secondary"
              size="block"
              onClick={() => {
                setError("");
                setMode("restore");
              }}
            >
              <HiOutlineArrowUpTray className="size-4" />
              Restore wallets
            </Button>
          </div>
          <p className="nc-caption text-red-400/80">
            Losing both the backup file and its password means permanent loss of
            funds — there is no recovery path beyond that.
          </p>
        </>
      ) : mode === "backup" ? (
        <form onSubmit={doBackup} className="nc-stack">
          <Field
            label="Vault passphrase"
            hint="Proves you own this vault. It is not stored in the file."
            error={error}
          >
            <PasswordInput
              autoFocus
              value={passphrase}
              onChange={(event) => {
                setPassphrase(event.target.value);
                if (error) setError("");
              }}
              placeholder="Vault passphrase"
              disabled={busy}
              invalid={Boolean(error)}
            />
          </Field>

          <Field
            label="Backup password"
            error={
              tooShort
                ? `Must be at least ${MIN_BACKUP_PASSWORD_LENGTH} characters`
                : ""
            }
            hint={`Encrypts the file — you'll need it to restore, on any machine.`}
            success={
              backupPass.length >= MIN_BACKUP_PASSWORD_LENGTH
                ? "Strong enough"
                : ""
            }
          >
            <PasswordInput
              value={backupPass}
              onChange={(event) => setBackupPass(event.target.value)}
              placeholder={`At least ${MIN_BACKUP_PASSWORD_LENGTH} characters`}
              disabled={busy}
              invalid={tooShort}
            />
          </Field>

          <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3">
            <HiOutlineShieldCheck className="mt-0.5 size-4 shrink-0 text-red-400" />
            <p className="nc-caption leading-relaxed text-red-300/90">
              Losing both this file and its password means permanent loss of funds.
              There is no recovery path beyond that.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              type="submit"
              size="block"
              loading={busy}
              disabled={!canBackup}
            >
              <HiOutlineArrowDownTray className="size-4" />
              Save backup
            </Button>
            <Button
              variant="secondary"
              size="block"
              onClick={reset}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <RestoreSection
          onRestored={onRestored}
          onNeedsUnlock={onNeedsUnlock}
          onBack={reset}
        />
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Wallet setup — first-run: generate or import                                */
/* ────────────────────────────────────────────────────────────────────────── */

function WalletSetup({ accountId, generate, generating, onNeedsUnlock, onImported }) {
  const [mode, setMode] = useState(null); // null | "import"
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleImport = async (event) => {
    event.preventDefault();
    if (!phrase.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await nileWalletClient.importWallet(accountId, phrase.trim());
      onImported?.();
    } catch (err) {
      if (err instanceof NileWalletLockedError) onNeedsUnlock?.();
      else setError(err?.message || "Import failed");
    } finally {
      setBusy(false);
    }
  };

  if (mode === "import") {
    return (
      <section className="nc-card-secondary nc-stack">
        <h3 className="font-bold">Import recovery phrase</h3>
        <form onSubmit={handleImport} className="nc-stack">
          <Field label="24-word recovery phrase" error={error}>
            <textarea
              autoFocus
              value={phrase}
              onChange={(e) => {
                setPhrase(e.target.value);
                if (error) setError("");
              }}
              placeholder="word1 word2 word3 …"
              rows={3}
              className="nc-input w-full resize-none"
              disabled={busy}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              type="submit"
              size="block"
              loading={busy}
              disabled={!phrase.trim() || busy}
            >
              Import
            </Button>
            <Button
              variant="secondary"
              size="block"
              onClick={() => {
                setMode(null);
                setPhrase("");
                setError("");
              }}
              disabled={busy}
            >
              Back
            </Button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="nc-card-secondary nc-stack text-center">
      <h3 className="font-bold">Set up your wallet</h3>
      <p className="nc-caption leading-relaxed">
        Generate a new 24-word recovery phrase, or import an existing one.
      </p>
      <div className="flex flex-col gap-2">
        <Button
          size="block"
          onClick={generate}
          loading={generating}
          disabled={generating}
        >
          <HiOutlineKey className="size-4" />
          Generate new wallet
        </Button>
        <Button
          variant="secondary"
          size="block"
          onClick={() => setMode("import")}
          disabled={generating}
        >
          <HiOutlineDocumentDuplicate className="size-4" />
          Import recovery phrase
        </Button>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Balance card — Level 0 (Hero)                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function BalanceCard({ wallet, balanceNano, balanceQuery, shortened, onRefresh, actions }) {
  return (
    <section className="nc-card-hero relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-24 h-40 bg-[radial-gradient(ellipse_at_center,rgba(212,168,67,0.14),transparent_70%)]"
      />
      <div className="nc-stack relative">
        <div className="flex items-center gap-2">
          <img src={TonCoinIcon} className="size-6" alt="" />
          <span className="nc-caption">Balance</span>
          <IconButton
            label="Refresh balance"
            onClick={onRefresh}
            loading={balanceQuery.isFetching}
            className="ml-auto"
          >
            <HiOutlineArrowPath className="size-4" />
          </IconButton>
        </div>

        <div className="nc-balance text-nile-gold-400">
          {balanceQuery.isLoading ? (
            <Skeleton className="h-10 w-48" />
          ) : balanceQuery.data?.error ? (
            <span className="text-neutral-500" title={balanceQuery.data.error}>—</span>
          ) : (
            <AmountValue value={balanceNano ?? 0n} suffix=" TON" />
          )}
        </div>

        <AddressRow address={wallet.address} display={shortened} />

        <p className="nc-caption -mt-1">
          Non-bounceable (UQ…) · tap to copy
        </p>

        {/* Inline action row */}
        <div className="flex gap-2 pt-1">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={action.onClick}
              className="nc-card-interactive flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-nile-gold-400"
            >
              {action.icon ? <action.icon className="size-4" /> : null}
              <span className="text-xs font-bold">{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* NileWallet — default export (main detail screen)                           */
/* ────────────────────────────────────────────────────────────────────────── */

export default function NileWallet() {
  const { id: accountId, name } = useContext(AccountContext);
  const queryClient = useQueryClient();
  const [connectRequest, setConnectRequest] = useState(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);

  /* ── Queries ──────────────────────────────────────────────────────────── */

  const vaultQuery = useQuery({
    queryKey: ["nile-vault-status"],
    queryFn: () => nileWalletClient.vaultStatus(),
  });

  const walletQuery = useQuery({
    queryKey: ["nile-wallet", accountId],
    queryFn: () => nileWalletClient.get(accountId),
    enabled: !!accountId,
  });

  const walletData = walletQuery.data;
  const hasAddress = Boolean(walletData?.status && walletData?.address);
  const unlocked = Boolean(vaultQuery.data?.unlocked);
  const configured = Boolean(vaultQuery.data?.configured);

  const balanceQuery = useQuery({
    queryKey: ["nile-wallet-balance", accountId, walletData?.address],
    queryFn: () => nileWalletClient.balance(accountId),
    enabled: !!accountId && hasAddress,
    refetchInterval: 45_000,
  });

  const balanceNano = useMemo(() => {
    const raw = balanceQuery.data?.balanceNano;
    if (raw == null) return null;
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }, [balanceQuery.data]);

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["nile-vault-status"] });
  }, [queryClient]);

  /* ── Mutations ────────────────────────────────────────────────────────── */

  const generateMutation = useMutation({
    mutationFn: () => nileWalletClient.generate(accountId),
  });

  const clearMutation = useMutation({
    mutationFn: () => nileWalletClient.clear(accountId),
  });

  const approveMutation = useMutation({
    mutationFn: (req) => nileWalletClient.approve(accountId, req),
  });

  const rejectMutation = useMutation({
    mutationFn: (req) => nileWalletClient.reject(accountId, req),
  });

  const handleGenerate = useCallback(() => {
    generateMutation
      .mutateAsync()
      .then(() => {
        toast.success("Wallet created — back up your recovery phrase");
        walletQuery.refetch();
        refreshAll();
      })
      .catch((err) => {
        if (err instanceof NileWalletLockedError) setNeedsUnlock(true);
        else toast.error(err?.message || "Failed to create wallet");
      });
  }, [generateMutation, walletQuery, refreshAll]);

  /* ── TON Connect listener ─────────────────────────────────────────────── */

  useEffect(() => {
    if (!accountId) return undefined;
    return nileWalletClient.onConnectRequest(accountId, (request) => {
      if (!request?.dAppPubKey || request.transport !== "bridge") return;
      if (request.items) {
        setConnectRequest(request);
        return;
      }
      const method = request?.request?.method || "request";
      const action = method === "sendTransaction" ? "send a transaction" : method;
      nileWalletClient
        .respondError(accountId, request, "NileVault cannot sign dApp-initiated requests yet")
        .catch(() => {});
      toast.error(
        `A connected app asked to ${action}. NileVault can't approve dApp-initiated signing yet, so the request was declined.`,
        { duration: 6_000 }
      );
    });
  }, [accountId]);

  const handleApproveConnect = useCallback(() => {
    if (!connectRequest) return;
    approveMutation
      .mutateAsync(connectRequest)
      .then(() => {
        toast.success("Wallet connected");
        setConnectRequest(null);
        queryClient.invalidateQueries({
          queryKey: ["nile-wallet-sessions", accountId],
        });
      })
      .catch((err) => {
        if (err instanceof NileWalletLockedError) setNeedsUnlock(true);
        else toast.error(err?.message || "Failed to connect");
      });
  }, [connectRequest, approveMutation, accountId, queryClient]);

  const handleRejectConnect = useCallback(() => {
    const req = connectRequest;
    setConnectRequest(null);
    if (req) rejectMutation.mutate(req);
  }, [connectRequest, rejectMutation]);

  /* ── Remove wallet ────────────────────────────────────────────────────── */

  const handleRemove = useCallback(() => {
    clearMutation
      .mutateAsync()
      .then(() => {
        toast.success("Wallet removed");
        setRemoveConfirm(false);
        walletQuery.refetch();
      })
      .catch((err) => toast.error(err?.message || "Failed to remove wallet"));
  }, [clearMutation, walletQuery]);

  /* ── Post-send refresh ────────────────────────────────────────────────── */

  const handleSent = useCallback(() => {
    balanceQuery.refetch();
    queryClient.invalidateQueries({
      queryKey: ["nile-wallet-token-balances", accountId],
    });
    queryClient.invalidateQueries({
      queryKey: ["nile-wallet-token-balance-single", accountId],
    });
    queryClient.invalidateQueries({ queryKey: ["nile-picker-details"] });
    queryClient.invalidateQueries({ queryKey: ["nile-portfolio-balances"] });
  }, [balanceQuery, queryClient, accountId]);

  /* ── Scroll helper ────────────────────────────────────────────────────── */

  const scrollTo = useCallback((id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /* ── No account selected ──────────────────────────────────────────────── */

  if (!accountId) {
    return (
      <Container size="md" className="text-center">
        <p className="nc-body">No account selected.</p>
      </Container>
    );
  }

  const shortened = walletData?.address
    ? truncateAddress(walletData.address, 8, 8)
    : "";

  return (
    <Container size="md" className="nc-stack">
      {/* ── Wallet header ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <img
          src={NileVaultLogo}
          className="size-9 shrink-0 rounded-xl border border-white/10"
          alt=""
        />
        <h2
          data-selectable
          className="min-w-0 grow truncate font-turret-road text-xl font-bold text-nile-gold-500"
        >
          {name || "NileWallet"}
        </h2>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold",
            unlocked
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border-nile-gold-500/30 bg-nile-gold-500/10 text-nile-gold-400"
          )}
        >
          {unlocked ? (
            <>
              <HiOutlineLockOpen className="size-3.5" /> Unlocked
            </>
          ) : (
            <>
              <HiOutlineLockClosed className="size-3.5" /> Locked
            </>
          )}
        </span>
      </div>

      {/* ── Loading state ─────────────────────────────────────────────── */}
      {walletQuery.isLoading ? (
        <div className="nc-stack">
          <div className="nc-card flex flex-col gap-3 p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-52" />
            <Skeleton className="h-11 w-full" />
          </div>
          <SkeletonRows rows={2} />
        </div>
      ) : hasAddress ? (
        <>
          {/* ── Balance + Send ────────────────────────────────────────── */}
          <div
            className="grid grid-cols-1 gap-3"
            style={{ gridTemplateColumns: "var(--wallet-grid, 1fr)" }}
          >
            <BalanceCard
              wallet={walletData}
              balanceNano={balanceNano}
              balanceQuery={balanceQuery}
              shortened={shortened}
              onRefresh={() => balanceQuery.refetch()}
              actions={[
                { id: "send", label: "Send", icon: HiOutlinePaperAirplane, onClick: () => scrollTo("send") },
                { id: "receive", label: "Receive", icon: HiOutlineQrCode, onClick: () => scrollTo("receive") },
                { id: "backup", label: "Backup", icon: HiOutlineShieldCheck, onClick: () => scrollTo("backup") },
              ]}
            />
            <SendSection
              accountId={accountId}
              balanceNano={balanceNano}
              balanceError={balanceQuery.data?.error}
              unlocked={unlocked}
              onNeedsUnlock={() => setNeedsUnlock(true)}
              onSent={handleSent}
            />
          </div>

          {/* ── Inline unlock (if locked) ────────────────────────────── */}
          {unlocked ? null : (
            <UnlockForm
              configured={configured}
              submitLabel="Unlock"
              onUnlocked={() => {
                refreshAll();
                setNeedsUnlock(false);
              }}
            />
          )}

          {/* ── Receive + Backup ─────────────────────────────────────── */}
          <div
            className="grid grid-cols-1 gap-3"
            style={{ gridTemplateColumns: "var(--wallet-grid, 1fr)" }}
          >
            <ReceiveSection address={walletData.address} />
            <div id="backup">
              <BackupSection
                onNeedsUnlock={() => setNeedsUnlock(true)}
                onRestored={() => {
                  walletQuery.refetch();
                  refreshAll();
                  queryClient.invalidateQueries({
                    queryKey: ["nile-wallet-tokens", accountId],
                  });
                }}
              />
            </div>
          </div>

          {/* ── Tokens ────────────────────────────────────────────────── */}
          <TokensSection accountId={accountId} />

          {/* ── Settings ─────────────────────────────────────────────── */}
          <div
            className="grid grid-cols-1 gap-3"
            style={{ gridTemplateColumns: "var(--wallet-grid, 1fr)" }}
          >
            <ChangePassphraseSection
              onNeedsUnlock={() => setNeedsUnlock(true)}
              onChanged={refreshAll}
            />
            <ConnectViaLink
              accountId={accountId}
              onPrepared={setConnectRequest}
              onNeedsUnlock={() => setNeedsUnlock(true)}
            />
            <ConnectedApps accountId={accountId} />
            <RevealPhrase
              accountId={accountId}
              unlocked={unlocked}
              onNeedsUnlock={() => setNeedsUnlock(true)}
            />

            {/* ── Danger zone — Level 3 (Destructive) ──────────────── */}
            <section className="nc-card-danger nc-stack">
              <h3 className="font-bold text-red-400">Danger zone</h3>
              <p className="nc-caption leading-relaxed">
                Removing the wallet deletes its encrypted recovery phrase and every
                TON Connect session for it. This cannot be undone unless you have
                saved the recovery phrase.
              </p>
              <Button variant="danger" onClick={() => setRemoveConfirm(true)}>
                <HiOutlineTrash className="size-4" />
                Remove wallet
              </Button>
            </section>
          </div>
        </>
      ) : (
        /* ── No address yet: setup or unlock ───────────────────────── */
        <>
          {unlocked ? (
            <WalletSetup
              accountId={accountId}
              generate={handleGenerate}
              generating={generateMutation.isPending}
              onNeedsUnlock={() => setNeedsUnlock(true)}
              onImported={() => {
                toast.success("Wallet ready");
                walletQuery.refetch();
                refreshAll();
              }}
            />
          ) : (
            <UnlockForm
              configured={configured}
              submitLabel={configured ? "Unlock" : "Set passphrase"}
              busy={vaultQuery.isLoading}
              onUnlocked={refreshAll}
            />
          )}
        </>
      )}

      {/* ── Overlays ────────────────────────────────────────────────── */}
      {needsUnlock && !unlocked ? (
        <UnlockForm
          configured={configured}
          submitLabel="Unlock"
          onUnlocked={() => {
            refreshAll();
            setNeedsUnlock(false);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={removeConfirm}
        title={`Remove ${name || "this wallet"}`}
        tone="danger"
        confirmLabel="Remove wallet"
        busy={clearMutation.isPending}
        onCancel={() => setRemoveConfirm(false)}
        onConfirm={handleRemove}
        description="The encrypted recovery phrase and all TON Connect sessions for this wallet will be deleted. Make sure you have saved the recovery phrase first."
      />

      <NileWalletConnectModal
        open={Boolean(connectRequest)}
        onOpenChange={(open) => {
          if (!open) handleRejectConnect();
        }}
        request={connectRequest}
        address={walletData?.address}
        busy={approveMutation.isPending}
        onApprove={handleApproveConnect}
        onReject={handleRejectConnect}
      />
    </Container>
  );
}


