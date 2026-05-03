# Sports Latency-Arbitrage on Kalshi — Technical Design

> Audience: software engineers and quants who want to understand how this
> system works end-to-end, including its modeling assumptions and the things
> that are still wrong.

This is the `sports_implementation` branch of the `Fintech-Predictions` repo.
Code lives in `sports_arb/`, observation tooling in `observation/`,
infrastructure in `supabase/`, and TypeScript scaffolding (`tsconfig.json`,
`jest.config.js`, `package.json`) at the root. The strategy plan that motivates
this code is `plan.md` on `main`; the implementation plan and progress notes
have been folded into this document.

---

## 1. The Edge in One Paragraph

Kalshi runs a CFTC-regulated binary-outcome market on, among many other things,
sports results. Casual users price these contracts off whatever feed they
happen to be watching — typically a streaming broadcast that lags the actual
game by 30–60 seconds. Fast public sports APIs (ESPN, league-official feeds)
update within 1–5 seconds of the play. The **strategy** is to detect a
high-impact in-game event from the fast feed, estimate its effect on win
probability before the broadcast crowd sees the play, take a position at the
stale Kalshi price, and exit once the crowd has caught up. Holding period is
seconds to minutes; we never hold to resolution.

This is **latency arbitrage on public information**, not insider trading and
not "frontrunning" in the legal sense. The edge is real to the extent that:
(a) the per-event win-probability shift is non-trivial; (b) Kalshi's market
takes meaningfully longer than our pipeline to incorporate it; and (c) the
spread plus our cost to cross it is smaller than the predicted move.

---

## 2. End-to-End Architecture

```
              ┌──────────────────────────────────────────┐
              │           Live sports feeds              │
              │  ┌────────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
              │  │ ESPN   │ │ NBA │ │ NFL │ │ MLB │      │   poll @ ~500ms
              │  └───┬────┘ └──┬──┘ └──┬──┘ └──┬──┘      │   each in its own
              │      │  fan-in via runPollLoop          │   backoff loop
              └──────┼───────────────────────────────────┘
                     │  GameState[]
                     ▼
              ┌─────────────────┐
              │ detector.ts     │  state diff → GameEvent
              └───────┬─────────┘
                      │
                      ▼
              ┌─────────────────┐    ┌──────────────────────────┐
              │ market_map.ts   │ ←─ │  Kalshi /markets list    │
              │ (resolveTicker) │    │  (5-min cache per series)│
              └───────┬─────────┘    └──────────────────────────┘
                      │  ResolvedMarket {ticker, contractType, side, quote}
                      ▼
              ┌─────────────────┐
              │ fair_value.ts   │  lookup table × Δscore × clock × contractType
              └───────┬─────────┘
                      │  FairValueResult
                      ▼
              ┌─────────────────┐
              │ router.ts       │  edge ≥ MIN_EDGE_CENTS after slippage?
              └───────┬─────────┘
                      │  TradeSignal + entry fill at ask (or 100−bid)
                      ▼
              ┌─────────────────┐    ┌──────────────────────────┐
              │ exit_manager.ts │    │  trade_journal.ts        │
              │ id-keyed positions   │  events / signals /      │
              │ shouldExit()        ─┼─►   opens / exits / skips │
              │ exitFillPrice()      │  → logs/paper-*.jsonl    │
              └───────┬─────────┘    └──────────────────────────┘
                      │  ClosedPosition w/ realized P&L
                      ▼
              ┌─────────────────┐
              │ pipeline.ts     │  human log + JSONL journal +
              │                 │   shutdown summary
              └─────────────────┘
```

There are three executable entry points, all routed through `pipeline.ts`:

- `npm run sim` — scripted scenarios, no network. Used to verify wiring.
- `npm run paper` — live feeds + live Kalshi quotes; `--dry-run` is the default,
  so no real orders are sent.
- `npm run observe` — live feeds + Kalshi prices; writes `events`/`edge_log`
  rows to Supabase for offline analysis (Phase 0).

`npm run replay` reads the JSONL journal that paper mode writes and reports
realized P&L, hit rate, and slippage.

---

## 3. Data Sources

### 3.1 In-game feeds

| Tier | Source | Latency | Auth |
|------|--------|---------|------|
| S | League-official (`cdn.nba.com`, `statsapi.mlb.com`) | 1–3 s | none |
| B | ESPN (`site.api.espn.com`) | 3–10 s | none, soft User-Agent |
| C | Twitter/X insiders (Schefter, Wojnarowski) | variable | scraping |
| Z | Streaming broadcast | 30–60+ s | — (this is what we beat) |

