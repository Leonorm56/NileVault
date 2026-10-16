# NileVault — shadcn/ui redesign plan

Status: **awaiting approval. No implementation code is in the tree.** One file was
briefly edited under the earlier (pre-shadcn) brief and has been reverted — verified
by grep for every token I had added (0 matches) and by `git diff --stat`, which
shows `index.css` back at its pre-existing 128-line in-flight diff.

Scope guard: visual/UX and component structure only. Send, receive, backup/restore,
TON Connect and every `@ton/core` call stay untouched.

---

## 1. Repo findings that change the brief

**1.1 Tailwind is already configured — and §3.1's setup step doesn't apply as
written.** There is no `tailwind.config.ts` and there shouldn't be: this is
**Tailwind v4**, CSS-first, via `@tailwindcss/vite` + `@import "tailwindcss"` +
an `@theme` block in `src/renderer/index.css`. v4 has no JS config by default.
So step 3.1 becomes: confirm v4 builds clean packaged (it does — I built it), and
point shadcn's `components.json` at the CSS file (`"tailwind": { "config": "" }`),
not at a new `tailwind.config.ts`. Adding a JS config would fight v4.

**1.2 The repo is already shadcn-shaped by hand. This is the big one.**
- `Button.jsx` uses `class-variance-authority` with shadcn's exact variant/size
  shape, and its own comment says *"(shadcn structure, NileVault tokens)"*.
- `index.css` already defines shadcn's token names in `@theme`: `--color-background`,
  `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`,
  `--accent`, `--destructive`, `--border`, `--input`, `--ring`, plus `--radius-sm…xl`.
- `Modal.jsx` already implements what Radix Dialog provides: focus trap, Esc to
  dismiss, focus restored to the trigger, `role="dialog"`, `aria-modal`, animated
  entrance — and documents consolidating three dialog treatments into one.
- `NileWalletConnectModal.jsx` already renders on Radix `Dialog`.
- Dependencies already present: `radix-ui`, `class-variance-authority`, `clsx`,
  `tailwind-merge`.

**Consequence:** a bulk `shadcn add` of Button/Card/Dialog/Input would *replace
working, already-verified components with equivalents* — pure churn, and it
concentrates the packaged-Electron regression risk you're worried about into the
widest possible diff. I recommend the selective route (see §2).

**1.3 The "no interactive states" complaint is contradicted by the code.** Hover/
active/focus transitions already exist in `Button`, `IconButton`, `AddressRow`
(hover + in-place copy confirmation), `AppShell`, `.nc-card-interactive`, plus a
global `:focus-visible` outline and `prefers-reduced-motion` handling. Either the
screenshots predate the in-flight pass, or the real gap is narrower — token pills
and tiles. **Re-verify against a current packaged build before designing around it.**

**1.4 The brief contradicts itself on gold.** §4 wants `--primary` (gold) for
"value and primary CTA only", but also wants `--border-active` to be
"'brighter/gold border on hover/focus/selected".' Those can't both hold: gold
borders on every hover/focus reintroduces exactly the overload in §1. My proposal —
**resolve in favour of §4's first rule**: gold for value (balances), one primary
CTA per screen, and the active/selected marker; focus and hover borders take a cool
blue `--focus`. Flagging rather than silently picking.

**1.5 The Tailwind purge defect is already fixed, and my earlier report of it was
wrong.** I first said "11 of 64 class tokens missing". That was my probe searching
unescaped selectors (`gap-1.5`) when the CSS holds escaped ones (`gap-1\.5`). A
correctly escaped audit says: **214 distinct tokens across all JSX, 2 absent.**
`@source "./app/";` works. The 2 real absences are references with no definition —
`nc-card-primary` (the entire **Send** section renders as a bare `<section>`) and
`nc-input` (an unstyled textarea). Fixing those two is part of this work.

**1.6 Gold is already the same value everywhere in source.** `--color-primary` and
`--color-nile-gold-500` are both `#d4a843`, and the wordmark uses the latter. §1's
"verify with an eyedropper" is answerable now in source, and will be confirmed by
pixel sampling the packaged build.

**1.7 There is no settings screen and no tabs.** `App.jsx` renders network → unlock
→ picker → wallet. The wallet view uses `AppShell`'s section nav (Wallet/Send/
Receive/Tokens/Settings — Settings `disabled`) which *scrolls to anchors*, not
tabs. So §3.3's Tabs is unnecessary, and "settings/wallet-management screen" is
actually the wallet view's own sections (`backup`, `tokens`, danger zone).

