# Architecture: NileVault (UI patterns rebuilt from My Wallet's desktop UX)

## Stack

| layer | choice | why |
| --- | --- | --- |
| desktop shell | Electron 41 + Vite 6 (existing) | already ships; keeps self-custody local-first, no server to run |
| UI | React 19 + Tailwind v4 + navy/gold tokens in `src/renderer/index.css` | existing system; replica-design maps roles onto it, brand unchanged |
| icons | `react-icons/hi2` (existing) + open sets only for new glyphs | MIT; no My Wallet assets copied |
| data | React Query 5 + `nileWalletClient` IPC bridge (existing) | local vault stays source of truth; TON data via public APIs with own keys |
| database | Local vault file (existing Encrypter) — no Postgres | self-custodial desktop has no server or users table; schema below = vault JSON + cache |
| auth | Vault password + in-memory key, manual lock (existing) | matches S02 unlock; no accounts server |
| payments | n/a (wallet, not SaaS) | on-ramp providers are deferred UI entries, provider-hosted |
| hosting | electron-builder NSIS + portable (existing) | packaged `.exe` is the release artifact |

One database: the encrypted vault file. No microservices.

## Schema

Tables: 5 logical stores (vault JSON sections + in-memory cache). Access rules: data-layer checks in `nileWalletClient` / main process — vault must be unlocked before any read; no RLS (no shared server).

```sql
-- replica/schema.sql documents the vault shape as SQL for portability.
-- The runtime store is the encrypted vault file, not Postgres.
```

## API

| method path | does | who | input | output | flow |
| --- | --- | --- | --- | --- | --- |
| IPC `vaultStatus` | unlocked? + wallet list | renderer (unlocked or not) | — | `{unlocked, wallets[]}` | F02 |
| IPC `unlock` | decrypt vault into memory | renderer, user password | `{password}` | `{ok}` | F02 |
| IPC `listTokens` | tracked jettons for wallet | unlocked renderer | `{accountId}` | `token[]` | F05 |
| IPC `jettonBalances` | balances for tracked tokens | unlocked renderer | `{accountId}` | `balances[]` | F05 |
| IPC `addToken` / `removeToken` | track / untrack jetton | unlocked renderer | `{accountId, addr}` | `{ok}` | F05 |
| TON `getBalance` / `getTransactions` | chain reads via user's endpoint | unlocked renderer via main | `{address}` | balance / tx list | F03–F05 |
| TON `sendBroadcast` | submit signed external-in | unlocked renderer, confirmed | signed msg | `{txid}` | F03 |

Webhooks in: none. Webhooks out: none.
Jobs: balance/tx polling via React Query refetch (30s), no cron.

Only official, public TON APIs with the user's own endpoint. Never My Wallet's private endpoints.

## The parts that bite

- seqno races: fetch-then-send can go stale; `isSeqnoMismatchError` retry path owns this, UI shows confirming → failed with retry
- idempotency: double-submit blocked by `sendQueue` + disabled confirm button; broadcast payload hashed for receipt dedupe
- fee headroom: `withFeeHeadroom` + `FEE_FALLBACK_NANO`; insufficient-for-fee is a validation state, not a send error
- addresses: bounceable vs non-bounceable, `parseTransferInput` accepts domain input for later; invalid = inline error, no toast
- times: `timestamptz` UTC in schema; display in OS locale, never convert twice
- money: integer nanotons/raw units + decimals column; fiat only at render via `formatAmount`
- GDPR deletion: remove-wallet wipes vault section + cache invalidation; no server copies

## Build order

1. Vertical slice: AppShell left-nav (S03 shell) + wallet home (S03: WalletCard, QuickActions, AssetRow) on real `nileWalletClient` data, ugly-first. Screens: S03. Stores: wallets, holdings.
2. Must-haves: S02 unlock polish, S04 token page, S05 send sheet, S06 receive sheet, S07 history + TXID detail, S11 settings (currency, hide balances), copy feedback, skeletons + empty/error states.
3. Should-haves: search entry, + action sheet, saved addresses, hide/sort networks, tab order, net-worth chart, add/remove token display, explorer links.
4. Fixes from replica-entrepreneur: after it runs.
