# NileVault — Audit & Implementation Plan (Step 1)

Repo: `Leonorm56/NileVault` · local: `C:\Users\GH\Desktop\NileVault` · branch `master` @ `bbca9f6` (clean tree)
Stack: Electron 41 + React 19 + Vite 6 + Tailwind 4 + `@ton/ton` / `@ton/core` / `@ton/crypto`

Two files carry almost all of the UI: `src/renderer/screens/WalletPicker.jsx` (959 lines)
and `src/renderer/app/NileWallet.jsx` (1784 lines). The send stack is
`lib/nileWallet.js` (facade) → `lib/WalletInstance.js` (sign / broadcast).

---

# PART A — SEND FIX

## A.0 The actual code path today

```
SendSection (NileWallet.jsx)
  ├─ isValidRecipient()        → Address.parse()            [OK — EQ + UQ both work]
  ├─ debounced estimate (500ms)
  │    → nileWalletClient.estimateTransfer()
  │    → nileWallet.handleTransferEstimate()
  │         ├─ getKeyPair()               ← requires UNLOCKED, decrypts the seed
  │         ├─ resolveSendParams()        ← Address.parse + amount → raw
  │         ├─ wallet.buildSignedTransfer()  ← SIGNS
  │         ├─ wallet.estimateTransferFee()  ← hardcoded 5_000_000n
  │         └─ wallet.checkTransferFunds()   ← TON only
  └─ Confirm → sendTransfer()
       → nileWallet.handleTransferSend()
            ├─ getKeyPair() → resolveSendParams()
            ├─ buildSignedTransfer()      ← SIGNS AGAIN (different seqno possible)
            ├─ estimateTransferFee() (hardcoded)
            ├─ checkTransferFunds()       (TON only)
            ├─ broadcastTransfer()  → POST tonapi /v2/blockchain/sendBoc
            └─ waitForSeqnoChange()  → _getSeqno() ← BROKEN ENDPOINT (see A.3)
```

## A.1 — Jetton sends are **impossible**. (blocker)

`resolveSendParams()` (`lib/nileWallet.js:121`):

```js
if (!token?.jetton_wallet_address) throw new Error("Token not tracked");
```

`jetton_wallet_address` is **never written anywhere in the repo**. Grep confirms only three
references, all *reads*:

- `lib/nileWallet.js:121` (the guard above)
- `lib/nileWallet.js:658` (balance lookup arg, passed as `undefined` positionally — see A.6)
- `lib/WalletInstance.js:204` (message destination)

`WalletInstance.addToken()` persists only
`{ jetton_master_address, name, symbol, decimals, icon_url }`.

Therefore every Jetton send throws `"Token not tracked"` before a cell is ever built. The
Jetton branch of `buildSignedTransfer` is unreachable dead code.

**Fix.** Resolve the owner's Jetton wallet address at send time and cache it on the token record.

1. Add `WalletInstance.getJettonWalletAddress(jettonMaster)`:
   - Primary: `GET {API_BASE}/accounts/{owner}/jettons/{jettonMaster}` → `{ address, balance }`.
     This is the same shape the existing `getJettonBalance` loop already parses
     (`j.jetton.address`), so it reuses working parsing.
   - Fallback: `POST {API_BASE}/blockchain/accounts/{owner}/methods/get_wallet_address`
     with the master as stack arg — only if the first shape is unavailable.
   - Cache the resolved `jetton_wallet_address` back onto the stored token via
     `storage.set(tokensKey, …)` so subsequent sends skip the lookup.
2. Replace the guard in `resolveSendParams` with a **resolution** step instead of a throw:
   `jetton.jetton_wallet_address ||= await wallet.getJettonWalletAddress(jetton.jetton_master_address)`.
3. Make `getJettonBalance` also persist the discovered wallet address while it is iterating
   jettons, so the address is usually already cached by the time the user hits Send.

## A.2 — Jetton message body is malformed. (blocker, masked by A.1)

`WalletInstance.buildSignedTransfer()` currently builds:

```js
const payload = beginCell()...
  .storeUint(0x0f8a7ea5, 32) ... .endCell();      // TEP-74 transfer
body = beginCell()
  .storeUint(0x362c90ee, 32)                        // ← non-standard outer op
  .storeUint(0, 64)
  .storeCoins(toNano("0.05"))
  .storeRef(payload)
  .endCell();
```

Two defects:

- **Outer op `0x362c90ee` is not a TEP-74 op.** The wallet contract will not treat this as a
  transfer request. A Jetton transfer is a *single* internal message whose body is the
  transfer op — no wrapper.
- The message must be addressed to the **owner's own Jetton wallet**, not to the master,
  because the Jetton wallet is what moves balances. Line 204's
  `jetton.jetton_wallet_address || to` silently falls back to the **recipient** when the
  address is missing — which, combined with A.1, would have sent 0.05 TON to the recipient
  with a garbage body.

**Fix.** One TEP-74 body, sent to the owner's Jetton wallet:

```js
const body = beginCell()
  .storeUint(0x0f8a7ea5, 32)   // transfer
  .storeUint(0, 64)            // query_id
  .storeCoins(amountRaw)       // jetton amount
  .storeAddress(toAddr)        // destination
  .storeAddress(ownerAddr)     // response_destination → leftovers come back
  .storeBit(0)                 // custom_payload: nothing
  .storeCoins(forwardTon)      // forward_ton_amount
  .storeBit(0)                 // forward_payload: nothing
  .endCell();
// message: { to: jettonWalletAddr, value: forwardTon + gasReserve, body }
```

