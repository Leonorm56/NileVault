/**
 * Custom wallet order — pure helpers.
 *
 * The order is a list of wallet *ids*, kept in the same kv storage the rest of
 * the wallet registry uses. Storing ids rather than positions means the order
 * survives unrelated changes: adding a wallet cannot shuffle existing ones, and
 * deleting one cannot shift the rest into the wrong slots.
 *
 * Filtering (`All` / `With Balance` / `Empty`) only ever *hides* tiles. The
 * order always spans the full list, so a filtered view never develops an order
 * of its own — that was an explicit requirement.
 */

/**
 * Apply a saved order to the wallet list.
 *
 * Wallets in the saved order come first, in that order; wallets the saved order
 * has never seen (newly added) keep their registry order after them. Ids in the
 * saved order that no longer exist are ignored, so a stale list cannot hide a
 * wallet or resurrect a deleted one.
 *
 * @param {Array<{id?: string}>} wallets registry order
 * @param {string[]} orderIds saved order, may be empty/stale/missing
 * @returns {Array} reordered copy (never mutates the input)
 */
export function applyWalletOrder(wallets, orderIds) {
  const list = Array.isArray(wallets) ? wallets : [];
  const saved = Array.isArray(orderIds) ? orderIds : [];
  if (!saved.length || list.length === 0) return list.slice();

  const rank = new Map();
  for (const id of saved) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }

  const ordered = [];
  const unseen = [];
  for (const wallet of list) {
    if (wallet?.id && rank.has(wallet.id)) ordered.push(wallet);
    else unseen.push(wallet);
  }

  ordered.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return [...ordered, ...unseen];
}

/**
 * Move one id to another id's position.
 *
 * Operates on the *full* id list even when the drag happened in a filtered
 * view: the visible ids are a subsequence, and moving within that subsequence
 * maps to the same relative move in the full list.
 *
 * @returns {string[]} new array; the input is not mutated
 */
export function reorderIds(ids, activeId, overId) {
  const list = Array.isArray(ids) ? ids.slice() : [];
  const from = list.indexOf(activeId);
  const to = list.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return list;

  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

/**
 * Ids of the wallets in a filtered view, in their full-list order — the set the
 * sortable context is told about.
 */
export function visibleIds(wallets, isVisible) {
  return (Array.isArray(wallets) ? wallets : [])
    .filter((wallet) => (isVisible ? isVisible(wallet) : true))
    .map((wallet) => wallet?.id)
    .filter(Boolean);
}
