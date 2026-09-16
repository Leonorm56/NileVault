import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  HiOutlineArrowDownTray,
  HiOutlineArrowPath,
  HiOutlineArrowUpTray,
  HiOutlineCheckCircle,
  HiOutlineEllipsisHorizontal,
  HiOutlineMagnifyingGlass,
  HiOutlinePencilSquare,
  HiOutlinePlus,
  HiOutlineShieldCheck,
  HiOutlineTrash,
  HiOutlineXMark,
  HiOutlineDocumentDuplicate,
} from "react-icons/hi2";

import AddWalletModal from "@/components/AddWalletModal";
import Button from "@/components/Button";
import ConfirmDialog from "@/components/ConfirmDialog";
import Container from "@/components/Container";
import Field from "@/components/Field";
import IconButton from "@/components/IconButton";
import Input from "@/components/Input";
import Modal from "@/components/Modal";
import PasswordInput from "@/components/PasswordInput";
import { Skeleton, SkeletonTiles } from "@/components/Skeleton";
import AmountValue from "@/components/AmountValue";
import nileWalletClient, { MIN_BACKUP_PASSWORD_LENGTH } from "@/lib/nileWalletClient";
import { openTextFile, saveTextFile } from "@/lib/files.js";
import { truncateAddress } from "@/lib/address.js";
import { cn } from "@/utils";
import TonCoinIcon from "@/assets/images/toncoin-ton-logo.svg";
import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";

const EMPTY = [];

/** Stable string key for a list of ids, so query keys don't churn per render. */
const keyOf = (ids) => ids.join(",");

/**
 * Per-wallet accent.
 *
 * Every tile previously used the same logo on the same surface, so a grid of
 * wallets was unreadable at a glance. The accent and monogram are derived from
 * the wallet id and stay inside the navy/gold palette — no new hues.
 */
const ACCENTS = [
  "border-nile-gold-500/40 bg-nile-gold-500/12 text-nile-gold-400",
  "border-nile-gold-300/35 bg-nile-gold-300/10 text-nile-gold-300",
  "border-neutral-300/30 bg-neutral-300/10 text-neutral-200",
  "border-neutral-500/40 bg-neutral-500/12 text-neutral-300",
];

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

const accentFor = (id) => ACCENTS[hashString(id) % ACCENTS.length];

const monogramFor = (name) => {
  const trimmed = String(name || "").trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  // Purely numeric names (farming account IDs like "140", "188"): show the
  // full number. It is short enough to fit the monogram box and avoids the
  // confusing truncation ("140" → "14") that the old slice created.
  if (words.length === 1 && /^\d+$/.test(words[0])) return words[0];
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
};

