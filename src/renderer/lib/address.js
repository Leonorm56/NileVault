import { Address } from "@ton/core";

import { rawToDec, TON_DECIMALS } from "./amount.js";

/**
 * Address helpers.
 *
 * `Address.parse` from `@ton/core` accepts every form users paste — bounceable
 * (`EQ…`), non-bounceable (`UQ…`), the testnet variants, and raw `0:<hex>` — and
 * normalizes them, so validity checking is delegated to it rather than being
 * re-implemented with prefix sniffing.
 */

/** Any parseable TON address → normalized display (`UQ…`, url-safe, non-bounceable). */
export function toDisplayAddress(value) {
  try {
    return Address.parse(String(value ?? "").trim()).toString({
      urlSafe: true,
      bounceable: false,
    });
  } catch {
    return null;
  }
}

/** True when the value parses as a TON address in any accepted encoding. */
export function isValidAddress(value) {
  return Boolean(toDisplayAddress(value));
}

/** `EQab12…7xYz` — for dense places. Returns "" for an empty value. */
export function truncateAddress(value, lead = 6, tail = 6) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= lead + tail + 1) return text;
  return `${text.slice(0, lead)}…${text.slice(-tail)}`;
}

/** True when two addresses point at the same account, whatever their form. */
export function sameAddress(a, b) {
  try {
    return Address.parse(String(a)).equals(Address.parse(String(b)));
  } catch {
    return false;
  }
}

/**
 * Pull a recipient (and amount, when the link carries one) out of a pasted
 * value.
 *
 * Handles a bare address and the TON transfer deep link — `ton://transfer/<addr>
 * ?amount=<nano>` and the `https://app.tonkeeper.com/transfer/…` shape, which
 * uses the same path. Anything unrecognized is returned as-is so the field can
 * show it and the inline validation can reject it.
 */
export function parseTransferInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return { address: "", amount: "" };

  if (isValidAddress(text)) return { address: normalize(text), amount: "" };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      // `ton://transfer/<addr>` parses the scheme's first segment as the host,
      // while an https link keeps it in the path — so consider both.
      const parts = [url.hostname, ...url.pathname.split("/")].filter(Boolean);
      const index = parts.indexOf("transfer");
      if (index !== -1 && parts[index + 1]) {
        const address = decodeURIComponent(parts[index + 1]);
        const nano = url.searchParams.get("amount");
        const amount =
          nano && /^\d+$/.test(nano) ? rawToDec(BigInt(nano), TON_DECIMALS) : "";
        return { address: normalize(address), amount };
      }
    } catch {
      /* not a URL after all — fall through and let validation decide */
    }
  }

  return { address: text, amount: "" };
}

/** Normalize a pasted address, returning the input unchanged if it is invalid. */
function normalize(value) {
  return toDisplayAddress(value) || value;
}