The pipeline runs four feeds in parallel (`EspnFeed`, `NbaFeed`, `NflFeed`,
`MlbFeed`). Each implements a small interface:

```ts
interface Feed {
  readonly name: string;
  poll(): Promise<GameState[]>;          // throws on transport failure
  start(intervalMs, onUpdate): void;
  stop(): void;
}
```

`runPollLoop` in `feeds/base.ts` calls `poll()` on a setTimeout chain. On
failure, it tracks consecutive errors and applies exponential backoff capped
at 30 seconds, suppressing log spam after the first error per failure run.
Recovery emits a single `recovered after Nx failures` line.

**Heads-up:** during the first paper run on 2026-05-02 the network briefly
dropped at 02:14 ET and the *previous* code retried 4-feeds × 500ms forever,
producing thousands of error lines in seconds. `runPollLoop` is the fix and
is shared by all four feeds now.

### 3.2 Kalshi market data

`kalshi_client.ts` talks to `api.elections.kalshi.com/trade-api/v2`:

- `getMarketQuote(ticker)` — full YES-side quote `{yesBid, yesAsk, yesMid, last}`
  in cents. Used everywhere realistic fill prices matter.
- `getMarketPrice(ticker)` — thin wrapper returning the mid only.
- `listMarkets(seriesTicker)` — bulk-fetch open markets in a series.
- `placeOrder(...)` — RSA-PSS-signed real order. Only invoked when
  `DRY_RUN=false`.

The response format flipped to dollar-denominated strings
(`yes_bid_dollars: "0.4900"`) sometime in late 2025; the parser tolerates both
the new and legacy integer fields.

---

## 4. Game-State Detection

`GameState` is the canonical per-game snapshot:

```ts
interface GameState {
  gameId, sport, homeTeam, awayTeam: string;
  homeScore, awayScore, period: number;
  clock: string | null;       // "9:32" or ISO 8601 "PT04M32.00S"
  possession?: string;        // NFL only
  down?, yardsToGo?: number;  // NFL only
  outs?, basesOccupied?: number; // MLB; basesOccupied is a 3-bit mask
  recordedAt: ISO timestamp;
}
```

Each feed parses its raw JSON into `GameState[]` for *only the games currently
in progress*. The pipeline holds a `Map<gameId, GameState>` of the latest seen
state and runs `detectEvents(prev, next)` on each update.

`detector.ts` only fires two event types today:

| EventType | Condition |
|-----------|-----------|
| `SCORING_PLAY` | total score changed (any positive Δ) |
| `TURNOVER`     | NFL only — `possession` flipped without a score change |

That's a deliberately narrow set. NBA ejections, MLB pitching changes, soccer
red cards, and injury news are **not detected today** — they're listed in
`plan.md §10` as deferred.

---

## 5. Market Resolution (`market_map.ts`)

Mapping an in-progress game to its Kalshi market is harder than it looks
because Kalshi has multiple ticker conventions for the same game (per-game
moneyline, series-winner, half-spread, quarter-winner, etc.) and tickers
encode team codes with no delimiters.

### 5.1 Series whitelist

```ts
NBA: [{KXNBAGAME, per_game}, {KXNBASERIES, series_winner}]
NFL: [{KXNFLGAME, per_game}]
MLB: [{KXMLBGAME, per_game}]
```

The list is in priority order. Per-game moneylines win when both contract
types match; series-winner is the playoff fallback when no per-game contract
exists (e.g. mid-series Game 7 was the only PHI@BOS market available on
2026-05-02).

### 5.2 Resolution algorithm

For each event the pipeline calls
`resolveKalshiTicker(gameId, home, away, sport)`. The function:

1. Fetches all open markets in the sport's whitelisted series, cached for
   5 minutes per series.
2. Filters to events whose **team segment** of `event_ticker` contains both
   the home and away tricodes. The team segment is the part *after* the
   series prefix and *before* a trailing round indicator
   (`KXNBASERIES-26PHIBOSR1` → team segment `26PHIBOS`).
3. For each candidate event, parses the `yes_bid_dollars` / `yes_ask_dollars`
   into a snapshot quote.
4. Drops markets with missing bid or ask, or spread > `MAX_SPREAD_CENTS`
   (default 10).
