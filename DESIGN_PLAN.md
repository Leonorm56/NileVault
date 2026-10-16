# NileVault Design Plan

## Problem Statement

Every section of NileVault currently receives the identical visual treatment:
same rounded-corner glass card, same border, same padding, same weight. There
is no hierarchy — "Danger zone" looks exactly like "Vault passphrase", which
looks exactly like "Connect via link." The app manages real funds with real
consequence, but the UI reads as a generic SaaS dashboard template.

## Guiding Principles

1. **Value at stake is visible.** This is a crypto wallet, not a todo app.
   Every screen should communicate that the user is interacting with real
   assets. Numbers should dominate. Actions should carry weight.

2. **Hierarchy through visual weight, not decoration.** The most important
   element on every screen should be unambiguously the most important. Not
   "slightly bigger" — structurally different.

3. **Consequence is legible.** Destructive actions (remove wallet, reveal
   seed) should feel structurally different from routine actions (send, add
   token). Not just red text on the same card.

4. **Precision over polish.** TON addresses, balances, hashes — these are
   high-precision values. The typography should honour that: tabular numbers,
   monospace for machine-readable values, tight tracking on data.

5. **Gold is a signal, not a fill.** Gold should mark the single most
   important interactive element on any screen. When everything is gold,
   nothing is.

---

## Grid System (8px base)

Every measurement derives from an 8px grid. No exceptions.

| Token | Value | Usage |
|-------|-------|-------|
| `--nc-unit` | 8px | Base unit |
| `--nc-gap-xs` | 4px | Inline gaps (icon + label) |
| `--nc-gap-sm` | 8px | Tight gaps (between related items) |
| `--nc-gap` | 16px | Standard gap between cards |
| `--nc-gap-lg` | 24px | Section separators |
| `--nc-gap-xl` | 32px | Major section breaks |
| `--nc-pad-sm` | 12px | Compact cards (wallet tiles) |
| `--nc-pad` | 16px | Standard card padding |
| `--nc-pad-lg` | 24px | Hero cards (balance display) |
| `--nc-radius-sm` | 8px | Small elements (buttons, badges) |
| `--nc-radius` | 12px | Standard cards |
| `--nc-radius-lg` | 16px | Hero elements |

**Column grid:**
- Container max-width: 1120px (consistent with Electron window)
- Two-column layout at lg: left 560px, right 560px
- Gutter between columns: 16px
- Both columns use the same internal card padding

---

## Type Scale

| Role | Size | Weight | Line Height | Tracking | Use |
|------|------|--------|-------------|----------|-----|
| `nc-balance` | 36px | 700 | 44px | -0.02em | Total balance, large numbers |
| `nc-display` | 28px | 700 | 34px | -0.01em | Section hero numbers |
| `nc-title` | 18px | 700 | 24px | 0 | Section headings |
| `nc-body` | 14px | 400 | 20px | 0 | Descriptions, prose |
| `nc-label` | 12px | 600 | 16px | 0.02em | Field labels, uppercase |
| `nc-caption` | 12px | 400 | 16px | 0 | Hints, secondary text |
| `nc-mono` | 13px | 400 | 18px | 0 | Addresses, hashes (Fira Code) |
| `nc-num` | 14px | 600 | 18px | 0 | Inline numbers (tabular) |

Key rule: **balance numbers dominate every screen they appear on.** The total
balance on the picker should be the largest, boldest element. Per-wallet
balances should be the dominant element in their tile.

---

## Card Treatments (Hierarchy)

### Level 0 — Hero (balance display, total balance)
- Background: subtle gold radial gradient overlay
- Border: none (or 1px gold/20)
- Padding: 24px
- Used for: total balance on picker, wallet balance on detail

### Level 1 — Primary action (send, receive)
- Background: glass surface (current default)
- Border: 1px white/10
- Padding: 16px
- Used for: send form, receive QR

### Level 2 — Secondary content (tokens, backup, connect)
- Background: glass surface, slightly dimmer
- Border: 1px white/8
- Padding: 12px (tighter than primary)
- Used for: token list, vault passphrase, connect link

### Level 3 — Destructive (danger zone, reveal seed, remove)
- Background: no glass — solid dark with red tint
- Border: 1px red-500/25
- Padding: 16px
- Visual: red-tinted background, no blur, heavier border
- Used for: danger zone, reveal recovery phrase, remove wallet

### Level 4 — Inline (confirmation badges, status)
- Background: none
- Border: none
- Used for: inline status, validation messages

---

## Gold Usage Rules

1. **One gold button per screen.** The single primary action gets gold fill.
   Everything else uses secondary/outline/ghost.

2. **Gold marks importance, not every action.** "Review and send" gets gold.
   "Backup wallets" gets secondary. "Connect" gets outline.

3. **Gold borders for the most important card.** Only the balance hero and
   the currently selected wallet tile get gold border treatment.

4. **Gold text for balance numbers.** The balance is the most important data
   on every screen — it gets gold-400 treatment.

---

## Component Specifics

### Wallet Tiles (Picker)
- Monogram: 40×40, rounded-xl, accent-colored border/bg (existing system)
- For numeric names: show the full number as monogram (fixed)
- Tile: `min-h-[7rem]`, p-3, glass surface
- Accent: per-wallet hash-based color from existing ACCENTS array
- Selected state: gold border + slight gold tint background
- Opening animation: scale(0.97) + dim, then navigate

### Send Screen Sections
- **Send form**: Level 1 card (primary)
- **Token selector**: Level 2 card (secondary, compact)
- **Confirm dialog**: Level 1 card with gold accent border
- **Fee display**: monospace, tabular, in the confirm dialog

### Settings/Detail Sections
Each section gets a card matching its hierarchy level:
- Tokens: Level 2
- Vault passphrase: Level 2
- Connect via link: Level 2
- Reveal recovery phrase: Level 3 (destructive)
- Danger zone: Level 3 (destructive)

Section headings use `nc-title` with consistent left padding matching the
card's internal padding.

### Buttons by Consequence
| Action | Variant | Reason |
|--------|---------|--------|
| Send / Confirm transfer | `default` (gold) | Primary financial action |
| Backup wallets | `secondary` | Important but routine |
| Restore | `secondary` | Important but routine |
| Connect | `outline` | External integration |
| Add Wallet | `secondary` | Building, not spending |
| Remove wallet | `danger` | Irreversible |
| Reveal seed | `danger` | Security-critical |

---

## Visual Language Notes

- No decorative illustrations. The visual interest comes from data
  (balances, addresses, status) not from clip art or icons.
- Subtle gold radial gradient on hero cards gives depth without new colors.
- The glass blur (backdrop-blur-md) is reserved for interactive surfaces
  only — informational cards use solid backgrounds.
- Reduced motion: all transitions collapse to 1ms. No exceptions.

---

## What Changes vs. Current

| Current | Proposed |
|---------|----------|
| All cards identical | 5 hierarchy levels with distinct treatments |
| Gold fill on every primary button | Gold reserved for one action per screen |
| All sections same card weight | Destructive sections get solid red-tinted cards |
| Balance text same size as labels | Balance gets dedicated nc-balance scale |
| No visual difference between routine/destructive | Structural card treatment differs |
| Monogram truncates numbers | Numeric names shown in full |
| Uniform padding everywhere | Padding scales with card hierarchy |
