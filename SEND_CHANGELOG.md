# NileVault send stack — Phase 1–3 changelog

Everything below is written against the **public specifications** — TEP-74, the
TON documentation on message management / wallet contracts / standard exit
codes, and the toncenter API docs. No MyTonWallet source was ported or adapted;
only the *list of properties a send stack needs* came from reading theirs. Each
non-obvious value carries its spec reference in a comment next to it. That keeps
NileVault free of GPL-3.0 obligations if it is ever distributed or made public.

---

## Phase 1 — correctness of the send path

**1. Wallet state is read in one snapshot** (`WalletInstance._fetchToncenterSnapshot`,
`fetchWalletState`, `parseToncenterStates`)

`status`, `balance`, `seqno` and `wallet_type` now arrive together from
toncenter v3 `/walletStates`, so the deployment decision and the sequence number
can never disagree. An address the indexer has never seen is *absent* from the
response (confirmed against the live API: 14 addresses asked for, 2 returned) and
is filled in as an empty account rather than treated as an error or a missing
key. tonapi is the fallback when toncenter is unavailable. The 5-second snapshot
cache is suppressed while a transfer is in flight.

**2. Fee estimation actually measures something** (`estimateTransferFee`)

Two independent defects made `estimated: false` unreachable:

- the request posted `{ boc, ignore_chksig }` to `/estimateFee`, which requires
  `address` + `body` (a live call returns `422 Field is missing: address`);
- the response was read flat off `result`, while the real response nests the
  fields under `result.source_fees` (and adds `result.destination_fees`), so every
  field parsed as `NaN`.

Both are fixed; the estimate now returns the measured total plus 5 % headroom,
falls back to a flagged flat constant (0.005 TON) when no measurement is
possible, and reports `source` so the UI can label it.

**3. The jetton attachment is counted once** (`checkTransferFunds`, `tonStandards`)

The old fallback returned the attachment itself as the "fee" and the funds check
added it again, demanding ~0.08 TON of idle TON for a transfer worth ~0.0007.
`JETTON_GAS_RESERVE` is gone; a jetton send needs the attachment plus the fee,
once each.

**4. `bounce` is derived, not hardcoded** (`resolveSendParams`, `bounceFlagFor`)

The recipient's *typed form* is preserved (`Address.parseFriendly`) instead of
being normalized to `UQ…` before the stack sees it, so `EQ…` means bounceable and
`UQ…` means not — which is the opposite behaviour for an account with no code. In
addition, a **bounceable** transfer to an account with no code is now refused
*before signing*, with a message that says what to do instead, and a testnet
address is rejected outright (the same hash exists on mainnet).

**5. Jetton wallet address: master-derived, reverse-verified, never persisted**
(`_deriveJettonWalletAddress`, `resolveJettonWalletAddress`)

The sender's own jetton wallet is obtained by calling the master's
`get_wallet_address` (authoritative, and works before the wallet exists), with the
spec's data layout as a local fallback, and is then **verification-checked
against the chain**: `get_wallet_data` must report this wallet as `owner` and this
master as `minter`, or the transfer is refused. Nothing is written to the token
record — a stored copy that has gone stale, or was written by an earlier build,
would be reused forever.

**6. Message identity is normalized** (`externalInHashNormalized`)

The user-facing hash is built from the external-in message *without* `state_init`,
so a first transfer (which carries the init) and the same transfer later agree;
the exact broadcast identity travels alongside it as `messageId`.

**7. Explicit timeout** — `valid_until` is `now + 600 s` (`TRANSFER_TIMEOUT_SEC`),
instead of a value that could already be in the past by the time the user
confirms.

**8. Random `query_id`** (TEP-74) — `generateQueryId()` returns a fresh uint64 per
jetton body, so two transfers are distinguishable in a trace.

---

## Phase 2 — concurrency, confirmation, error classification

**9. Per-account send queue** (`sendQueue.js`, `handleTransferSend`)

The whole build → sign → broadcast sequence runs inside a per-`(network, address)`
FIFO, and the wallet's state is read *after* the in-flight mark is set. Two
signatures against one `seqno` cannot both land, and the loser is dropped by
validators with no error — which is exactly the silent failure this removes. The
queue also suppresses the snapshot cache for that address. The only other code
path that signs is TON Connect's `sendTransaction`, which this app declines with
an explicit error rather than dropping (it cannot sign dApp-initiated requests), so
nothing can sign outside the queue.

**10. Confirmation is by seqno advance, and does not block**
(`waitForConfirmation`, `handleTransferSend`)

The caller gets the message hash as soon as the network accepts the BOC; the
outcome arrives through `onTransferSettled`. The signal is the wallet's own
`seqno` moving past the value that was signed — proof of *execution*, which the
old "is the message still in progress" check could not distinguish from a message
that was accepted and never executed. A message that never executes stays
`pending` rather than being reported as sent.

**11. TVM exit codes are classified** (`parseExitCode`, `isSeqnoMismatchError`,
`isExpiredTransferError`, `broadcastTransfer`)

33/133 (seqno mismatch) and 35/136 (expired window) are recognised by number and
mapped to a retryable message; `accepted: false` on an otherwise-OK broadcast is
no longer reported as success.

**12. MAX is sweep mode 130** (`SWEEP_SEND_MODE`, `fillMax`)

MAX sends the whole balance as `128 + 2` (carry the remaining balance, do not
replay on failure) instead of guessing a reserve — the only correct way to empty
a wallet. Typing an amount by hand clears the flag.

