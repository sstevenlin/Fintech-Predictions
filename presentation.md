<!--
Slide deck. Slides are separated by `---`. Compatible with Marp, Slidev,
reveal-md, or pandoc -t revealjs. Each slide is intentionally terse so
it reads as a slide, but together they preserve the full technical detail
of the project.
-->

# Sports Latency-Arbitrage on Kalshi

A walking tour of the `sports_implementation` branch.

Audience: engineers and quants who want the full design, not the pitch.

---

# The Edge in One Paragraph

Kalshi runs CFTC-regulated binary markets, including live sports.
Casual users price contracts off **broadcast video, lagged 30–60 s**.
Public APIs (ESPN, league-official) update within **1–5 s** of the play.

We:

1. Detect the event from the fast feed.
2. Estimate its impact on win probability before the crowd repaints.
3. Take a position at the stale Kalshi price.
4. Exit once the crowd has caught up — seconds to a minute later.

It's **latency arbitrage on public information**, not insider trading
and not "frontrunning" in the legal sense.

---

# End-to-End Architecture

```
   ESPN  NBA  NFL  MLB  ─┐  poll @ ~500ms each, with backoff
                         │
                         ▼
                  detector.ts            (state diff → GameEvent)
                         │
                         ▼
              market_map.ts ←── Kalshi /markets list (5-min cache)
                         │
                         ▼   ResolvedMarket {ticker, contractType,
                  fair_value.ts            side, snapshot quote}
                         │
                         ▼   FairValueResult
                  router.ts               (edge ≥ MIN_EDGE_CENTS
                         │                 after slippage?)
                         ▼   TradeSignal + entry fill at ask
                exit_manager.ts ──→ trade_journal.ts
                  id-keyed positions       events / signals /
                  shouldExit()             opens / exits / skips
                  exitFillPrice()          → logs/paper-*.jsonl
                         │
                         ▼   ClosedPosition w/ realized P&L
                  pipeline.ts (human log + JSONL + summary)
```

---

# Three Entry Points

All routed through `pipeline.ts`:

| Command | Mode |
|---|---|
| `npm run sim`     | scripted scenarios, no network. Wiring + math regression. |
| `npm run paper`   | live feeds + live Kalshi quotes. `--dry-run` default — no real orders. |
| `npm run observe` | live feeds, prices to Supabase `events` / `edge_log` (Phase 0). |
| `npm run replay`  | offline JSONL summary — realized P&L, hit rate, slippage. |

---

# Data Sources — In-Game Feeds

| Tier | Source | Latency | Auth |
|------|--------|---------|------|
| S | `cdn.nba.com`, `statsapi.mlb.com`        | 1–3 s | none |
| B | `site.api.espn.com`                       | 3–10 s | soft User-Agent |
| C | Twitter/X insiders (Schefter, Wojnarowski) | variable | scraping |
| Z | Streaming broadcast                       | 30–60+ s | this is what we beat |

Pipeline runs four feeds in parallel:
`EspnFeed`, `NbaFeed`, `NflFeed`, `MlbFeed`.

---

# Feed Interface

```ts
interface Feed {
  readonly name: string;
  poll(): Promise<GameState[]>;          // throws on transport failure
  start(intervalMs, onUpdate): void;
  stop(): void;
}
```

Each feed parses its raw JSON into `GameState[]` for **only the games
currently in progress**.

The shared `runPollLoop` in `feeds/base.ts` calls `poll()` on a
`setTimeout` chain.

---

# The Backoff Loop (Why It Exists)

Live test, 2026-05-02, 02:14 ET:
network briefly dropped → previous code retried 4 feeds × 500 ms forever
→ thousands of error lines per second.

Fix:

- Track consecutive failures per feed.
- Suppress log spam after the first error in a failure run.
- Exponential backoff capped at 30 s.
- One `recovered after Nx failures` line on first success.

Lives in `feeds/base.ts`, shared by all four feeds.

---

# Kalshi Client

`api.elections.kalshi.com/trade-api/v2`:

| Function | Purpose |
|---|---|
| `getMarketQuote(ticker)`  | full YES quote `{yesBid, yesAsk, yesMid, last}` |
| `getMarketPrice(ticker)`  | mid only — thin wrapper |
| `listMarkets(seriesTicker)` | bulk-fetch open markets |
| `placeOrder(...)`         | RSA-PSS-signed real order. `DRY_RUN=false` only. |

