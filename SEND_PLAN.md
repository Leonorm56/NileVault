# NileVault send stack — MyTonWallet study + plan

Status: **plan for review. No code has been touched.**

- NileVault studied at `master` (single commit `bbca9f6` + working-tree changes) —
  `src/renderer/lib/nileWallet.js`, `src/renderer/lib/WalletInstance.js`,
  `src/renderer/app/NileWallet.jsx`, `tests/send.test.mjs`.
- MyTonWallet studied at `mytonwallet-org/mytonwallet@master` (v26.9.5, GPL-3.0-or-later).
  A blobless clone is parked at `%TEMP%/mtw-src` for reference if this plan is approved.

---

## Part 1 — How MyTonWallet actually sends

Six subsystems, each of which NileVault either lacks or does differently.

### 1.1 Wallet state and seqno — one call, one snapshot

`src/api/chains/ton/wallet.ts` + `src/api/chains/ton/toncenter/other.ts`

```ts
// toncenter/other.ts:55
export async function getWalletInfos(network, addresses: string[], signal) {
  const { wallets: states, address_book: addressBook } = await callToncenterV3(
    network, '/walletStates', { address: addresses.join(',') }, signal);
  // ...
  return Object.fromEntries(addresses.map((inputAddress) => [
    inputAddress,
    walletInfoByRawAddress[toRawAddress(inputAddress).toLowerCase()]
      ?? { address: inputAddress, balance: 0n, isInitialized: false, seqno: 0 },
  ]));
}
```

`wallet_type` gives the contract version, `status === 'active'` gives deployment,
`seqno` comes back as a plain field. **No stack parsing, no run-method call, no
assumption about response shape** — and a never-seen address normalizes to
`{balance: 0n, isInitialized: false, seqno: 0}` instead of throwing.

I verified this endpoint live, no API key required:

```
GET https://toncenter.com/api/v3/walletStates?address=EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N
200 → {"wallets":[{"address":"0:83DF…","is_wallet":true,"wallet_type":"wallet v3 r2",
       "seqno":343,"wallet_id":698983191,"balance":"1592540632751193","status":"active",
       "code_hash":"hNr6…","last_transaction_hash":"iBBQ…"}], …}
```

It accepts a comma-separated batch, which is also what lets them price/verify
multiple wallets in one request.

They then cache the result for 5 s (`WALLET_INFO_CACHE_TTL`) but **suppress the
cache while a transfer is in flight**:

```ts
// transfer.ts:156
function markTransferInFlight(network, address) { inFlightTransfers.add(getWalletInfoCacheKey(network, address)); }
// transfer.ts:192  — consumeCachedWalletInfo() returns undefined while in flight
```

So a stale seqno can never be reused across the estimate→send boundary.

### 1.2 Sign → broadcast, with the init attached at the last moment

`src/api/chains/ton/util/sendExternal.ts`

```ts
let neededInit;
if (init) {
  if (isWalletInitialized === true) neededInit = undefined;
  else if (isWalletInitialized === false) neededInit = init;
  else if (!await client.isContractDeployed(address)) neededInit = init;   // only ask if unknown
}
const ext = external({ to: address, init: neededInit, body: message });
```

Then two hashes are computed deliberately:

```ts
const msgHash = cell.hash().toString('base64');            // raw external message
const msgHashNormalized = getExternalMsgHashNormalized(ext); // canonical external-in (no stateInit)
const bodyMessageHash = message.hash().toString('base64');
```
and `msgHashNormalized` is what becomes the activity id / explorer id, while
`msgHash` is kept separately for CEX/swap matching.

### 1.3 Message construction

`src/api/chains/ton/transfer.ts:1636`

```ts
messages: messages.map(({ amount, payload, toAddress, stateInit }) => internal({
  value: amount,
  to: toAddress,
  body: payload,
  bounce: parseAddress(toAddress).isBounceable,   // ← the flag the sender chose
  init: parseStateInitCell(stateInit),
})),
sendMode: (doPayFeeFromAmount ? SendMode.CARRY_ALL_REMAINING_BALANCE : SendMode.PAY_GAS_SEPARATELY)
  + SendMode.IGNORE_ERRORS,
timeout: expireAt,   // now + TRANSFER_TIMEOUT_SEC (600 s)
```

with the comment: *"It's important to add IGNORE_ERRORS to every transaction.
Otherwise, failed transactions may repeat and drain the wallet balance."*
NileVault already uses mode 3 = `PAY_GAS_SEPARATELY|IGNORE_ERRORS`, so that part
matches — but `bounce` is hardcoded `true` and no `timeout` is passed.

### 1.4 Pre-flight: what they refuse to send

