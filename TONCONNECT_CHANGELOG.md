# NileVault TON Connect link handling — fix changelog

The reported crash was `Cannot read properties of undefined (reading 'length')`
when a pasted `tc://` link was approved. It was not in the link parser, and it
was not the extra `trace_id` parameter. It was a **shape mismatch between the
connect manager and the UI**: the prepared connect request was handed to the
approval sheet wrapped in `{ status, prepared }`, so every field the sheet and
the signing path read was `undefined`.

---

## 1. Crash location and root cause

Reproduced with the real Link 1 before touching anything:

```
TypeError: Cannot read properties of undefined (reading 'length')
    at hexToBytes      (src/renderer/lib/NileWalletConnect.js:25:21)
    at boxEncrypt      (src/renderer/lib/NileWalletConnect.js:187:7)
    at approve         (src/renderer/lib/NileWalletConnect.js:367:23)
```

`hexToBytes` read `hex.length` on `undefined`. The `undefined` was
`dAppPubKey`. The chain that produced it:

1. `connectManager.parseLink` returned `{ status: true, prepared }` — the
   prepared request **nested** under `prepared`
   (`src/renderer/lib/nileWalletConnectManager.js`).
2. `nileWalletClient.parseLink` passed that object straight through, and
   `ConnectViaLink` stored it as the pending request and handed it to
   `NileWalletConnectModal`.
3. The sheet read `request.manifest` / `request.items` — both `undefined` — so it
   showed **"Unknown app"** with no host and no icon. (No crash yet: this is why
   pasting appeared to work.)
4. Pressing Approve called `connect.approve(prepared)` with that wrapper.
   Destructuring gave `dAppPubKey`, `manifest`, `manifestUrl` and `items` all
   `undefined`: `new URL(undefined)` threw and was swallowed by the catch, so
   `domain` became `""`; `items` fell back to the default `ton_addr` item; and
   `boxEncrypt(event, undefined, secretKey)` finally reached `hexToBytes`.

Reject crashed the same way from the same missing key — the report's "fails to
complete the connection" was one of two broken paths, not a second bug.

**`trace_id` was a red herring.** `parseLink` reads the query with
`URLSearchParams.get`, by name, so an unexpected or extra parameter is
irrelevant. Link 2 parses identically to Link 1 — confirmed with both links side
by side, and pinned by a test that asserts extra params (`trace_id`, `ret`, an
unknown `unknown=1`) do not shift which value lands in the request.

## 2. What changed

**The shape bug** — `nileWalletConnectManager.parseLink` now returns the prepared
request flattened (`{ status: true, ...prepared }`), and `nileWalletClient`
normalizes whatever it receives: it accepts both the flat request and the legacy
`{ prepared }` envelope, and rejects anything else with `Invalid connect link`
rather than letting `undefined` travel into the crypto path.

**Defensive validation** — `src/renderer/lib/NileWalletConnect.js`:

- `hexToBytes` validates its input (the crash line) and fails with
  "Connect session key is missing/malformed" instead of a bare `TypeError`.
- `parseLink` validates the link, its `id`, and the decoded `r`; `r` is accepted
  both URL-encoded and raw (`decodeRequestPayload`). Every failure mode collapses
  into one user-facing message family: **"Invalid connect link"**.
- `normalizeRequestItems` treats `items` as optional (per spec a link may ask for
  `ton_addr` alone, or omit the list), drops item types the wallet does not
  implement, guarantees a string payload for `ton_proof`, and always includes
  `ton_addr` — which the spec requires in a ConnectEvent reply even when it was
  not explicitly requested.
- `assertPrepared` validates the request before signing and publishing (and
  tolerates the legacy envelope, so an in-flight old shape still approves).
- `fetchManifest` validates the response before reading it: a manifest that is
  empty, is not an object, or renames a field still yields a usable identity
  (host, no icon) so the sheet renders instead of failing.
- `boxEncrypt` / `boxDecrypt` resolve and validate both keys, including the
  x25519 secret-key length, before drawing a nonce.

**UI** — `NileWalletConnectModal` only treats `items` as a list when it *is* one;
`ConnectViaLink` already surfaced `err.message`, so a malformed link now shows
"Invalid connect link" in the form instead of an unhandled exception.

