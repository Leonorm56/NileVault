# NileVault — redesign v2 plan (grid + reorder + naming fix)

Status: **awaiting approval. No implementation code written for this brief.** Per
`AGENTS.md` §1 and §0 of the brief.

This plan reconciles the new brief against the tree as it actually stands, because
the tree has moved since the brief was written. Read §1 and §2 before approving —
two items in the brief do not match the code, and one deliverable is blocked.

---

## 0. What I have and don't have

**Blocked: the two mockups are not available to me.** `wallet-grid-target.png` and
`unlock-network-check-target.png` are not in the repo, not on the Desktop, and were
not attached to this session. I searched for them and found nothing. Everything
below marked **[fidelity]** is a design judgement I cannot verify against the target
— it will need one pass of correction once I can see the images. The structural work
(§6 reorder, §2 naming fix, header/filter/wiring) is not blocked.

**Also: I am not the only writer in this tree.** `git status` shows 17 modified
tracked files plus untracked `replica/`, five plan docs, and a stray `nul` file
(the Windows `> nul` artifact). Several files I did not touch are modified
(`CopyButton`, `Input`, `Skeleton`, `ConfirmDialog`, `NileWalletConnectModal`,
`ScreenHeader`, `App.jsx`, `NetworkCheck.jsx`, `package.json`). I will only edit
files this plan names, will not add `nul` to anything, and will not `git add -A`.

---

## 1. Repo reality vs the brief