5. Reads the **side suffix** of the ticker (`KXNBASERIES-26PHIBOSR1-PHI` →
   side suffix `PHI`) and tags each candidate as `home` or `away`. Anything
   whose suffix doesn't match either team is dropped — better to skip than
   guess.
6. Sorts by side (home first), then by contract type (per-game first), then
   by spread (tightest first), and returns the winner along with its quote.

The result is a `ResolvedMarket`:

```ts
{ ticker, eventTicker, contractType, side, spreadCents, yesBid, yesAsk, yesMid }
```

The pipeline caches the resolution per `gameId` so subsequent events on the
same game reuse the same ticker without scanning the entire series list.

### 5.3 Why the home-side preference matters

The lookup-table deltas are written from the home team's perspective: a
positive delta means home-team win probability went up. Routing the trade to
the home-side YES contract makes that delta apply directly. If we land on the
away side, the delta has to flip — the pipeline does this via the
`homeIsYes=false` path through `estimateFairValue`. Either is correct, but
having a single canonical orientation keeps the math auditable.

---

## 6. Fair-Value Model

`fair_value.ts` returns a target fair price given a `GameEvent`, the current
Kalshi mid, the contract type, and which side is YES. It is intentionally
simple — a lookup table multiplied by deterministic scaling factors. There is
no live ML model.

### 6.1 Lookup tables

`sports_arb/lookup_tables/{nfl,nba,mlb}.json` — entries per sport × event type
× game state:

```json
"NBA SCORING_PLAY:late":   { "delta": 0.18, "confidence": "high" },
"NBA SCORING_PLAY":        { "delta": 0.06, "confidence": "medium" },
"NFL SCORING_PLAY:close":  { "delta": 0.25, "confidence": "high" },
"NFL TURNOVER":            { "delta": 0.12, "confidence": "medium" },
"MLB SCORING_PLAY:late_close": { "delta": 0.22, "confidence": "high" }
```

`buildLookupKey(event)` picks the more specific key when game state qualifies
(NBA: Q4 → `:late`; NFL: margin ≤ 7 → `:close`; MLB: inning ≥ 7 + margin ≤ 2 →
`:late_close`).

The numerical deltas are hand-picked from public win-probability literature
(nflfastR, pbpstats, MLB leverage index). They are *not* fitted to historical
Kalshi prices. They reflect roughly how much win probability moves on the
event under typical conditions, which is what we want as a first
approximation.

### 6.2 Scaling factors

Raw lookup deltas would over-fire. The model multiplies the signed delta by:

| Factor | Range | Purpose |
|--------|-------|---------|
| `pointsScale(prev, next)` | ~0.4–2.0 | 1-pt FT vs 2-pt vs 3-pt vs multi-point bundles |
| `clockDecay(sport, state)` | 0.05–1.0 | NBA/NFL Q4 only — full strength > 5 min, decays linearly to 0.05 at the buzzer |
| `contractTypeScale(ct)` | 0.5 or 1.0 | per_game = 1.0; series_winner = 0.5 |

`pointsScale` keeps a free throw from triggering the same +18pp delta as a
Q4 three-pointer. `clockDecay` keeps a garbage-time bucket with eight seconds
left from triggering anything material. `contractTypeScale` is the
acknowledgement that a single-game outcome only partially updates a
multi-game series winner — the 0.5 default is conservative because we don't
know how many games remain in the series without scraping additional data.

When the combined scale is heavy enough, the result's `confidence` field is
demoted (high → medium → low) so the router can pass on it.

### 6.3 Worked example

PHI scores 3 in Q4 with 4:30 left, BOS series-winner contract on the BOS
(home-loss) side at 21¢:

- away team scored → home-perspective delta is negative
- `:late` table entry for NBA: delta = +0.18, confidence high
- `pointsScale(3pt) = 1.4`
- `clockDecay(NBA, 4:30 in Q4)` → seconds=270 → `0.05 + 270/300 × 0.95 ≈ 0.905`
- `contractTypeScale(series_winner) = 0.5`
- signed delta = `-0.18 × 1.4 × 0.905 × 0.5 ≈ -0.114` → `-11.4 pp`
- fair = `21 + (-0.114 × 100) = 9.6c → clamp to [1, 99] → 10c`