## 3. Defects found while verifying

Verifying the flow turned up two more real problems, both fixed:

- **Connected apps showed "Unknown dApp"** for every session. The list read
  `session.name` / `session.url`, but the session record carries the dApp's
  `manifest` — so the user could not tell which app they were disconnecting.
  Now `session.manifest?.name` / `session.manifest?.url`.
- **`src/renderer/app/` was excluded from git.** `.gitignore` had an unanchored
  `app/` (intended for the Vite output directory) which also matched
  `src/renderer/app/`, so the whole wallet screen was never committed *and* was
  skipped by Tailwind's source scan. The rule is now anchored to `/app/`. As a
  result `src/renderer/app/` currently shows as untracked — **it still needs to
  be added**, or a fresh clone has no wallet screen.

Two build-gate strings in the same file were also corrected: the confirmation
that names the jetton wallet ("Token contract being called") and `.nc-address`
on full-length addresses so an unbroken 48-character address wraps instead of
overflowing. `npm run check:build` is clean on both the bundle and the packaged
asar.

## 4. Verification

**Unit / regression — `npm test` (106 passed, 0 failed)**

57 send + 18 backup + **31 new TON Connect tests**. The new suite covers both
real links verbatim, the extra-param case, ten malformed-link shapes, manifest
responses that are not objects, links with no `items` or only `ton_proof`, the
approve path (asserting the published ConnectEvent decrypts, `ton_addr` matches
the wallet, network is `-239`, and the **`ton_proof` signature verifies** against
the wallet public key when re-derived from the spec layout), reject, and two
explicit regressions for the old `{ prepared }` wrapper and for an undefined
session key.

**Live network + real bridge — `npm run verify:tonconnect`**

Both real links parse; their real manifests fetch over the network
("Six Seven Club", "Rignite"); both publish to `bridge.tonapi.io` and are
accepted. A controlled session then round-trips through the **real bridge**: the
message is read back off the stream, decrypted, and checked — `ton_addr` matches
the approving wallet, network `-239`, `ton_proof` payload echoed and signature
verified. Address logged:

```
0:6e55f7885c3f91f1a62c9bc3fd3d3e6cf8211d3bcdcecbdd0fa5c730de694943
```

**Packaged build, real UI — `npm run verify:ui`**

Drives `dist/win-unpacked/NileVault.exe` over the DevTools protocol — no dev
server, no browser mock — in its own `--user-data-dir` so the throwaway vault can
never touch the real one. All 32 checks pass:

- Link 1 and Link 2 each open the approval sheet, which shows the **dApp name,
  host, icon loaded from the manifest**, the account being connected, and the
  `ton_proof` disclosure; approval completes ("Wallet connected") and the app
  lists the dApp under Connected apps.
- Reject closes the sheet without a crash and leaves no session behind.
- A truncated link reports **"Invalid connect link"**.
- A session whose key the harness owns is approved through the UI, and the
  ConnectEvent the app published is read back off the real bridge, decrypted, and
  matched against the address the UI displays.

Screenshots: `dist/tonconnect-verify/` — wallet page, both approval sheets, both
approved states, post-reject, malformed link, and the transport check. Wallet
address shown in the app during that run:

```
UQDmyMkAbH7QSxtGBmsEW5-OSgRrKoRE9oJbjsw9r1S2DzWE
```

Artifacts rebuilt as **1.0.2**: `dist/NileVault 1.0.2.exe`,
`dist/NileVault Setup 1.0.2.exe`, and `dist/win-unpacked/`. The version was
bumped so this build cannot be confused with the 1.0.1 installer, which carried
the blank-screen fix but not this one.

## 5. Known limitations / next

- **`ton_proof` payload encoding is unchanged** (`utf8`, matching the shipped
  NileChain extension). If a dApp ever rejects the proof, that is the first thing
  to test — hex bytes are the documented alternative.
- `src/renderer/app/` still needs its first `git add`, or clones remain broken.
- dApp-initiated `sendTransaction` is still unimplemented and replies with an
  explicit error rather than signing.
