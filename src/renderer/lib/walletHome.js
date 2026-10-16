/**
 * Wallet-home view-model (vertical slice: S03).
 *
 * Pure aggregation for the home screen: holdings in, sorted rows + exact
 * total out. Money stays BigInt base units end to end; `rawToDec` is the only
 * place a decimal string is produced. Fiat totals arrive with the base-currency
 * slice — until then the total sums native-scale (9-decimal) rows.
 */

import { rawToDec } from "./amount.js";

/** Mask shown in place of every figure when balances are hidden. */
export const HIDDEN_MASK = "••••";

/** Native-scale decimals used for the header total until fiat lands. */
export const TOTAL_DECIMALS = 9;

function toRaw(value) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * @param {{holdings?: Array<{id?: string, symbol: string, balanceRaw: string|bigint, decimals?: number, pinned?: boolean}>, hidden?: boolean}} input
 * @returns {{isEmpty: boolean, totalRaw: bigint, totalDisplay: string, rows: Array<{id?: string, symbol: string, balanceRaw: bigint, balanceDisplay: string, pinned: boolean}>}}
 */
export function buildHomeModel({ holdings = [], hidden = false } = {}) {
  const rows = holdings.map((holding) => {
    const decimals =
      Number.isInteger(holding.decimals) && holding.decimals >= 0
        ? holding.decimals
        : TOTAL_DECIMALS;
    const balanceRaw = toRaw(holding.balanceRaw);
    const row = {
      symbol: String(holding.symbol ?? ""),
      decimals,
      pinned: Boolean(holding.pinned),
      balanceRaw,
      balanceDisplay: hidden ? HIDDEN_MASK : rawToDec(balanceRaw, decimals),
    };
    if (holding.id !== undefined) row.id = holding.id;
    return row;
  });

  rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.balanceRaw === b.balanceRaw) return 0;
    return a.balanceRaw > b.balanceRaw ? -1 : 1;
  });

  const totalRaw = rows.reduce((sum, row) => sum + row.balanceRaw, 0n);

  return {
    isEmpty: rows.length === 0,
    totalRaw,
    totalDisplay: hidden ? HIDDEN_MASK : rawToDec(totalRaw, TOTAL_DECIMALS),
    rows,
  };
}
