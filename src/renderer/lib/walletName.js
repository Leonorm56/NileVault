/**
 * Wallet naming — pure helpers for the registry and the picker.
 *
 * Two separate concerns live here, both display-only:
 *
 *  1. {@link uniqueWalletName} allocates the default label for a wallet the
 *     user never named. The restore path used to derive it from the registry
 *     *length* (`Wallet ${wallets.length + 1}`), and length shrinks when a
 *     wallet is deleted — so deleting one wallet and restoring another
 *     re-issued a label that was already in use. Allocation is by
 *     max-used-index instead, which cannot collide with anything present.
 *
 *  2. {@link disambiguateLabels} keeps two wallets that legitimately share a
 *     label from rendering as two identical tiles. The registry's only
 *     uniqueness guarantee is the id, and NileVault does not own the labels
 *     people type, so duplicates are legitimate data, not an error to reject —
 *     the grid just has to make them tellable apart.
 *
 * Deliberately free of storage, IPC and React so it is testable in plain node.
 */

/** Prefix used for wallets the user never named. */
export const DEFAULT_WALLET_NAME = "Wallet";

/** Matches an allocated/explicit `Wallet N` label so its index stays reserved. */
const GENERATED_NAME = /^wallet\s+(\d+)$/i;

/** Case- and whitespace-insensitive identity for "is this label taken". */
const labelKey = (name) => String(name ?? "").trim().toLowerCase();

/**
 * Allocate a default wallet name that cannot collide.
 *
 * Considers both allocator output and hand-typed `Wallet N` labels, so a user
 * who named a wallet "Wallet 5" themselves still reserves index 5. Returns the
 * lowest free index rather than appending to the end, so a registry with gaps
 * (from deletions) refills instead of growing.
 *
 * @param {Array<{name?: string}>} [existing] current registry entries
 * @returns {string} e.g. `"Wallet 3"`
 */
export function uniqueWalletName(existing) {
  const used = new Set();

  for (const wallet of existing || []) {
    const match = GENERATED_NAME.exec(String(wallet?.name ?? "").trim());
    if (match) used.add(Number(match[1]));
  }

  let index = 1;
  while (used.has(index)) index += 1;
  return `${DEFAULT_WALLET_NAME} ${index}`;
}

/**
 * Short, stable discriminator for a wallet: the tail of its address.
 *
 * The address is the only per-wallet value that is both stable and already
 * displayed by the tile, which is why it is preferred over an ordinal — an
 * ordinal would renumber when any earlier wallet is deleted.
 */
function discriminator(wallet, address) {
  const fromAddress = String(address || "").replace(/\s+/g, "");
  if (fromAddress) return fromAddress.slice(-6);
  return String(wallet?.id || "").slice(-4);
}

/**
 * Choose a display label for every wallet, disambiguating duplicates.
 *
 * Non-colliding labels are returned untouched. Colliding ones keep their label
 * and gain a discriminator (`"188 · 4qW8Ig"`), so nothing the user typed is
 * rewritten — the label is preserved for search, rename and the delete
 * confirmation, and only the *rendering* differs.
 *
 * @param {Array<{id?: string, name?: string}>} [wallets]
 * @param {Record<string, string|null>} [addressById] id → address, when known
 * @returns {Record<string, string>} id → display label
 */
export function disambiguateLabels(wallets, addressById = {}) {
  // Only entries that can actually render as a tile participate. An entry with
  // no id cannot be keyed, opened or clicked, so it must not inflate a count
  // and force a suffix onto a wallet that has no twin on screen.
  const renderable = (wallets || []).filter((wallet) => wallet?.id);

  const counts = new Map();
  for (const wallet of renderable) {
    const key = labelKey(wallet.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const labels = {};
  for (const wallet of renderable) {
    const label = String(wallet.name ?? "");
    labels[wallet.id] =
      counts.get(labelKey(wallet.name)) > 1
        ? `${label} · ${discriminator(wallet, addressById[wallet.id])}`
        : label;
  }
  return labels;
}
