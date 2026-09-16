/**
 * Amount helpers — the single implementation of decimal ↔ base-unit conversion
 * and display formatting.
 *
 * Everything money-shaped in the app goes through here: the wallet stack needs
 * exact BigInt math for signing, and the UI needs one consistent display format.
 * Previously three separate formatters existed (a `toFixed(4)` one in the
 * picker, a full-precision one in the wallet, and inline `BigInt` math in
 * between), which is why the same balance rendered differently on two screens.
 *
 * All values are handled as BigInt base units (nano for TON) internally so no
 * precision is ever lost to floating point.
 */

/** TON base units per coin. */
export const TON_DECIMALS = 9;

/** True for a well-formed unsigned decimal string ("1", "1.5", "0.000000001"). */
export function isDecimalString(value) {
  return /^\d+(\.\d+)?$/.test(String(value ?? "").trim());
}

/**
 * Decimal string → base units.
 *
 * Input is forgiving about grouping separators and surrounding space (users
 * paste "1,000.5"), but strict about form and precision. Messages are written
 * for the person typing, because they surface directly under the field.
 */
export function decToRaw(value, decimals = TON_DECIMALS) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[,\s_]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error("Enter a valid amount");
  }
  const [whole, fraction = ""] = cleaned.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Too many decimals (max ${decimals})`);
  }
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Base units → trimmed decimal string, full precision, no grouping. */
export function rawToDec(raw, decimals = TON_DECIMALS) {
  let value;
  try {
    value = BigInt(raw);
  } catch {
    return "0";
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = (abs % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${
    fraction ? `${whole}.${fraction}` : whole.toString()
  }`;
}

/** Insert thousands separators into an unsigned integer string. */
export function groupDigits(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Display formatter.
 *
 * `maxFraction` bounds the tail so a balance never renders as an unreadable
 * nine-digit string, but a non-zero amount is *never* silently rounded away: if
 * the whole visible window is zeroes the window widens to the first significant
 * digit. Pass `maxFraction: null` for the unbounded, exact value (`undefined`
 * cannot be used — it would fall back to the default).
 */
export function formatAmount(
  raw,
  { decimals = TON_DECIMALS, maxFraction = 4, group = true } = {},
) {
  if (raw === null || raw === undefined || raw === "") return "0";
  let value;
  try {
    value = BigInt(raw);
  } catch {
    return String(raw);
  }
  if (value === 0n) return "0";

  const plain = rawToDec(value, decimals);
  const negative = plain.startsWith("-");
  const [wholeRaw, fraction = ""] = (negative ? plain.slice(1) : plain).split(".");
  const whole = group ? groupDigits(wholeRaw) : wholeRaw;
  const sign = negative ? "-" : "";

  if (!fraction) return `${sign}${whole}`;
  if (maxFraction === null) return `${sign}${whole}.${fraction}`;

  const shown = fraction.slice(0, maxFraction).replace(/0+$/, "");
  if (shown) return `${sign}${whole}.${shown}`;

  // The visible window is entirely zeroes. When the value really is zero we are
  // done; otherwise extend to the first significant digit so a real (if tiny)
  // holding never renders as "0".
  const firstSignificant = fraction.search(/[1-9]/);
  if (firstSignificant !== -1) {
    return `${sign}${whole}.${fraction.slice(0, firstSignificant + 1)}`;
  }
  return `${sign}${whole}`;
}

/** Convenience wrappers for TON, which is the common case in the UI. */
export const nanoToTon = (nano) => rawToDec(nano, TON_DECIMALS);
export const tonToNano = (ton) => decToRaw(ton, TON_DECIMALS);

/**
 * Compare two decimal amount strings numerically via base units. Returns a
 * negative number, zero, or a positive number. Used for inline "exceeds
 * balance" feedback without going through parseFloat.
 */
export function compareAmounts(a, b, decimals = TON_DECIMALS) {
  try {
    const left = decToRaw(a, decimals);
    const right = decToRaw(b, decimals);
    return left === right ? 0 : left > right ? 1 : -1;
  } catch {
    return null;
  }
}