`transfer.ts:206 checkTransactionDraft` + `:466 checkToAddress`

- Rejects non-user-friendly / non-url-safe (`/[+=/]/`) formats and testnet
  addresses on mainnet (`InvalidAddressFormat`).
- **Refuses when the destination has no code and the address is bounceable**:
  ```ts
  // transfer.ts:248
  if (result.isBounceable && !isInitialized && !stateInit) {
    result.isToAddressNew = !(await fetchHasTransaction(network, toAddress, signal));
    return { ...result, error: ApiTransactionDraftError.InactiveContract };
  }
  ```
  and warns (`isToAddressNew`) when it's a first‑time recipient.
- Reports `explainedFee`, `isScam`, `isMemoRequired` (known-exchange addresses).
- Blocks on `InsufficientBalance` — computed from emulation, not a constant.

### 1.5 Fee estimation: emulate the real message

`src/api/chains/ton/emulation.ts` + `transfer.ts:1408`

```ts
async function emulateTransactionWithFallback(network, wallet, transaction, isInitialized, signal) {
  try {
    const emulation = await emulateTransaction(network, wallet, transaction, isInitialized, signal);
    return { isFallback: false, ...emulation };
  } catch (err) { logDebugError('Failed to emulate a transaction', err); }

  // legacy fallback — cannot estimate > 20 messages
  const { code = null, data = null } = !isInitialized ? wallet.init : {};
  const { source_fees: fees } = await getTonClient(network).estimateExternalMessageFee(wallet.address, {
    body: transaction, initCode: code, initData: data, ignoreSignature: true,
  });
  const networkFee = BigInt(fees.in_fwd_fee + fees.storage_fee + fees.gas_fee + fees.fwd_fee);
  return { isFallback: true, networkFee };
}
```

The primary path **emulates the whole external message and sums fees from the
resulting trace** (`parseEmulation` → `parsedTrace.totalNetworkFee`, plus
`realFee` and `received`), so it sees the jetton wallet hop, bounces, undeployed
contracts and multi-message transactions. Then:

```ts
// transfer.ts:1618
export function applyFeeFactorToEmulationResult(estimation) {
  return { ...estimation, networkFee: bigintMultiplyToNumber(estimation.networkFee, FEE_FACTOR) }; // 1.05
}
```

Note the shape of the legacy response: `source_fees` is **nested**. That detail
matters for NileVault (see B1).

### 1.6 Jetton transfers

`src/api/chains/ton/tokens.ts:207 buildTokenTransfer` + `util/tonCore.ts:85`

Wallet address resolution is **derived on-chain from the master**, not looked up
in an index:

```ts
export async function fetchTokenWalletAddress(network, address, tokenAddress, signal) {
  const minter = getTonClient(network).open(new JettonMinter(Address.parse(tokenAddress)));
  const walletAddress = await raceWithAbortSignal(() => minter.getWalletAddress(Address.parse(address)), signal);
  return toBase64Address(walletAddress, true, network);
}
export const resolveTokenWalletAddress = withCacheAsync(fetchTokenWalletAddress); // memoized in-process only
```

…and then **verified in the reverse direction** before it is trusted:

```ts
if (isTokenWalletDeployed) {
  const realTokenAddress = await resolveTokenAddress(network, tokenWalletAddress);
  if (tokenAddress !== realTokenAddress) throw new Error('Invalid contract');
}
```

Attached TON is per-token, not a constant
(`src/api/chains/ton/constants.ts` + `src/util/fee/getTonOperationFees.ts:77`):

| constant | value | used for |
|---|---|---|
| `TOKEN_TRANSFER_AMOUNT` | 0.05 TON | default jetton transfer |
| `TINY_TOKEN_TRANSFER_AMOUNT` | 0.018 TON | `token.isTiny` and TON USDT |
| `CLAIM_MINTLESS_AMOUNT` | 0.02 TON | mintless jetton (first claim) |
| `TOKEN_TRANSFER_FORWARD_AMOUNT` | 1 nano | `forward_ton_amount` |
| `DEFAULT_FEE` | (config) | added to the above for the pre-emulation bound |

plus mintless `stateInit` attachment, and `+ forwardAmount` when forwarding more
than 1 nano.

Body (`util/tonCore.ts:184`) — the TEP-74 layout, with the `Either` field written
through the documented helper:

```ts
let builder = new Builder()
  .storeUint(JettonOpCode.Transfer, 32)
  .storeUint(queryId ?? generateQueryId(), 64)   // random, not 0 — for trace/idempotency
  .storeCoins(tokenAmount)
  .storeAddress(Address.parse(toAddress))
  .storeAddress(Address.parse(responseAddress))
  .storeMaybeRef(customPayload)
  .storeCoins(forwardAmount ?? 0n);
builder = storeInlineOrRefCell(builder, forwardPayload, 0, noInlineForwardPayload);
```