export default function WalletPicker({ onSelect }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [removeTokenTarget, setRemoveTokenTarget] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const openTimerRef = useRef(0);

  useEffect(() => () => clearTimeout(openTimerRef.current), []);

  /* ── Data ─────────────────────────────────────────────────────────────── */

  const walletsQuery = useQuery({
    queryKey: ["nile-wallets"],
    queryFn: () => nileWalletClient.listWallets(),
  });
  const wallets = useMemo(
    () => (Array.isArray(walletsQuery.data) ? walletsQuery.data : EMPTY),
    [walletsQuery.data],
  );
  const walletIds = useMemo(() => wallets.map((wallet) => wallet.id), [wallets]);

  const detailsQuery = useQuery({
    queryKey: ["nile-picker-details", keyOf(walletIds)],
    queryFn: async () => {
      /*
       * One batched wallet-state request for the whole list instead of two
       * requests per wallet (`get` for the address, `balance` for the number).
       * The stack falls back to the per-wallet path when the index is
       * unavailable, in which case this costs what it used to.
       */
      const rows = await nileWalletClient.walletOverview();
      const byId = new Map(rows.map((row) => [row.id, row]));

      return wallets.map((wallet) => {
        const row = byId.get(wallet.id);
        return {
          id: wallet.id,
          address: row?.address || null,
          // `balanceNano` keeps the total exact — converting a decimal string
          // back through Number would lose precision on large balances.
          balanceNano: row?.balanceNano ?? null,
          balanceError: row?.error || null,
        };
      });
    },
    enabled: wallets.length > 0,
    refetchInterval: 45_000,
  });

  const detailsById = useMemo(() => {
    const map = {};
    for (const row of detailsQuery.data || []) map[row.id] = row;
    return map;
  }, [detailsQuery.data]);

  /** Total across every wallet, summed in base units so it stays exact. */
  const totalNano = useMemo(() => {
    let sum = 0n;
    for (const row of detailsQuery.data || []) {
      if (!row.balanceNano) continue;
      try {
        sum += BigInt(row.balanceNano);
      } catch {
        /* skip a malformed value rather than zeroing the whole total */
      }
    }
    return sum;
  }, [detailsQuery.data]);

  const hasUnreadableBalance = (detailsQuery.data || []).some(
    (row) => row.balanceError,
  );

  /* ── Portfolio ────────────────────────────────────────────────────────── */

  const portfolioTokensQuery = useQuery({
    queryKey: ["nile-portfolio-tokens", keyOf(walletIds)],
    queryFn: async () => {
      const seen = new Map();
      const walletsPerToken = new Map();

      await Promise.all(
        wallets.map(async (wallet) => {
          try {
            const res = await nileWalletClient.listTokens(wallet.id);
            for (const token of res?.tokens || []) {
              const master = token.jetton_master_address;
              if (!seen.has(master)) {
                seen.set(master, token);
                walletsPerToken.set(master, []);
              }
              walletsPerToken.get(master).push(wallet.id);
            }
          } catch {
            /* this wallet has no tokens, or could not be read */
          }
        }),
      );

      return [...seen.values()].map((token) => ({
        ...token,
        walletIds: walletsPerToken.get(token.jetton_master_address) || [],
      }));
    },
    enabled: wallets.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const portfolioTokens = portfolioTokensQuery.data || [];
  const portfolioMasters = useMemo(
    () => portfolioTokens.map((token) => token.jetton_master_address),
    [portfolioTokens],
  );

  /**
   * Aggregated balances, one request per wallet rather than one per token —
   * tonapi returns every jetton balance for an account in a single response.
   */
  const portfolioBalancesQuery = useQuery({
    queryKey: [
      "nile-portfolio-balances",
      keyOf(portfolioMasters),
      keyOf(walletIds),
    ],
    queryFn: async () => {
      const balances = {};
      let unreachable = false;
      await Promise.all(
        wallets.map(async (wallet) => {
          try {
            const res = await nileWalletClient.jettonBalances(wallet.id);
            for (const [master, raw] of Object.entries(res?.balances || {})) {
              balances[master] = (
                BigInt(balances[master] || "0") + BigInt(raw || "0")
              ).toString();
            }
          } catch {
            unreachable = true;
          }
        }),
      );
      return { balances, unreachable };
    },
    enabled: portfolioTokens.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const portfolioBalances = portfolioBalancesQuery.data?.balances || {};

  /* ── Mutations ────────────────────────────────────────────────────────── */

  const deleteMutation = useMutation({
    mutationFn: (id) => nileWalletClient.deleteWallet(id),
  });

  const removeTokenMutation = useMutation({
    mutationFn: async ({ masterAddress }) => {
      await Promise.all(
        wallets.map((wallet) =>
          nileWalletClient.removeToken(wallet.id, masterAddress).catch(() => {}),
        ),
      );
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }) => nileWalletClient.renameWallet(id, name),
  });

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["nile-wallets"] });
    queryClient.invalidateQueries({ queryKey: ["nile-picker-details"] });
    queryClient.invalidateQueries({ queryKey: ["nile-portfolio-tokens"] });
    queryClient.invalidateQueries({ queryKey: ["nile-portfolio-balances"] });
  }, [queryClient]);

  const confirmDelete = useCallback(() => {
    const wallet = deleteTarget;
    if (!wallet) return;
    return deleteMutation
      .mutateAsync(wallet.id)
      .then(() => {
        toast.success(`${wallet.name} removed`);
        setDeleteTarget(null);
        refreshAll();
      })
      .catch((error) => {
        toast.error(error?.message || "Failed to remove wallet");
      });
  }, [deleteTarget, deleteMutation, refreshAll]);

  const confirmRemoveToken = useCallback(() => {
    const token = removeTokenTarget;
    if (!token) return;
    return removeTokenMutation
      .mutateAsync({ masterAddress: token.jetton_master_address })
      .then(() => {
        toast.success(`${token.symbol} removed`);
        setRemoveTokenTarget(null);
        refreshAll();
      })
      .catch(() => toast.error("Failed to remove token"));
  }, [removeTokenTarget, removeTokenMutation, refreshAll]);

  const refreshBalances = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["nile-picker-details"] });
    queryClient.invalidateQueries({ queryKey: ["nile-portfolio-balances"] });
  }, [queryClient]);

  /* ── Interaction ──────────────────────────────────────────────────────── */

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return wallets;
    return wallets.filter((wallet) => {
      const detail = detailsById[wallet.id];
      return (
        wallet.name.toLowerCase().includes(query) ||
        (detail?.address && detail.address.toLowerCase().includes(query))
      );
    });
  }, [wallets, detailsById, search]);

  /**
   * Open a wallet with a press handoff: the tile lifts and dims for a beat
   * before the screen changes, so the tap has a visible consequence instead of
   * the previous instantaneous swap.
   */
  const openWallet = useCallback(
    (wallet) => {
      if (openingId) return;
      setOpeningId(wallet.id);
      clearTimeout(openTimerRef.current);
      openTimerRef.current = setTimeout(() => {
        onSelect({ id: wallet.id, name: wallet.name });
      }, 150);
    },
    [onSelect, openingId],
  );

  const openContextMenu = useCallback((event, wallet) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, wallet });
  }, []);

  /** Anchor the menu to a control (keyboard-reachable path for the same menu). */
  const openContextMenuFromButton = useCallback((event, wallet) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.right - 8, y: rect.bottom + 4, wallet });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => closeContextMenu();
    const onKey = (event) => {
      if (event.key === "Escape") closeContextMenu();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu, closeContextMenu]);

  const hasWallets = wallets.length > 0;
  const searching = search.trim().length > 0;

  /* ── Render ───────────────────────────────────────────────────────────── */

  return (
    <Container size="xl" className="flex flex-col gap-3">
      {/* Total balance */}
      <div className="nc-card relative overflow-hidden p-4 text-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-24 h-40 bg-[radial-gradient(ellipse_at_center,rgba(212,168,67,0.14),transparent_70%)]"
        />
        <div className="relative flex flex-col items-center gap-1">
          <span className="nc-section">Total Balance</span>
          <span className="nc-display text-nile-gold-400">
            {detailsQuery.isLoading && hasWallets ? (
              <Skeleton className="h-9 w-40" rounded="rounded-lg" />
            ) : (
              <AmountValue value={totalNano} suffix=" TON" />
            )}
          </span>
          <span className="nc-caption flex items-center gap-1">
            {hasWallets
              ? `${wallets.length} wallet${wallets.length === 1 ? "" : "s"}`
              : "No wallets yet"}
            {hasUnreadableBalance ? (
              <span
                className="text-red-400"
                title="One or more balances could not be read"
              >
                · some unavailable
              </span>
            ) : null}
            <IconButton
              label="Refresh balances"
              onClick={refreshBalances}
              loading={detailsQuery.isFetching}
              size="size-6"
              className="ml-1"
            >
              <HiOutlineArrowPath className="size-3.5" />
            </IconButton>
          </span>
        </div>
      </div>

      {/* Portfolio */}
      {hasWallets ? (
        <div className="nc-card p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="nc-section">All Tokens</h3>
            <span className="nc-caption">
              {portfolioTokens.length + 1} asset
              {portfolioTokens.length > 0 ? "s" : ""}
            </span>
          </div>

          <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
            <div className="flex min-w-[130px] shrink-0 flex-col gap-1 rounded-xl border border-nile-gold-500/25 bg-nile-gold-500/[0.06] p-3">
              <div className="flex items-center gap-2">
                <img src={TonCoinIcon} className="size-5" alt="" />
                <span className="text-sm font-bold">TON</span>
              </div>
              <span className="text-base font-bold text-nile-gold-500">
                {detailsQuery.isLoading ? (
                  <Skeleton className="h-5 w-20" />
                ) : (
                  <AmountValue value={totalNano} />
                )}
              </span>
            </div>

            {portfolioTokensQuery.isLoading && hasWallets
              ? [0, 1].map((index) => (
                  <div
                    key={index}
                    className="flex min-w-[130px] shrink-0 flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3"
                  >
                    <Skeleton className="h-5 w-20" />
                    <Skeleton className="h-5 w-24" />
                  </div>
                ))
              : portfolioTokens.map((token) => {
                  const raw = portfolioBalances[token.jetton_master_address];
                  const unreadable =
                    raw === undefined &&
                    portfolioBalancesQuery.data?.unreachable === true;
                  return (
                    <div
                      key={token.jetton_master_address}
                      className="group relative flex min-w-[130px] shrink-0 flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition-[border-color,background-color,transform] duration-[var(--nc-dur)] hover:-translate-y-0.5 hover:border-nile-gold-500/40 hover:bg-white/[0.06]"
                    >
                      <div className="absolute right-1.5 top-1.5 flex opacity-0 transition-opacity duration-[var(--nc-dur)] group-hover:opacity-100 focus-within:opacity-100">
                        <IconButton
                          label={`Remove ${token.symbol}`}
                          variant="danger"
                          size="size-5"
                          onClick={() => setRemoveTokenTarget(token)}
                        >
                          <HiOutlineXMark className="size-3" />
                        </IconButton>
                      </div>
                      <div className="flex items-center gap-2">
                        {token.icon_url ? (
                          <img
                            src={token.icon_url}
                            className="size-5 rounded-full bg-white/10 object-cover"
                            alt=""
                          />
                        ) : (
                          <span className="inline-flex size-5 items-center justify-center rounded-full border border-nile-gold-500/30 bg-nile-gold-500/10 text-[9px] font-bold text-nile-gold-500">
                            {token.symbol?.slice(0, 2).toUpperCase() || "?"}
                          </span>
                        )}
                        <span className="truncate text-sm font-bold">
                          {token.symbol}
                        </span>
                      </div>
                      <span className="text-base font-bold text-nile-gold-500">
                        {portfolioBalancesQuery.isLoading && raw === undefined ? (
                          <Skeleton className="h-5 w-24" />
                        ) : raw === undefined ? (
                          <span
                            className="text-neutral-500"
                            title={unreadable ? "Balance unavailable" : undefined}
                          >
                            —
                          </span>
                        ) : (
                          <AmountValue
                            value={raw}
                            decimals={Number(token.decimals) || 9}
                          />
                        )}
                      </span>
                    </div>
                  );
                })}

            <button
              type="button"
              onClick={() => setShowAddToken(true)}
              className={cn(
                "flex min-w-[130px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl",
                "border border-dashed border-white/15 p-3 text-neutral-400",
                "transition-[border-color,color,background-color,transform] duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
                "hover:-translate-y-0.5 hover:border-nile-gold-500/60 hover:bg-nile-gold-500/[0.06] hover:text-nile-gold-400",
                "active:translate-y-0 active:scale-[0.98]",
              )}
            >
              <HiOutlinePlus className="size-5" />
              <span className="text-xs font-bold">Add Token</span>
            </button>
          </div>

          {!portfolioTokensQuery.isLoading && portfolioTokens.length === 0 ? (
            <p className="nc-caption mt-2">
              No custom tokens tracked yet. Add a Jetton by its contract address
              to watch its balance.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Search */}
      {wallets.length > 1 ? (
        <div className="relative">
          <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-neutral-500" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search wallets by name or address…"
            className="pl-10 pr-11"
            aria-label="Search wallets"
          />
          {searching ? (
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
              <IconButton label="Clear search" onClick={() => setSearch("")}>
                <HiOutlineXMark className="size-4" />
              </IconButton>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* First-run empty state */}
      {!walletsQuery.isLoading && !hasWallets ? (
        <div className="nc-card nc-anim-rise flex flex-col items-center gap-3 p-8 text-center">
          <img
            src={NileVaultLogo}
            className="size-16 rounded-2xl border border-white/10 shadow-lg"
            alt=""
          />
          <h2 className="text-lg font-bold">Your vault is empty</h2>
          <p className="nc-body max-w-sm text-neutral-400">
            NileVault keeps every TON wallet you own encrypted on this device.
            Create your first wallet — you can generate a new recovery phrase or
            import an existing one inside it — or restore one from a backup file.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setShowAdd(true)}>
              <HiOutlinePlus className="size-4" />
              Create a wallet
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowRestoreModal(true)}
            >
              <HiOutlineArrowUpTray className="size-4" />
              Restore from backup
            </Button>
          </div>
        </div>
      ) : null}

      {/* Tiles */}
      {walletsQuery.isLoading ? (
        <SkeletonTiles count={4} />
      ) : null}

      {!walletsQuery.isLoading && hasWallets && filtered.length === 0 && searching ? (
        <div className="nc-card nc-anim-rise flex flex-col items-center gap-2 p-8 text-center">
          <HiOutlineMagnifyingGlass className="size-6 text-neutral-500" />
          <p className="nc-body text-neutral-400">
            No wallets match &ldquo;{search}&rdquo;
          </p>
          <Button variant="link" size="sm" onClick={() => setSearch("")}>
            Clear search
          </Button>
        </div>
      ) : null}

      {!walletsQuery.isLoading && hasWallets && filtered.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((wallet) => {
            const detail = detailsById[wallet.id];
            const opening = openingId === wallet.id;
            return (
              <div key={wallet.id} className="group relative">
                <button
                  type="button"
                  onClick={() => openWallet(wallet)}
                  onContextMenu={(event) => openContextMenu(event, wallet)}
                  aria-label={`Open ${wallet.name}`}
                  className={cn(
                    "nc-card-interactive flex min-h-[7rem] w-full flex-col gap-1 p-3 text-left",
                    opening &&
                      "border-nile-gold-500/70 bg-nile-gold-500/[0.07] opacity-80",
                  )}
                  style={opening ? { transform: "scale(0.97)" } : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center rounded-xl border text-sm font-bold",
                        accentFor(wallet.id),
                      )}
                    >
                      {monogramFor(wallet.name)}
                    </span>
                    <span className="min-w-0 grow truncate text-sm font-bold">
                      {wallet.name}
                    </span>
                  </div>

                  <span className="text-base font-bold text-nile-gold-500">
                    {detail?.balanceError ? (
                      <span
                        className="text-neutral-500"
                        title={detail.balanceError}
                      >
                        —
                      </span>
                    ) : detail?.balanceNano == null ? (
                      detailsQuery.isLoading ? (
                        <Skeleton className="h-5 w-24" />
                      ) : (
                        "—"
                      )
                    ) : (
                      <AmountValue value={detail.balanceNano} suffix=" TON" />
                    )}
                  </span>

                  <span className="nc-mono mt-auto truncate text-neutral-500">
                    {truncateAddress(detail?.address) || "—"}
                  </span>
                </button>

                {/* Keyboard-reachable entry point for the same menu. */}
                <div className="absolute right-2 top-2 opacity-0 transition-opacity duration-[var(--nc-dur)] group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton
                    label={`Actions for ${wallet.name}`}
                    size="size-7"
                    onClick={(event) => openContextMenuFromButton(event, wallet)}
                    className="bg-neutral-900/70 backdrop-blur-sm hover:bg-white/[0.12]"
                  >
                    <HiOutlineEllipsisHorizontal className="size-4" />
                  </IconButton>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className={cn(
              "flex min-h-[7rem] flex-col items-center justify-center gap-2 rounded-xl",
              "border border-dashed border-white/15 text-neutral-400",
              "transition-[border-color,color,background-color,transform] duration-[var(--nc-dur)] ease-[var(--nc-ease-out)]",
              "hover:-translate-y-0.5 hover:border-nile-gold-500/60 hover:bg-nile-gold-500/[0.06] hover:text-nile-gold-400",
              "active:translate-y-0 active:scale-[0.98]",
            )}
          >
            <HiOutlinePlus className="size-5" />
            <span className="text-xs font-bold">Add Wallet</span>
          </button>
        </div>
      ) : null}

      {/* Vault actions */}
      {hasWallets ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowBackupModal(true)}
            className="nc-card-interactive flex flex-1 items-center justify-center gap-2 px-3 py-2.5 text-xs font-bold text-neutral-400 hover:text-nile-gold-400"
          >
            <HiOutlineShieldCheck className="size-4" />
            Backup Vault
          </button>
          <button
            type="button"
            onClick={() => setShowRestoreModal(true)}
            className="nc-card-interactive flex flex-1 items-center justify-center gap-2 px-3 py-2.5 text-xs font-bold text-neutral-400 hover:text-nile-gold-400"
          >
            <HiOutlineArrowUpTray className="size-4" />
            Restore
          </button>
        </div>
      ) : null}

      {/* ── Dialogs ────────────────────────────────────────────────────── */}

      {showAdd ? (
        <AddWalletModal
          onClose={() => setShowAdd(false)}
          onCreated={(wallet) => {
            setShowAdd(false);
            refreshAll();
            if (wallet?.id) onSelect({ id: wallet.id, name: wallet.name });
          }}
        />
      ) : null}

      {showBackupModal ? (
        <VaultBackupModal
          onClose={() => setShowBackupModal(false)}
          walletCount={wallets.length}
        />
      ) : null}

      {showRestoreModal ? (
        <VaultRestoreModal
          onClose={() => setShowRestoreModal(false)}
          onRestored={() => {
            setShowRestoreModal(false);
            refreshAll();
          }}
        />
      ) : null}

      {showAddToken ? (
        <AddTokenModal
          wallets={wallets}
          onClose={() => setShowAddToken(false)}
          onAdded={() => {
            setShowAddToken(false);
            refreshAll();
          }}
        />
      ) : null}

      {renameTarget ? (
        <RenameWalletModal
          wallet={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setRenameTarget(null);
            refreshAll();
          }}
          renameMutation={renameMutation}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove wallet"
        tone="danger"
        confirmLabel="Remove wallet"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        description="This deletes the encrypted recovery phrase and every TON Connect session for this wallet. It cannot be undone."
        detail={
          deleteTarget ? (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold",
                  accentFor(deleteTarget.id),
                )}
              >
                {monogramFor(deleteTarget.name)}
              </span>
              <span className="truncate text-sm font-bold">
                {deleteTarget.name}
              </span>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={Boolean(removeTokenTarget)}
        title={`Remove ${removeTokenTarget?.symbol || "token"}`}
        tone="danger"
        confirmLabel="Remove token"
        busy={removeTokenMutation.isPending}
        onCancel={() => setRemoveTokenTarget(null)}
        onConfirm={confirmRemoveToken}
        description="It will stop being tracked in every wallet. The token itself is unaffected — you can add it again at any time."
      />

      {/* Context menu */}
      {contextMenu ? (
        <div
          role="menu"
          aria-label={`Actions for ${contextMenu.wallet.name}`}
          className="nc-anim-scale fixed z-[70] min-w-[170px] origin-top-left overflow-hidden rounded-xl border border-white/10 bg-neutral-900/95 py-1 shadow-2xl backdrop-blur-xl"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 190),
            top: Math.min(contextMenu.y, window.innerHeight - 100),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeContextMenu();
              setRenameTarget(contextMenu.wallet);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors duration-[var(--nc-dur)] hover:bg-white/[0.08] active:bg-white/[0.12]"
          >
            <HiOutlinePencilSquare className="size-4 text-neutral-400" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeContextMenu();
              setDeleteTarget(contextMenu.wallet);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 transition-colors duration-[var(--nc-dur)] hover:bg-red-500/15 active:bg-red-500/25"
          >
            <HiOutlineTrash className="size-4" />
            Delete
          </button>
        </div>
      ) : null}
    </Container>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Add token                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function AddTokenModal({ wallets, onClose, onAdded }) {
  const [selectedWallet, setSelectedWallet] = useState(wallets[0]?.id || "");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const trimmed = address.trim();

  const submit = async (event) => {
    event.preventDefault();
    if (!selectedWallet || !trimmed || loading) return;
    setLoading(true);
    setError("");
    try {
      await nileWalletClient.addToken(selectedWallet, trimmed);
      toast.success("Token added");
      onAdded();
    } catch (err) {
      const message =
        err?.message === "needs-unlock"
          ? "Unlock the vault first"
          : err?.message || "Invalid token address";
      setError(message);
      if (err?.message === "needs-unlock") toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!loading}
      title="Add Token"
      description="Track a Jetton by its master contract address. It appears in this vault's portfolio."
      icon={<HiOutlinePlus className="size-4" />}
    >
      <form onSubmit={submit} className="nc-stack">
        <Field label="Wallet">
          <select
            value={selectedWallet}
            onChange={(event) => setSelectedWallet(event.target.value)}
            className={cn(
              "w-full appearance-none rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5 text-sm",
              "outline-none transition-[border-color,box-shadow] duration-[var(--nc-dur)]",
              "focus:border-nile-gold-500/60 focus:ring-2 focus:ring-nile-gold-500/20",
            )}
          >
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id} className="bg-neutral-900">
                {wallet.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Jetton master address"
          error={error}
          hint="Starts with EQ… or UQ…"
        >
          <Input
            autoFocus
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              if (error) setError("");
            }}
            placeholder="EQ…"
            className="font-mono text-sm"
            disabled={loading}
            invalid={Boolean(error)}
          />
        </Field>

        <div className="flex gap-2">
          <Button
            type="submit"
            size="block"
            loading={loading}
            disabled={!selectedWallet || !trimmed}
          >
            Add Token
          </Button>
          <Button
            variant="secondary"
            size="block"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Rename                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function RenameWalletModal({ wallet, onClose, onRenamed, renameMutation }) {
  const [name, setName] = useState(wallet.name);
  const [error, setError] = useState("");

  const trimmed = name.trim();
  const unchanged = trimmed === wallet.name;

  const submit = (event) => {
    event.preventDefault();
    if (!trimmed || unchanged || renameMutation.isPending) return;
    setError("");
    renameMutation
      .mutateAsync({ id: wallet.id, name: trimmed })
      .then(() => {
        toast.success("Wallet renamed");
        onRenamed();
      })
      .catch((err) => {
        const message = err?.message || "Rename failed";
        setError(message);
        toast.error(message);
      });
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!renameMutation.isPending}
      title="Rename wallet"
      size="max-w-sm"
    >
      <form onSubmit={submit} className="nc-stack">
        <Field label="Wallet name" error={error}>
          <Input
            autoFocus
            value={name}
            maxLength={42}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError("");
            }}
            disabled={renameMutation.isPending}
            invalid={Boolean(error)}
          />
        </Field>
        <div className="flex gap-2">
          <Button
            type="submit"
            size="block"
            loading={renameMutation.isPending}
            disabled={!trimmed || unchanged}
          >
            Rename
          </Button>
          <Button
            variant="secondary"
            size="block"
            onClick={onClose}
            disabled={renameMutation.isPending}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Backup                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function VaultBackupModal({ onClose, walletCount }) {
  const [passphrase, setPassphrase] = useState("");
  const [backupPass, setBackupPass] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const tooShort =
    backupPass.length > 0 && backupPass.length < MIN_BACKUP_PASSWORD_LENGTH;
  const canSubmit =
    passphrase.length > 0 && backupPass.length >= MIN_BACKUP_PASSWORD_LENGTH;

  const handleBackup = async (event) => {
    event.preventDefault();
    if (!canSubmit || loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await nileWalletClient.backup(passphrase, backupPass);
      const saved = await saveTextFile({
        defaultPath: result.filename,
        content: result.json,
      });
      if (saved?.canceled) {
        toast("Backup cancelled", { icon: "•" });
      } else {
        toast.success(`Backup saved — ${result.count} wallet(s)`);
      }
      onClose();
    } catch (err) {
      const message =
        err?.code === "bad-passphrase"
          ? "Wrong vault passphrase"
          : err?.message || "Backup failed";
      setError(message);
      if (err?.code === "bad-passphrase") toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!loading}
      title="Backup vault"
      description={`Exports all ${walletCount} wallet(s) to one encrypted file.`}
      icon={<HiOutlineShieldCheck className="size-4" />}
    >
      <form onSubmit={handleBackup} className="nc-stack">
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
            disabled={loading}
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
            disabled={loading}
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
            loading={loading}
            disabled={!canSubmit}
          >
            <HiOutlineArrowDownTray className="size-4" />
            Save backup
          </Button>
          <Button
            variant="secondary"
            size="block"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Restore                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function VaultRestoreModal({ onClose, onRestored }) {
  const [password, setPassword] = useState("");
  const [fileName, setFileName] = useState("");
  const [json, setJson] = useState("");
  const [preview, setPreview] = useState(null);
  const [overwrite, setOverwrite] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const pickFile = async () => {
    const result = await openTextFile({ title: "Select a NileVault backup" });
    if (result?.canceled) return;
    setJson(result.content || "");
    setFileName(result.fileName || "backup.json");
    setPreview(null);
    setOverwrite({});
    setError("");
  };

  const handlePreview = async (event) => {
    event.preventDefault();
    if (!json || !password || loading) return;
    setLoading(true);
    setError("");
    try {
      const res = await nileWalletClient.restorePreview(password, json);
      setPreview(res);
      setOverwrite(
        Object.fromEntries(
          res.entries.filter((entry) => entry.exists).map((entry) => [entry.account_id, false]),
        ),
      );
    } catch (err) {
      const message =
        err?.code === "bad-passphrase"
          ? "Wrong backup password"
          : err?.message || "Preview failed";
      setError(message);
      if (err?.code === "bad-passphrase") toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!preview || loading) return;
    setLoading(true);
    setError("");
    try {
      const res = await nileWalletClient.restoreApply(password, json, overwrite);
      toast.success(
        `Restored ${res.restored} wallet${res.restored === 1 ? "" : "s"}${
          res.skipped ? ` · ${res.skipped} skipped` : ""
        }`,
      );
      queryClient.invalidateQueries({ queryKey: ["nile-wallets"] });
      onRestored();
    } catch (err) {
      const message = err?.message || "Restore failed";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const overwriteCount = Object.values(overwrite).filter(Boolean).length;

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!loading}
      title="Restore from backup"
      description="Select a backup file and enter the password it was encrypted with to preview it."
      icon={<HiOutlineArrowUpTray className="size-4" />}
      size="max-w-md"
    >
      <form onSubmit={handlePreview} className="nc-stack">
        <button
          type="button"
          onClick={pickFile}
          disabled={loading || Boolean(preview)}
          className="nc-card-interactive flex w-full items-center gap-3 p-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-nile-gold-500/30 bg-nile-gold-500/10 text-nile-gold-400">
            <HiOutlineDocumentDuplicate className="size-4" />
          </span>
          <span className="min-w-0 grow">
            <span className="block truncate text-sm font-bold">
              {fileName || "Choose backup file…"}
            </span>
            <span className="nc-caption block">
              {fileName ? "File selected" : "A .json file exported from NileVault"}
            </span>
          </span>
          {json ? (
            <HiOutlineCheckCircle className="size-4 shrink-0 text-emerald-400" />
          ) : null}
        </button>

        {!preview ? (
          <>
            <Field
              label="Backup password"
              error={error}
              hint="The password chosen when this file was exported."
            >
              <PasswordInput
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError("");
                }}
                placeholder="Backup password"
                disabled={loading}
                invalid={Boolean(error)}
              />
            </Field>

            <div className="flex gap-2">
              <Button
                type="submit"
                size="block"
                loading={loading}
                disabled={!json || !password}
              >
                Preview backup
              </Button>
              <Button
                variant="secondary"
                size="block"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="nc-body">
              Found <span className="font-bold">{preview.entries.length}</span>{" "}
              wallet{preview.entries.length === 1 ? "" : "s"} in this backup.
            </p>

            <div className="flex flex-col gap-2">
              {preview.entries.map((entry, index) => (
                <div
                  key={entry.account_id}
                  className="nc-anim-rise flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3"
                  style={{ animationDelay: `${index * 40}ms` }}
                >
                  <div className="flex min-w-0 grow flex-col">
                    <span
                      data-selectable
                      className="nc-mono truncate text-neutral-200"
                    >
                      {truncateAddress(entry.address)}
                    </span>
                    <span className="nc-caption">
                      {entry.token_count
                        ? `${entry.token_count} token${entry.token_count === 1 ? "" : "s"}`
                        : "no tokens"}
                    </span>
                  </div>
                  {entry.exists ? (
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-bold text-nile-gold-400">
                      <input
                        type="checkbox"
                        checked={Boolean(overwrite[entry.account_id])}
                        disabled={loading}
                        onChange={(event) =>
                          setOverwrite((current) => ({
                            ...current,
                            [entry.account_id]: event.target.checked,
                          }))
                        }
                        className="size-3.5 accent-nile-gold-500"
                      />
                      Overwrite
                    </label>
                  ) : (
                    <span className="shrink-0 text-xs font-bold text-emerald-400">
                      New
                    </span>
                  )}
                </div>
              ))}
            </div>

            <p className="nc-caption">
              {overwriteCount > 0
                ? `${overwriteCount} existing wallet(s) will be replaced.`
                : "Existing wallets are kept unless you tick Overwrite."}
            </p>

            {error ? <p className="nc-message text-red-400">{error}</p> : null}

            <div className="flex gap-2">
              <Button
                size="block"
                loading={loading}
                disabled={loading}
                onClick={handleRestore}
              >
                Restore {preview.entries.length} wallet
                {preview.entries.length === 1 ? "" : "s"}
              </Button>
              <Button
                variant="secondary"
                size="block"
                onClick={() => setPreview(null)}
                disabled={loading}
              >
                Back
              </Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
