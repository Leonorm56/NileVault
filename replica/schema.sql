-- NileVault vault shape, documented as SQL for portability.
-- Runtime store is the encrypted vault file (see Encrypter.js), NOT Postgres.
-- Times UTC, money as integers + decimals. Every user-owned row carries wallet_id.

create table wallets (
  id uuid primary key,
  name text not null,
  address text not null,
  type text not null default 'mnemonic'
    check (type in ('mnemonic','view-only','hardware-ref')),
  created_at timestamptz not null default now()
);

create table token_holdings (
  wallet_id uuid not null references wallets(id) on delete cascade,
  chain text not null default 'ton',
  token_address text not null default 'native',
  symbol text not null,
  decimals integer not null default 9 check (decimals >= 0),
  balance_raw text not null default '0',
  pinned boolean not null default false,
  hidden boolean not null default false,
  primary key (wallet_id, chain, token_address)
);
create index on token_holdings (wallet_id);

create table transactions (
  txid text not null,
  wallet_id uuid not null references wallets(id) on delete cascade,
  chain text not null default 'ton',
  direction text not null check (direction in ('in','out')),
  counterpart text not null default '',
  token text not null default 'TON',
  amount_raw text not null default '0',
  fee_raw text not null default '0',
  status text not null default 'done'
    check (status in ('pending','done','failed')),
  comment text not null default '',
  ts timestamptz not null,
  primary key (wallet_id, txid)
);
create index on transactions (wallet_id, ts desc);

create table saved_addresses (
  id uuid primary key,
  wallet_id uuid not null references wallets(id) on delete cascade,
  label text not null,
  address text not null,
  chain text not null default 'ton',
  created_at timestamptz not null default now()
);
create index on saved_addresses (wallet_id, label);

create table wallet_settings (
  wallet_id uuid primary key references wallets(id) on delete cascade,
  base_currency text not null default 'USD',
  hidden_balances boolean not null default false,
  hidden_networks text[] not null default '{}',
  tab_order text[] not null default '{assets,activity}',
  updated_at timestamptz not null default now()
);
