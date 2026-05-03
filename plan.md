# Latency-Arbitrage Strategy — Sports Prediction Markets

Strategy plan for trading Kalshi (and similar) sports contracts by reacting to in-game events **before the median user's price feed (TV broadcast) catches up**. Holding period is seconds to minutes, not to resolution.

> "Frontrunning" in the legal sense means trading ahead of a client's known orders. That's not this. This is **latency arbitrage**: exploiting a public-information lag between fast data feeds and slow ones. Correct terminology matters both for clarity and for compliance conversations.

> **Status:** Phase 1 complete on `sports_implementation`. Slippage-aware
> paper trading runs end-to-end against live feeds and live Kalshi quotes.
> Sim closes 4/4 wins for +380¢ realized under a 2¢ spread. See
> `presentation.md` for the full technical design and known defects.
> Next: Phase 2 (live orders, Supabase orders/fills/positions, liquidity-
> aware sizing, non-scoring event detection).

---

## 1. Thesis

Casual Kalshi users on sports contracts trade off what they see on their screen — typically a streaming broadcast with **30–60+ seconds of latency**. Public stats APIs (ESPN, league-official) update within **1–5 seconds** of the actual event. That delta is the edge.

When a material event happens:

1. Our system sees it via the fast feed.
2. We estimate the event's impact on win probability → estimate the new fair price.
3. We hit the book before casual users finish seeing the play and manually clicking.
4. Once the crowd has priced it in, we exit.

No need to be right about the game's final outcome. We just need to be right about where the market's going to be 30–90 seconds from now.

## 2. Data sources (ordered by speed)

| Tier | Source | Typical delay | Cost | Notes |
| :---- | :---- | :---- | :---- | :---- |
| S | League-official feeds (NBA Stats API, MLB Stats API, NFL Gamecenter) | ~1–3s | Free for most, some gated | Ground truth. What ESPN aggregates from. |
| A | Sportradar / Genius Sports (official data partners) | <1s | $$$ | Paid, contract required. Pros use these. |
| B | ESPN public API (`site.api.espn.com`) | ~3–10s | Free, undocumented | Cached behind their CDN; best effort. |
| B | Twitter/X insider accounts (Schefter, Wojnarowski, Ian Rapoport) | variable — sometimes beats all feeds for injuries | Free with scraping risk | |
| C | Kalshi's own market data | reflects our target | Free | What we're racing against. |
| Z | Broadcast (cable/OTA) | 5–10s | — | Reference point. |
| Z | Streaming (ESPN+, YouTube TV, Hulu Live) | 30–60+s | — | What most casuals use. |

**v1 stack:** ESPN public API as primary + the relevant league-official API as tier-up. Twitter/X as a later add.

## 3. Target events

We want events that cause **sharp, predictable probability shifts** that casuals take 30+ seconds to trade.

| Sport | Event | Why it moves markets |
| :---- | :---- | :---- |
| NFL | Scoring play, turnover, QB injury | 10–25pp swings on moneyline contracts |
| NBA | Late-game clutch bucket, ejection, lead-changing three | Live win-prob jumps are sharp |
| MLB | Walk-off hit, home run, pitching change late-inning | Especially late innings |
| Soccer | Goal, red card | Rare events with huge price gaps |
| Tennis | Service break | Well-modeled, known impact |
| Any | Weather/game delay | Volatility spike, mispriced futures |

**Avoid:** normal ball-by-ball action. Too noisy, edge too thin, competing against bots.

## 4. Fair-value model

For each targeted event, we need a quick mapping: *event → expected Δ win probability → target price.*

**Approach:**
- Start with **lookup tables** derived from publicly available win-probability models (e.g., nflfastR for NFL, pbpstats for NBA, MLB leverage index).
- Cache "pre-event fair price" continuously by mirroring each model against the live game state.
- On event trigger: compute post-event fair, compare to current Kalshi price. If gap > threshold, fire.

**Minimum viable version:** hardcoded impact table by sport × event × game state (e.g., "late-game NFL touchdown when trailing by ≤7 → +35pp to leading team's moneyline").

## 5. Execution loop

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Fast data poll │ ──▶ │  Event detector  │ ──▶ │  Fair-value Δ  │
│  (ESPN, league) │     │  (state diff)    │     │  estimator     │
└─────────────────┘     └──────────────────┘     └───────┬────────┘
                                                         │
