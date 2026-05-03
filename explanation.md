# How It Works

## The Core Idea

Kalshi is a regulated prediction market where you can bet on binary outcomes — including live sports results like "Will the Lakers win tonight?" Prices move in response to in-game events (a score, a turnover), but there is a lag: Kalshi's market typically takes 15–60 seconds to reprice after a significant event.

This system detects those events from free public sports APIs the moment they happen — usually 1–5 seconds after the play — and places a limit order on Kalshi before the market reprices. The profit comes from closing the position after the market catches up.

This is **latency arbitrage**: not predicting outcomes, but being faster than the market at incorporating publicly available information.

---

## Architecture

```
Sports Feeds (ESPN / NBA / NFL / MLB)
         │  poll every 500ms
         ▼
     Detector
   (score changed? possession flipped?)
         │  GameEvent
         ▼
  Fair Value Estimator
   (lookup tables: how much should the price move?)
         │  FairValueResult
         ▼
       Router
   (is the edge large enough to trade?)
         │  TradeSignal
         ▼
   Kalshi Client ──────────► Supabase (event + edge log)
   (place limit order)
         │
         ▼
   Exit Manager
   (close at target price or after 60s)
```

---

## Components

### Feeds

Four parallel pollers hit free public APIs every 500ms:

- **ESPN** (`site.api.espn.com`) — covers NFL, NBA, MLB
- **NBA Official** (`cdn.nba.com`) — 1–3s fresher than ESPN for basketball
- **NFL** — ESPN's NFL endpoint with possession and down/distance data
- **MLB** (`statsapi.mlb.com`) — includes inning, outs, and baserunner bitmask

Each feed parses the response into a `GameState` object: scores, clock, period, possession, etc. The pipeline compares consecutive `GameState` snapshots for the same game to find changes.

### Detector

`detectEvents(prev, next)` compares two consecutive game states and returns a list of `GameEvent` objects:

- **SCORING_PLAY** — total score changed between snapshots
- **TURNOVER** — NFL possession changed without a score change

Each event carries both the before and after game state, which the fair value estimator needs.

### Fair Value Estimator

Uses pre-computed lookup tables (JSON files in `sports_arb/lookup_tables/`) to estimate how much the win-probability should shift given an event.

Each entry in the table maps a situation to a `delta` (signed win-probability change, expressed as a fraction of 1) and a `confidence` level. The key encodes context:

- NFL: `SCORING_PLAY:close`, `SCORING_PLAY:medium`, `SCORING_PLAY:blowout` (based on margin)
- NBA: `SCORING_PLAY:late` vs `SCORING_PLAY` (based on whether it's Q4)
- MLB: `SCORING_PLAY:late_close`, `SCORING_PLAY:late`, `SCORING_PLAY` (inning + margin)

The delta is always expressed from the home team's perspective. If the away team scored, the sign is flipped.

**Example:** NBA Q4 close game, home team scores → delta = +0.18 → if Kalshi shows 49¢, fair value = 49 + 18 = 67¢.

The lookup tables avoid the need for a live ML model: they are deterministic, fast, and easy to audit.

### Router

`evaluate(fairValue)` decides whether to trade:

1. Skip if confidence is `low`
2. Skip if the gap between fair value and market price is below `MIN_EDGE_CENTS` (default: 5¢)
3. Otherwise emit `buy_yes` (fair > market) or `buy_no` (fair < market)

`placeOrder(signal, dryRun)` sends the limit order to Kalshi. In dry-run mode it logs the order and returns a position without sending anything to the exchange.

### Kalshi Client

Plain `fetch` calls to the Kalshi REST API. Authentication uses RSA-PSS signatures: each request is signed with a timestamp + method + path + body, and the signature is sent in the `KALSHI-ACCESS-SIGNATURE` header.

Orders are placed as **limit buys** at the fair value price, so they only fill if the market is still lagging when the order arrives.

### Exit Manager

Tracks open positions and checks two exit conditions on every poll cycle:

- **Target hit** — the YES price has reached the estimated fair value (for a YES position) or fallen to it (for a NO position)
- **Hard timeout** — 60 seconds have elapsed since entry

Whichever comes first triggers a close. P&L is calculated as the price difference times the number of contracts (10 by default).

### Market Map

Resolves a game (home team + away team + sport) to a Kalshi market ticker. It fetches open markets for the relevant Kalshi series (e.g. `NBAWIN`) and matches both team abbreviations against the `event_ticker` string. Results are cached per game for the session, and the series list refreshes every 5 minutes.

---

## Database Schema

Two tables in Supabase:

**`events`** — one row per detected game event  
Records the sport, event type, description, source feed, timestamp, and the full before/after game state as JSON.

**`edge_log`** — one row per event that has a matching Kalshi market  
Records Kalshi's YES price at T+0, T+15s, T+30s, T+60s, and T+120s after the event, plus the model's estimated fair price and a simulated P&L (10 contracts × price drift at T+60s).

This data feeds the observation phase: after 2–4 weeks you can query hit rates, average drift, and simulated returns by sport and event type to validate the model before trading real money.

---

## Why This Works (and When It Doesn't)

**Works when:**
- A meaningful event happens (score, turnover) in a live game with an active Kalshi market
- Kalshi's market is slow to reprice (the 15–60s lag is the edge)
- The model's delta estimate is in the right direction

**Doesn't work when:**
- No live games or no matching Kalshi markets
- Kalshi reprices faster than the feed detects the event
- The lookup table delta is wrong for an unusual game situation
- Another participant beats you to the same trade (the order fills at a worse price)

The observation phase exists specifically to measure how often the model is right and whether the edge exceeds transaction costs before committing capital.

---

## Phase 1 status

The pipeline now runs Phase 1 (paper trading with realistic friction) end to end:

- **Slippage is modelled.** Entries pay `yes_ask` (or `100 - yes_bid` for NO);
  exits sell at `yes_bid` (or `100 - yes_ask`). The router refuses signals whose
  edge is already eaten by the cross-spread cost.
- **Multiple positions per market are supported.** Each open position has a
  unique id; back-to-back signals on the same ticker no longer overwrite each
  other.
- **Fair value attenuates near the buzzer.** A bucket with eight seconds left
  in Q4 is no longer treated like a bucket with six minutes left, and 1-point
  free throws are scaled relative to 2- and 3-point buckets.
- **Feeds back off on network failure.** A dead connection produces one error
  line plus exponential backoff up to 30 seconds, instead of a 500ms retry
  storm.
- **Every action is journaled.** A JSON-lines file (`logs/paper-*.jsonl`)
  records every event, signal, fill, and exit so P&L can be recomputed offline.

Sim mode (`npm run sim`) closes three scripted scenarios at +330¢ realised
under a 2¢ spread — Phase 1's exit criterion (positive simulated P&L after
realistic slippage) is met on the canned data.

What's still deferred for Phase 2:
- Persistence into the Supabase `orders`/`fills`/`positions` tables on the
  database branch. The JSONL journal is the durable record for now.
- Liquidity-aware sizing — `MAX_QUANTITY` is still a flat configuration knob.
- Detection of non-scoring events (NBA ejections, MLB pitching changes,
  injury news from Twitter/X).