The router compares the 21¢ market to a 10¢ fair, sees an 11¢ gap (above the
5¢ threshold), and emits `buy_no` BOS — i.e. bet against Boston winning the
series, profiting if the price drops toward 10¢. With the home preference
hitting the BOS side and the contract-type halving, the math accounts for
the fact we're trading a series ticker, not a per-game contract.

---

## 7. Routing & Slippage (`router.ts`)

Two functions:

- `evaluate(fv)` — produces `buy_yes`, `buy_no`, or `pass` based on
  `MIN_EDGE_CENTS` and confidence.
- `placeOrder(signal, dryRun, quote)` — opens the position with realistic
  cross-the-spread fill prices. In `dryRun`, no Kalshi call is made; the
  `OpenPosition` is returned for the exit manager to track.

### 7.1 Cross-the-spread fills

The realistic cost to enter:

| side | entry fill | exit fill |
|------|------------|-----------|
| `yes` | `yes_ask`             | `yes_bid` |
| `no`  | `100 − yes_bid`       | `100 − yes_ask` |

Both are denominated in the side's own "buy this contract for X cents"
currency, so P&L for both sides is `(exitFill − entryFill) × qty` with no
sign-flipping.

The router rejects any signal where the cost-to-cross has already eaten the
post-event edge:

```ts
expectedEdge = targetSideExitPrice − entryFillPrice
if expectedEdge < MIN_EDGE_CENTS: pass
```

This is the most direct check that "P&L positive after realistic slippage"
is even possible for a given trade. The Phase 1 exit criterion in the strategy
plan is exactly that — and the router enforces it pre-fire instead of letting
the position open and lose.

### 7.2 Position lifetime

`exit_manager.ts` keeps positions in a `Map<id, OpenPosition>` (id-keyed, not
ticker-keyed — see §10.1). On each pipeline cycle:

```ts
for pos in exitManager.all():
  quote = fetchQuoteCached(pos.kalshiTicker)
  decision = shouldExit(pos, quote.yesMid)
  if decision.exit:
    exitFill = exitFillPrice(pos.side, quote)
    pnl = realizedPnlCents(pos.side, pos.entryFillPrice, exitFill, pos.quantity)
    record + remove
```

`shouldExit` returns `'target'` if the YES mid has crossed `targetYesMid`
(in the right direction for the side), or `'timeout'` after `HOLD_DURATION_MS`
(60 s). Whichever comes first.

---

## 8. Persistence: JSONL Journal & Supabase

### 8.1 Paper-mode JSONL (Phase 1)

`trade_journal.ts` opens an append-only `logs/paper-<timestamp>.jsonl`
alongside the human-readable log. Records are one JSON object per line with
shapes:

```
{kind: "event",  sport, gameId, eventType, description, period, clock, ...}
{kind: "signal", action, ticker, currentYesMid, estimatedFair, confidence, ...}
{kind: "open",   id, ticker, side, quantity, entryFillPrice, entryYesMid,
                 entryQuote, targetYesMid, enteredAt, hardExitAt}
{kind: "exit",   id, ticker, side, reason, holdMs, entryFillPrice,
                 exitFillPrice, exitYesMid, exitQuote, quantity, pnlCents}
{kind: "skip",   ticker, reason, ...}
```

This is the durable record. P&L can be recomputed from the journal alone — no
DB connection, no live network. `npm run replay` (in `observation/replay.ts`)
reads any `.jsonl` you point it at and prints the realized total, win/loss
breakdown, target-vs-timeout split, median hold time, average entry slippage,
and a per-series breakdown.

### 8.2 Observation-mode Supabase (Phase 0)

The `observation/run.ts` flow writes to two Supabase tables defined by
`supabase/migrations/0004_sports_arb.sql`:

- `events` — every detected event, with prev/next state snapshot in
  `payload_json`.
- `edge_log` — Kalshi YES mid at T+0 / +15s / +30s / +60s / +120s plus the
  estimated fair price; `simulated_pnl_cents = (t60 − t0) × 10` is computed
  when the t60 row lands.

`observation/analyzer.ts` aggregates `edge_log` across many runs to produce
hit-rate and avg-drift stats per sport/event type. This is the data that
*should* gate any move to live trading.

### 8.3 Deferred: orders / fills / positions

The strategy plan also calls for paper trades to land in the `orders`,
`fills`, and `positions` tables that exist on the `database` branch. That
table set carries an `auth.users` foreign-key dependency that hasn't been
merged into `sports_implementation`. For Phase 1 the JSONL journal is the
record of truth; bringing the database tables in is queued for Phase 2.

