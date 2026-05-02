-- Sports latency-arb tables for Phase 0 (observation) and Phase 1 (paper trading).
-- Builds on top of the existing markets / price_history schema.

-- =========================================================================
-- EVENTS
-- Every game event detected by the fast feed, timestamped at detection.
-- =========================================================================
create type public.sport_type as enum ('NFL', 'NBA', 'MLB', 'SOCCER', 'TENNIS');

create type public.event_type as enum (
  'SCORING_PLAY',
  'TURNOVER',
  'INJURY',
  'EJECTION',
  'PITCHING_CHANGE',
  'WEATHER_DELAY'
);

create table public.events (
  id            bigserial primary key,
  market_id     text,   -- Kalshi ticker; plain text so inserts never block on a missing markets row
  game_id       text not null,
  sport         public.sport_type not null,
  event_type    public.event_type not null,
  description   text,
  source        text not null,           -- 'espn', 'nba-official', etc.
  detected_at   timestamptz not null default now(),
  payload_json  jsonb                    -- raw prev/next state snapshot
);

create index events_game_detected_idx  on public.events (game_id, detected_at desc);
create index events_market_idx         on public.events (market_id);
create index events_sport_type_idx     on public.events (sport, event_type);

comment on table  public.events              is 'Game events detected by the fast feed during Phase 0/1 observation.';
comment on column public.events.detected_at  is 'Wall-clock time our system first saw the event — used for latency measurement.';
comment on column public.events.payload_json is 'Full prev/next GameState snapshot for post-hoc analysis.';

-- =========================================================================
-- EDGE_LOG
-- Per-event price snapshots: Kalshi price at detection + follow-up readings.
-- Used in Phase 0 to measure whether the crowd actually reprices late.
-- =========================================================================
create table public.edge_log (
  id                    bigserial primary key,
  event_id              bigint not null references public.events(id) on delete cascade,
  kalshi_price_at_t0    integer check (kalshi_price_at_t0  between 0 and 100),
  kalshi_price_at_t15s  integer check (kalshi_price_at_t15s between 0 and 100),
  kalshi_price_at_t30s  integer check (kalshi_price_at_t30s between 0 and 100),
  kalshi_price_at_t60s  integer check (kalshi_price_at_t60s between 0 and 100),
  kalshi_price_at_t120s integer check (kalshi_price_at_t120s between 0 and 100),
  estimated_fair_price  integer check (estimated_fair_price between 0 and 100),
  simulated_pnl_cents   numeric(8, 2),  -- realized edge if we'd traded, in cents
  recorded_at           timestamptz not null default now()
);

create index edge_log_event_idx on public.edge_log (event_id);

comment on table  public.edge_log                    is 'Kalshi price path per event: Phase 0 edge measurement.';
comment on column public.edge_log.kalshi_price_at_t0 is 'Kalshi price snapshot taken immediately at event detection (cents).';
comment on column public.edge_log.simulated_pnl_cents is 'Hypothetical P&L: (t60s - t0) * qty, before slippage. Null until t60s row is filled.';