---

## Phase 3 — wrong-contract guards, version enumeration, payloads, picker

**13. On-chain interface guard** (`tonStandards.signingPlatformConflict`,
`buildTransferRequest`)

The transfer is checked against the *same snapshot the `seqno` comes from*: if the
chain reports a wallet version that is not the one the signing contract was built
for, the send is refused before signing instead of producing a valid message the
deployed contract rejects. Unknown on either side does not block a send.

**14. Full version enumeration** (`WALLET_PLATFORMS`, `buildWalletContract`,
`detectPlatform`, `importWallet`)

v3r2 / v4r2 / w5 are all derivable, and an import probes every candidate address
in **one** batched request and keeps the deployed/funded one, instead of deriving
a v4 address from a v3/W5 seed and showing an empty wallet. The version is stored
on the wallet record and used for every later signature.

**15. Comment payloads** (`commentToCell`) — `op = 0` text comments, with the
snake chain for anything past the 123 bytes that fit next to the opcode.

**16. Batched picker states** (`walletOverview`) — one request per *fleet*, not
one per wallet, degrading to the per-wallet path only if the batch read fails.

**17. The confirmation names the contract a jetton send is addressed to**
(`handleTransferEstimate` → `jettonWallet`, `NileWallet.jsx` confirm dialog,
`index.css` `.nc-address`)

For a jetton send the recipient is written *inside* the TEP-74 body; the message
itself goes to the sender's own jetton wallet. That resolved contract was
invisible, so the one derived value in the whole transfer was the one the user
could not check. The estimate now carries `jettonWallet` and the confirmation
renders it under "Token contract being called", with the recipient's caption
saying where the recipient actually lives.

Verifying that surfaced a second defect: the address spans asked for Tailwind's
`break-all`, which **this project never generates** (see the finding below), so a
48-character address had nothing to break on and overflowed the card — the
recipient address was clipped in the confirmation. Both addresses now use
`.nc-address` (a rule in `index.css`, always emitted) and wrap fully.

---

## Defect found while verifying, fixed

**`_sameAddress` rejected `Address` objects.** It fed both arguments straight to
`Address.parse`, which takes text; when the jetton verification passed the
`Address` objects a get-method decode returns, the comparison silently became
"false". The effect was that **every** jetton send failed closed at the
verification step. Fixed to coerce through `String()` when the value is not
already an `Address`, with a comment explaining why. Caught by
`tests/send.test.mjs` ("derives the wallet address from the master") and
confirmed by a live resolution of a real master.

---

## Out-of-scope finding (not fixed — needs a decision)

**Tailwind never generates utilities used only in `src/renderer/app/`.** v4's
source detection honours `.gitignore`, and the `app/` entry there (intended for
the Vite output directory) matches `src/renderer/app` at any depth. Measured on
the production bundle: of the 30 class tokens used *only* in the app-level JSX,
**25 are absent from the built CSS** — `break-all`, `break-words`, `border-t`,
`pt-2`, `p-6`, `py-1.5`, `h-11`, `w-52`, `grid-cols-1`, `lg:col-span-2`,
`min-h-[1.25rem]`, `-mt-1` and more. Symptoms visible in the running app:
section separators that never draw, spacing and control sizes that silently fall
back to defaults.

The one-line fix is a `@source` directive in `index.css` naming the app
directory, but it will materialise ~25 utilities across every screen at once,
which is a visual change that should be reviewed rather than slipped into this
work. `.nc-address` was added so this change does not depend on it.

## Verification

| Layer | Command | Result |
| --- | --- | --- |
| Unit — send stack | `npm test` (`test:send`) | **56 passed, 0 failed** |
| Unit — backup/restore | `npm test` (`test:backup`) | **18 passed, 0 failed** |
| Packaged artifact | `npm run build` → `check:build` | bundle **and** `app.asar` carry every new path; none of the old bugs (`storeMaybeCustomPayload`, `362c90ee`, `blockchains/accounts`, `JETTON_GAS_RESERVE`) |
| Live network, no key | `npm run verify:live` | **97 passed, 0 failed** |
| Live UI (browser preview, real chain) | `npm run build:web-preview` + preview server | confirm dialog renders the jetton wallet resolved from the live master; fee returned as a **measurement** (0.000524954 TON, no `~`); no console errors |
| Live funded, real broadcasts | `npm run verify:funded` | see below |

The live harness resolves a **real** jetton wallet for a real master
(`MGRMGA` → `EQBLdEnXnnbUeJ2PLJ-qTmA9M1wLJAKALaYRmm8fBoal98pR`) through the
master-derived, chain-verified path, asserts the exact TEP-74 body layout
(zero bits left over), reads real seqnos, estimates real fees, and confirms the
signed message is addressed to the owner's jetton wallet. A real batched read of
14 vault addresses returns one active wallet (0.05898512 TON, seqno 1,
`wallet_v4r2`) and correctly treats the addresses the indexer omits as empty
accounts.

**Outstanding:** the three real broadcasts (native TON, jetton, never-funded `UQ…`)
require the vault passphrase for the funded wallet, which only the holder has.
`scripts/funded-verify.mjs` performs all three through the app's own
`nileWallet` module against a copy of the real vault, waits for each `seqno`
advance, and prints the transaction links. It has not been run yet, so **no
commit** is made and the funded leg is not claimed as passing.