Response format flipped to dollar-denominated strings
(`yes_bid_dollars: "0.4900"`) in late 2025;
parser tolerates new and legacy integer fields.

---

# Game-State Snapshot

```ts
interface GameState {
  gameId, sport, homeTeam, awayTeam: string;
  homeScore, awayScore, period: number;
  clock: string | null;       // "9:32" or ISO 8601 "PT04M32.00S"
  possession?: string;        // NFL only
  down?, yardsToGo?: number;  // NFL only
  outs?, basesOccupied?: number; // MLB; bases is a 3-bit mask
  recordedAt: ISO timestamp;
}
```

Pipeline holds `Map<gameId, GameState>` of the latest seen state and
runs `detectEvents(prev, next)` on each update.

---

# Detector — What Fires

Two event types today:

| EventType | Condition |
|-----------|-----------|
| `SCORING_PLAY` | total score changed (any positive Δ) |
| `TURNOVER`     | NFL only — `possession` flipped without a score change |

**Not** detected today (deferred to Phase 2):

NBA ejections · MLB pitching changes · soccer red cards · weather
delays · injury news.

---

# Market Resolution — The Problem

Kalshi has multiple ticker conventions for the same game:

- per-game moneyline (`KXNBAGAME-26MAY04PHINYK-NYK`)
- series-winner (`KXNBASERIES-26PHIBOSR1-PHI`)
- half-spread, quarter-winner, etc.

Tickers encode team codes **with no delimiters**:
`26PHIBOS` — Philadelphia + Boston, concatenated.

Naive substring matching has hazards: `LA` is a substring of `LAL`.

---

# Series Whitelist

```ts
NBA: [{KXNBAGAME, per_game}, {KXNBASERIES, series_winner}]
NFL: [{KXNFLGAME, per_game}]
MLB: [{KXMLBGAME, per_game}]
```

Priority order. Per-game moneylines win when both contract types match.
Series-winner is the playoff fallback (e.g. PHI@BOS Game 7 had no
per-game contract listed).

5-min cache per series.

---

# Resolution Algorithm

`resolveKalshiTicker(gameId, home, away, sport)`:

1. Fetch open markets in the sport's whitelisted series (cached 5 min).
2. Filter to events whose **team segment** of `event_ticker`
   contains both team codes.
   `KXNBASERIES-26PHIBOSR1` → segment `26PHIBOS`.
3. Parse `yes_bid_dollars` / `yes_ask_dollars` into a snapshot quote.
4. Drop markets with missing bid/ask, or spread > `MAX_SPREAD_CENTS`
   (default 10).
5. Read the **side suffix**: `...-PHI` → `'PHI'`.
   Tag candidates `home` / `away`. Unknown suffix → drop, don't guess.
6. Sort: home first, then per-game over series-winner, then tightest
   spread first. Return winner with its quote.

---

# What Resolution Returns

```ts
interface ResolvedMarket {
  ticker: string;
  eventTicker: string;
  contractType: 'per_game' | 'series_winner';
  side: 'home' | 'away';
  spreadCents: number;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
}
```

Pipeline caches per `gameId`, so subsequent events on the same game
reuse the resolved ticker without re-scanning.

---

# Why the Home-Side Preference

Lookup-table deltas are written from the home team's perspective:
positive delta = home win-prob went up.

Routing the trade to the **home-side YES contract** makes that delta
apply directly.

If we land on the away side instead, the delta has to flip.
The pipeline does this via the `homeIsYes=false` path through
`estimateFairValue`. Either is correct, but a single canonical
orientation keeps the math auditable.

---

# Fair-Value Model — Anatomy

`fair_value.ts`. Inputs:

- `GameEvent` (event type, prev/next state)
- current Kalshi mid
- contract type (`per_game` | `series_winner`)
- `homeIsYes` boolean

No live ML. Lookup table × deterministic scaling factors.

Output: `FairValueResult { estimatedFairPrice, deltaWinProb,
confidence }`.

---

# Lookup Tables

Sport × event type × game state. Sample:

```json
"NBA SCORING_PLAY:late":         { "delta": 0.18, "confidence": "high" },
"NBA SCORING_PLAY":              { "delta": 0.06, "confidence": "medium" },
"NFL SCORING_PLAY:close":        { "delta": 0.25, "confidence": "high" },
"NFL TURNOVER":                  { "delta": 0.12, "confidence": "medium" },
"MLB SCORING_PLAY:late_close":   { "delta": 0.22, "confidence": "high" }
```