`storeMaybeRef` is the real `@ton/core` `Builder` method. `storeMaybeCustomPayload`
— the name that crashed your last live jetton send — **does not exist** in
`@ton/core@0.63.1` (`node_modules/@ton/core/dist/boc/Builder.d.ts` exports only
`storeAddress`, `storeBit`, `storeCoins`, `storeMaybeRef`). Your tests since then
pin that explicitly (`tests/send.test.mjs:296`), which is the right fix.

### 1.7 Concurrency, retries and confirmation

`src/api/common/preventTransferConcurrency.ts:24` — a FIFO queue per
`(network, fromAddress)` with two stages, foreground (returned to the caller) and
background (awaited before the *next* send starts):

> *"Preventing concurrency is necessary in TON, because every transaction must
> have a unique sequential `seqno` that matched the one in the wallet data exactly."*

`src/api/chains/ton/util/sendBocRetry.ts:10` — `waitUntilWalletSeqnoChanges`,
60 s budget, 1 s poll. `submitGasfullTransfer` returns **as soon as the BOC is
accepted** and hands that wait to `finalizeInBackground`:

```ts
finalizeInBackground(async () => {
  try { await waitForWalletSeqnoChange(network, fromAddress, seqno); }
  finally { clearTransferInFlight(network, fromAddress); }
});
return { txId: msgHashNormalized, msgHashForCexSwap: msgHash, localActivityParams: {...} };
```

So the confirmation signal for a plain send is **"the wallet's seqno advanced"** —
proof the contract executed the message — not "the message hash says completed".

Error classification is by TVM exit code, not string sniffing
(`util/tonCore.ts:416`):

```ts
export function isSeqnoMismatchError(error: string) { return error.match(/exitcode=(33|133)\D/); }
export function isExpiredTransactionError(error: string) { return error.match(/exitcode=(35|136)\D/); }
```
→ mapped to `ConcurrentTransaction` / `IncorrectDeviceTime`.

### 1.8 Wallet version detection

`wallet.ts:313 getWalletVersions` builds **every** known version from the public
key (`simpleR1…v4R2, W5` — `walletClassMap`, `tonCore.ts:60`), asks the chain
about all of them at once, and `pickBestWalletVersion` (`wallet.ts:185`) picks by
last-transaction → balance → "has a jetton wallet". This is why importing a seed
created by another wallet app lands on the address that actually holds funds.

---

## Part 2 — NileVault's stack today

```
NileWallet.jsx  (form, debounced estimate, MAX, confirm snapshot)
  └─ nileWalletClient (preload/IPC)
      └─ nileWallet.js
           resolveSendParams()            validate address+amount, decToRaw, resolve jetton wallet
           handleTransferEstimate()       throwaway key → build → estimateFee → checkFunds
           handleTransferSend()           getKeyPair → build → estimate → check → broadcast → wait
             └─ WalletInstance.js
                  readSeqno()              tonapi /accounts/{a} status, then run_get_method getSeqno
                  buildTransferRequest()   internal(...) + createTransfer + external/storeMessage
                  estimateTransferFee()    toncenter /estimateFee
                  checkTransferFunds()     balances vs amount+fee
                  broadcastTransfer()      tonapi /blockchain/message
                  waitForConfirmation()    poll /blockchain/messages/{hash} 5×3 s
```

The good parts, which should be preserved: `Address.parse` everywhere; `sendMode 3`
(IGNORE_ERRORS); the jetton message targeting the owner's own jetton wallet;
`storeBit(0)` for both `Either` fields (byte-identical to `storeMaybeRef(undefined)`);
`accepted: false` handling on broadcast; the "a failed balance read is not a zero
balance" rule; the explicit `needsDeploy`; and the test suite that decodes the
signed BOC rather than mocking `beginCell`.

Everything below is a gap against §1.

---

## Part 3 — Concrete defects

### B1. Fee estimation never works — the request is malformed (verified live) 🔴

`WalletInstance.js:586`

```js
const res = await fetch(`${TONCENTER_BASE}/estimateFee`, {
  method: "POST",
  body: JSON.stringify({ boc, ignore_chksig: true }),
});
if (res.ok) {
  const data = await res.json();
  const total = sumFeeFields(data?.result);
```

Two independent bugs, both confirmed against the live endpoint:

