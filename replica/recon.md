# Recon map: My Wallet / MyTonWallet (desktop/web UI patterns)

Scope: UI-first slice — desktop wallet shell (nav, balance hero, tokens, send/receive, history, settings) rebuilt clean-room into NileVault Electron desktop. No source-code copying.
For: NileVault desktop users (TON-first, single-wallet detail today → multi-wallet shell tomorrow)
Date: 2026-10-11

Clean-room note: this map is built from public pages, help docs, and store
listings only. No My Wallet source bundles, binaries, private APIs, or
network logs were read or saved. My Wallet's LICENSE forbids deploying
builds derived from its code — NileVault rebuilds UX patterns fresh, with
its own code, assets, copy, and brand. Screenshots (if added later) live in
`replica/screens/` as layout reference only and never ship.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | marketing site | https://mywallet.io/ | core loop in their words; quick actions; 17 chains; Fund/Send/Swap/Earn; ratings (App Store 4.8, Google Play 4.8/37K, Trustpilot 4.8) |
| 2 | help center home | https://help.mywallet.io/ | entry to all guides; install → create → receive path |
| 3 | key features index | https://help.mywallet.io/intro/key-features.md | fullest feature list: balances, token display, pinned tokens, token pages, multichain, base currency, charts, personalization, subwallets |
| 4 | desktop layout + navigation | https://help.mywallet.io/intro/key-features/desktop-layout-and-navigation.md | left-column nav, top quick actions, wallet card, Fund/Send/Swap/Earn, Assets/NFTs/Activity, customizable tabs |
| 5 | transfers index | https://help.mywallet.io/intro/transfers.md | send/receive/multisend/gasless/TXID-status flows |
| 6 | repo README (public description only) | https://github.com/mytonwallet-org/mytonwallet | positioning + platform list (mobile/desktop/web/extension/Telegram); NOT used for code |
| 7 | app store listings | https://mywallet.io/ (links to App Store / Google Play / Chrome Web Store) | screenshots of key screens, pitch, ratings; to be captured into replica/screens/ |
| 8 | NileVault current UI (own project) | C:/Users/GH/Desktop/NileVault/src/renderer/app/NileWallet.jsx | single-wallet detail: hero balance, send form, receive, tokens, backup, connect; baseline to upgrade |

Not consulted: JS bundles, binaries, private endpoints, anyone else's account.
Terms check: no logged-in scraping was performed; all of the above is public.

## Core loop

See total balance, pick a token, send or receive it, check it landed.

## Screens

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Onboarding: create / import | first run; "Install → Create wallet" help path | new or restored wallet (seed/BIP39) | seed grid, import input, primary CTA, legal checkbox | empty, filled, error |
| S02 | Unlock / passcode | app launch when locked; "Remember passcode" | gate access | passcode pad, biometric hint, hide-balances toggle | locked, error, loading |
| S03 | Wallet home (desktop) | default after unlock; left-nav Wallet | portfolio overview + entry to all actions | left nav, wallet card (balance + % change + name), quick actions (Fund/Send/Swap/Earn/Buy/Sell), Assets/NFTs/Activity tabs | empty, loading, filled, error |
| S04 | Token page | click asset row on S03 | per-token balance, chart, actions | price chart + controls, Send/Receive/Swap buttons, about, history slice | loading, filled, empty-history |
| S05 | Send sheet/modal | Send on S03/S04 or + button | build + confirm transfer | recipient field (address/domain/saved), amount + fiat, fee row, comment/memo, confirm screen, TXID receipt | empty, filled, validating, confirming, sent, failed |
| S06 | Receive sheet/modal | Receive/Fund on S03/S04 | show address + copy/share | QR, address row, copy button, network warning, deposit-link option | filled, copy-feedback |
| S07 | Activity / history | Activity tab on S03; token slice on S04 | verify what happened | tx list rows (direction icon, counterpart, amount, status), filter, detail sheet with TXID + explorer link | empty, loading, filled, error |
| S08 | Market | Market section (swipe/top menu; desktop nav) | follow + trade popular assets | asset table (price, % change, chart spark), token quick actions | loading, filled |
| S09 | Explore (dapps/services) | Explore section | open dapps, buy/withdraw via providers | dapp grid, banners, search | filled, empty-search |
| S10 | Search-or-Ask + Plus-button | bottom bar (mobile) / omni entry (desktop) | jump to token/feature/dapp or ask Agent | search input, results list, agent entry, + action sheet | empty, typing, results |
| S11 | Settings | wallet icon top-right → Settings | personalize + security + recovery | base currency, hide/sort networks, tab customization, personalization, balance hiding, saved addresses, backup phrase, support link | filled |
| S12 | Fund / Buy-with-card | Fund/Buy quick action | on-ramp entry | provider list, amount, card form (provider-hosted), status | empty, pending, done, failed |

UI-first slice builds: S02, S03, S04, S05, S06, S07, S11. S01 reused from NileVault's existing onboarding (restyled). S08/S09/S10/S12 deferred to later slices.

## Flows