Hand-picked from public WP literature (nflfastR, pbpstats,
MLB leverage index). **Not fitted to Kalshi prices yet.**

---

# Scaling Factors

Raw lookup deltas would over-fire. The signed delta is multiplied by:

| Factor | Range | Purpose |
|--------|-------|---------|
| `pointsScale(prev, next)`  | ~0.4–2.0 | 1-pt FT vs 2-pt vs 3-pt vs multi-point |
| `clockDecay(sport, state)` | 0.05–1.0 | Q4 only; full > 5 min, decays linearly to 0.05 at buzzer |
| `contractTypeScale(ct)`    | 0.5 or 1 | per-game = 1.0, series-winner = 0.5 |

Heavy combined attenuation demotes `confidence` (high → medium → low),
which the router can then pass on.

---

# Worked Example

PHI scores 3 in Q4 with 4:30 left.
Trading the BOS series-winner contract at 21¢:

- Away team scored → home-perspective delta is **negative**.
- `:late` NBA entry: `delta = +0.18`, confidence **high**.
- `pointsScale(3pt) = 1.4`
- `clockDecay`: 270 s left → `0.05 + 270/300 × 0.95 ≈ 0.905`
- `contractTypeScale(series_winner) = 0.5`

Signed delta = `-0.18 × 1.4 × 0.905 × 0.5 ≈ -0.114` → **-11.4 pp**

Fair = `21 + (-0.114 × 100) = 9.6c → clamp to [1, 99] → 10c`

Router sees an 11¢ gap → `buy_no` BOS.

---

# Routing — Cross-the-Spread Fills

Realistic cost for a paper trade:

| side | entry fill | exit fill |
|------|------------|-----------|
| `yes` | `yes_ask`            | `yes_bid` |
| `no`  | `100 − yes_bid`      | `100 − yes_ask` |

Both sides denominated in their own "buy this contract for X cents"
currency, so:

```
P&L = (exitFill − entryFill) × qty
```

— no sign-flipping needed.

---

# Pre-Fire Slippage Check

The router rejects any signal where the cost-to-cross has already
eaten the post-event edge:

```ts
expectedEdge = targetSideExitPrice − entryFillPrice
if expectedEdge < MIN_EDGE_CENTS: pass
```

This is the most direct check that "P&L positive after realistic
slippage" is even possible for a given trade.

The Phase 1 exit criterion in `plan.md` is exactly that.
Router enforces it pre-fire.

---

# Position Lifetime

`exit_manager.ts` keeps positions in `Map<id, OpenPosition>` —
**id-keyed, not ticker-keyed**.

Each pipeline cycle:

```ts
for pos in exitManager.all():
  quote = fetchQuoteCached(pos.kalshiTicker)
  decision = shouldExit(pos, quote.yesMid)
  if decision.exit:
    exitFill = exitFillPrice(pos.side, quote)
    pnl = realizedPnlCents(pos.side, pos.entryFillPrice,
                           exitFill, pos.quantity)
    record + remove
```

Exit reasons: `'target'` (mid crossed `targetYesMid`) or `'timeout'`
(60 s `HOLD_DURATION_MS`). Whichever comes first.

---

# Persistence — JSONL Journal

`trade_journal.ts` writes one JSON object per line to
`logs/paper-<timestamp>.jsonl`.

Record kinds:

```
{kind: "event",  sport, gameId, eventType, description, period, clock, ...}
{kind: "signal", action, ticker, currentYesMid, estimatedFair,
                 confidence, ...}
{kind: "open",   id, ticker, side, quantity, entryFillPrice,
                 entryYesMid, entryQuote, targetYesMid, ...}
{kind: "exit",   id, ticker, side, reason, holdMs, entryFillPrice,
                 exitFillPrice, exitYesMid, exitQuote, quantity,
                 pnlCents}
{kind: "skip",   ticker, reason, ...}
```

Durable record. P&L recomputable offline. No DB required.

---

# Persistence — Supabase (Phase 0)

`observation/run.ts` writes to two tables in
`supabase/migrations/0004_sports_arb.sql`:

- **`events`** — every detected event + prev/next state in `payload_json`.
- **`edge_log`** — Kalshi YES mid at T+0 / +15s / +30s / +60s / +120s
  plus estimated fair price; `simulated_pnl_cents = (t60 − t0) × 10`
  computed when t60 lands.