1. **Request shape is wrong.** toncenter v2 `/estimateFee` does not take `boc`.
   ```
   POST https://toncenter.com/api/v2/estimateFee  {"boc":"te6…","ignore_chksig":true}
   → 422 {"ok":false,"error":"failed to parse post request: Error at path 'address': Field is missing"}
   ```
   It takes `{ address, body, init_code, init_data, ignore_chksig }`.

2. **Response shape is wrong too.** With the correct request:
   ```
   POST {address, body, init_code, init_data, ignore_chksig:true}
   → 200 {"ok":true,"result":{"@type":"query.fees",
        "source_fees":{"in_fwd_fee":613201,"storage_fee":0,"gas_fee":60534,"fwd_fee":0},
        "destination_fees":[]}}
   ```
   The four fields live under `result.source_fees`, but `sumFeeFields(data.result)`
   reads `result.in_fwd_fee` etc. → every field `Number(undefined)` → `NaN` →
   `seen` stays false → `null` → falls through to the fallback.

**Net effect: `estimated: false` is unreachable.** Every send silently reports the
flat fallback as the fee — 0.005 TON for TON (≈7× the real 0.00067 TON measured
above) and, worse, see B2.

*Fix:* send `{address, body: bodyCellBoc, init_code, init_data, ignore_chksig}` and
read `result.source_fees`; prefer trace emulation (§1.5) as the primary path with
this as the fallback.

### B2. The jetton fallback "fee" is the attached value, counted twice 🔴

```js
// WalletInstance.js:606
return {
  feeNano: isJetton ? JETTON_FORWARD_TON + JETTON_GAS_RESERVE : FALLBACK_FEE_NANO,  // 0.040000001
  estimated: true,
};
```
```js
// WalletInstance.js:641
const gasNeeded = JETTON_FORWARD_TON + JETTON_GAS_RESERVE + fee;   // 0.04 + 0.040000001
```
Combined with B1 (the fallback always fires), a jetton send requires **0.08 TON**
of TON to be considered funded, and the UI shows `~0.04 TON` as the network fee —
a number that is not a fee at all, it's the value being attached to the message.
A user holding 0.05 idle TON cannot send a USDT transfer that would actually work.

*Fix:* the fallback must be a *fee* constant, and the attached value must be
accounted once, on the requirement side (as MTW does: `fee = toncoinAmount + networkFee`).

### B3. `bounce: true` always, and no inactive-destination guard 🔴

```js
// WalletInstance.js:~528-545
message = internal({ to: destination, value: BigInt(amountRaw), bounce: true, body: beginCell().endCell() });
message = internal({ to: jettonWallet, value: JETTON_FORWARD_TON + JETTON_GAS_RESERVE, bounce: true, body: … });
```

and the bounce flag the user actually chose is discarded *before* the stack sees it:

```js
// NileWallet.jsx:652
const display = toDisplayAddress(value);            // → UQ…, url-safe, non-bounceable
// NileWallet.jsx:703
.estimateTransfer(accountId, { …, to: recipientState.address, … })   // the normalized form
```

MTW does the opposite on both counts (§1.3, §1.4): `bounce` comes from the parsed
recipient, and a bounceable address with no code is refused outright.

Consequences today:
- Pasting an `EQ…` address for a wallet that has never been deployed → the value
  bounces back, the recipient gets nothing, fees are burned, and the app reports
  success. This is the single most likely "I sent it and it never arrived" report.
- Pasting a `UQ…` address (the user explicitly asking for non-bounce) → the
  message now bounces anyway, which is the opposite of the request.

*Fix:* `Address.parseFriendly(raw)` (available in `@ton/core`) gives
`{address, isBounceable, isTestOnly}` — thread it through `resolveSendParams` →
`buildTransferRequest`; keep the raw input in the form state instead of only the
normalized display form; block (or hard-warn) when `isBounceable && !deployed`
using the `getAccountInfo` call that is already being made.

### B4. Jetton wallet address: indexer-dependent, persisted, never verified 🔴

```js
// WalletInstance.js:390
const cached = (await this.listTokens()).find(t => t.jetton_master_address === master);
if (cached?.jetton_wallet_address) return cached.jetton_wallet_address;      // ← persisted, never invalidated
const info = await this._json(`${API_BASE}/accounts/${owner}/jettons`);      // ← indexer dependency
```

MTW derives it from the master (`get_wallet_address`) and verifies the reverse
mapping (§1.6). NileVault's version fails when tonapi's index lags, fails
entirely for a token the account has never held, and — the dangerous case —
trusts a *stale* address written to disk by an earlier session with no expiry and
no re-verification, then sends a jetton transfer to it.

*Fix:* derive from the master on-chain; keep caching in memory only; verify with
`get_wallet_data().minter` before signing; drop `jetton_wallet_address` from the
persisted token record (or store it with a TTL and always re-verify).