┌─────────────────┐     ┌──────────────────┐     ┌───────▼────────┐
│  Exit manager   │ ◀── │  Position state  │ ◀── │  Order router  │
│ (time / price)  │     │                  │     │  → Kalshi      │
└─────────────────┘     └──────────────────┘     └────────────────┘
```

- **Polling cadence:** 500ms–1s for ESPN; faster if league feed allows streaming/websocket.
- **Latency budget end-to-end (event → order filled):** target ≤ 3s. Most of this is network + Kalshi order ack.
- **Exit rule v1:** time-based (sell after 60s) OR price-based (sell when price crosses our modeled post-event fair by X cents). Whichever hits first.

## 6. Backtesting + measurement

Orderbook history on Kalshi is not easily available retroactively, so proving the edge requires a two-phase measurement:

1. **Observation-only phase (no capital):** built. `npm run observe` writes
   detected events plus Kalshi YES-mid at T+0/+15s/+30s/+60s/+120s into
   Supabase tables `events` and `edge_log`. `observation/analyzer.ts`
   aggregates into per-sport hit-rate and drift reports. Status: infra
   ready, weeks of live data still to be collected.
2. **Shadow-trading phase:** built. `npm run paper` runs the full pipeline
   against live feeds + live Kalshi quotes with `DRY_RUN=true`. Every
   event/signal/open/exit lands in a JSONL journal at `logs/paper-*.jsonl`.
   `npm run replay` aggregates that journal into realized P&L, hit rate,
   target-vs-timeout split, median hold, average entry slippage, and a
   per-series breakdown — all offline, no DB required.
3. **Live phase:** queued. Set `DRY_RUN=false` once the journal data shows
   realized edge survives the spread.

Key metrics to track: **hit rate** (% of events that moved in our direction), **avg price move during hold**, **avg slippage**, **latency distribution** (fast feed → order acked).

## 7. Risks

- **Somebody else is already faster.** Sophisticated market makers on Kalshi almost certainly arb this already on major contracts. Our edge exists in:
  - Smaller-volume contracts they don't cover.
  - Events outside their model (weird injuries, weather).
  - Off-hours games.
- **Kalshi may throttle or flag.** Aggressive polling, suspiciously well-timed trades, and rapid churn can get an account reviewed or rate-limited. Respect rate limits. Don't burst.
- **Data outages.** ESPN JSON occasionally stalls or returns stale data. Need freshness checks (is `lastPlay.timestamp` moving?).
- **Kalshi liquidity gaps.** Thin books mean no fills at our target price. Must size orders to available liquidity.
- **Partial fills and reversals.** The casual reprice might already be priced in by the time we arrive — we pay without realizing edge. Our detection threshold controls this but not perfectly.
- **Regulatory / TOS.** Kalshi is CFTC-regulated. Trading on public data is legal, but:
  - Review Kalshi's Terms of Service before deploying bots — automated trading may require specific disclosures or API limits.
  - Never use information obtained from non-public sources (insider info, stolen feeds).
  - If operating at scale, talk to a lawyer before go-live.
- **Strategy decay.** This edge shrinks as more users run it. Expect diminishing returns over time; be ready to move to fresher niches.

## 8. Phased roadmap

| Phase | Status | Scope | Exit criteria |
| :---- | :---- | :---- | :---- |
| 0. Measure | infra done, data pending | Log events + Kalshi price paths for 2–4 weeks. No trading. | Quantified edge for ≥ 1 event type in ≥ 1 sport. |
| 1. Paper | **done** | Full pipeline, simulated orders with realistic slippage. JSONL journal as record-of-truth. | Simulated P&L positive after realistic slippage. ✓ +380¢ on canned data. |
| 2. Live small | next | Minimal size on one sport, one event type. Persist to Supabase orders/fills/positions. Liquidity-aware sizing. | Live P&L tracks simulated P&L within tolerance. |
| 3. Scale | queued | Expand event types / sports. Add NBA ejections, MLB pitching changes, injury news (Twitter/X). League-official feeds where they exist. | Throughput or latency limits reached. |
| 4. Harden | queued | Redundant feeds, monitoring, circuit breakers, compliance review. | Ready for meaningful capital. |

Phase 1's slippage check happens pre-fire in `router.ts`: any signal whose
post-spread expected edge is below `MIN_EDGE_CENTS` is dropped before a
position opens. See `presentation.md` for the full technical breakdown and
known modeling defects.

## 9. Fit with the existing Fintech-Predictions app

What's wired up today (`sports_implementation` branch):
- `events` and `edge_log` tables added in
  `supabase/migrations/0004_sports_arb.sql`. `observation/run.ts` writes
  to both. `observation/analyzer.ts` reports.
- The full sports-arb pipeline lives under `sports_arb/` — feeds,
  detector, fair-value, router, exit manager, market resolver, Kalshi
  client. Independent of Princeden's market-data polling.
- Phase 1 paper trades land in JSONL (`logs/paper-*.jsonl`), not in
  Supabase. The journal is durable and self-describing; `npm run replay`
  reads it.

What's still on the `database` branch and **not** yet merged here:
- `users`, `markets`, `price_history`, `orders`, `fills`, `positions`
  tables. These have an `auth.users` foreign-key dependency and
  Eric's order flow.
- Phase 2 will wire paper (and eventually live) trades into the
  relational tables so the rest of the app sees the same record of
  truth.

## 10. Deliberate non-goals (for now)

- Holding sports contracts to resolution.
- Prop-bet-style event modeling (player stats, etc.) — too noisy for latency arb.
- Live-streaming video analysis (CV on feeds) — expensive and slower than APIs.
- Cross-venue arbitrage (Kalshi vs Polymarket vs DraftKings) — separate strategy, different infra.
