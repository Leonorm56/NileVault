import AddWalletModal from "@/components/AddWalletModal";
import Container from "@/components/Container";
import nileWalletClient from "@/lib/nileWalletClient";
import toast from "react-hot-toast";
import { cn } from "@/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HiOutlineArrowPath,
  HiOutlineMagnifyingGlass,
  HiOutlinePencilSquare,
  HiOutlinePlus,
  HiOutlineShieldCheck,
  HiOutlineTrash,
  HiOutlineXMark,
} from "react-icons/hi2";
import TonCoinIcon from "@/assets/images/toncoin-ton-logo.svg";
import NileVaultLogo from "@/assets/images/nilevault-logo.jpg";

const CARD =
  "border bg-white/70 dark:bg-white/[0.06] backdrop-blur-md shadow-sm rounded-xl";

function formatTon(n) {
  return Number(n || 0)
    .toFixed(4)
    .replace(/\.?0+$/, "");
}

function formatTokenBalance(raw, decimals) {
  try {
    const value = BigInt(raw);
    const divisor = 10n ** BigInt(decimals);
    const whole = value / divisor;
    const fraction = (value % divisor)
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return "0";
  }
}

function truncate(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-6)}` : "—";
}

/** First-letter avatar colors based on first char of symbol. */
const AVATAR_COLORS = [
  "bg-nile-gold-500/15 text-nile-gold-600 border-nile-gold-500/30",
  "bg-blue-500/15 text-blue-400 border-blue-500/30",
  "bg-purple-500/15 text-purple-400 border-purple-500/30",
  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  "bg-rose-500/15 text-rose-400 border-rose-500/30",
  "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  "bg-amber-500/15 text-amber-400 border-amber-500/30",
];

function avatarColor(symbol) {
  const ch = (symbol || "?").charCodeAt(0);
  return AVATAR_COLORS[ch % AVATAR_COLORS.length];
}

export default function WalletPicker({ onSelect }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const gridRef = useRef(null);

  const walletsQuery = useQuery({
    queryKey: ["nile-wallets"],
    queryFn: () => nileWalletClient.listWallets(),
  });
  const wallets = Array.isArray(walletsQuery.data) ? walletsQuery.data : [];

  const detailsQuery = useQuery({
    queryKey: ["nile-picker-details", wallets.map((w) => w.id)],
    queryFn: async () =>
      Promise.all(
        wallets.map(async (w) => {
          const info = await nileWalletClient.get(w.id).catch(() => null);
          const address = info?.address || null;
          let balance = null;
          if (address) {
            const res = await nileWalletClient.balance(w.id).catch(() => null);
            balance = res && !res.error ? res.balance : null;
          }
          return { id: w.id, address, balance };
        }),
      ),
    enabled: wallets.length > 0,
    refetchInterval: 30_000,
  });

  const detailsById = useMemo(() => {
    const map = {};
    for (const row of detailsQuery.data || []) map[row.id] = row;
    return map;
  }, [detailsQuery.data]);

  const total = useMemo(
    () =>
      (detailsQuery.data || []).reduce(
        (sum, r) => sum + (parseFloat(r.balance) || 0),
        0,
      ),
    [detailsQuery.data],
  );

  /* ── Portfolio: discover all tokens across wallets, aggregate balances ── */

  const portfolioTokensQuery = useQuery({
    queryKey: ["nile-portfolio-tokens", wallets.map((w) => w.id)],
    queryFn: async () => {
      // Collect every token from every wallet, preserving first-added order.
      const seen = new Map(); // jetton_master_address → token metadata
      const walletsPerToken = new Map(); // jetton_master_address → [walletId]

      await Promise.all(
        wallets.map(async (w) => {
          try {
            const res = await nileWalletClient.listTokens(w.id);
            const tokens = res?.tokens || [];
            for (const t of tokens) {
              const addr = t.jetton_master_address;
              if (!seen.has(addr)) {
                seen.set(addr, t);
                walletsPerToken.set(addr, []);
              }
              walletsPerToken.get(addr).push(w.id);
            }
          } catch {
            // wallet has no tokens or fetch failed — skip
          }
        }),
      );

      // Return deduplicated list, first-added order (Map preserves insertion).
      return [...seen.values()].map((t) => ({
        ...t,
        walletIds: walletsPerToken.get(t.jetton_master_address) || [],
      }));
    },
    enabled: wallets.length > 0,
    refetchInterval: 30_000,
  });

  const portfolioTokens = portfolioTokensQuery.data || [];

  // Fetch aggregated balances for each portfolio token across ALL wallets.
  const portfolioBalancesQuery = useQuery({
    queryKey: [
      "nile-portfolio-balances",
      portfolioTokens.map((t) => t.jetton_master_address),
      wallets.map((w) => w.id),
    ],
    queryFn: async () => {
      const allWalletIds = wallets.map((w) => w.id);
      const results = {};
      await Promise.all(
        portfolioTokens.map(async (t) => {
          let sum = 0n;
          for (const wid of allWalletIds) {
            try {
              const res = await nileWalletClient.tokenBalance(wid, t);
              sum += BigInt(res?.balance || "0");
            } catch {
              // individual wallet balance failed — treat as 0
            }
          }
          results[t.jetton_master_address] = sum.toString();
        }),
      );
      return results;
    },
    enabled: portfolioTokens.length > 0,
    refetchInterval: 30_000,
  });

  const portfolioBalances = portfolioBalancesQuery.data || {};

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return wallets;
    return wallets.filter((w) => {
      const detail = detailsById[w.id];
      return (
        w.name.toLowerCase().includes(q) ||
        (detail?.address && detail.address.toLowerCase().includes(q))
      );
    });
  }, [wallets, detailsById, search]);

  const deleteMutation = useMutation({
    mutationFn: (id) => nileWalletClient.deleteWallet(id),
  });

  const removeTokenMutation = useMutation({
    mutationFn: async ({ masterAddress }) => {
      await Promise.all(
        wallets.map((w) =>
          nileWalletClient.removeToken(w.id, masterAddress).catch(() => {}),
        ),
      );
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }) => nileWalletClient.renameWallet(id, name),
  });

  const remove = useCallback(
    (wallet) => {
      if (
        !window.confirm(
          `Remove "${wallet.name}"? This deletes its encrypted seed and TON Connect sessions. Make sure you've backed up the recovery phrase — this cannot be undone.`,
        )
      )
        return;
      deleteMutation
        .mutateAsync(wallet.id)
        .then(() => {
          toast.success("Wallet removed");
          queryClient.invalidateQueries({ queryKey: ["nile-wallets"] });
        })
        .catch((error) =>
          toast.error(error?.message || "Failed to remove wallet"),
        );
    },
    [deleteMutation, queryClient],
  );

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["nile-wallets"] });
    queryClient.invalidateQueries({ queryKey: ["nile-picker-details"] });
    queryClient.invalidateQueries({ queryKey: ["nile-portfolio-tokens"] });
    queryClient.invalidateQueries({ queryKey: ["nile-portfolio-balances"] });
  }, [queryClient]);

  const removeToken = useCallback(
    (token) => {
      if (
        !window.confirm(
          `Remove "${token.symbol}" from all wallets?`,
        )
      )
        return;
      removeTokenMutation
        .mutateAsync({ masterAddress: token.jetton_master_address })
        .then(() => {
          toast.success(`${token.symbol} removed`);
          refreshAll();
        })
        .catch(() => toast.error("Failed to remove token"));
    },
    [removeTokenMutation, refreshAll],
  );

  const openContextMenu = useCallback((e, wallet) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, wallet });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => closeContextMenu();
    window.addEventListener("click", handler);
    window.addEventListener("contextmenu", handler);
    return () => {
      window.removeEventListener("click", handler);
      window.removeEventListener("contextmenu", handler);
    };
  }, [contextMenu, closeContextMenu]);

  return (
    <Container className="flex flex-col gap-4 max-w-[1440px]">
      {/* Total-balance summary */}
      <div
        className={cn(
          CARD,
          "flex flex-col items-center gap-1 p-5 text-center",
          "bg-gradient-to-b from-nile-gold-500/10 to-transparent",
        )}
      >
        <span className="text-xs uppercase tracking-wide text-neutral-400">
          Total Balance
        </span>
        <span className="text-3xl font-bold">
          {detailsQuery.isLoading && wallets.length > 0
            ? "…"
            : `${formatTon(total)} TON`}
        </span>
        <span className="text-xs text-neutral-400">
          {wallets.length} NileWallet{wallets.length === 1 ? "" : "s"}
          <button
            type="button"
            onClick={refreshAll}
            className="ml-2 inline-flex align-middle text-neutral-400 hover:text-nile-gold-500"
            title="Refresh balances"
          >
            <HiOutlineArrowPath
              className={cn(
                "size-3.5",
                detailsQuery.isFetching && "animate-spin",
              )}
            />
          </button>
        </span>
      </div>

      {/* Portfolio tokens row */}
      {wallets.length > 0 && (
        <div className={cn(CARD, "p-4")}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-neutral-400 uppercase tracking-wide">
              All Tokens
            </h3>
            <span className="text-xs text-neutral-500">
              {portfolioTokens.length + 1} asset{portfolioTokens.length > 0 ? "s" : ""}
            </span>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
            {/* TON card (always first) */}
            <div
              className={cn(
                "flex flex-col gap-1 p-3 rounded-xl min-w-[120px] shrink-0",
                "bg-white/50 dark:bg-white/[0.04] border border-neutral-200 dark:border-white/10",
              )}
            >
              <div className="flex items-center gap-2">
                <img src={TonCoinIcon} className="size-5" alt="" />
                <span className="text-sm font-bold">TON</span>
              </div>
              <span className="text-base font-bold text-nile-gold-500">
                {detailsQuery.isLoading && wallets.length > 0
                  ? "…"
                  : `${formatTon(total)} TON`}
              </span>
            </div>

            {/* Discovered jetton tokens */}
            {portfolioTokens.map((token) => {
              const raw = portfolioBalances[token.jetton_master_address];
              const isLoading = raw === undefined && portfolioBalancesQuery.isLoading;
              return (
                <div
                  key={token.jetton_master_address}
                  className={cn(
                    "group relative flex flex-col gap-1 p-3 rounded-xl min-w-[120px] shrink-0",
                    "bg-white/50 dark:bg-white/[0.04] border border-neutral-200 dark:border-white/10",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => removeToken(token)}
                    className="absolute top-1.5 right-1.5 text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-red-500"
                    title={`Remove ${token.symbol}`}
                  >
                    <HiOutlineXMark className="size-3.5" />
                  </button>
                  <div className="flex items-center gap-2">
                    {token.icon_url ? (
                      <img
                        src={token.icon_url}
                        className="size-5 rounded-full bg-white/10 object-cover"
                        alt=""
                      />
                    ) : (
                      <span
                        className={cn(
                          "inline-flex items-center justify-center size-5 rounded-full border text-[9px] font-bold",
                          avatarColor(token.symbol),
                        )}
                      >
                        {token.symbol?.slice(0, 2).toUpperCase() || "?"}
                      </span>
                    )}
                    <span className="text-sm font-bold truncate">
                      {token.symbol}
                    </span>
                  </div>
                  <span className="text-base font-bold text-nile-gold-500">
                    {isLoading
                      ? "…"
                      : `${formatTokenBalance(raw || "0", token.decimals)} ${token.symbol}`}
                  </span>
                </div>
              );
            })}

            {/* Add Token tile */}
            <button
              type="button"
              onClick={() => setShowAddToken(true)}
              className={cn(
                "flex flex-col items-center justify-center gap-1 p-3 rounded-xl min-w-[120px] shrink-0",
                "border border-dashed border-neutral-300 dark:border-white/15",
                "text-neutral-400 hover:text-nile-gold-500 hover:border-nile-gold-500/50",
                "transition-colors",
              )}
            >
              <HiOutlinePlus className="size-5" />
              <span className="text-xs font-bold">Add Token</span>
            </button>
          </div>
        </div>
      )}

      {/* Search bar */}
      {wallets.length > 1 && (
        <div className="relative">
          <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-neutral-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search wallets…"
            className={cn(
              "w-full rounded-xl border border-neutral-200 dark:border-white/10",
              "bg-white/70 dark:bg-white/[0.06] backdrop-blur-md",
              "pl-9 pr-9 py-2.5 text-sm",
              "placeholder:text-neutral-400",
              "outline-none focus:border-nile-gold-500/50",
              "transition-colors",
            )}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <HiOutlineXMark className="size-4" />
            </button>
          )}
        </div>
      )}

      {/* Tiles */}
      {walletsQuery.isLoading ? (
        <p className="text-center text-neutral-400">Loading wallets…</p>
      ) : filtered.length === 0 && search ? (
        <p className="text-center text-neutral-400 py-8">
          No wallets match &quot;{search}&quot;
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {filtered.map((w) => {
            const detail = detailsById[w.id];
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => onSelect({ id: w.id, name: w.name })}
                onContextMenu={(e) => openContextMenu(e, w)}
                className={cn(
                  CARD,
                  "group relative flex flex-col gap-1 p-3.5 text-left",
                  "hover:border-nile-gold-500/50 transition-colors",
                )}
              >
                <img src={NileVaultLogo} className="size-7 rounded-lg shrink-0" alt="" />
                <span className="font-bold text-sm truncate">{w.name}</span>
                <span className="text-base font-bold text-nile-gold-500">
                  {detail?.balance == null
                    ? detailsQuery.isLoading
                      ? "…"
                      : "—"
                    : `${formatTon(detail.balance)} TON`}
                </span>
                <span className="font-mono text-xs text-neutral-400 truncate">
                  {truncate(detail?.address)}
                </span>
              </button>
            );
          })}

          {/* Add tile */}
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className={cn(
              "flex flex-col items-center justify-center gap-2 p-3.5",
              "border border-dashed border-neutral-300 dark:border-white/15 rounded-xl",
              "text-neutral-400 hover:text-nile-gold-500 hover:border-nile-gold-500/50",
              "min-h-[7.5rem] transition-colors",
            )}
          >
            <HiOutlinePlus className="size-6" />
            <span className="text-sm font-bold">Add Wallet</span>
          </button>
        </div>
      )}

      {/* Vault actions row */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setShowBackupModal(true)}
          className={cn(
            CARD,
            "flex-1 flex items-center justify-center gap-2 py-3 px-4",
            "text-sm font-bold text-neutral-400",
            "hover:border-nile-gold-500/50 hover:text-nile-gold-500",
            "transition-colors",
          )}
        >
          <HiOutlineShieldCheck className="size-4" />
          Backup Vault
        </button>
        <button
          type="button"
          onClick={() => setShowRestoreModal(true)}
          className={cn(
            CARD,
            "flex-1 flex items-center justify-center gap-2 py-3 px-4",
            "text-sm font-bold text-neutral-400",
            "hover:border-nile-gold-500/50 hover:text-nile-gold-500",
            "transition-colors",
          )}
        >
          <HiOutlineArrowPath className="size-4" />
          Restore
        </button>
      </div>

      {showAdd && (
        <AddWalletModal
          onClose={() => setShowAdd(false)}
          onCreated={(wallet) => {
            setShowAdd(false);
            refreshAll();
            if (wallet?.id) onSelect({ id: wallet.id, name: wallet.name });
          }}
        />
      )}

      {showBackupModal && (
        <VaultBackupModal
          onClose={() => setShowBackupModal(false)}
          walletCount={wallets.length}
        />
      )}

      {showRestoreModal && (
        <VaultRestoreModal
          onClose={() => setShowRestoreModal(false)}
          onRestored={() => {
            setShowRestoreModal(false);
            refreshAll();
          }}
        />
      )}

      {showAddToken && (
        <AddTokenModal
          wallets={wallets}
          onClose={() => setShowAddToken(false)}
          onAdded={() => {
            setShowAddToken(false);
            refreshAll();
          }}
        />
      )}

      {renameTarget && (
        <RenameWalletModal
          wallet={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setRenameTarget(null);
            refreshAll();
          }}
          renameMutation={renameMutation}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-xl border border-neutral-200 dark:border-white/10 bg-white dark:bg-neutral-900 shadow-xl py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              closeContextMenu();
              setRenameTarget(contextMenu.wallet);
            }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-neutral-100 dark:hover:bg-white/[0.06]"
          >
            <HiOutlinePencilSquare className="size-4 text-neutral-400" />
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              closeContextMenu();
              remove(contextMenu.wallet);
            }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-neutral-100 dark:hover:bg-white/[0.06] text-red-500"
          >
            <HiOutlineTrash className="size-4" />
            Delete
          </button>
        </div>
      )}
    </Container>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* AddTokenModal — pick a wallet + enter contract address               */