### B5. No jetton-wallet deployment or mintless support 🟠

`buildTransferRequest` never asks whether the jetton wallet exists, never attaches
a `stateInit`, and has no mintless path (`CLAIM_MINTLESS_AMOUNT`, `isMintlessClaimed`).
A mintless jetton (the airdrop-style jettons) cannot be moved at all — the message
needs the claim `stateInit` and ~0.02 TON, and without it the transfer bounces or
exits with code 0. Combined with the fixed 0.04 attached (B2/§1.6 table) even a
plain first-time transfer to a fresh jetton wallet is under-funded relative to
MTW's per-token values.

*Fix:* `isTokenWalletDeployed` check + optional `stateInit` on the jetton message +
per-token attached value with a tiny-token case.

### B6. The hash shown is not the explorer hash when the wallet is undeployed 🟠

```js
// WalletInstance.js:~700
const hash = data.message_hash || Cell.fromBase64(boc).hash().toString("hex");
```

`boc` is the external message *including* `stateInit`. When `needsDeploy` is true
— i.e. a brand-new wallet's very first outgoing transfer, exactly when the user
most wants to check the link — the fallback hashes a different cell than the
indexer does, so `https://tonscan.org/tx/<hash>` (NileWallet.jsx:850) 404s. MTW
computes the canonical external-in hash on purpose for this reason (§1.2).

*Fix:* compute a normalized external-in hash (no stateInit) and use it for the
activity/explorer id, keeping tonapi's `message_hash`/raw hash as a secondary.

### B7. No serialization of concurrent sends → seqno race 🔴

There is nothing preventing two sends from the same wallet whose seqno reads
overlap: the send form, a second app window, and `nileWalletConnectManager`
(TON Connect requests) all reach `buildTransferRequest` independently. Both read
seqno *N*, both sign, validators accept one and drop the other — silently.

MTW's answer is a per-`(network,address)` queue plus in-flight cache suppression
(§1.7), with the *next* send waiting for the *previous* one to be seqno-confirmed.

*Fix:* a small per-account promise queue (≈30 lines: `createTaskQueue(1)`
equivalent) wrapping build→sign→broadcast, and a flag that marks the account
in-flight so any cached wallet state is ignored; hold the queue until the seqno
advance is observed (or a timeout).

### B8. Confirmation blocks the UI and uses a weaker signal 🟠

```js
// nileWallet.js:224 handleTransferSend
const { hash } = await wallet.broadcastTransfer(request.boc);
const txStatus = await wallet.waitForConfirmation(hash);   // 5 × 3 s, inline
```
The IPC call the UI awaits therefore takes up to 15 s past broadcast, and the
signal is tonapi's message status (`in_progress` → `pending`) rather than "the
wallet contract executed this". A `pending` answer is returned as a normal result,
so a dropped message is reported as a sent-but-unconfirmed transfer.

*Fix:* return immediately after the BOC is accepted with `{hash, msgHash, seqno}`;
confirm via seqno advance (§1.7) in the background, and let the UI poll/react.
Keep a bounded wait, but stop making the send call own it.

### B9. Wallet version is assumed, never verified 🟠

`WalletContractV4.create({workchain: 0, publicKey})` is hardcoded in
`nileWallet.js:70`, `nileWallet.js:130` and `WalletInstance.js:180`. `getAccountInfo`
already returns tonapi's `interfaces` (`WalletInstance.js:228-250`) — including
`wallet_v4r2` — and nothing reads it.

For wallets NileVault itself generates this is consistent. For an **imported**
24-word phrase from MyTonWallet or Tonkeeper (usually W5, sometimes v3r2 — see the
live sample above: `"wallet_type":"wallet v3 r2"`), NileVault derives a *different
address*, shows a zero balance, and the user reasonably concludes their funds are
gone. `@ton/ton@16.3.0` already ships `WalletContractV3R2`/`V5R1` classes.

*Fix:* cheap version — refuse to sign when the on-chain interface doesn't match
the contract being used to sign. Full version — MTW's enumerate-and-pick
(§1.8). At minimum the cheap one should ship with the send fixes; the full one is
a separate feature.

### B10. Address validation is weaker than it looks 🟡

`resolveSendParams` (`nileWallet.js:139`) accepts anything `Address.parse` takes:
raw `0:hex`, non-url-safe base64, and **testnet forms on mainnet** — MTW rejects
all three (`checkToAddress`, `transfer.ts:471`) because a testnet address has the
same hash as its mainnet twin, so pasting one silently sends real funds to the
mainnet account at that hash.