`observation/analyzer.ts` aggregates `edge_log` across many runs into
a per-sport hit-rate report — the data that *should* gate any move
to live trading.

---

# Deferred Persistence

The strategy plan calls for paper trades to land in the
`orders` / `fills` / `positions` tables that exist on the
`database` branch.

That table set has an `auth.users` foreign-key dependency that
hasn't been merged into `sports_implementation`.

For Phase 1, the JSONL journal is record-of-truth.
Bringing the relational tables in is queued for Phase 2.

---

# Validation — Sim Results

`npm run sim` runs four scripted scenarios under a 2¢ realistic spread:

```
NBA Q4 6:10 BOS scores         buy_yes  fill 50→63  +130c
NFL Q4 4:30 turnover            buy_no   fill 51→58   +70c
MLB bot-8 walk-off              buy_yes  fill 51→64  +130c (target hit)
NBA series-winner scoring       buy_yes  fill 50→55   +50c (delta halved)
                                                      ─────
                                                      +380c
```

Phase 1 exit criterion ("simulated P&L positive after realistic
slippage") **satisfied on canned data**.

Sim is a wiring/math regression. **Not** evidence the live edge is real.

---

# Validation — Live Evidence

One paper run vs PHI@BOS Game 7, 2026-05-02.

On the now-fixed code path that run would have looked very different:

- ExitManager overwrite bug erased ~19 of 35 positions before exit.
- Model fired full +18pp deltas on garbage-time free throws.
- Network blip thrashed feeds at full poll rate (no backoff).

The next live run, captured in JSONL, will be the real test.

---

# Why This Works (and When It Doesn't)

**Works when:**
- A meaningful event happens (score, turnover) in a live game with an
  active Kalshi market.
- Kalshi's market is slow to reprice — the 15–60 s lag is the edge.
- The model's delta estimate is in the right direction.

**Doesn't work when:**
- No live games or no matching Kalshi markets.
- Kalshi reprices faster than our feed detects the event.
- The lookup-table delta is wrong for an unusual game situation.
- Another participant beats us to the same trade — our order fills at
  a worse price.

The observation phase exists specifically to measure how often the model
is right and whether the edge exceeds transaction costs **before**
committing capital.

---

# Replay Analyzer Output

`npm run replay`:

```
── PAPER-TRADE JOURNAL ──
records: 1234  events: 41  signals: 41  opens: 35  exits: 16
positions opened but not exited (stranded): 0
overall: realized=+190c  closed=16  wins=8  losses=4  hit-rate=50.0%
exits:   target=1   timeout=15   median-hold=60.0s   avg-entry-slippage=1.5c
by series:
  KXNBASERIES   16  8  4  +190c  50.0%  60.0s
```

The aggregate the project actually needs is the same shape across many
runs across many games. Still ahead of us.

---

# Bugs Already Fixed (1/2)

**ExitManager overwrite.**
Position map keyed by ticker → two signals on the same market dropped
the older position silently. Now keyed by id; multiple concurrent
positions per ticker are first-class.
**Live evidence:** 19 of 35 positions vanished mid-flight on PHI@BOS.

**Mid-price fills, no slippage cost.**
Old code computed P&L as `(exitMid − entryMid) × qty`, ignoring the
spread on both sides. Now `entryFillPrice` and `exitFillPrice` are
bid/ask-aware.

**Kalshi base URL was dead.**
`trading-api.kalshi.com` redirects 302 to `api.elections.kalshi.com`.
Old client never followed; every price read returned `null` silently.

---

# Bugs Already Fixed (2/2)

**Series tickers wrong.**
`NBAWIN`/`NFLWIN`/`MLBWIN` aren't Kalshi series anymore.
Replaced with `KXNBAGAME`/`KXNFLGAME`/`KXMLBGAME` plus
`KXNBASERIES` as playoff fallback.

**Substring market match.**
Whole-ticker `includes(home) && includes(away)` could pick up
`LA`-in-`LAL` collisions. Now matches against the parsed team
segment and re-validates via the side suffix.

**No backoff on network failure.**
Previous run produced ~40 fetch-failure log lines per second once
the network blipped. Now one error per failure run plus exponential
backoff capped at 30 s.

---

# Modeling Defects We Know About

- **Lookup deltas are not fitted to Kalshi.** Replace with empirical
  deltas conditioned on Kalshi's price-path once we have weeks of
  `edge_log` data.
- **`contractTypeScale` is a flat 0.5.** A real series-winner derivative
  depends on games remaining + current standings. We don't pull series
  state.
- **Detector fires only `SCORING_PLAY` and NFL `TURNOVER`.** No NBA
  ejections, MLB pitching changes, weather, or injury news. Phase 2.
- **Multi-point bundles get a single event.** When the feed jumps +3 in
  one update (a 3-pointer + the and-one), `pointsScale` scales
  linearly above 2 — fine first approximation, but two real plays
  classified as one still misclassifies the lookup key.

---

# More Defects

- **Clock parsing trusts the feed.** ESPN occasionally returns a stale
  clock for several polls; we treat each poll as fresh. A stale-clock
  detector belongs in `EspnFeed.poll`.
- **No fill probability or market impact.** Paper assumes our limit at
  the ask always fills in full. On thin Kalshi books, a 10-contract
  order would partial-fill or walk the book. Phase 2.
- **No tournament-deciding-game adjustment.** Game 7 of a series should
  get `contractTypeScale ≈ 1.0` even on a series ticker because the
  series outcome IS the game outcome. We don't currently distinguish
  Game 7 from Game 1.

---

# Operational Gaps

- No persistence of paper trades to Supabase yet (JSONL only).
- No alerting. Pipeline silently drops events when the resolver finds
  no market — we record a `skip`, but don't surface it operationally.
- No graceful Windows shutdown handler. SIGINT works on Linux/Mac;
  on Windows the handler may not fire reliably under all PowerShell
  modes.

---

# Repository Layout (1/2)

```
sports_arb/
  pipeline.ts          ─ entry: live + sim + dry-run
  sim.ts               ─ scripted scenarios
  detector.ts          ─ GameState diff → GameEvent[]
  fair_value.ts        ─ lookup × pointsScale × clockDecay × contractScale
  router.ts            ─ evaluate(fv); placeOrder(signal, dryRun, quote)
  exit_manager.ts      ─ id-keyed positions; shouldExit; realizedPnlCents
  market_map.ts        ─ Kalshi resolution + liquidity filter
  kalshi_client.ts     ─ getMarketQuote / listMarkets / placeOrder
  feeds/
    base.ts  espn.ts  nba.ts  nfl.ts  mlb.ts
  lookup_tables/
    nfl.json nba.json mlb.json
  trade_journal.ts     ─ append-only JSONL
  file_logger.ts       ─ console mirror to logs/paper-*.log
  types.ts
  sports_arb.test.ts   ─ 20 jest unit tests
```

---

# Repository Layout (2/2)

```
observation/
  run.ts               ─ Phase 0 observer → Supabase
  logger.ts            ─ Supabase row writers
  analyzer.ts          ─ aggregate edge_log into per-sport report
  replay.ts            ─ read paper-*.jsonl, print P&L summary

supabase/
  migrations/
    0001_init.sql               users / markets / orders / fills / positions
    0002_harden_functions.sql   pin search_path on touch_updated_at
    0003_enable_rls.sql         enable RLS
    0004_sports_arb.sql         events + edge_log
  seed.sql

instructions.md   ─ user-facing run book
explanation.md    ─ system overview + Phase 1 status
plan.md           ─ original strategy doc (on main)
presentation.md   ─ THIS DECK
```

---

# How to Reproduce

```bash
# install
npm install

# verify
npm run typecheck
npm test                 # 20 jest tests
npm run sim              # closes 4/4 wins for +380c

# go live (paper, no money at risk)
cp .env.example .env     # KALSHI/SUPABASE entries
npm run paper            # ts-node sports_arb/pipeline.ts --dry-run

# read the resulting journal
npm run replay
# or: npm run replay -- logs/paper-<timestamp>.jsonl
```

To send real orders: set `DRY_RUN=false`, ensure `KALSHI_API_KEY` and
`KALSHI_API_SECRET` (path to RSA-PSS PEM) are populated, and re-run
`npm run paper`.

Read the modeling-defects slides first.

---

# Where Things Stand

**Phase 1 done:**
slippage-aware paper trading, multi-position-per-ticker, contract-type-
aware fair value, hardened market resolver, JSONL journal + offline
analyzer, network backoff. Sim shows positive realized P&L under
realistic slippage.

**Phase 2 next:**
real Kalshi orders (`DRY_RUN=false`), Supabase
`orders`/`fills`/`positions` persistence, liquidity-aware sizing,
non-scoring event detection, fitted lookup deltas from `edge_log`
data.

The next playoff game is the validator. The pipeline is ready.