---

## 9. Validation

Phase 1's exit criterion in `plan.md` is:

> Simulated P&L positive after realistic slippage assumptions.

The `npm run sim` scenarios run that gauntlet with deterministic data:

```
NBA Q4 6:10 BOS scores       buy_yes  fill 50→63   +130c
NFL Q4 4:30 turnover          buy_no   fill 51→58   +70c
MLB bot-8 walk-off            buy_yes  fill 51→64   +130c (target hit)
NBA series-winner scoring     buy_yes  fill 50→55   +50c   (delta halved)
                                                    ─────
                                                    +380c
```

These are scripted: they prove the wiring is consistent and the slippage math
balances, *not* that the live edge is real.

The live evidence so far is one paper run against PHI@BOS Game 7
(2026-05-02, in `logs/paper-*.log` from the previous commit). On the now-
fixed code path that run would have looked materially different — the
ExitManager overwrite bug erased ~19 of 35 positions before they could exit,
and the model fired full +18pp deltas on garbage-time free throws. The next
live run, captured in JSONL, will be the real test.

The replay analyzer is what extracts the bar-passing evidence:

```
$ npm run replay
── PAPER-TRADE JOURNAL ──
records: 1234  events: 41  signals: 41  opens: 35  exits: 16
positions opened but not exited (stranded): 19   ← was 19 before fix; should be ≤ N+open
overall: realized=+190c  closed=16  wins=8  losses=4  hit-rate=50.0%
exits:   target=1   timeout=15   median-hold=60.0s   avg-entry-slippage=1.5c
by series: KXNBASERIES  16  8  4  +190c  50.0%  60.0s
```

The aggregate the project actually needs is the same shape across many runs
across many games. That's still ahead of us.

---

## 10. Known Pitfalls and What's Still Wrong

These are written down so the next person doesn't have to relearn them.

### 10.1 Bugs already fixed in this branch

- **ExitManager overwrite.** The position map used to be keyed by ticker.
  Two signals on the same market in succession dropped the older position
  on the floor. Now keyed by id; multiple concurrent positions per ticker
  are first-class. Live evidence: 19 of 35 positions vanished mid-flight on
  the 2026-05-02 PHI@BOS run.
- **Mid-price fills, no slippage cost.** Old code computed P&L as
  `(exitMid − entryMid) × qty`, ignoring the spread we have to cross both
  ways. Now `entryFillPrice` and `exitFillPrice` are bid/ask-aware.
- **Kalshi base URL was dead.** `trading-api.kalshi.com` redirects (302) to
  `api.elections.kalshi.com`. Old client never followed the redirect; every
  price read returned `null` silently.
- **Series tickers wrong.** `NBAWIN`/`NFLWIN`/`MLBWIN` aren't Kalshi series
  any more. Replaced with `KXNBAGAME`/`KXNFLGAME`/`KXMLBGAME` plus
  `KXNBASERIES` as a playoff fallback.
- **Substring market match.** Whole-ticker `includes(home) && includes(away)`
  could pick up false positives (`LA` substring in `LAL`). Now matches
  against the parsed team segment and re-validates via the side suffix.
- **No backoff on network failure.** The previous run produced ~40
  fetch-failure log lines per second once the network blipped. Now one error
  per failure run plus exponential backoff capped at 30 s.

### 10.2 Modeling defects we know about

- **Lookup deltas are not fitted.** They reflect public-WP-model intuition,
  not Kalshi-specific behavior. Once we have a few weeks of `edge_log` data,
  these tables should be replaced (or augmented) with empirical deltas
  conditioned on Kalshi's own price-path.
- **`contractTypeScale` is a flat 0.5.** A real series-winner derivative
  depends on games remaining and current score; we don't pull series state.
  Consequence: fair-value moves on series tickers are still rough.
- **Detector fires only `SCORING_PLAY` and NFL `TURNOVER`.** No NBA ejections,
  MLB pitching changes, weather delays, or injury news. The plan calls these
  out — they're Phase 2 work.