- `forwardTon` = 1n (notify the recipient's wallet so their balance updates) — currently 0,
  which is why the existing code also had to send 0.05 TON separately. Use
  `value = forwardTon + 0.04 TON` as the gas budget attached to the message.
- Drop `contract.address` fallback on the destination — throw a clear error instead
  (`"Could not resolve this token's wallet address"`).
- Remove the dead `0x362c90ee` construction entirely.

## A.3 — Seqno lookup hits a non-existent endpoint → every send from a used wallet fails. (blocker)

`WalletInstance._getSeqno()`:

```js
const raw = Address.parse(address).hash.toString("hex");
const res = await fetch(`${API_BASE}/blockchains/accounts/${raw}/methods/getSeqno`);
//                                              ^^^^^^^^^^^^  ^^^
if (!res.ok) return 0;
```

Two independent errors:

- Path is `/blockchains/` — tonapi v2's run-method path is
  **`/blockchain/accounts/{account_id}/methods/{method_name}`** (singular). `/blockchains/`
  does not exist → 404.
- It passes the 32-byte **hash hex** as the account id. tonapi needs a full address
  (`contract.address.toString()`, or raw `0:<hex>`).

Both failures land in `catch { return 0; }`, so the wallet **signs every transfer with
`seqno = 0`**. For a `WalletContractV4` whose seqno is already > 0 (i.e. any wallet that has
ever sent anything), the contract rejects the message — the transfer never lands, and no
error is ever surfaced because broadcast of an *unsigned-against-current-state* message
still returns HTTP 200 from `sendBoc`.

This is the headline "send is missing/broken" symptom.

**Fix.**

1. Correct the URL: `${API_BASE}/blockchain/accounts/${contract.address.toString()}/methods/getSeqno`.
2. Parse the real response shape: tonapi returns
   `{ success, exit_code, stack, decoded }`; read `decoded.seqno` and fall back to parsing the
   tuple from `stack[0]` (`["num", "0x…"]`). `success:false` / non-zero `exit_code` must be
   treated as *failure*, not as seqno 0.
3. **Never conflate "unknown" with "0".** `_getSeqno` should throw
   `Error("Could not read wallet sequence number")` on transport failure, and only return 0
   when the run-method call actually succeeded with a 0 result.
4. Track whether the contract is deployed at all (`account.status === "uninit"` from
   `GET /v2/accounts/{addr}`): an undeployed wallet *is* seqno 0 and also needs its
   `stateInit` attached to the first transfer (see A.7).
5. Add a transient-retry (2 attempts, short backoff) before giving up.

## A.4 — Confirmation is never detected; the UI hangs on "Broadcasting…".

`waitForSeqnoChange()` polls `_getSeqno` every 2s for 30s. Because A.3 always returns 0
(never > 0), the loop **always times out**, `txStatus` stays `"pending"`, and the success card
forever reads "Broadcasting… The transfer was accepted by the network and is pending
confirmation." Fixing A.3 largely fixes this, plus:

- Replace the blind seqno poll with `GET {API_BASE}/blockchain/messages/{hash}` and read
  `in_progress` / `status`, which is authoritative and cheap.
- Reduce inline blocking: poll ~4× at 3s, and if still pending, hand off to a React Query
  `refetchInterval` on the message so the button un-freezes and the card updates itself
  instead of holding the mutation for 30s.

## A.5 — "Fee estimation" is a stub.

```js
async estimateTransferFee(address, cell) { return 5000000n; }   // ignores both args
```

Every send shows a hardcoded `~0.005 TON`. For Jettons the real cost is
`forward_ton + storage + compute`, i.e. ~10–20× that.

**Fix.** Real estimation with a labelled fallback:

- Primary: `POST https://toncenter.com/api/v2/estimateFee` with the BOC
  (`{ boc }` → `{ result: { storage_fees, in_fwd_fee, … } }`), summing to a total.
- Fallback: keep the constant but return it flagged (`{ nano, estimated: false }`) so the UI
  renders `est. fee` instead of a precision it does not have. If the live call fails, never
  silently present the stub as an exact figure.
- Fee display must be asset-aware: TON sends pay in TON; Jetton sends pay TON gas
  *and* move the Jetton — the current single "Network fee" line conflates them.

## A.6 — No Jetton balance check; TON check is lossy.

```js
async checkTransferFunds({ contract, amountRaw, jetton, feeNano }) {
  ...
  return { sufficient: true, tonBalanceRaw: balanceNano.toString(), jettonBalanceRaw: null };
}
```

The `jetton` argument is accepted and **never used**. Consequences:

- Sending more USDT than you hold produces a perfectly valid BOC that fails on-chain after
  broadcast — the user sees "Broadcasting…" and then nothing.
- `jettonBalanceRaw` is always `null`, so `SendSection` has no way to warn before signing.
- `balanceNano = toNano(await this.getBalance(address))` round-trips nano → decimal string
  (`fromNano`) → nano, losing precision and relying on a string parse that throws on
  malformed input. Use the raw API balance instead.
- Jetton sends need TON for gas; that is never checked, so a token-only wallet builds a
  transfer it cannot pay for.

**Fix.**

- `getBalance` returns `{ nano, available }` (raw `data.balance` string) rather than a
  pre-formatted decimal; keep a formatting helper for the UI.
- `checkTransferFunds` checks, in order: (a) Jetton `amountRaw <= jettonBalance`, (b) TON
  `balance >= gasReserve + feeNano` for Jetton sends, (c) `balance >= amountRaw + feeNano`
  for TON sends. Return a specific reason for each.
- Distinguish **"balance unavailable"** (RPC failure) from **"insufficient"**. Today any
  network hiccup makes `getBalance` return `"0"` and the form claims
  "Insufficient TON balance (0 TON)", which is actively misleading.
- Fetch the Jetton balance through the existing `_getJettonBalance` path and pass it into the
  check so the pre-sign validation is real.

## A.7 — First transfer from a fresh wallet will not deploy it.

`contract.createTransfer()` on `WalletContractV4` does not attach `stateInit`. A brand-new
`V4R2` wallet with a funded but undeployed address will broadcast a transfer that cannot
execute.

**Fix.** When `account.status === "uninit"`, attach `init: contract.init` to the transfer's
message so the first outgoing transfer also deploys the wallet, and include the deploy cost in
the fee estimate and the funds check.

## A.8 — The confirm dialog is not showing the same transaction that gets broadcast.

Estimate signs once, send signs again. If seqno moves between the two (or if the fee
changed), the message the user approved is not the message that goes out. Also the estimate
path requires the vault to be **unlocked** purely to decrypt the seed and sign.

**Fix.**

- Split estimation from signing: parsing/validation (`Address.parse`, decimal→raw, funds
  check against a fetched balance) needs **no keys**. Only the final broadcast needs the seed.
  Stop prompting for unlock while the user is merely typing an address.
- For a real fee figure without a signature, build an unsigned transfer or simulate with a
  throwaway keypair; never require unlock for validation.
- Snapshot the confirmed parameters (`to`, `amountRaw`, `asset`, `feeNano`) into state and send
  *those*, not the live form values, so editing the form while the confirm box is open cannot
  change what is sent.

## A.9 — Post-send refresh is incomplete.

`onSent` refetches the TON balance and invalidates TokenSection's balances, but the picker's
`nile-picker-details` / `nile-portfolio-balances` queries keep stale values until their own
30s interval ticks. Invalidate those keys on send so the picker is correct when you go back.

## A.10 — Confirmed already working (regression guard)

- **EQ/UQ: yes.** `isValidRecipient()` and `resolveSendParams()` both use `Address.parse()`,
  which accepts bounceable (`EQ`), non-bounceable (`UQ`), and raw `0:hex` forms and normalizes
  them. Addresses are stored and transmitted as non-bounceable `UQ`. This must be covered by a
  test after the refactor (they are easy to break when rewriting the send path).
- **Native TON send: structurally correct** — body is an empty cell (`storeUint(0,1)`),
  destination is the parsed recipient, value is the raw amount. It fails only because of
  A.3 (seqno) and A.6/A.7 (funds/deploy).

## A.11 — Send DX gaps to close in the same pass

- No paste handling for deep links (`ton://transfer/EQ…?amount=1.5`, `tonkeeper://…`). Parse
  them and prefill both fields.
- No "send to self"/"send to my other wallet" shortcut, though the picker knows every address.
- No amount-vs-balance inline hint until the estimate round-trip returns.
- The recipient is echoed back as a raw 48-char string in the confirm box; show a
  truncated `EQab…7xYz` with a copy button.
- No balance refresh after a failed send, so a stale balance keeps blocks/permits retries
  incorrectly.
- The success card links to `https://tonscan.org/address/{sender}` — should be
  `https://tonscan.org/tx/{hash}` (see Audit item B).

## A.12 — Verification plan for the send fix

1. Unit-test the pure helpers (`decimalToRaw`/`rawToDecimal`, `isValidRecipient`) with EQ, UQ,
   raw `0:hex`, an invalid checksum, and boundary decimals; assert huge values don't lose
   precision (BigInt paths).
2. Assert the built Jetton body bytes equal a known-good TEP-74 fixture
   (op `0x0f8a7ea5`, query_id 0, amount, destination, response_destination = owner,
   forward payload empty) and that the message destination is the **Jetton wallet**, not the
   recipient or the master.
3. Assert `_getSeqno` calls `/blockchain/accounts/{address}/methods/getSeqno` (singular) and
   that a transport failure throws rather than returning 0.
4. Live test in the **packaged .exe** on mainnet: (a) TON send to a second wallet you control,
   confirm the balance drops and the row appears on tonscan; (b) Jetton send of a dust amount
   from a wallet holding that Jetton; (c) attempt an over-balance Jetton send and assert the
   inline warning blocks the button; (d) send from a wallet with seqno > 0 (the case that is
   broken today) and from a fresh, never-sent wallet (deploy path); (e) send to a `UQ…`
   address and to a raw `0:…` address.
5. Confirm the seqno after the send actually incremented (proves we did not double-spend by
   replaying seqno 0).

---

# PART B — INTERACTION & FEEL

Ground truth: across ~3,300 lines of renderer code there are **13** occurrences of
`transition*` and **zero** `active:` variants. Tiles/switches change colour with no transition;
nothing in the app registers a press. This is the mechanical source of "stiff".

## B.0 Shared primitives (build these first — most of B.1 collapses into them)

1. **`Button`** (`components/Button.jsx`) — currently
   `p-2 rounded-lg font-bold flex justify-center items-center gap-2 disabled:opacity-50` with
   only colour variants. Add:
   `transition-all duration-150 ease-out`, `hover:-translate-y-px`, `active:translate-y-0
   active:scale-[0.98]`, `focus-visible:ring-2 focus-visible:ring-nile-gold-400/60
   focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950`, `disabled:cursor-not-allowed`,
   and distinct hover shades per variant (`default: hover:bg-nile-gold-400 active:bg-nile-gold-600`;
   `secondary: hover:bg-white/[0.08] active:bg-white/[0.12]`; `danger: hover:bg-red-500
   active:bg-red-600`). Add a `loading` prop that renders a spinner **in place of the icon**
   and keeps the label, so a sending button never looks like a frozen one.
2. **`Spinner`** (`components/Spinner.jsx`, new) — a single gold-on-navy ring used by Button,
   the balance refresh, tiles, and screens. Today `animate-spin` is hand-applied in 4 places on
   whatever icon happens to be there.
3. **`IconButton`** (`components/IconButton.jsx`, new) — wraps the 6+ naked icon-only buttons
   (refresh, clear search, remove token, remove token tile, password toggle). Adds hover fill
   (`hover:bg-white/[0.08]`), press scale, focus ring, and a required `label` for
   `aria-label`.
4. **`Switchable`/`Field`** wrapper for inputs — see B.2/B.3.
5. **Global motion tokens** in `index.css`: `--nc-dur-fast: 120ms; --nc-dur: 160ms;
   --nc-dur-slow: 240ms; --nc-ease: cubic-bezier(.2,.8,.2,1)` plus `@media
   (prefers-reduced-motion: reduce)` zeroing them. Every animation below reads these.

## B.1 Complete inventory of interactive elements with **no** feedback state

Legend: **H** = hover, **A** = active/pressed, **T** = transition, **D** = disabled distinct,
**L** = loading distinct, **F** = focus-visible, **V** = inline validation.

### `App.jsx` (shell)
| # | Element | Has today | Missing | Fix |
|---|---|---|---|---|
| 1 | "← Wallets" back button | colour-on-hover | A T F | underline slide-in + `active:scale`; becomes a real transition anchor for the screen change |
| 2 | "Lock" button | colour-on-hover | H(fill) A T F L | add hover fill, press, and a brief "Locking…" spinner state; locking is currently instantaneous with no acknowledgement |
| 3 | Header (wordmark / version) | static | — | version becomes a subtle animated swap when the value arrives, not a pop-in |

### `screens/WalletPicker.jsx`
| # | Element | Has today | Missing | Fix |
|---|---|---|---|---|
| 4 | Total-balance refresh icon **H A T F** | colour-on-hover | H A T F | IconButton + gold hover disc; spinner replaces the icon while fetching |
| 5 | "TON" portfolio card | static | — | not clickable today; either make it open the wallet that holds it or drop the card affordance |
| 6 | Token card remove "✕" (appears on `group-hover`) | `opacity-0 → 100` **with no transition** | H A T F | fade+scale in over 120ms, red hover disc, `aria-label`; today it *snaps* into existence |
| 7 | "Add Token" dashed tile | colour-on-hover | A T F | lift + press, dashed border animates to solid gold on hover, `active:scale-[0.98]` |
| 8 | "Search wallets…" input | focus border | T V F(ring) | focus ring transition; show an inline "no match" state as you type rather than only after the list collapses |
| 9 | Search clear "✕" | colour-on-hover | H A T F | IconButton |
| 10 | **Wallet tile** | `hover:border-gold transition-colors` | H(lift) A T(exit) F | this is the flagship fix: `hover:-translate-y-0.5 hover:shadow-lg hover:shadow-nile-gold-500/5`, `active:scale-[0.98]`, and a **press → hold (150ms) → fade/scale-out → destination fade/scale-in** handoff instead of the current instant swap |
| 11 | Wallet tile `onContextMenu` | none | — | no visual hint that right-click exists; add a `⋯` affordance on hover |
| 12 | "Add Wallet" tile | colour-on-hover | A T F | as #7 |
| 13 | "Backup Vault" button | colour-on-hover | H(fill) A T F | CARD-style buttons share a `cardButton` primitive with lift+press |
| 14 | "Restore" button | colour-on-hover | H(fill) A T F | same |
| 15 | Context menu container | none | enter animation | scale-in from the cursor anchor (`origin-top-left`, 120ms) + fade |
| 16 | Context menu rows (Rename/Delete) | `hover:bg-*` | T A F | add transition + active shade + focus ring; arrow-key navigation |
| 17 | Modal overlay | none | enter/exit | fade 160ms + `backdrop-blur` ramp |
| 18 | Modal panel | none | enter/exit F | scale 0.96→1 + fade; add a real close "✕", Esc handling, and focus trap (the radix connect modal already has these; the hand-rolled one does not) |
| 19 | `select` wallet dropdown (AddTokenModal) | none | H T F | same focus ring token as `Input`; custom chevron |
| 20 | AddToken submit | `opacity-50 cursor-wait` for **both** invalid and loading | A T L | `disabled:cursor-not-allowed` when invalid vs spinner+`cursor-wait` when loading |
| 21 | Rename submit | same flaw | A T L F | same |
| 22 | VaultBackup submit | text-swap only ("Encrypting…") | A T L | spinner + disabled fields during encrypt (scrypt is slow — this is the worst freeze in the app) |
| 23 | "Choose backup file…" button | colour-on-hover | A T L | IconButton-style + show the chosen filename with a checkmark transition |
| 24 | Restore preview rows | none | enter animation | stagger in 40ms each |
| 25 | Restore submit | text-swap | A T L | spinner |
| 26 | Password/address `Input`s in all modals | focus border, no transition on the ring | T V | see B.2 |

### `app/NileWallet.jsx`
| # | Element | Has today | Missing | Fix |
|---|---|---|---|---|
| 27 | Balance refresh icon | colour-on-hover | H A T F | IconButton + spinner swap |
| 28 | **Address copy row** | **nothing at all** | H A T F | hover fill + gold border, press scale, and an inline "Copied ✓" morph on the icon for 1.2s (toast alone is easy to miss) |
| 29 | Receive address copy row | **nothing** | H A T F | same primitive as #28 |
| 30 | "Hide" (phrase) text button | colour | H A T F | underline transition |
| 31 | "Copy phrase" text button | colour | H A T F | same |
| 32 | "I understand — continue" (danger) | none | H A T F | Button variants |
| 33 | "Reveal Phrase" | none | H A T L F | spinner while revealing |
| 34 | "Connect via link" input + submit | none | T V F | Input + Button |
| 35 | Disconnect (per app row) | `disabled:opacity-50` | H A T F | confirm-before-disconnect; today one stray click drops a dApp session with no undo |
| 36 | Tokens "Add Token"/"Add"/"Cancel" | none | H A T F L | Button |
| 37 | Token row remove "✕" | colour-on-hover | H A T F | IconButton |
| 38 | **Asset pills (TON / JETTON)** | border+bg swap, **no transition, no hover** | H A T T | the selection snaps; add `transition-colors` + a shared sliding gold indicator, hover state, and `aria-pressed` |
| 39 | Recipient `Input` | focus ring only | T V F | **inline validation on blur/after 3+ chars**: green tick + "valid TON address" or red "not a valid address"; slide in, never a popup; show the truncate form once valid |
| 40 | Amount `Input` | focus ring only | T V F | inline: "exceeds balance", "max 9 decimals", "must be > 0" as you type; show the ≈ TON equivalent |
| 41 | "MAX" button | none | H A T F | Button; and MAX must account for the real fee, not the hardcoded 0.05 reserve |
| 42 | Fee line (`Network fee ~…`) | **pops in/out instantly** | T | reserve the row height and cross-fade between skeleton → value; today the card reflows and the layout jumps on every keystroke |
| 43 | Estimate error / "insufficient" text | instant | T | slide+fade in; never shift the whole card |
| 44 | Confirm box | instant appear | T | expand/collapse 160ms; it currently shoves the Send button down with no animation |
| 45 | "Confirm" (send) | text-swap "Sending…" | A T L F | **must show a spinner**; a frozen gold button with changing text is exactly the reported "dead button" |
| 46 | "Back" in confirm | none | H A T F | Button |
| 47 | "Send" button | `disabled:opacity-50` | H A T F | + a tooltip explaining *why* it is disabled (locked / invalid address / no amount / over balance) — today the disable is silent |
| 48 | Success card | instant swap of the whole card | T | animate in (checkmark draw + fade); add a "copy hash" affordance |
| 49 | Success "View on explorer" link | colour only | H A T F | underline + `active:scale`; see Audit B for the wrong URL |
| 50 | "Done" | none | H A T F | Button |
| 51 | Wallet-setup: Create / Import / Restore | none | H A T F L | Button; "Creating…" needs a spinner (keygen is async and slow) |
| 52 | Import textarea | focus ring | T V | smooth word-count progress bar (0/24 → green at 24) instead of a static counter; validate as you type |
| 53 | Import "Back" | colour | H A T F | button |
| 54 | RestoreSection: file chooser / password / Decrypt / Restore / Back / overwrite checkbox | none | H A T F T | Button + a **custom themed checkbox** (a native checkbox in a navy/gold wallet is the single most out-of-place control in the app) |
| 55 | BackupSection: both action buttons + password + download | none | H A T F L | Button; download needs a success state |
| 56 | UnlockForm password + submit | none | H A T F L | Button; `busy` currently renders "Please wait…" with no spinner on first paint |
| 57 | `PasswordInput` eye toggle | none | H A T T F | IconButton; also `top-0 right-0 h-full` mis-aligns — centre it and add hover |
| 58 | Wallet balance number | snaps `…` → value | counter | animate/count up over ~400ms; see B.4 |
| 59 | Lock/Unlock status chip | instant swap | T | cross-fade icon+label |
| 60 | Connected-app rows, token rows, session rows | static | T | enter/exit transitions when lists change |

### `screens/NetworkCheck.jsx` + `Unlock.jsx`
| # | Element | Has today | Missing | Fix |
|---|---|---|---|---|
| 61 | Retry button | none | H A T F L | Button + spinner (spinner is hand-applied to the icon today) |
| 62 | Continue button | none | H A T F L | Button |
| 63 | Endpoint rows | appear all at once after the probe | H T | stagger in (60ms each); rows aren't clickable so no hover needed |
| 64 | Unlock screen logo/heading | static | T | fade+rise on mount |

### Global
| # | Element | Has today | Missing | Fix |
|---|---|---|---|---|
| 65 | Screen router (`network → unlock → picker → wallet`) | **hard cut** (`if/else` render) | T | wrap in a transition layer: outgoing fades/scales to 0.98 while incoming fades/rises from 0.98, ~200ms, direction-aware (forward = slide-left, back = slide-right). This is the single highest-impact change for "feels stiff" |
| 66 | Toaster | default react-hot-toast styling | theme | restyle to the navy surface + gold border; today an unthemed white/black toast lands on a navy app |
| 67 | Modal stack / picker→wallet focus | — | — | restore focus to the invoking tile on close |

## B.2 Inputs (shared behaviour)

Focus states today are `focus:ring-3 focus:ring-nile-gold-400` with no transition, no
`:focus-visible` distinction, and a ring drawn *outside* the field with no room reserved.

- `focus-visible:ring-2 ring-nile-gold-400/60 ring-offset-2 ring-offset-neutral-950`,
  `transition-[box-shadow,border-color] duration-150`.
- Reserve a message slot under each field (fixed min-height) so validation text never reflows
  the card.
- Inline validation renders as a single line that slides+fades between states; the field border
  tints green/red to match. Never `window.alert`, never a popup.
- Error state must also set `aria-invalid` + `aria-describedby`.

## B.3 Buttons — the disabled/loading contract

Every async action gets three visually distinct states:

| state | treatment |
|---|---|
| idle | gold fill, hover lighten + 1px lift, active press |
| pending | spinner in the icon slot, label unchanged or progressive ("Sending…"), `aria-busy`, `cursor-wait`, still full opacity (the current `opacity-50` makes pending look *disabled*) |
| disabled | 40% opacity, `cursor-not-allowed`, and a reason surfaced in a `title`/tooltip |

**The `opacity-50 cursor-wait` pattern currently used for both states must go.**

## B.4 Data transitions

- **Count-up**: balance, total balance, and token balances animate from the previous value to
  the new one over ~400ms with an ease-out, formatted through one shared formatter. Currently
  `…` → string is an instant snap, and every 30s poll re-renders a differently-grouped number.
- **One formatter**: three exist today — `formatTon` (picker, `toFixed(4)` then strip zeros),
  `rawToDecimal` (wallet, full precision), and `BigInt` inline math. Consolidate to
  `formatAmount(raw|string, decimals, { group, maxFraction })`, with thousand separators.
  `toFixed(4)` also flattens dust (`0.00000001` → `0`).
- **Skeletons, not text**: replace `"Loading…"` / `"Loading wallets…"` / `"Loading tokens…"` /
  `"…"` with shimmer placeholders that match the final layout's shape, so the app never shows
  a blank flash or a reflow.

## B.5 Accessibility of interaction (part of "feel")

- No `aria-label` on any icon-only control (refresh ×3, clear search, remove token ×2, password
  toggle). All get one via `IconButton`.
- No visible `focus-visible` ring on buttons/tiles → keyboard navigation is invisible.
- Picker modals: no Esc, no focus trap, no `role="dialog"`/`aria-modal`, no initial focus.
- Context menu is mouse-only; needs arrow keys + Esc + `role="menu"`.
- `prefers-reduced-motion` is honoured nowhere.

---

# PART C — VISUAL POLISH

Constraints: keep the palette. Canvas `#040a14`, surfaces `#0b1526`/`#192940`, gold `#D4A843`,
text `#f0f4fa`, muted `#a8bcd4`. Do not introduce new hues.

1. **The app is dark-only but styled as if it could be light.** `index.html` hard-sets
   `class="dark"`, and `index.css` gives `html` a light-mode gradient fallback. Every component
   carries dead light-mode classes (`bg-white/70`, `border-neutral-200`,
   `text-neutral-900 dark:text-neutral-100`). Decide: **dark-only**, then strip the light half
   and the `dark:` variants. This is the single biggest source of class noise and of the
   `#f0f4fa`-on-white bugs that never show up because the class is unreachable.
2. **Layout width inconsistency.** `Container` is `max-w-md` (448px) but the window
   **maximizes on show** (`main.js: ready-to-show → maximize()`). So on a 1920px display the
   wallet screen is a 448px ribbon in a void, while the picker passes
   `max-w-[1440px]` and fills the width. The header has no container at all, so its content is
   flush to the window edge while the body is centred. Fix:
   - Give the shell a real layout: a centred container `max-w-2xl` (wallet) / `max-w-5xl`
     (picker) applied consistently to **header and main together**.
   - Or stop maximizing and let the window open at a designed size (e.g. 1100×760, resizable,
     with `minWidth`/`minHeight`) so the two-column picker has a home and the wallet screen is
     not floating.
   - `cn()` + `max-w-md` + `max-w-[1440px]` currently works by tailwind-merge last-wins, which
     is fragile; use explicit per-screen container props instead of override collisions.
3. **Spacing scale is ad hoc.** `p-3` / `p-3.5` / `p-4` / `p-5`, `gap-1` / `1.5` / `2` /
   `3` / `4` are mixed within the same card stack, and `Container`'s `p-4` fights cards' own
   padding. Standardise: card `p-4`, section stack `gap-4`, intra-card `gap-2`/`gap-3`,
   section title → content `mb-3`. Pick one and apply it everywhere.
4. **Typography hierarchy is flat.** `body` is `text-xs` globally and every component overrides
   it upward; there is no type scale. Define and apply:
   `display` 3xl/700 (balance), `title` xl/700 turret-road (screen names), `section` sm/700
   uppercase tracking-wide muted (card headers), `body` sm/400, `label` xs/700 muted,
   `mono` xs Fira Code (addresses/hashes), `caption` xs muted.
   `font-turret-road` is applied inconsistently (wordmark, wallet heading, two modal titles) —
   make it the display face for screen titles only.
5. **No skeletons anywhere** (see B.4). Add a `Skeleton` primitive shaped like each card.
6. **Empty states.** The picker with zero wallets renders only a dashed "Add Wallet" tile —
   there is no first-run screen explaining what NileVault is and offering Create/Import. Add an
   illustrated empty state (logo, one sentence, primary CTA). Token empty state exists but has
   no icon and no "add" affordance in the empty branch. Add a "no connected apps" and
   "no tokens in send" state. Add a "no search results" state with a clear-search action.
7. **Wallet picker tile treatment.** Every tile uses the identical `nilevault-logo.jpg`, so the
   grid is visually monotonous and you cannot identify a wallet at a glance. Add a
   deterministic per-wallet accent (derive a hue from the id but keep it inside the navy/gold
   family — e.g. gold-tinted rings plus a distinct monogram), plus a visible selected/active
   state for the press handoff.
8. **Send/Receive are buried.** The balance card has a lone refresh icon; Send and Receive are
   separate full cards far down the page. A standard wallet puts a prominent
   **Send / Receive / Backup** action row directly under the balance. Add it (as anchors that
   scroll/focus the sections) — this fixes most of the "static screen" feel on its own.
9. **Balance card is under-designed.** The address is a monospace string in a grey pill; no
   identicon, no copy affordance beyond the toast, no explorer link. Give it a monogram/identicon,
   a copy button with inline confirmation, and a "view on tonscan" link.
10. **Unit/format inconsistency.** `… TON available` in Send prints the raw full-precision
    string while the balance card and picker show different precision. One formatter (B.4).
11. **Three different modal treatments.** `Modal` (solid `bg-white dark:bg-neutral-900`),
    `AddWalletModal` (glass `CARD`), `NileWalletConnectModal` (radix, `bg-neutral-950` + gold
    border, focus trap). Unify into one shell — the connect modal is the best of the three;
    adopt it and refactor the other two onto it.
12. **Toaster unthemed** (see B.1 #66).
13. **`ReceiveSection` QR is bare.** White square with no card framing, no "copied" state, no
    amount field, no share-as-image. Wrap it in a proper receive sheet with the address styled
    and a copy action.
14. **Network-check screen** has a duplicated logo/wordmark block with `Unlock.jsx` — extract a
    shared brand header for consistency.
15. **Scrollbars** are styled by one broad `@layer base` selector with a nested `@apply` block;
    modals with `max-h` are missing on the picker's `Modal` (tall modals overflow a 720p
    window with no internal scroll). Add `max-h-[85vh] overflow-y-auto` to the shared shell.
16. **`Toaster` + modal `z-50` collisions**: the picker context menu, modals, and toaster all
    sit at `z-50`; the toaster will render under/over inconsistently. Establish a z-scale
    (`dropdown 40 < modal 50 < toast 60`).
17. **Focus ring offset on light/dark**: rings use no offset colour, so on the navy canvas they
    smear. Use `ring-offset-neutral-950`.

---

# PART D — AUDIT (found while reading; listed, not fixed yet)

### Correctness / functional
**A.** **The "Backup Password" field is collected, validated (min 8 chars), then silently
ignored.** `VaultBackupModal` → `nileWalletClient.backup(passphrase)` passes *only the vault
passphrase*; `handleWalletBackup` encrypts entries with `message.password` (i.e. the vault
passphrase) and never sees `backupPass`. A user who follows the UI and later restores with
their "backup password" gets **"Wrong passphrase"** and cannot recover. Either wire the backup
password through as a second encryption layer or remove the field. This is a data-loss-shaped
bug and I'd rank it above everything except A.1/A.3.

**B.** The send success screen links to `https://tonscan.org/address/{sender}` — it should link
to the transaction (`/tx/{result.hash}`). As written, "View on explorer" shows the wallet, not
the transfer you just made.

**C.** **dApp-initiated `sendTransaction` is received, decrypted, and then dropped.**
`NileWalletConnect.handleBridgeMessage` decrypts it and calls `onRequest`; `NileWallet`'s
listener requires `request.items` so a `sendTransaction` never surfaces; and there is **no
bridge response path at all** (no code ever posts a reply event back for a non-connect
request). A connected dApp that asks the wallet to send will hang forever with no error. Either
implement sign-and-reply or reply with an explicit error event.

**D.** `estimateTransfer`/`sendTransfer` rebuild and re-sign independently (see A.8) — the
confirmed transaction can differ from the broadcast one.

**E.** `_getSeqno` returning `0` on **any** error makes "network hiccup" indistinguishable from
"seqno is genuinely 0" (see A.3).

**F.** `getBalance` / `getJettonBalance` swallow all HTTP errors and `return "0"` after a
`console.error`, so an API outage renders as **zero balance** and an "insufficient funds"
message. Never surface an error as a data point.

**G.** `checkTransferFunds` converts nano → decimal string → nano via `fromNano`/`toNano`,
losing precision and coupling correctness to string parsing.

**H.** `TON_RESERVE_NANO` (0.05) is applied only by the MAX shortcut; a hand-typed maximum
passes the funds check against a 0.005 TON fee. The two numbers disagree.

**I.** `WalletInstance.getJettonBalance(jettonWalletAddress, _undefined, jettonMasterAddress)`
— a positional `undefined` hole in a public method signature; the first parameter is discarded
entirely. Rename/simplify to `getJettonBalance(jettonMasterAddress)`.

### Dead / duplicated code
**J.** `src/renderer/styles.css` — 300+ lines of a complete legacy design system
(`.btn`, `.wallet-tile`, `.modal`, `.form-group`, `.spinner`) that is **never imported**
(`grep styles.css src/` → no hits; `main.jsx` imports only `index.css`). It also carries
`user-select: none; overflow: hidden; height: 100vh` on `body`, which would break text selection
app-wide if it were ever imported. Delete it.

**K.** `downloadFile()` in `utils/index.js` is **unused**. The app has three separate file-save
paths: `downloadFile` (unused), `downloadJson` (data-URL, used by NileWallet's BackupSection),
and `saveBackupFile` (IPC save dialog, used by the picker's VaultBackupModal). Consolidate.

**L.** **`changePassphrase` has no UI.** `nileWallet.changePassphrase` + the client wrapper
implement a careful all-or-nothing re-key (decrypt every seed first, abort before any write) —
and nothing calls it. `grep changePassphrase src/` outside the lib returns zero hits. The
feature is fully built and unreachable.

**M.** **Backup/restore is implemented twice with different mechanics**: the picker's
`VaultBackupModal`/`VaultRestoreModal` (IPC native dialogs) and NileWallet's
`BackupSection`/`RestoreSection` (browser download + `<input type=file>`), both calling the same
backend, with different copy, different password semantics (see Audit A), and different
success/error handling. Pick one.

**N.** `AddTokenModal` (picker) adds a token to **one** chosen wallet; `removeToken` in the
picker removes it from **all** wallets as a side effect of the portfolio model. Asymmetric.

**O.** `devBridgeMock.js` is dev/preview-only and correctly stripped — fine, noted for
completeness.

### Security / hardening
**P.** **No `setWindowOpenHandler` / `will-navigate` guard.** `main.js` creates the window
without intercepting navigation or `window.open`. The renderer renders dApp-supplied
`manifest.iconUrl`/`image` and has external links; in Electron, `target="_blank"` spawns a new
window by default and any navigation can replace the wallet UI with remote content. Route
external URLs through `shell.openExternal` and deny in-window navigation.
**Q.** No CSP header/meta; `nodeIntegration:false` + `contextIsolation:true` are correctly set,
but there is no Content-Security-Policy to constrain the renderer.
**R.** DevTools toggles on F12 in **packaged** builds (`main.js` `before-input-event` has no
`app.isPackaged` guard).
**S.** `vault.json` is rewritten synchronously (`fs.writeFileSync(JSON.stringify(store, null,2))`)
on every single key write. Fine at this size, but the store now holds session maps and token
lists; every keystroke-level state write is a full-file sync.

### Build / tooling
**T.** **`npm run dev` cannot work.** `preview-server.cjs`'s own header documents that
`vite-plugin-node-polyfills@0.28` is incompatible with Vite 6's dev dep-optimizer, so the dev
server can't boot — hence the entire `build:web-preview` + `_preview.html` + `preview-server.cjs`
harness. But `package.json` still ships `"dev": "cross-env VITE_DEV=1 concurrently \\"vite\\" …"`
and `vite.config.js` still carries a large `optimizeDeps.include` list for that server. Either
fix the dev server (drop/patch node-polyfills) or delete the dead path and document the real
loop (build → preview-server).
**U.** `build.win.icon` points at `nilevault-logo.jpg`. electron-builder needs `.ico`/`.png`;
a `.jpg` is ignored and the app ships with the **default Electron icon** (the stray
`dist/.icon-ico` directory suggests this was worked around by hand).
**V.** `dist/win-unpacked` is from Aug 26 and predates nothing in git (single commit) — i.e.
there is currently **no build that contains any of this work**; the packaged exe must be
rebuilt to verify anything.
**W.** The renderer hard-codes `https://tonapi.io/v2` with no key and no rate-limit/backoff;
the picker fans out `wallets × tokens` requests **every 30 s** (10 wallets × 5 tokens = 50
requests per poll, every poll, forever, per window).
**X.** `PasswordInput.jsx` has two separate import statements from `"react"`
(`import { memo } from "react"; import { useState } from "react";`).

### Stale comments / metadata
**Y.** `NileWalletConnect.js` header says *"Runs only in the MV3 service worker. No DOM, no page
crypto."* — it now runs in the renderer and uses `EventSource`/`fetch`. The file's own
`_trySubscribeSSE` contradicts it.
**Z.** `NileWalletConnect` advertises `WALLET_APP_NAME = "NileChain"` and `WALLET_VERSION =
"1.0.0"` to dApps, so a dApp's UI will show **"NileChain"** as the connected wallet, not
NileVault. Also `DEFAULT_BRIDGE`/`FALLBACK_BRIDGES` are hard-coded.
**AA.** Several comments describe the extension origin (service worker, popup, `chrome.storage`,
`chrome.downloads`) in a desktop app; harmless but misleading.

### Product gaps
**BB.** No auto-lock/idle timer. `App.jsx` documents this as intentional ("matching the
NileWallet reference"), but for a wallet holding seeds it means an unattended machine is an
unlocked vault indefinitely.
**CC.** No passphrase-change UI despite Audit L. No "verify your backup" flow.
**DD.** No transaction history anywhere in the app — you can send, but you can never see what
you sent. The only record is the one-shot success card (which is lost on navigation).
**EE.** `ReceiveSection` has no amount-encoding QR, no share, no "request" concept.
**FF.** No per-asset send from the picker (clicking a token card does nothing); tokens are
display-only there.
**GG.** Import is V4R2-only and hard-codes `workchain: 0`. The UI warns about V3R2 address
divergence, but there is no way to actually select a wallet version, no "this phrase belongs to
a different version" detection, and no v3r2/v5 support. Any user importing a modern (W5/v5)
wallet gets a **different address with zero balance** and the warning is easy to miss.
**HH.** No address book / recent recipients, so every send is a paste.
**II.** No fee/amount confirmation of the *actual* post-send balance change.
**JJ.** `deleteWallet` (registry) and the in-wallet "Remove wallet" (`clear`) are two different
destructive actions with near-identical copy; "Remove wallet" in the Danger zone deletes the
seed but **keeps the registry entry**, leaving a wallet tile that then shows "No wallet on this
account" forever. Confusing and effectively unrecoverable.

---

# PART E — PROPOSED EXECUTION ORDER (for Step 3, on approval)

1. **Send correctness** — A.3 seqno endpoint + A.1 Jetton wallet resolution + A.2 standard
   TEP-74 body + A.6 real funds check + A.7 deploy-on-first-send + A.4 confirmation.
   (Blockers; everything else is polish by comparison.)
2. **Send UX** — A.5 real fee estimation, A.8 no-unlock-to-validate + parameter snapshot,
   A.9/A.11 refresh, paste parsing, action row.
3. **Shared primitives** — Button loading/active/focus, Spinner, IconButton, Skeleton,
   motion tokens, reduced-motion, single `formatAmount`.
4. **Screen transitions** — B.1 #65 router transition, tile press→handoff, modal enter/exit.
5. **Per-element feedback** — work the B.1 tables top to bottom.
6. **Visual** — Part C.
7. **Audit fixes** — Part D items the user approves (recommend A, B, C, J, K, L, M, P, R, T, U
   as the high-value set).

**Verification for every step is in the packaged `.exe`** (`npm run build` → launch
`dist/win-unpacked/NileVault.exe`), not the dev server, because (a) `npm run dev` is broken
(Audit T) and (b) the renderer's dev/prod split (`app/index.html` vs `localhost:5173`,
`devBridgeMock` staging) is exactly where divergence bugs live. The `app-preview` harness may be
used for fast visual iteration, but every change must be re-confirmed in the packaged build.

**Nothing edited yet — awaiting review.**