/* ──────────────────────────────────────────────────────────────────── */

function AddTokenModal({ wallets, onClose, onAdded }) {
  const [selectedWallet, setSelectedWallet] = useState(wallets[0]?.id || "");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    if (!selectedWallet || !address.trim()) return;
    setLoading(true);
    setError("");
    try {
      await nileWalletClient.addToken(selectedWallet, address.trim());
      toast.success("Token added to wallet");
      onAdded();
    } catch (err) {
      if (err?.message === "needs-unlock") {
        toast.error("Unlock the vault first");
      } else {
        setError(err?.message || "Invalid token address");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Add Token">
      <form onSubmit={add} className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          Add a Jetton by its master contract address. It will be tracked in the
          selected wallet and appear in the portfolio.
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-neutral-500">Wallet</span>
          <select
            value={selectedWallet}
            onChange={(e) => setSelectedWallet(e.target.value)}
            className={INPUT}
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-neutral-500">
            Jetton Master Address
          </span>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="EQ…"
            className={cn(INPUT, "font-mono")}
            autoFocus
          />
        </label>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={loading || !selectedWallet || !address.trim()}
          className={cn(BTN_PRIMARY, (loading || !selectedWallet || !address.trim()) && "opacity-50 cursor-wait")}
        >
          {loading ? "Adding…" : "Add Token"}
        </button>
      </form>
    </Modal>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* RenameWalletModal                                                     */
/* ──────────────────────────────────────────────────────────────────── */

function RenameWalletModal({ wallet, onClose, onRenamed, renameMutation }) {
  const [name, setName] = useState(wallet.name);

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    renameMutation
      .mutateAsync({ id: wallet.id, name: name.trim() })
      .then(() => {
        toast.success("Wallet renamed");
        onRenamed();
      })
      .catch((err) => toast.error(err?.message || "Rename failed"));
  };

  return (
    <Modal onClose={onClose} title="Rename Wallet">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-neutral-500">Wallet Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
            autoFocus
          />
        </label>
        <button
          type="submit"
          disabled={!name.trim() || renameMutation.isPending}
          className={cn(BTN_PRIMARY, (!name.trim() || renameMutation.isPending) && "opacity-50 cursor-wait")}
        >
          {renameMutation.isPending ? "Renaming…" : "Rename"}
        </button>
      </form>
    </Modal>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* VaultBackupModal                                                     */
/* ──────────────────────────────────────────────────────────────────── */

function VaultBackupModal({ onClose, walletCount }) {
  const [passphrase, setPassphrase] = useState("");
  const [backupPass, setBackupPass] = useState("");
  const [loading, setLoading] = useState(false);

  const handleBackup = async (e) => {
    e.preventDefault();
    if (!passphrase) return toast.error("Vault passphrase required");
    if (!backupPass) return toast.error("Backup password required");
    if (backupPass.length < 8) return toast.error("Backup password must be at least 8 characters");

    setLoading(true);
    try {
      const result = await nileWalletClient.backup(passphrase);
      const { filename, json } = result;
      await window.nilevault.saveBackupFile({ defaultPath: filename, content: json });
      toast.success(`Backup saved — ${result.count} wallet(s)`);
      onClose();
    } catch (err) {
      if (err?.code === "bad-passphrase") {
        toast.error("Wrong vault passphrase");
      } else {
        toast.error(err?.message || "Backup failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Backup Vault">
      <form onSubmit={handleBackup} className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          Export all {walletCount} wallet(s) encrypted under a separate backup
          password. The vault passphrase proves you own the wallets; the backup
          password encrypts the exported file.
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-neutral-500">Vault Passphrase</span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className={INPUT}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-neutral-500">Backup Password (min 8 chars)</span>
          <input
            type="password"
            value={backupPass}
            onChange={(e) => setBackupPass(e.target.value)}
            className={INPUT}
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className={cn(BTN_PRIMARY, loading && "opacity-50 cursor-wait")}
        >
          {loading ? "Encrypting…" : "Save Backup"}
        </button>
      </form>
    </Modal>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* VaultRestoreModal                                                    */
/* ──────────────────────────────────────────────────────────────────── */

function VaultRestoreModal({ onClose, onRestored }) {
  const queryClient = useQueryClient();
  const [backupPass, setBackupPass] = useState("");
  const [json, setJson] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  const pickFile = async () => {
    const result = await window.nilevault.openBackupFile();
    if (result.canceled) return;
    setJson(result.content);
    setPreview(null);
  };

  const handlePreview = async (e) => {
    e.preventDefault();
    if (!json) return toast.error("Select a backup file first");
    if (!backupPass) return toast.error("Backup password required");

    setLoading(true);
    try {
      const res = await nileWalletClient.restorePreview(backupPass, json);
      setPreview(res);
    } catch (err) {
      if (err?.code === "bad-passphrase") {
        toast.error("Wrong backup password");
      } else {
        toast.error(err?.message || "Preview failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    setLoading(true);
    try {
      const overwrite = {};
      for (const entry of preview.entries) {
        if (entry.exists) overwrite[entry.account_id] = true;
      }
      const res = await nileWalletClient.restoreApply(backupPass, json, overwrite);
      toast.success(`Restored ${res.restored} wallet(s)`);
      onRestored();
    } catch (err) {
      toast.error(err?.message || "Restore failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Restore from Backup">
      <form onSubmit={handlePreview} className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          Select a NileVault backup file and enter the backup password to
          preview and restore wallets.
        </p>
        <button
          type="button"
          onClick={pickFile}
          className={cn(
            CARD,
            "w-full py-3 px-4 text-sm font-bold text-neutral-400",
            "hover:border-nile-gold-500/50 hover:text-nile-gold-500",
            "transition-colors",
          )}
        >
          {json ? "Backup file selected" : "Choose backup file…"}
        </button>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-neutral-500">Backup Password</span>
          <input
            type="password"
            value={backupPass}
            onChange={(e) => setBackupPass(e.target.value)}
            className={INPUT}
          />
        </label>
        {!preview ? (
          <button
            type="submit"
            disabled={loading || !json}
            className={cn(BTN_PRIMARY, (loading || !json) && "opacity-50 cursor-wait")}
          >
            {loading ? "Decrypting…" : "Preview Backup"}
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-neutral-200 dark:border-white/10 p-3 text-sm space-y-2">
              {preview.entries.map((e) => (
                <div key={e.account_id} className="flex justify-between items-center">
                  <span className="font-mono text-xs text-neutral-500 truncate">
                    {truncate(e.address)}
                  </span>
                  <span
                    className={cn(
                      "text-xs font-bold",
                      e.exists ? "text-yellow-500" : "text-green-500",
                    )}
                  >
                    {e.exists ? "Overwrite" : "New"}
                  </span>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={handleRestore}
              disabled={loading}
              className={cn(BTN_PRIMARY, loading && "opacity-50 cursor-wait")}
            >
              {loading ? "Restoring…" : `Restore ${preview.entries.length} Wallet(s)`}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Shared small modal + Tailwind tokens                                 */
/* ──────────────────────────────────────────────────────────────────── */

function Modal({ onClose, title, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-neutral-200 dark:border-white/10 bg-white dark:bg-neutral-900 p-6 shadow-xl">
        <h2 className="text-lg font-bold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const INPUT =
  "rounded-xl border border-neutral-200 dark:border-white/10 bg-white/70 dark:bg-white/[0.06] px-3 py-2.5 text-sm outline-none focus:border-nile-gold-500/50 transition-colors w-full";

const BTN_PRIMARY =
  "w-full rounded-xl bg-nile-gold-500 hover:bg-nile-gold-600 text-white font-bold py-2.5 text-sm transition-colors";