*Fix:* `Address.parseFriendly` + the three format checks, with the same inline
error surface as the existing recipient validation.

### B11. MAX leaves a fixed reserve instead of carrying the balance 🟡

`NileWallet.jsx:740` subtracts a hardcoded `TON_SEND_RESERVE_NANO = 0.05`, while
`TON_SEND_RESERVE_NANO` is not tied to the actual fee (which is ~0.0007 TON).
MTW switches to `CARRY_ALL_REMAINING_BALANCE|IGNORE_ERRORS` (130) when
`toncoinBalance === amount` (§1.3), which sweeps the account exactly and cannot
be under-reserved.

*Fix:* MAX sets mode 130 and sends `balance - 1` nano; the funds check must then
use the "full transfer" branch (fee only, not `amount + fee`).

### B12. Missing but cheap: `timeout`, `query_id`, comments 🟡

- No explicit `timeout` (valid-until) on `createTransfer`; `@ton/ton` has a
  `timeout?: Maybe<number>` arg (verified in `@ton/ton` `v4/WalletContractV4.d.ts`, `WalletV4BasicSendArgs`).
  MTW uses 600 s; the library default is far shorter, and a confirm dialog left
  open can outlive it.
- `queryId = 0n` on every jetton transfer. Legal, but it forfeits trace
  disambiguation and idempotency; MTW randomizes 64 bits (`generateQueryId`).
- No text-comment / payload support at all (native body is always empty), no
  `isMemoRequired` check for exchange deposit addresses. Feature gap rather than
  a bug, but it's the one thing users notice fastest.

---

## Part 4 — License: the plain answer

You asked for the real answer, so:

**MyTonWallet is `GPL-3.0-or-later`** (verified: `LICENSE` is the GPLv3 text,
`package.json` → `"license": "GPL-3.0-or-later"`). GPL-3.0 is strong copyleft —
not LGPL, not AGPL, but the ordinary GPL whose whole purpose is to propagate.

**If you copy or adapt their code and distribute NileVault, then yes: NileVault
must be licensed GPL-3.0 (or later) as a whole** — the entire application, not
just the ported file. Specifically you would have to:

- license all of NileVault under GPL-3.0-or-later (you cannot relicense it, and
  you cannot make it closed-source or dual-licensed),
- ship the complete corresponding source of the *whole* app to anyone you give
  the binary to (an Electron bundle is a binary distribution),
- keep their copyright notices and add a prominent notice of the modification,
- pass on the same rights to your recipients.

**What does *not* trigger it:** using it yourself. GPL obligations attach to
"conveying" (distributing) a copy. Running an adapted private build on your own
machine, never giving it to anyone, is unrestricted — GPL has no clause requiring
you to publish your own private modifications. Two things to keep in mind: this
checkout has a GitHub origin `Leonorm56/NileVault` that currently answers **404**
(i.e. private or nonexistent) — the moment that repo is public, or you hand the
`.exe` to another person, you are conveying, and the obligation is live. Note also
that **NileVault has no `LICENSE` file and no `private` flag in `package.json`**,
so right now there is nothing standing between you and accidentally shipping it.

**Does "write equivalent logic independently using only the public standards"
avoid the obligation? Yes — that is exactly the path that avoids it.** Copyright
protects *expression*, not the underlying method. TEP-74 defines the opcode
`0x0f8a7ea5`, the field order, and the two `Either` fields; the TON docs define
wallet-contract `seqno`, `valid_until`, `sendMode` flags and bounce semantics;
toncenter's API docs define the endpoint shapes. Any implementation you write
from those is your own code and carries no copyleft, even though it is
functionally identical to theirs.

The honest caveat: a *translated* port — same lines, renamed variables, TS→JS —
is still a derivative work, and "I reimplemented it from the documentation" is
much weaker if the file's structure and comments track theirs line for line.
To make the independent derivation real, not just claimed:

1. Write the spec first, from TEP-74 / TON docs / toncenter API docs (Part 1 above
   is most of it) — including the exact numbers, derived from *your own*
   measurement rather than copied constants.
2. Implement from that spec without having their files open.
3. Record the spec sources in the code comments (TEP-74 §, docs URLs), not their
   file paths.
4. Do not copy their constants, comments, function names or file layout.

Practical recommendation: **do this.** Everything NileVault needs is standard,
the volume is small (the whole agenda below is maybe 300 lines), and the payoff is
keeping NileVault freely licensable.

---

## Part 5 — Plan

### Approach

Clean-room implementation against the public standards (Part 4). No MyTonWallet
code enters the repo — not even as a comment. Where MyTonWallet's behaviour is
worth matching, the *standard or measured fact* is the justification, and that is
what goes in the comment.

