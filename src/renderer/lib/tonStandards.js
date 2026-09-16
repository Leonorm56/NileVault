/**
 * TON protocol constants and small pure helpers for the send stack.
 *
 * Everything here is derived from the *public specifications* — the jetton
 * standard (TEP-74), the TON documentation on message management and wallet
 * contracts, and the toncenter API documentation. No third-party wallet's
 * implementation is copied: the values below are the values the standards
 * prescribe, with the reasoning recorded next to each one.
 *
 * Spec references:
 *  - TEP-74 "Jettons standard": the `transfer#0f8a7ea5` layout, the jetton
 *    wallet data layout (`balance:Coins owner:MsgAddressInt
 *    jetton_master_address:MsgAddressInt jetton_wallet_code:^Cell`), the
 *    `get_wallet_address` get-method, and the guidance to attach TON so the
 *    jetton wallet can pay for its own gas and forward a notification.
 *  - TON docs, "Message management → sending messages": send-mode flags
 *    1 = pay fees separately, 2 = ignore errors, 128 = carry the remaining
 *    balance. Mode 2 (IGNORE_ERRORS) is mandatory for a wallet that signs
 *    several messages: without it a failed action makes the contract replay
 *    the action list.
 *  - TON docs, wallet contracts: `seqno` (one outgoing message per value) and
 *    `valid_until` / `timeout` (the message is invalid after that time).
 *  - toncenter API docs v2 (`/estimateFee`, `/runGetMethod`) and v3
 *    (`/walletStates`).
 */

import { beginCell, external, storeMessage } from "@ton/core";
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from "@ton/ton";

/* ────────────────────────────────────────────────────────────────────────── */
/* Jettons (TEP-74)                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/** `transfer#0f8a7ea5` — the TEP-74 opcode for a jetton transfer body. */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/**
 * `forward_ton_amount`. Any non-zero value makes the destination's jetton
 * wallet send a `transfer_notification` to its owner; 1 nano is the smallest
 * amount that does so without giving away meaningful value (TEP-74).
 */
export const JETTON_FORWARD_TON = 1n;

/**
 * TON attached to a jetton transfer. TEP-74 expects the sender to fund the
 * jetton wallet's gas, its storage, the notification forward and (on the first
 * transfer) the deployment of the destination's jetton wallet; the standard's
 * reference value for that is 0.05 TON, and any unspent remainder comes back to
 * the sender's `response_destination`.
 */
export const JETTON_ATTACHED_TON = 50_000_000n;

/**
 * Smaller attachment for "tiny" jettons (low-value tokens whose transfers cost
 * less gas because they carry no meaningful notification payload). Chosen as
 * the smallest value that still covers a wallet-to-wallet transfer plus the
 * forward; callers that can emulate should use the emulated number instead.
 */
export const JETTON_ATTACHED_TON_TINY = 18_000_000n;

/**
 * Extra TON a mintless jetton needs on its first transfer, to pay for the
 * `state_init` that claims the jetton wallet (TEP-74 mintless extension).
 */
export const MINTLESS_CLAIM_TON = 20_000_000n;

/**
 * A random 64-bit `query_id` for a jetton transfer (TEP-74).
 *
 * A fixed 0 is legal, but it makes every transfer indistinguishable in a trace
 * and removes the idempotency handle a repeated message would otherwise have.
 * Where the platform has no CSPRNG the value falls back to `Math.random`; the
 * field only has to be distinct, not unpredictable.
 */
