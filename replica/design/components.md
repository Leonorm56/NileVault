# Components — NileVault primitives for the My-Wallet-pattern shell

Built in code before any screen (replica-design Step 4). Existing primitives
reused: Button, Input, Field, Modal, ConfirmDialog, IconButton, Skeleton,
Spinner, ScreenHeader, Container. New blocks below map to existing CSS in
`src/renderer/index.css` (nc-*) — no raw hex in components.

```
AppShell
  variants  desktop (left nav 232px) / narrow (top bar only <1024px)
  states    default, wallet-open, locked
  tokens    bg bg, surface surface, border border, header 52px
  a11y      <nav> landmark, current page via aria-current, skip link to main
  used on   S03 shell for S03-S11
WalletCard
  variants  single, multi-switcher (later)
  states    loading (skeleton), filled, balance-hidden, error
  tokens    hero card nc-card-hero, balance nc-balance, muted text-muted
  a11y      balance in <p> with aria-live polite, hide toggle labelled
  used on   S03
QuickActions
  variants  Fund, Send, Swap(entry), Earn(entry)
  states    default, disabled (locked/loading), loading
  tokens    Button primary/secondary/ghost
  a11y      real <button>s, visible focus ring, disabled announced
  used on   S03, S04
AssetRow
  variants  native, jetton, pinned
  states    loading skeleton, filled, price up/down, hidden-balance (••••)
  tokens    surface-2 hover, num tabular, muted caption
  a11y      row is a link/button with name + balance, pinned has aria-pressed
  used on   S03, S08(later)
TxRow + TxDetail
  variants  in, out, pending, failed, spam-flagged
  states    loading, filled, empty, error
  tokens    success/danger for direction, mono for txid
  a11y      status text not colour-only, detail in <dialog> labelled
  used on   S07, S04 slice
SendSheet / ReceiveSheet
  variants  sheet large (desktop modal)
  states    empty, filled, validating, confirming, sent, failed / copied-feedback
  tokens    card primary, input border-input, focus gold ring
  a11y      <dialog> labelled, errors tied with aria-describedby, focus trapped
  used on   S05, S06
EmptyState
  variants  first-run, no-history, no-results
  states    single (illustration-free, CTA)
  tokens    muted body + primary CTA
  a11y      heading + action, no dead ends
  used on   S03, S07
```

Copy rule: every label/empty-state sentence written fresh for NileVault.
No My Wallet sentences, no brand colour taken (accent is NileVault gold).