Concretely: everything in my recommended list is defined by TEP-74, the TON
message-management docs, toncenter's `/estimateFee` + `/walletStates` API docs,
and `@ton/core`/`@ton/ton` typings — all of which I verified directly against the
live endpoints and the installed packages above. Nothing needs to come from their
source.

If you decide to keep NileVault private forever and take the fastest route, direct
porting is legal and I'd skip steps 1–4 in Part 4 — but you also then can never
distribute it. I'd rather not build that trap in.

### Phase 1 — correctness of the fee/message path (must ship together)

| # | Change | File |
|---|---|---|
| 1 | Single-snapshot wallet state: `fetchWalletState(address)` calling toncenter v3 `/walletStates` (returns `status`, `balance`, `seqno`, `wallet_type`, `interfaces`, batched), with the current tonapi path as fallback. `readSeqno` becomes a thin wrapper keeping its existing signature and error message. | `WalletInstance.js` (`getAccountInfo`, `readSeqno`, `readStackNumber` retained for the fallback only) |
| 2 | Correct fee estimation: primary = trace emulation of the full external message; fallback = `/estimateFee` with the **correct request shape** and reading `result.source_fees`; sum + 5 % headroom; flat constant only as last resort, and **never** the attached jetton value. | `WalletInstance.js:estimateTransferFee` |
| 3 | Fix the jetton double count: requirement = attached value + network fee, once. | `WalletInstance.js:checkTransferFunds` |
| 4 | Real `bounce` flag + inactive-destination guard + format checks (testnet-on-mainnet, non-url-safe, non-user-friendly); thread the **raw typed address** through instead of only the normalized display form. | `nileWallet.js:resolveSendParams`, `WalletInstance.js:buildTransferRequest`, `NileWallet.jsx` (recipient state) |
| 5 | Jetton wallet address derived from the master on-chain, verified against `get_wallet_data().minter`, in-memory cache only. | `WalletInstance.js:resolveJettonWalletAddress` / `_cacheJettonWallet` |
| 6 | Jetton-wallet deployment: `isTokenWalletDeployed` probe, per-token attached value, `stateInit` attached when the wallet (or a mintless claim) needs it. | `WalletInstance.js:buildTransferRequest`, new constants module |
| 7 | Normalized external-in hash for the activity id / explorer link; keep tonapi's hash separately. | `WalletInstance.js:broadcastTransfer`, `NileWallet.jsx` (result card) |
| 8 | Explicit `timeout` (600 s) on `createTransfer`; random `query_id`. | `WalletInstance.js:buildTransferRequest`, `buildJettonTransferBody` |

### Phase 2 — send safety

| # | Change | File |
|---|---|---|
| 9 | Per-account send queue (build→sign→broadcast serialized; next send waits for the previous seqno advance or timeout), plus in-flight state that suppresses any cached wallet info. Applies to the send form **and** the TON Connect manager path. | new small module + `nileWallet.js:handleTransferSend`, `nileWalletConnectManager.js` |
| 10 | Send returns as soon as the BOC is accepted; seqno-advance confirmation runs in the background and reports back through the existing react-query invalidation. | `nileWallet.js:handleTransferSend`, `NileWallet.jsx` |
| 11 | Error classification by TVM exit code (33/133 → concurrent, 35/136 → clock skew) instead of substring matching on the response text. | `WalletInstance.js:broadcastTransfer` |
| 12 | MAX = mode 130 + `balance - 1` nano, with the matching funds-check branch. | `NileWallet.jsx:fillMax`, `WalletInstance.js:checkTransferFunds` |

### Phase 3 — worth doing, separately reviewable

| # | Change | File |
|---|---|---|
| 13 | Version guard: refuse to sign when the on-chain interface/`code_hash` contradicts the contract being used (cheap). | `nileWallet.js:loadPublicContract`, `getKeyPair` |
| 14 | Full version enumeration + `pickBestWalletVersion` so imported W5/v3 seeds resolve to the funded address. | new module + picker/import flow |
| 15 | Text comment / payload on native sends; `isMemoRequired` warning for known exchange addresses. | `nileWallet.js:resolveSendParams`, `NileWallet.jsx` |
| 16 | Batched wallet states for the picker (one `/walletStates` request for all wallets instead of one tonapi fan-out each). | `WalletPicker.jsx` data path |

### Test plan (extend `tests/send.test.mjs`, keep the decode-the-BOC style)

- fee: `/estimateFee` is called with `{address, body, init_code, init_data}` and
  `result.source_fees` is the value that surfaces — assert `estimated === false`
  on the happy path (this test fails today, which is the point).