```
F01 New user creates wallet and receives first funds
    S01 -> S03 (empty) -> S06 -> S03 (funded) -> S07
    happy path clicks: 5
    edge: seed mistyped, address copied from wrong network, deposit not yet arrived
F02 Existing user imports wallet and unlocks
    S01 -> S02 -> S03
    happy path clicks: 4
    edge: wrong seed length, unsupported BIP39 path, passcode forgotten
F03 Send TON/token to an address (happy path to beat)
    S03 -> S05 (recipient) -> S05 (amount+fee) -> S05 (confirm) -> S07
    happy path clicks: 4
    edge: invalid address, insufficient for fee, comment required, tx failed, double-submit
F04 Receive: show QR and copy address
    S03 -> S06 -> copied
    happy path clicks: 2
    edge: wrong network selected, copy without feedback
F05 Check balance + per-token history
    S03 -> S04 -> S07(detail)
    happy path clicks: 3
    edge: loading balances, empty history, spam/scam tx flagged
F06 Personalize: hide balance, hide/sort network, reorder tabs
    S03 -> S11 -> S03
    happy path clicks: 4
    edge: all networks hidden, base currency changed mid-session
F07 (deferred) Swap / Earn / Buy-with-card
    S03 -> S12/Swap sheet -> status -> S07
    edge: provider unavailable, slippage, KYC required
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Left nav (desktop) | Wallet, Market, Explore, Settings | active, hover, badge | S03 shell |
| Wallet card | single, multi (switcher) | loading, filled, % up/down, hidden-balance | S03 |
| Quick actions bar | Fund, Send, Swap, Earn, Buy, Sell | default, disabled, loading | S03, S04 |
| Asset row | token, fiat total, pinned | loading skeleton, filled, price up/down | S03, S08 |
| Token chart | net-worth, portfolio, token | loading, empty, range-switched | S03, S04 |
| Send form | address, amount+fiat, fee, memo | empty, filled, validating, error, confirming, sent | S05 |
| Receive sheet | QR + address + copy | filled, copied-feedback | S06 |
| Tx row + detail | in/out, pending/done/failed | loading, filled, empty, spam-flagged | S07 |
| Search-or-Ask bar | search, agent entry | empty, typing, results | S10 |
| Plus (+) action sheet | send, receive, buy, swap | closed, open | S03, mobile |
| Settings group | currency, networks, tabs, security | filled, toggled | S11 |
| Toast / status | success, error, info | auto-dismiss, sticky-error | all |
| Modal / sheet | small, large, bottom-sheet | open, closed, loading-in-modal | S05, S06, S07-detail |
| Empty state | first-run, no-history, no-results | illustrated + CTA | S03, S07, S09 |

NileVault already has: Button, Input, Field, Modal, ConfirmDialog, IconButton,
Skeleton, Spinner, ScreenHeader, Container. Gaps vs this list: left-nav shell,
wallet card, asset row, chart block, send/receive sheets, tx row/detail,
search entry, action sheet, empty states.

## Inferred data model

```
Wallet  id, name, addresses {chain: address}, type (mnemonic | view-only | hardware-ref), created_at
        evidence: S01 create/import, S11 switching between wallets, view mode + Ledger refs
        confidence: high
TokenHolding  wallet_id, chain, token_address | native, symbol, decimals, balance_raw, price_fiat, pinned, hidden
        evidence: S03 assets, add/remove token display, pinned tokens, base currency
        confidence: high
Transaction  id (txid/hash), wallet_id, chain, direction (in|out), counterpart, token, amount_raw, fee_raw, status (pending|done|failed), comment, ts
        evidence: S05 receipt + TXID, S07 list + detail + explorer link
        confidence: high
SavedAddress  id, wallet_id, label, address, chain
        evidence: S05 recipient shortcuts, saved-addresses + quick-actions docs
        confidence: high
Settings  wallet_id, base_currency, hidden_balances, hidden_networks[], tab_order[], locale
        evidence: S11 settings, base currency, hide/sort networks, tab customization
        confidence: medium
MarketQuote  token, chain, price, change_24h, spark[]
        evidence: S08 market, S04 token page
        confidence: medium (derived cache, not stored)
```

Relationships: Wallet 1-n TokenHolding, Wallet 1-n Transaction,
Wallet 1-n SavedAddress, Wallet 1-1 Settings.

## Feature matrix

See `features.csv`. Must: 14, should: 8, could: 6, skip: 5.

## Out of scope (cannot or should not be cloned)

- Multichain backend (17 chains), swap aggregator routes, staking yields, gasless relaying — partner/infra, not UI; backend slices later, TON-only first
- NFT/collectibles catalogues, Telegram Gifts inventory — licensed content + marketplaces
- MoonPay/card rails and KYC — third-party providers; UI entry only (S12 deferred)
- Agent/AI backends, push-notification infra, card widgets, iOS shortcuts — platform/infra
- My Wallet name, logo, copy, icons, fonts, illustrations — their brand assets; NileVault keeps its own (replica-brand enforces)
- My Wallet source code of any kind — license + clean-room rule; everything rebuilt fresh

## Size

Screens 12 (7 in UI-first slice), flows 7 (6 in slice), entities 6. Hard parts: chart + price plumbing without copying APIs, send-confirm-receipt state machine, tx-history fidelity (pending/failed/spam), desktop left-nav shell inside Electron, balance-hiding + base-currency consistency. Size: M (a few weeks for the UI slice; backend multichain/swap/staking would push L/XL and is out of this slice).