export function generateQueryId() {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * The data cell of a standard TEP-74 jetton wallet, used to derive the wallet's
 * address from the jetton master's wallet code without asking an indexer:
 *
 *   `balance:Coins owner:MsgAddressInt jetton_master_address:MsgAddressInt
 *    jetton_wallet_code:^Cell`
 */
export function jettonWalletData({ owner, master, code }) {
  return beginCell()
    .storeCoins(0n)
    .storeAddress(owner)
    .storeAddress(master)
    .storeRef(code)
    .endCell();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Send modes and timeouts                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/** Pay the fee from the wallet's balance, not from the transferred value. */
export const SEND_MODE_PAY_GAS_SEPARATELY = 1;
/** Do not replay the action list if an action fails. */
export const SEND_MODE_IGNORE_ERRORS = 2;
/** Withdraw the entire remaining balance of the wallet. */
export const SEND_MODE_CARRY_ALL_REMAINING_BALANCE = 128;

/** Default: fee paid separately, failures not replayed. */
export const DEFAULT_SEND_MODE =
  SEND_MODE_PAY_GAS_SEPARATELY + SEND_MODE_IGNORE_ERRORS;
/**
 * "Send everything": carry the whole balance instead of naming an amount. This
 * is the only correct way to empty a wallet — it cannot be under-reserved for a
 * fee the wallet has not measured yet.
 */
export const SWEEP_SEND_MODE =
  SEND_MODE_CARRY_ALL_REMAINING_BALANCE + SEND_MODE_IGNORE_ERRORS;

/**
 * `valid_until` window for a signed transfer, in seconds. A wallet contract
 * rejects a message whose timeout has passed, so this is the budget the user
 * has to confirm and broadcast. Ten minutes leaves room for a slow confirmation
 * dialog without leaving a signed transfer valid for long after the fact.
 */
export const TRANSFER_TIMEOUT_SEC = 600;

/* ────────────────────────────────────────────────────────────────────────── */
/* Fees                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Flat fee used only when no live estimate can be obtained (0.005 TON). */
export const FEE_FALLBACK_NANO = 5_000_000n;

/**
 * Headroom applied to a live estimate before it is shown or enforced. A real
 * fee can land slightly above an emulation (gas prices move between the
 * estimate and the block), and a funds check that is a few nano short turns
 * into a failed send.
 */
export const FEE_HEADROOM_PERCENT = 5;

/** Apply the headroom, in integer nano, without touching floating point. */
export function withFeeHeadroom(nano) {
  const value = BigInt(nano ?? 0n);
  if (value <= 0n) return value;
  return (value * BigInt(100 + FEE_HEADROOM_PERCENT)) / 100n;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Message hashing, comments, error codes                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Longest text comment that fits in a cell's bits: 1023 bits of payload.
 * The first cell also carries the 32-bit `op=0`, so it holds less.
 */
export const MAX_INLINE_COMMENT_BYTES = 127;
/** Payload bytes left in the head cell once the 32-bit opcode is written. */
export const MAX_HEAD_COMMENT_BYTES = Math.floor((1023 - 32) / 8); // 123

/**
 * A text comment as a message body: `op=0` (text) followed by the comment.
 *
 * Comments longer than 127 bytes do not fit in one cell, so the remainder is
 * packed into referenced cells (the "snake" format the TON documentation
 * defines for arbitrary byte strings).
 */
export function commentToCell(text) {
  const bytes = Buffer.from(String(text ?? ""), "utf8");
  if (bytes.length === 0) return beginCell().endCell();

  const headBytes = bytes.subarray(0, MAX_HEAD_COMMENT_BYTES);
  const chunks = [headBytes];
  for (
    let offset = MAX_HEAD_COMMENT_BYTES;
    offset < bytes.length;
    offset += MAX_INLINE_COMMENT_BYTES
  ) {
    chunks.push(bytes.subarray(offset, offset + MAX_INLINE_COMMENT_BYTES));
  }

  // The last chunk has nothing after it, so the chain is built backwards:
  // each earlier cell references the one that follows it.
  let next = null;
  for (let i = chunks.length - 1; i >= 1; i -= 1) {
    const builder = beginCell().storeBuffer(chunks[i]);
    if (next) builder.storeRef(next);
    next = builder.endCell();
  }

  const head = beginCell().storeUint(0, 32).storeBuffer(chunks[0]);
  if (next) head.storeRef(next);
  return head.endCell();
}

/**
 * A stable identifier for a transfer that does not depend on `state_init`.
 *
 * The message a wallet broadcasts carries its own `state_init` while it is not
 * deployed yet, which changes the hash of the cell that goes on the wire — so
 * the identifier a user copies for a first transfer would not match the same
 * transfer made later. Building the external-in message *without* the init
 * gives one value for both cases; the exact broadcast identity is returned
 * alongside it and is what the indexer is asked about.
 */
export function externalInHashNormalized({ to, body }) {
  return beginCell()
    .store(storeMessage(external({ to, body })))
    .endCell()
    .hash()
    .toString("hex");
}

/**
 * TVM exit codes, per the TON documentation on standard exit codes.
 * 33 → the wallet's `seqno` did not match the one in the message;
 * 35 → the message's `valid_until` had already passed.
 * The `+100` variants are the same codes reported by the action phase.
 */
const SEQNO_EXIT_CODES = new Set([33, 133]);
const EXPIRED_EXIT_CODES = new Set([35, 136]);

/** Pull a TVM exit code out of an error string, if one is present. */
export function parseExitCode(message) {
  const text = String(message ?? "");
  const match =
    text.match(/exit_?code[\s:=]+(-?\d+)/i) || text.match(/-?\b(33|133|35|136)\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** True when the failure is a `seqno` mismatch (another send won the race). */
export function isSeqnoMismatchError(message) {
  const code = parseExitCode(message);
  if (code !== null) return SEQNO_EXIT_CODES.has(code);
  return /seqno/i.test(String(message ?? ""));
}

/** True when the failure is an expired `valid_until`. */
export function isExpiredTransferError(message) {
  const code = parseExitCode(message);
  if (code !== null) return EXPIRED_EXIT_CODES.has(code);
  return /expire|valid_until|valid until/i.test(String(message ?? ""));
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Wallet contract versions                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * TON Connect "network global id" for mainnet. Wallet v5 stores it inside its
 * `wallet_id`, so a v5 wallet built with a different id is a different address.
 */
export const MAINNET_GLOBAL_ID = -239;

/** Versions this wallet can derive and sign for. */
export const WALLET_PLATFORMS = ["v3r2", "v4r2", "w5"];

/** Fallback for wallets created before the version was recorded. */
export const DEFAULT_WALLET_PLATFORM = "v4r2";

/**
 * Build the wallet contract for a public key. The version has to come from the
 * wallet record (or from on-chain detection): deriving a v4 address from a seed
 * that actually belongs to a v5 or v3 wallet produces a valid address that
 * holds nothing.
 */
export function buildWalletContract(publicKey, platform = DEFAULT_WALLET_PLATFORM) {
  const key = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(String(publicKey), "hex");
  switch (platform) {
    case "v3r2":
      return WalletContractV3R2.create({ workchain: 0, publicKey: key });
    case "w5":
      return WalletContractV5R1.create({
        workchain: 0,
        publicKey: key,
        walletId: { networkGlobalId: MAINNET_GLOBAL_ID },
      });
    case "v4r2":
    default:
      return WalletContractV4.create({ workchain: 0, publicKey: key });
  }
}

/**
 * Normalize the wallet version reported by an indexer into one of
 * {@link WALLET_PLATFORMS}, or `null` when the account is not a wallet this
 * build knows about.
 *
 * tonapi reports interfaces (`wallet_v4r2`), toncenter v3 reports a
 * human-readable `wallet_type` (`wallet v4 r2`); both spell the same contract.
 */
export function normalizeWalletPlatform(value) {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!text) return null;
  if (text.includes("v5") || text.includes("w5")) return "w5";
  if (text.includes("v4")) return "v4r2";
  if (text.includes("v3")) return "v3r2";
  return null;
}

/** True when an indexer interface string names a wallet contract. */
export function isWalletInterface(value) {
  return normalizeWalletPlatform(value) !== null;
}

/**
 * Refuse to sign a transfer with a contract version the chain does not agree
 * with.
 *
 * A wallet's address is a hash of its code and data, so the version that built
 * the contract is the version that must sign for it. Signing with the wrong one
 * produces a perfectly valid external message that the deployed contract
 * rejects — the user sees "sent" and nothing moves. The indexer reports the
 * deployed contract's interface for the same block the state was read from, so
 * the disagreement is detectable *before* anything is signed or broadcast.
 *
 * Unknown on either side is allowed: an account with no code has no interface
 * yet, and a provider that does not classify the contract must not be able to
 * block a send.
 *
 * Returns `null` when the two agree (or cannot be compared) and a
 * user-facing message when they do not.
 */
export function signingPlatformConflict(localPlatform, chainPlatform) {
  if (!localPlatform || !chainPlatform) return null;
  if (localPlatform === chainPlatform) return null;
  return (
    `The chain reports this wallet as ${chainPlatform}, but it would be signed ` +
    `as ${localPlatform}. Signing with a different contract version cannot ` +
    `succeed — re-import the wallet to rebuild it from its seed.`
  );
}
