-- Minimal markets table required by 0004_sports_arb.sql.
-- Replace with your real schema when building the full market-tracking layer.
create table if not exists public.markets (
  id          text primary key,   -- Kalshi ticker, e.g. 'NBAWIN-25-BOS-IND'
  title       text,
  created_at  timestamptz not null default now()
);