**1.8 Destructive confirmations already exist.** `ConfirmDialog.jsx` replaced
`window.confirm` for irreversible actions, with a themed dialog, named consequence
and a pending state. §5's AlertDialog item is therefore mostly done — I'd verify
coverage (which destructive actions route through it) rather than re-platform it.

---

## 2. Approach — needs your call

| | A. Selective shadcn (recommended) | B. Bulk CLI migration |
| --- | --- | --- |
| What | Add only primitives that bring behaviour the repo lacks; keep existing primitives that already satisfy the same contract | `shadcn add` Button/Card/Dialog/Input/… and rewrite call sites onto them |
| Cost | Small diff, low regression risk | Rewrites working, verified code |
| Gain | New capability where it's missing | Uniform provenance |
| Risk | Two coexisting idioms | Worst case for the packaged-`file://` regression you flagged |

Which primitives actually add something here: **AlertDialog** (verify vs
ConfirmDialog), **Tooltip**, **Separator**, **Badge** (token pills), **Tabs**
(only if the wallet sections should become real tabs — that's an IA change, and §6
forbids IA changes, so: **no**), **ScrollArea** (nice-to-have).

**Dependency caveat for either route:** the repo has the unified `radix-ui`
package; shadcn-generated files import `@radix-ui/react-*` and would add ~8–15
new deps. Worth deciding deliberately rather than as a side effect of `add`.

Recommended order: **AlertDialog + Badge + Separator + Tooltip**, then the token
and elevation work, then re-verify.

---

## 3. Design tokens (shadcn convention, extending what exists)

The `@theme` block already carries the shadcn names, so this is an extension, not
a replacement. Additions:

```css
:root {
  /* two elevations, gradient + blur, glass only on these two tiers */
  --nc-surface-1: linear-gradient(180deg, rgb(16 28 48 / .72), rgb(11 21 38 / .72));
  --nc-surface-2: linear-gradient(180deg, rgb(26 43 71 / .82), rgb(19 31 54 / .82));
  --nc-glass-1: 8px;  --nc-glass-2: 16px;
  --nc-shadow-1: 0 1px 2px rgb(0 0 0 / .45), inset 0 0 0 1px rgb(255 255 255 / .03);
  --nc-shadow-2: 0 18px 40px -18px rgb(0 0 0 / .75), inset 0 0 0 1px rgb(255 255 255 / .04);

  /* borders: rest vs active. Cool blue, not gold — see §1.4 */
  --nc-border-subtle: #1e2c44;
  --nc-border-active: #3d5a86;

  /* focus, mapped to shadcn's --ring so Radix focus-visible inherits it */
  --nc-focus: #8fb4e8;          /* --color-ring */

  --nc-danger-surface: linear-gradient(180deg, rgb(229 72 77 / .12), rgb(229 72 77 / .05));
  --nc-danger-border: rgb(229 72 77 / .45);

  /* three text tiers: balance+wallet name / labels / addresses+helper */
  --nc-type-balance: 2rem;      /* 32 / 700 */
  --nc-type-figure: 1.125rem;   /* 18 / 600 */
  --nc-type-meta: .75rem;       /* 12 / 500 */
}
```

Spacing/radius: keep the existing 8px-derived `--nc-gap* / --nc-pad* / --nc-radius*`
scale (already consistent) rather than swapping in Tailwind's defaults — §4 allows
"audit and replace one-offs", and these aren't one-offs. The one-offs to hunt are
inline `p-4`, `py-2.5`, `size-9` style values inside components.

Glass allocation (your approved decision): `--nc-surface-2` + blur on the balance
hero, header, modals and overlays; `--nc-surface-1` (gradient, no blur) on
panels/rows. Blur only where something sits behind the surface.

---

## 4. Primitive → component mapping

| shadcn | maps to | action |
| --- | --- | --- |
| Button | `components/Button.jsx` (cva, same shape) | **keep**, retune variants |
| Card | `.nc-card*` classes | **keep** (token work only) |
| Dialog | `components/Modal.jsx` (already has the behaviour) | **keep**, add glass |
| AlertDialog | `components/ConfirmDialog.jsx` | **verify coverage**, then decide |
| Input | `components/Input.jsx`, `Field.jsx`, `PasswordInput.jsx` | **keep**, add `.nc-input` |
| Badge | token pills (in `NileWallet.jsx`) | **adopt** |
| Separator | inline `border-b` dividers | **adopt** |
| Tooltip | `title=` attributes on icon buttons | **adopt, low priority** |
| Tabs | AppShell section nav | **reject** — IA change, §6 |
| ScrollArea / Popover | — | not needed |

---

## 5. Component-by-component