- fee: with the endpoint erroring, the returned fee is a *fee*, and for a jetton
  send it is not equal to the attached value; `checkTransferFunds` total equals
  `attached + fee`, not `attached + attached + fee`.
- bounce: `EQ…` input → `bounce: true`; `UQ…` input → `bounce: false`; decode the
  signed BOC to prove it.
- inactive destination: bounceable + undeployed → refused with a user-facing message.
- testnet address on mainnet → refused.
- jetton wallet: derived from the master; a mismatched `get_wallet_data` → refused;
  a stale persisted address never wins over a fresh derivation.
- undeployed wallet: the returned hash is the normalized external-in hash (and
  differs from `Cell.fromBase64(boc).hash()`).
- concurrency: two overlapping sends on one account serialize; the second either
  uses seqno+1 or re-reads; assert only one read of seqno for the pair when queued.
- exit codes 33/133 → "concurrent transaction" message; 35/136 → clock message.

### Verification beyond unit tests

1. `npm test` (all existing + new).
2. `npm run check:build` — extend it so the fee-request shape and the bounce
   derivation are asserted in the *bundled* output, not only in source.
3. `npm run verify:live` — extend to send a real 0.01 TON transfer from a funded
   test wallet and assert (a) `seqno` advanced and (b) the returned hash resolves
   in the indexer / on tonscan.
4. Packaged `.exe` (this app has a history of dev/prod divergence): one real TON
   send on the funded wallet with the fee it displayed matching the fee it paid,
   one real jetton send, and one send to a never-funded `UQ…` address.

### What I will not do

- No refactor of the TON Connect stack, backup/restore, or the layout work.
- No new runtime dependency — everything above is `@ton/core`, `@ton/ton` and
  `fetch`, all already in the tree.
- No behavioral change to the estimate *gate* semantics the UI depends on beyond
  the fields listed above.
- Nothing gets committed without your say-so.

---

## Part 6 — Beyond send: what else is worth taking

Ranked by how directly each addresses a problem NileVault has already hit.

1. **`withoutTransferConcurrency`** (§1.7) — the seqno queue. Highest value per
   line of code in this whole document; it is the difference between "one of two
   rapid sends silently vanished" and correct behaviour.
2. **In-flight suppression of cached wallet info** — same class of bug as the
   estimate→send race already identified in the code comment at
   `nileWallet.js:224`. NileVault has no cache today, so this is really "don't add
   one without this guard".
3. **Wallet version enumeration** (§1.8) — the only thing standing between an
   imported seed and a terrifying zero balance.
4. **Jetton wallet resolution by derivation + reverse verification** (§1.6) —
   makes resolution independent of indexer freshness, which is what B4 is about.
5. **Emulation-based fee estimation** (§1.5) — the only estimate that can see the
   jetton hop, a bounce, or an undeployed contract.
6. **Address book / scam + memo-required flags** (`resolveAddress`) — cheap
   warning surface for a wallet that lets people paste arbitrary addresses.
7. **`explainedFee`** — turning "Fee: ~0.04 TON" into "Fee: 0.005 TON network +
   0.018 TON attached to the token transfer" removes exactly the confusion B2
   creates.
8. **Trace/websocket-driven activity confirmation** — the long-term replacement
   for polling a message hash, and it removes the 15 s stall (B8) for good.
9. **State-init export** (`getWalletStateInit`, `wallet.ts:352`) — a recovery tool
   for an undeployed/never-funded wallet.
10. **The 5 % fee headroom convention** — trivial, and it prevents "not enough
    balance" flakes when a real fee lands slightly above the estimate.

---

## Appendix — reproduction

```bash
# 1. Malformed fee request (what NileVault sends today)
curl -s -X POST https://toncenter.com/api/v2/estimateFee \
  -H 'Content-Type: application/json' \
  -d '{"boc":"<any boc>","ignore_chksig":true}'
#  → 422 {"ok":false,"error":"failed to parse post request: Error at path 'address': Field is missing"}

# 2. The correct request + the real response shape
#    (address, body = signed transfer cell, init_code/init_data from contract.init)
#  → 200 {"result":{"source_fees":{"in_fwd_fee":613201,"gas_fee":60534,...},"destination_fees":[]}}

# 3. The single-snapshot wallet-state endpoint (no API key)
curl -s 'https://toncenter.com/api/v3/walletStates?address=EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'
#  → seqno, wallet_type, status, balance, code_hash in one response

# 4. Builder API reality check
node -e "const {beginCell}=require('@ton/core');const b=beginCell();
console.log(typeof b.storeMaybeRef, typeof b.storeMaybeCustomPayload)"
#  → function undefined
```
