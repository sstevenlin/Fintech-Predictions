-- Seed data for local dev (Ticket 2)
-- Applied by `supabase db reset`. Safe to re-run: all inserts are idempotent.
-- Markets only — users/orders/fills/positions are created via the app flow
-- so the signup trigger and order logic are exercised end-to-end.

-- =========================================================================
-- MARKETS (~10 covering different categories + statuses)
-- =========================================================================
insert into public.markets (id, title, category, status, yes_price, no_price, expires_at) values
  ('FED-DEC25-CUT',  'Will the Fed cut rates at the December 2025 meeting?',  'economics', 'open',   82, 18, '2025-12-18T19:00:00Z'),
  ('SPX-YE25-GT6K',  'Will the S&P 500 close above 6000 by end of 2025?',      'markets',   'open',   35, 65, '2025-12-31T21:00:00Z'),
  ('BTC-YE25-GT100', 'Will Bitcoin close above $100k by end of 2025?',         'crypto',    'open',   58, 42, '2025-12-31T23:59:00Z'),
  ('ETH-JAN26-3K',   'Will ETH close above $3000 on Jan 31, 2026?',            'crypto',    'open',   47, 53, '2026-01-31T23:59:00Z'),
  ('NFL-SB26-KC',    'Will the Chiefs win Super Bowl LX?',                     'sports',    'open',   22, 78, '2026-02-08T23:00:00Z'),
  ('OSCARS26-BEST',  'Will Oppenheimer 2 win Best Picture at the 2026 Oscars?','entertainment','open', 14, 86, '2026-03-15T04:00:00Z'),
  ('CPI-JAN26-LT3',  'Will January 2026 CPI print below 3.0% YoY?',            'economics', 'open',   61, 39, '2026-02-14T13:30:00Z'),
  ('GDP-Q4-POS',     'Will Q4 2025 US GDP growth be positive?',                'economics', 'closed', 92,  8, '2026-01-30T13:30:00Z'),
  ('ELECT-UK26',     'Will UK hold a general election before July 2026?',      'politics',  'open',   28, 72, '2026-07-01T00:00:00Z'),
  ('WEATHER-NYC26',  'Will NYC see >40in of snow in winter 2025-2026?',        'weather',   'settled', 0,100, '2026-03-20T00:00:00Z')
on conflict (id) do nothing;

-- =========================================================================
-- PRICE_HISTORY (a handful of observations per open market, ~hourly backfill)
-- =========================================================================
insert into public.price_history (market_id, yes_price, no_price, recorded_at) values
  ('FED-DEC25-CUT',  78, 22, now() - interval '6 hours'),
  ('FED-DEC25-CUT',  80, 20, now() - interval '4 hours'),
  ('FED-DEC25-CUT',  81, 19, now() - interval '2 hours'),
  ('FED-DEC25-CUT',  82, 18, now()),
  ('BTC-YE25-GT100', 55, 45, now() - interval '6 hours'),
  ('BTC-YE25-GT100', 57, 43, now() - interval '3 hours'),
  ('BTC-YE25-GT100', 58, 42, now()),
  ('SPX-YE25-GT6K',  32, 68, now() - interval '5 hours'),
  ('SPX-YE25-GT6K',  35, 65, now());

-- =========================================================================
-- NOTE: user / order / fill / position seeds are intentionally omitted.
-- To create realistic demo data, sign up a test user via the app and place
-- orders through the normal flow. This exercises:
--   * the on_auth_user_created trigger (cash_balance = 1000.00)
--   * Eric's order/fill logic (once implemented)
-- Seeding these directly would require fabricating auth.users rows, which
-- diverges from production behavior.
-- =========================================================================