**1.1 Tailwind v4 is already set up, CSS-first.** `@tailwindcss/vite` +
`@import "tailwindcss"` + an `@theme` block in `src/renderer/index.css`. There is no
`tailwind.config.ts` and there should not be one. §4's "define as Tailwind/shadcn CSS
variables" is **already true** — `--color-background/-card/-primary/-border/-ring/
-destructive` exist. This is an extension, not a migration.

**1.2 Most of the token work from the earlier brief is already in the tree.**
`--nc-surface-1/2` (gradient elevation tiers), `--nc-glass-1/2`, `--nc-shadow-1/2`,
`--nc-border-subtle/-active`, `--nc-focus`, `--nc-danger-surface/-border`, the
three text tiers, `prefers-reduced-transparency`, and the previously-missing
`.nc-card-primary` / `.nc-input` definitions. **§4 is ~70% done.** What §4 still
genuinely needs: a real `--color-success` token (the brief requires success as a
*second accent* distinct from gold; today `emerald-400` is used ad hoc in ~4 places),
and `--card-elevated` named explicitly rather than only as `--nc-surface-2`.

**1.3 The wallet grid the brief describes does not exist yet.** `WalletPicker.jsx`
is 1348 lines with: monogram tile, `...` overflow menu, rename, delete, add, search,
total balance, Backup/Restore as **full-width stacked** buttons. It has **no** header
row, **no** status row, **no** `All/With Balance/Empty` filter, **no** search icon in
a header bar, **no** per-tile balance colouring, and **no** zero-balance de-weighting.
So §2's grid is real work, not a restyle. Note the brief's own §2 (search icon +
Filter control) partially duplicates what search already does.

**1.4 There is no custom titlebar and no plan to add one by accident.** `src/main.js`
constructs `BrowserWindow` with the default frame — no `frame: false`, no
`titleBarStyle`, no `titleBarOverlay`, and no `-webkit-app-region` anywhere in the
renderer. §2's frameless titlebar is therefore a **structural Electron change**:
`frame: false` + IPC-driven minimize/maximize/close + drag regions + losing native
snap. See §7 — I recommend *not* doing it in this pass.

**1.5 shadcn is absent as a CLI but the repo is shadcn-shaped by hand.** `Button.jsx`
is cva with shadcn's exact variant shape, `Modal.jsx` already implements focus trap /
Esc / focus restore, `ConfirmDialog.jsx` already replaced `window.confirm`.
Dependencies present: `radix-ui` (unified), `class-variance-authority`, `clsx`,
`tailwind-merge`. §5's non-goal ("don't bulk-install") is already the de-facto state.
I propose **only** adding `Separator` + `Badge` (token pills) and verifying
`AlertDialog` coverage against `ConfirmDialog` — nothing else.

**1.6 There is no settings screen and no tabs.** The wallet view's section nav
scrolls to anchors (`Wallet/Send/Receive/Tokens/Settings`, Settings `disabled`).
That is IA, and §5 forbids IA changes. Out of scope.

**1.7 The `nilevault-redesign-final-prompt.md` file itself is the source of truth
for intent, but its §0.4 verification standard (packaged `.exe` only) has a
mechanics problem — see §11.**

---

## 2. Deliverable 2 — the duplicate-name root cause (investigated, pre-answer)

**Finding: the generator is not what produced "188".** There is exactly one
auto-generated name in the codebase — `src/renderer/lib/nileWallet.js:893`, in the
**vault restore** path:

```js
name: `Wallet ${wallets.length + 1}`,
```

The only other paths are `createWallet(name)` (line 537) and `renameWallet`
(line 550), and **both require a user-typed name**; the sole caller is
`AddWalletModal`, whose input is required (`disabled={!trimmed}`). So:

- That generator can only ever emit `"Wallet N"` — it cannot emit `"188"`.
- Therefore the two tiles named `"188"` are **two genuinely distinct registry
  entries with the same user-supplied label** — i.e. the benign branch of the
  brief's own question. The brief's "second wallet has 0.00001 TON" is consistent
  with two separate accounts both labelled `188` (the picker already disambiguates
  them by address suffix, which is why the mockup shows two tiles).

**But it exposed two real defects, which I recommend fixing:**

1. **The restore generator can collide.** `wallets.length + 1` is a *count*, not an
   allocation. Delete any wallet → the count drops → the next restore synthesises a
   name that already exists. Restoring into a registry of 2 wallets after having
   deleted one yields a duplicate `"Wallet 3"`.
2. **Restore does not preserve the original name**, and cannot: backup entries carry
   no `name` field at all (I checked the entry shape). Every restored wallet gets a
   synthetic label and the user's own naming is silently lost. That is arguably the
   worse bug of the two, and it is a data-fidelity issue, not styling.

**Proposed fix (reportable on its own, as the brief requires):**

- Add `uniqueWalletName(existing)` in `lib/nileWallet.js`: returns the smallest
  `Wallet N` whose `N` is not already taken (max-used-index + 1 semantics, not
  length). Used by restore.
- Add the `name` field to backup entries (write side) and restore it when present,
  falling back to the generator only when absent — so old backups still restore.
  **This touches the backup *format*, not backup crypto or key handling.** The brief
  says stop and flag anything requiring transaction logic; this is neither
  transaction nor key logic, but it is a serialized-format change, so **I am
  flagging it for your explicit yes/no** rather than assuming.
- Guard against silent duplicates at the label layer: on create/rename, if the label
  is already in use, still allow it (renaming to a duplicate is the user's right) but
  make the picker disambiguate visibly rather than rendering two identical tiles.
  **[fidelity]** — the exact treatment (address suffix in the tile vs a count badge)
  is a mockup question.
- **TDD:** `tests/wallet-registry.test.mjs` — a failing test for
  `uniqueWalletName` after a deletion, plus a round-trip test that a named wallet
  survives backup → restore with its name intact.

I will report the root cause in the final report exactly as above: *not a naming
counter bug; two distinct wallets sharing a typed label; plus two adjacent defects
found while looking.*

---

## 3. Open design questions from §2 — my proposals

**3.1 The dot colours → derive deterministically from the wallet id. (option b)**
Assignable colour tags (option a) mean new persisted per-wallet state, a new editing
UI, and a new interaction surface the brief did not scope. Deterministic derivation
costs nothing, is stable across re-renders (hash the id → index into a fixed 8-colour
palette drawn from existing tokens), and delivers exactly what the mockup reads as:
*scanability*. I will document that these dots carry **no semantic meaning** — they
are decoration — in the component, so nobody later mistakes them for status. Status
stays the `● Connected` indicator and the balance colour.

**3.2 Inline tile actions → hover/focus for every tile, always-on for keyboard.**
Matches the brief's own leaning. Concretely: `Copy / Send / Receive` revealed on
hover and on `:focus-within` for every tile; zero-balance tiles keep `Copy` and
`Receive` and drop `Send` (disabled, not hidden, so the layout doesn't jump); the
add-wallet tile exposes none. On touch/coarse pointers the row is always visible.

**3.3 The status-row counts.** The brief is right that the mockup is internally
inconsistent ("1 with balance" vs two nonzero tiles). I will compute **both** counts
from the same `detailsQuery` rows the tiles render from, so they cannot disagree by
construction, and I will assert that in a test rather than by eye.

---

## 4. Tokens — what changes

| Brief §4 | State | Action |
| --- | --- | --- |
| `--background` | exists | keep |
| `--card` / `--card-elevated` | `--nc-surface-1/2` exist | alias `--card-elevated` to surface-2 so the brief's name works |
| `--border` / `--border-active` | exist as `--nc-border-subtle/-active` | keep; hover/active surfaces use `-active`, focus uses `--nc-focus` |
| `--primary` gold | exists, already CTA-only | keep; enforce "one gold per screen" in the new grids |
| `--success` | **missing as a token** | **add** `--color-success` (+ `--nc-success-soft` for tinted status rows) and route the ~4 ad-hoc `emerald-400` uses through it |
| `--foreground` tiers | three tiers exist | keep; new tiles must use them, not `text-neutral-*` |
| `--destructive` + surface | exist | keep; danger zone untouched this pass except route-through |
| radius/spacing | existing 8px scale | keep; hunt one-off `p-4`/`size-9` only in files touched |

No hardcoded hex in components — the existing `.nc-*` classes already enforce this.

---

## 5. Screens

**Wallet grid (`screens/WalletPicker.jsx`)**
- Header row: logo + wordmark + version, live `Total: X TON`, search icon, `Filter`
  control, `Lock` — one row. Version comes from the existing `getVersion` IPC.
- Status/filter row: `● Connected`, `N Wallets`, `M with balance`, and a
  three-way `All / With Balance / Empty` segmented control that **filters** (never
  reorders). Counts from the same rows the tiles use (§3.3).
- Tile: extract `components/WalletTile.jsx`. Id-derived status dot, name (primary
  tier), `...` menu, balance (success colour when nonzero, muted at zero), truncated
  address. Funded tiles full opacity + visible border; zero-balance ~70% opacity,
  muted figure, no accent border.
- Inline actions per §3.2. `+ Add Wallet` dashed, no fill, never draggable, last.
- `Backup Vault` / `Restore` → two equal-width bordered buttons side by side.

**Unlock / network check** — `Container size="auth"`, one shared background treatment
so the card stops looking like a stamp in a large window, gold `Continue` + outline
`Retry`, success-toned status rows with dividers. **[fidelity]** on the logo
treatment.

**Wallet view (`app/NileWallet.jsx`)** — mostly done in the current tree (hero
elevation, action row on `Button`, `.nc-card-primary` defined). Remaining: token
pills → `Badge`-style with a filled selected state, and the danger zone routed onto
the destructive *surface*. No logic touched.

---

## 6. Drag-to-reorder (the only new interaction)

- **Library:** `@dnd-kit/core` + `@dnd-kit/sortable` (+ `@dnd-kit/utilities` for
  transforms). Not present in the repo — grep finds no drag library. Two risks I
  will verify before writing component code: **React 19 peer ranges** (dnd-kit 6.x
  targets 18; I will confirm install + runtime under React 19.2 in dev before
  committing to it, and report if it needs a different approach) and that
  `useSortable` transforms play well with the CSS grid.
- **Order model:** order is a list of wallet **ids** over the *full* wallet list.
  Filters hide tiles; they never sort. `+ Add Wallet` is non-draggable and pinned last.
- **Persistence:** a pure helper in `lib/walletHome.js` — `applyWalletOrder(wallets,
  savedOrder)` — reconciling unknown/missing ids (dropped) and new wallets (appended).
  Stored via the **existing** kv mechanism (`storage.set`, `lib/storage.js`) under
  `nilevault:wallet-order`. No new storage layer.
- **Accessibility:** `KeyboardSensor` + `sortableKeyboardCoordinates`, the dnd-kit
  defaults the brief asks for. Not mouse-only.
- **Drag visuals:** dragged tile → `--nc-surface-2` + `--nc-glass-2` + `--nc-shadow-2`
  + slight scale; drop target gets `--nc-border-active`. Reuses the existing tokens,
  no new elevation concept.
- **TDD first:** `applyWalletOrder` is a pure function — failing tests for
  reconcile-on-delete, append-on-add, no-op on unchanged order, and persistence
  round-trip. Then the component.
- **Interaction audit note:** `WalletPicker.jsx` already has a `contextMenu` state, a
  `renameTarget`, a `deleteTarget`, and click-to-open on the tile. Drag must not fight
  the tile's click-to-open or the `...` menu — I will gate drag activation on a
  long-press/handle sensor so a plain click still opens the wallet.

---

## 7. Custom titlebar — recommend deferring out of this pass

This is not styling; it is `frame: false` plus hand-rolled window controls, and on
Windows it costs native snap, Aero shake and the system menu unless reimplemented
over IPC. Your own §5 names it "a known Electron footgun" and asks me to flag it.

**Recommendation: do not do it in this pass.** Do the grid, reorder, naming fix and
`--success` first, verify packaged, then take the titlebar as its own change with its
own packaged drag/snap/minimize test. Mixing it in means every other screenshot in
the pack is taken through an unverified chrome layer. If you want it now, say so and
I will treat it as a separate first commit with its own verification — but the
snap/drag regression is yours to accept.

---

## 8. Files

**Modify:** `src/renderer/index.css` (success tokens, `--card-elevated` alias);
`components/{Button,AppShell,WalletCard,AssetRow}.jsx` (route success through the new
token); `screens/WalletPicker.jsx` (header/status/filter/tiles/buttons);
`app/NileWallet.jsx` (token pills, danger surface); `lib/nileWallet.js` (naming
allocator, backup-entry `name`, order get/set); `lib/walletHome.js` (order helper);
`components/AddWalletModal.jsx` (duplicate-label guard, only if you approve §2.3).
**Create:** `components/WalletTile.jsx`; `components/ui/{separator,badge}.jsx` (or
equivalent under existing `components/`); `tests/wallet-registry.test.mjs`; extend
`tests/wallet-home.test.mjs`.
**Not touched:** `src/main.js` and `preload.js` (§7 — unless you approve the
titlebar, in which case they are touched by that change only); `lib/{tonStandards,
sendQueue,WalletInstance,Encrypter,nileWalletClient,NileWalletConnect*}.js` except
the additive wrappers the reorder needs; anything in `send`/`receive`/`backup`
*crypto*.

**Untouched by me:** `replica/`, the five pre-existing plan docs, `nul`, and every
file another agent has modified that this plan does not name.

---

## 9. Tests (before implementation, per `AGENTS.md` §2)

1. `tests/wallet-registry.test.mjs` — `uniqueWalletName` after deletion; name
   survives backup → restore. **RED first.**
2. `tests/wallet-home.test.mjs` — `applyWalletOrder`: reconcile deleted id, append
   new id, unchanged order is a no-op, stable across filter changes.
3. `tests/wallet-home.test.mjs` — the two status-row counts agree with the rows the
   tiles render (the mockup's inconsistency, asserted against).
4. Existing suites must stay green: 57 send / 18 backup / 6 home.

---

## 10. Verification

1. `npm test` green, with the new tests added (not replacing any).
2. `npx vite build` + escaped-token audit against the emitted CSS — no new dangling
   `.nc-*`/Tailwind references (this is how `.nc-card-primary` was found dead).
3. `npm run build` → packaged `.exe`; confirm the new CSS is in the packaged
   artifact under `file://`, not just dev.
4. **Packaged screenshots of every screen, before/after, plus drag-in-progress and
   after-restart-persisted** — your §0.4 standard.

**Mechanics problem, stated up front:** the packaged app cannot be driven
programmatically the way the browser preview can, and the vault screens need an
unlock I do not have the passphrase for. I propose: launch the packaged exe and
capture the window with a PowerShell/.NET screen-grab script (no elevation, own
window only), with **you** unlocking for the vault screens. If you would rather, a
temporary dev-only capture hook is the alternative — but that adds code to the app
and I would want it explicitly approved and removed before the final build.

---

## 11. Decisions I need from you

1. **The mockups.** Attach the two PNGs, or tell me to proceed structurally and take
   one correction pass later. Every **[fidelity]** item above waits on this.
2. **Backup-format change** (§2, defect 2): add `name` to backup entries so restore
   stops losing names, or leave the format alone for now and fix only the colliding
   generator?
3. **Titlebar** (§7): defer as recommended, or take it first as its own verified change?
4. **§2 defect 1 fix scope** — colliding generator only, or generator + the
   add/rename duplicate-label guard in `AddWalletModal`?
