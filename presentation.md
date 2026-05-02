# Presentation Guide

## Format

Aim for 8–12 minutes. Use the simulation demo as your anchor — it runs in ~10 seconds and makes the abstract concrete immediately.

---

## Suggested Structure

### 1. Hook (1 min)

Open with the core insight, not the tech:

> "When a team scores, Kalshi's prediction market takes 15–60 seconds to update its price. Public sports APIs show the same score within 1–5 seconds. This system exploits that gap."

Keep it one sentence. The audience should understand the whole idea before you say anything about code.

---

### 2. What Kalshi Is (1–2 min)

Briefly explain the market for anyone unfamiliar:

- Kalshi is a CFTC-regulated prediction market — legally a derivatives exchange
- Markets are binary: a contract pays $1 if the outcome is YES, $0 if NO
- Prices trade between 1¢ and 99¢ and represent the market's implied probability
- You can buy and sell at any point before resolution

Keep this short. One or two slides maximum. The audience cares more about the strategy than the venue.

---

### 3. The Strategy (2 min)

Walk through the logic step by step:

1. A game event happens (e.g. Boston scores in Q4, tied game)
2. Our system detects it from ESPN/NBA feeds within ~2 seconds
3. Kalshi's market still shows 49¢ (pre-event price)
4. Our model estimates the fair price is now 67¢
5. We buy YES at ~50¢ before the market reprices
6. 30 seconds later Kalshi reprices to 65¢ — we sell and pocket ~15¢ per contract

Emphasize: this is not gambling on the outcome. The position is held for seconds, not hours.

---

### 4. Live Demo (2–3 min)

Run the simulation in the terminal:

```bash
npm run sim
```

Point out each line of output as it appears:

- The detected event and description
- The market price vs model fair price and the edge in cents
- The trade signal (`buy_yes` / `buy_no`) and the reason
- The open position summary with estimated P&L

This is the most persuasive part of the demo. Let it speak for itself — resist the urge to narrate every line.

If you have live games available, switch to `npm run paper` and show a real signal firing. Make clear that `DRY_RUN=true` means no money is at risk.

---

### 5. Architecture (2 min)

Use the diagram from `explanation.md`. Walk left to right:

- **Feeds** — four parallel pollers, free public APIs, 500ms interval
- **Detector** — diffs consecutive game states, fires on score changes and turnovers
- **Fair Value** — lookup tables keyed on sport + event type + game situation
- **Router** — filters by edge threshold, emits buy_yes or buy_no
- **Kalshi Client** — RSA-signed limit orders, fills only if the market is still lagging
- **Exit Manager** — closes at price target or 60-second timeout

One key design decision worth explaining: **lookup tables instead of ML**. The tables are pre-computed win-probability deltas derived from historical data. They are deterministic, auditable, and run in microseconds — no model inference latency.

---

### 6. Database & Observation Phase (1 min)

Explain the two-phase approach:

- **Phase 0 (now):** `npm run observe` records every event and price snapshot (T+0 through T+120s) with no capital at risk. After 2–4 weeks you have empirical hit rates and simulated P&L by sport and event type.
- **Phase 1:** Paper trading — live signals, no real orders
- **Phase 2:** Live trading — only after the data confirms a real edge

This shows the project is methodical, not just speculative.

---

### 7. Results / What You'd Show After Observation (1 min)

If you have observation data, show the edge report output from `analyzer.ts`:

```
NBA:SCORING_PLAY:late     n=47  hitRate=76.6%  avgDrift=9.2c  avgPnl=+8.4c
NFL:SCORING_PLAY:close    n=31  hitRate=67.7%  avgDrift=7.1c  avgPnl=+5.9c
NFL:TURNOVER              n=18  hitRate=55.6%  avgDrift=4.3c  avgPnl=+1.2c
```

If you don't have real data yet, explain what these metrics mean and what thresholds would justify going live (e.g. hit rate > 60%, avg P&L > transaction costs).

---

### 8. Risks & Limitations (1 min)

Address these proactively — it shows rigor:

- **Latency competition** — if others run the same strategy, the edge compresses
- **Model error** — lookup tables are averages; individual game situations vary
- **Market liquidity** — thin Kalshi order books mean large orders move the price against you
- **Feed delays** — ESPN and NBA APIs are not guaranteed real-time; outages happen
- **Regulatory** — Kalshi is CFTC-regulated but rules around automated trading may evolve

---

## Tips

- **Run the demo first in rehearsal** to make sure there are no TypeScript errors or dependency issues on the day.
- **Have a backup** — record a short screen capture of `npm run sim` output in case of network issues.
- **Avoid diving into code** unless specifically asked. Architecture diagrams and terminal output are more compelling than source files.
- **Know your numbers** — be ready to answer: "What's the typical edge in cents?" (5–20¢), "How long do you hold?" (seconds, max 60), "Is this legal?" (yes, Kalshi is CFTC-regulated).
