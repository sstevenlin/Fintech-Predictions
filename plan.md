# Latency-Arbitrage Strategy — Sports Prediction Markets

Strategy plan for trading Kalshi (and similar) sports contracts by reacting to in-game events **before the median user's price feed (TV broadcast) catches up**. Holding period is seconds to minutes, not to resolution.

> "Frontrunning" in the legal sense means trading ahead of a client's known orders. That's not this. This is **latency arbitrage**: exploiting a public-information lag between fast data feeds and slow ones. Correct terminology matters both for clarity and for compliance conversations.

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

1. **Observation-only phase (no capital):**
   - Log every targeted event from the fast feed with a timestamp.
   - Poll Kalshi price at that instant and at +15s / +30s / +60s / +120s.
   - Measure the realized price path: did casuals actually lag? By how much? For which events?
2. **Shadow-trading phase:**
   - Run the full pipeline but record "would-have" orders instead of placing them.
   - Mark against actual Kalshi fills to estimate realistic slippage.
3. **Live phase:** Start with minimal size, scale up only if the measured edge survives live-fill friction.

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

| Phase | Scope | Exit criteria |
| :---- | :---- | :---- |
| 0. Measure | Log events + Kalshi price paths for 2–4 weeks. No trading. | Quantified edge for ≥ 1 event type in ≥ 1 sport. |
| 1. Paper | Full pipeline, simulated orders against our existing paper-trading DB. | Simulated P&L positive after realistic slippage assumptions. |
| 2. Live small | Minimal size on one sport, one event type. | Live P&L tracks simulated P&L within tolerance. |
| 3. Scale | Expand to more event types / sports. Add league-official feeds. | Throughput or latency limits reached. |
| 4. Harden | Redundant feeds, monitoring, circuit breakers, compliance review. | Ready for meaningful capital. |

## 9. Fit with the existing Fintech-Predictions app

The paper-trading MVP on the `database` branch is actually **perfect infrastructure for Phase 1**:
- `markets`, `price_history`, `orders`, `fills`, `positions` already exist.
- Add an `events` table: `id`, `market_id`, `sport`, `event_type`, `detected_at`, `source`, `payload_json`.
- Add an `edge_log` table: `event_id`, `kalshi_price_at_detection`, `price_at_t_plus_15s/30s/60s`, `simulated_pnl`.
- Princeden's ingestion already handles market-data polling — the events feed is a natural extension.
- Eric's order flow can back-end the simulated trades for Phase 1.

This means Phase 0 and Phase 1 are mostly data work, not a new codebase.

## 10. Deliberate non-goals (for now)

- Holding sports contracts to resolution.
- Prop-bet-style event modeling (player stats, etc.) — too noisy for latency arb.
- Live-streaming video analysis (CV on feeds) — expensive and slower than APIs.
- Cross-venue arbitrage (Kalshi vs Polymarket vs DraftKings) — separate strategy, different infra.
