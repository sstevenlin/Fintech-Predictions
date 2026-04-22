-- Fintech-Predictions: initial schema (Ticket 1)
-- Tables: users, markets, price_history, orders, fills, positions
-- Conventions:
--   * All prices stored as integer cents (0-100 for Kalshi yes/no contracts)
--   * Money stored as numeric(14,2) to avoid float rounding errors
--   * Every PK is a uuid (except markets, which uses the Kalshi ticker as a text PK)

-- =========================================================================
-- USERS
-- 1:1 with auth.users. Holds app-level profile and simulated cash balance.
-- =========================================================================
create table public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  cash_balance  numeric(14, 2) not null default 1000.00 check (cash_balance >= 0),
  created_at    timestamptz not null default now()
);

comment on table  public.users              is 'App-level profile mirroring auth.users, with simulated cash balance.';
comment on column public.users.cash_balance is 'Simulated USD cash. New users start at 1000.00.';

-- =========================================================================
-- MARKETS
-- Normalized Kalshi-like prediction markets.
-- Primary key is the Kalshi ticker (text) so ingestion can upsert by ticker.
-- =========================================================================
create type public.market_status as enum ('open', 'closed', 'settled');

create table public.markets (
  id          text primary key,
  title       text not null,
  category    text,
  status      public.market_status not null default 'open',
  yes_price   integer not null check (yes_price between 0 and 100),
  no_price    integer not null check (no_price  between 0 and 100),
  expires_at  timestamptz,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

comment on table  public.markets           is 'Current snapshot of each prediction market.';
comment on column public.markets.id        is 'Kalshi ticker (e.g. FED-25DEC-T3.0).';
comment on column public.markets.yes_price is 'Current YES contract price in cents (0-100).';
comment on column public.markets.no_price  is 'Current NO  contract price in cents (0-100).';

-- =========================================================================
-- PRICE_HISTORY
-- Time series of price observations per market. Princeden writes here.
-- =========================================================================
create table public.price_history (
  id           bigserial primary key,
  market_id    text not null references public.markets(id) on delete cascade,
  yes_price    integer not null check (yes_price between 0 and 100),
  no_price     integer not null check (no_price  between 0 and 100),
  recorded_at  timestamptz not null default now()
);

create index price_history_market_recorded_idx
  on public.price_history (market_id, recorded_at desc);

comment on table public.price_history is 'Append-only time series of market price observations.';

-- =========================================================================
-- ORDERS
-- User order submissions. v1 = market orders only; limit_price reserved for v2.
-- =========================================================================
create type public.order_side   as enum ('yes', 'no');
create type public.order_action as enum ('buy', 'sell');
create type public.order_status as enum ('pending', 'filled', 'rejected');

create table public.orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id)   on delete cascade,
  market_id    text not null references public.markets(id) on delete restrict,
  side         public.order_side   not null,
  action       public.order_action not null,
  quantity     integer not null check (quantity > 0),
  limit_price  integer check (limit_price is null or limit_price between 0 and 100),
  status       public.order_status not null default 'pending',
  created_at   timestamptz not null default now()
);

create index orders_user_created_idx on public.orders (user_id, created_at desc);
create index orders_market_idx       on public.orders (market_id);

comment on table  public.orders            is 'User order submissions. v1 only supports market orders (limit_price null).';
comment on column public.orders.limit_price is 'Null for market orders. Reserved for v2 limit orders.';

-- =========================================================================
-- FILLS
-- Execution record per order. v1 = one fill per order (no partials).
-- =========================================================================
create table public.fills (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  fill_price  integer not null check (fill_price between 0 and 100),
  quantity    integer not null check (quantity > 0),
  filled_at   timestamptz not null default now()
);

create index fills_order_idx on public.fills (order_id);

comment on table public.fills is 'Execution record per filled order. v1: one row per order, no partial fills.';

-- =========================================================================
-- POSITIONS
-- Current holdings aggregated per (user, market, side).
-- Eric's fill logic writes here; unique constraint enforces one row per slot.
-- =========================================================================
create table public.positions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id)   on delete cascade,
  market_id   text not null references public.markets(id) on delete cascade,
  side        public.order_side not null,
  quantity    integer not null check (quantity >= 0),
  avg_cost    integer not null check (avg_cost between 0 and 100),
  updated_at  timestamptz not null default now(),
  unique (user_id, market_id, side)
);

create index positions_user_idx on public.positions (user_id);

comment on table  public.positions         is 'Current holdings aggregated per (user, market, side).';
comment on column public.positions.avg_cost is 'Weighted average acquisition price in cents.';

-- =========================================================================
-- TRIGGER: auto-create public.users row on auth signup
-- Every new Supabase auth user gets a matching profile with $1000 cash.
-- =========================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================================
-- TRIGGER: keep markets.updated_at fresh on upsert
-- =========================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger markets_touch_updated_at
  before update on public.markets
  for each row execute function public.touch_updated_at();

create trigger positions_touch_updated_at
  before update on public.positions
  for each row execute function public.touch_updated_at();