- **Multi-point bundles get a single event.** NBA feeds occasionally jump
  +3 in a single update (a 3-pointer + the and-one shows up at once).
  `pointsScale` scales the delta linearly above 2 points, which is a fine
  approximation, but treating two real plays as one event still misclassifies
  the lookup key (the second event's pre-state isn't the same as the first's).
- **Clock parsing trusts the feed.** ESPN occasionally returns a stale clock
  for several polls in a row — we treat each poll as fresh. A stale-clock
  detector belongs in `EspnFeed.poll`.
- **No fill probability or market impact.** Paper trading assumes our limit
  at the ask always fills in full. On thin Kalshi books, a 10-contract order
  would partial-fill or walk the book. Phase 2 needs to model this.
- **No tournament-deciding-game adjustment.** Game 7 of a series should get
  `contractTypeScale(per_game) ≈ 1.0` even on a series ticker because the
  series outcome IS the game outcome. We don't currently distinguish
  Game 7 from Game 1.

### 10.3 Operational

- **No persistence of paper trades to Supabase yet.** JSONL only.
- **No alerting.** Pipeline silently drops events when the resolver finds no
  market. We log a `skip` record but don't surface it operationally.
- **No graceful Windows shutdown handler.** SIGINT works on Linux/Mac; on
  Windows the handler may not fire reliably under all PowerShell modes.

---

## 11. Repository Layout

```
sports_arb/
  pipeline.ts          ─ entry point. live + sim + dry-run.
  sim.ts               ─ scripted scenarios for regression.
  detector.ts          ─ GameState diff → GameEvent[].
  fair_value.ts        ─ lookup × pointsScale × clockDecay × contractScale.
  router.ts            ─ evaluate(fv) and placeOrder(signal, dryRun, quote).
  exit_manager.ts      ─ id-keyed positions; shouldExit; realizedPnlCents.
  market_map.ts        ─ Kalshi market resolution + liquidity filter.
  kalshi_client.ts     ─ getMarketQuote / listMarkets / placeOrder.
  feeds/
    base.ts            ─ Feed interface + runPollLoop with backoff.
    espn.ts            ─ NBA/NFL/MLB scoreboard via ESPN public CDN.
    nba.ts             ─ cdn.nba.com fast scoreboard.
    nfl.ts             ─ ESPN-NFL with possession/down/distance.
    mlb.ts             ─ statsapi.mlb.com schedule + linescore.
  lookup_tables/
    nfl.json nba.json mlb.json
  trade_journal.ts     ─ append-only JSONL of every event/signal/open/exit/skip.
  file_logger.ts       ─ mirror console.{log,warn,error} to logs/paper-*.log.
  types.ts             ─ GameState, GameEvent, FairValueResult, OpenPosition,
                         ClosedPosition, KalshiQuote.
  sports_arb.test.ts   ─ jest unit tests (20 currently).

observation/
  run.ts               ─ Phase 0 observer: events + edge_log to Supabase.
  logger.ts            ─ Supabase row writers.
  analyzer.ts          ─ aggregate edge_log into per-sport hit-rate report.
  replay.ts            ─ NEW. read paper-*.jsonl, print realized P&L summary.

supabase/
  config.toml          ─ local CLI config (Docker postgres, ports 54321-4).
  migrations/
    0001_init.sql      ─ users, markets, price_history, orders, fills,
                          positions tables.
    0002_harden_functions.sql   ─ pin search_path on touch_updated_at.
    0003_enable_rls.sql         ─ enable RLS on the public tables.
    0004_sports_arb.sql         ─ events + edge_log for the sports work.
  seed.sql             ─ 10 sample markets + 9 price observations.

backend/
  utils/logger.py      ─ unrelated, was on the branch before.

instructions.md        ─ user-facing run book for sim/paper/observe/live.
explanation.md         ─ how the system works + Phase 1 status.
presentation.md        ─ talk track.
plan.md                ─ original strategy document (now superseded by this file
                         for technical detail).
PROJECT.md             ─ THIS DOCUMENT.
```

---

## 12. How to Reproduce

```bash
# install
npm install

# verify
npm run typecheck
npm test                 # 20 jest tests
npm run sim              # scripted: closes 4/4 wins for +380c

# go live (paper, no money at risk)
cp .env.example .env     # only KALSHI/SUPABASE entries needed for live data
npm run paper            # ts-node sports_arb/pipeline.ts --dry-run

# read the resulting journal
npm run replay
# or: npm run replay -- logs/paper-2026-05-03Txx-xx.jsonl
```

To send real orders, set `DRY_RUN=false`, ensure `KALSHI_API_KEY` and
`KALSHI_API_SECRET` (path to RSA-PSS PEM) are populated, and run
`npm run paper` again. Read §10 first.
