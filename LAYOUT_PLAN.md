# NileVault Layout Plan

## Diagnosis (current state)

- **Window:** `1100×780` (not maximized — your screenshots show 1920 because Windows DPI scaling). Fixed size, no resize handler beyond `minWidth:420 minHeight:620`.
- **Centered column:** `Container max-w-4xl` (56rem = 896px) inside a 1100-wide window → ~100px dead on each side. The 1920 "void" you're seeing is DPI/HiDPI scaling at 175% on a 4K display.
- **Wallet screen uses `max-w-xl` (36rem = 576px)** — too narrow for the four-block layout (balance / actions / receive / send).
- **Wallet detail (NileWallet.jsx):** four stacked full-width blocks. Action row already exists (Send/Receive/Backup) but it's a separate card *after* the balance card. Receive/Send render below as full-width sections that push the action row offscreen on a 780-tall window.
- **Picker tiles:** `grid-cols-2 lg:grid-cols-3` inside `max-w-4xl`. At 1100-wide window the picker actually uses ~896px → tiles get ~290px each, looks spacious for sparse content.
- **Button gold:** same hex (#d4a843) as the wordmark, but a `shadow-sm shadow-nile-gold-500/20` muted layer reduces perceived saturation. Active state goes to `bg-nile-gold-600` (#c99a36) — *darker*, so press reads as "going muddy". Needs brightening on press, not darkening.
- **Header gap:** logo + version number with `ml-auto` gap. Looks empty because the centre has nothing to anchor.

## Fix 1 — Layout system

**Decision: responsive, not fixed-size window.** The 1100×780 stays as a sensible default, but the layout becomes responsive so HiDPI/large screens fill proportionally instead of leaving void.

- Container scale becomes: `sm=md (28rem), md=xl (36rem), lg=2xl (42rem), xl=4xl (56rem), 2xl=6xl (72rem)`. Wallet screen bumps to `lg` so balance card + receive QR can sit side-by-side.
- Add a `ResponsiveGrid` primitive (12-col CSS grid) so screens can opt into 2-column layouts at `lg`+ (≥1024px).
- **Wallet detail at lg+:** Balance card (left, 7-col) + Receive QR (right, 5-col). Send + Backup stack below at full width.
- **Wallet detail at sm/md:** single column (current behavior).
- **Settings:** Tokens card and Vault passphrase card side-by-side at lg+.
- **Picker grid:** `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` at xl — packs more per row, tiles feel populated.

## Fix 2 — Action row & balance restructure

Current: balance card → action row card → receive card → send card.

New at lg+:
- **Top row:** Balance card (7-col) | Receive QR card (5-col) — both visible without scroll, balance on the left where eyes land first, QR ready for scanning immediately.
- **Action row (icons + labels):** Send / Backup chips inline under the balance, not a separate card.
- **Send section:** full width below.
- **Tokens section:** own row below, full width.

At sm/md: keep stacked (everything visible by scrolling).

## Fix 3 — Settings density

- Wrap each section card in `p-3` instead of `p-4/p-5`.
- Reduce header-to-content `gap-3` (12px) consistently — replace ad-hoc `gap-2/gap-3/gap-4`.
- Tokens + Vault passphrase → 2-col at lg+. Backup & restore + Connect via link → 2-col at lg+. Reveal phrase + Danger zone → 2-col at lg+.
- Add a `SectionHeader` primitive so section titles are uniform (small caps, muted, divider line).

## Fix 4 — Gold buttons

Current: `bg-nile-gold-500 #d4a843` + `shadow-sm shadow-nile-gold-500/20` → reads as muted khaki because of the shadow on the navy canvas.

Fix:
- Bump default fill to `bg-nile-gold-400 #e8c454` (the brighter shade).
- Replace the muted shadow with a subtle gold ring `shadow-[0_0_0_1px_rgba(232,196,84,0.4)]` (1px gold halo, not a downward shadow).
- Active state: `bg-nile-gold-300 #f8db80` + slight scale-down (already there). Goes *lighter* on press, not darker — reads as "energised", matches the wordmark's bright stroke.
- Hover: `bg-nile-gold-300` (brighter) + 1px lift (already there).
- Loading state: spinner already in slot, label unchanged (already there).
- Text: `text-neutral-950` (already there) — keep, that's the contrast against gold.

## Fix 5 — Wallet tiles

- Shrink tile height from current ~96px to ~72px by tightening inner padding (`p-3.5` → `p-3`).
- Each tile gets a **monogram identicon** in the gold ring (first letter of name in a 36×36 gold-tinted badge) — replaces the duplicated `nilevault-logo.jpg` that makes every tile indistinguishable.
- Right side: balance in large gold + address truncated underneath (already there but smaller).
- 4 columns at lg means tiles are ~200px each at xl. Reads as a real grid, not a sparse row.

## Fix 6 — Header dead space

Currently: `ml-auto` puts version number far right, gap between logo and version is empty.

Add between them (when unlocked):
- **Network status pill** — "Mainnet" in green-tinged chip (reads tonapi once on mount).
- **Account switcher** — current wallet name + chevron when a wallet is selected, clicking pops the picker.

These fill the gap with two useful chips, not decoration. At sm/md both collapse to icons.

## Fix 7 — Spacing scale

Single source in `index.css`:
```
--nc-pad-card: 0.875rem;     /* 14px — card inner padding (was 16px-20px) */
--nc-pad-section: 1.25rem;   /* 20px — section padding */
--nc-gap-stack: 0.875rem;    /* 14px — between siblings in a stack (was 12-16px) */
--nc-gap-page: 1rem;         /* 16px — between major page sections */
```

Replace per-component `p-3/p-3.5/p-4/p-5` with `nc-pad-card`, `gap-2/gap-3/gap-4` with `nc-gap-stack`. Lints against ad-hoc spacing values.

## Verification

After implementation:
- `npm run build` produces fresh `.exe`.
- Tests still pass (47/47) — no behavior changes.
- Manual visual check on packaged build at 1100×780, 1440×900, 1920×1200 viewports.
- Pick a 1500-coin send to verify the new balance/QR layout doesn't break anything.

## Execution order

1. Spacing scale + Container sizes (foundational).
2. Gold button variants.
3. Wallet tiles (monogram, density, grid columns).
4. Header (network + switcher).
5. Wallet detail restructure (responsive grid, balance/QR side-by-side at lg+).
6. Settings density (p-3, 2-col at lg+).
7. Build + verify.

Nothing edited yet — awaiting review.