**Global**
- `index.css`: elevation tokens; `.nc-card-hero` → surface-2 + blur + shadow-2 and
  left-aligned (a centred balance fought the label for optical centre); `.nc-card`
  → surface-1 + shadow-1; `.nc-card-secondary` → recessed (inner highlight, no
  outer shadow); `.nc-card-danger` → destructive surface; `.nc-card-interactive`
  hover → `--nc-border-active`; **define `.nc-card-primary` and `.nc-input`**;
  `:focus-visible` → `--nc-focus`; add `prefers-reduced-transparency`.
- `Button.jsx`: gold stays on `default` only; `link` loses gold; `danger` gets a
  real hover/active pair instead of `brightness-110`.
- `IconButton.jsx`: drop the `gold` variant (only the pinned star uses it).
- `AppShell.jsx`: active item becomes a gold left-marker with the icon inheriting
  text colour, so selection is one signal rather than two.
- `AssetRow.jsx`: pinned star → muted, not gold; figure at `--nc-type-figure`.

**Wallet picker** (`screens/WalletPicker.jsx`, 1348 lines — internals not yet read)
- Tile anatomy: initials chip → name (primary tier) → balance (gold, largest
  figure) → truncated address (tertiary) → asset icons.
- Tiering via opacity/contrast and border only: funded → full opacity + visible
  border; zero-balance → ~70% + muted figure, no accent border. **No resorting** —
  `lib/walletHome.js` already sorts pinned-first then balance-descending, and §6
  forbids changing it.
- Named vs numbered: a presentation-only helper flags default-looking names (all
  digits; `wallet test N`) and renders them muted; real names get full weight. No
  stored data touched.
- "+ Add Wallet" cell: dashed border, no fill.
- Extract `WalletTile.jsx` so the hierarchy lives in one component.

**Wallet view** (`app/NileWallet.jsx`, 1653 lines)
- Hero via `WalletCard` → surface-2; action row switches from raw `<button>`s to
  `Button` so "Send" is the single gold CTA and Receive/Backup are secondary.
- Send form: `.nc-input`/`Input` with one radius and a clear focus ring. **The
  `nc-card-primary` definition is what makes this section a card at all.**
- Token pills → `Badge`-style with an unambiguous selected state (filled gold +
  dark text), not a border tint.
- Danger zone (line 1576), Reveal recovery phrase (811), Backup warning: destructive
  surface, heavier border, no gold anywhere inside.

**Unlock / network check**
- Add `Container size="auth"` (bounded column, vertically centred) and one shared
  background treatment for both screens — fixing "tiny card in a vast window".
- Network rows: success-tinted row background, not just a green icon.

---

## 6. Files

**Modify:** `src/renderer/index.css`; `components/{Button, IconButton, Modal,
ConfirmDialog, AppShell, WalletCard, AddressRow, AssetRow, Field, Container,
ScreenHeader}.jsx`; `screens/{Unlock, NetworkCheck, WalletPicker}.jsx`;
`app/NileWallet.jsx`.
**Create:** `components/WalletTile.jsx`; `lib/walletName.js` (display helper, ~10
lines); `components.json` (shadcn config only); any adopted shadcn primitive files
under the existing `components/` directory.
**Not touched:** `lib/**` except the display helper; `src/main.js`; `preload.js`;
`lib/{tonStandards,sendQueue,WalletInstance,nileWallet,NileWalletConnect*}.js`.

---

## 7. Verification

1. `npm test` — 56 send / 18 backup / 6 home stay green (the evidence that no
   logic was touched).
2. `npm run build` → `check:build`; then launch the packaged `.exe` and confirm no
   Tailwind purge/build regression under `file://` — new CSS must be present in the
   packaged artifact, not just dev. (I'd re-run the escaped-token audit against the
   *packaged* CSS, which is where a purge regression would show.)
3. Screenshot every screen from the packaged build, before/after: network check,
   unlock, picker (populated + empty), wallet hero, send, receive, tokens, backup,
   danger zone, add-wallet, connect modal, confirm dialog. You unlock during this
   pass (your decision) — nothing about the vault leaves the machine.
4. Eyedropper the rendered wordmark vs the primary button to close §1.6 with pixels.
5. Re-check the four complaints that the code contradicts (§1.3, §1.5) against the
   packaged build before claiming them fixed.

---

## 8. Open decisions

1. **§2 route:** selective shadcn (recommended) vs bulk CLI migration.
2. **§1.4 gold conflict:** my proposal is gold for value + one CTA + active marker,
   cool-blue focus/hover. Confirm or override.
3. **Unified `radix-ui` vs `@radix-ui/react-*`:** decide before any `shadcn add`,
   since the CLI adds the latter by default.
4. Already answered and still standing: glass on overlays + heroes only; build on
   the current 17-file tree; you unlock during the screenshot pass.
