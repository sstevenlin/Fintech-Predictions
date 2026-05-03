# Running the Project

## Quick Reference

| Command | What it does | Dependencies |
|---|---|---|
| `npm run sim`       | Scripted demo, no live data            | None |
| `npm run paper`     | Live games, no real money (default)    | Kalshi public API only |
| `npm run replay`    | Aggregate paper-mode JSONL into stats  | None |
| `npm run observe`   | Record price snapshots into Supabase   | Supabase + Kalshi public API |
| `npm test`          | Run jest unit tests                    | None |
| `npm run typecheck` | TypeScript type check                  | None |

---

## Mode 1 — Simulation (no setup required)

Runs four scripted scenarios through the full detector → fair-value → router →
exit-manager pipeline. No API keys, no database.

```bash
npm install
npm run sim
```

Expected: detector fires, fair-value estimates print, the router emits
`buy_yes` / `buy_no`, positions open and close, and a P&L summary at the end.

A clean run currently closes 4/4 wins for **+380¢** under a 2¢ realistic
spread — Phase 1's exit criterion (positive simulated P&L after slippage).

---

## Mode 2 — Paper Trading (live games, no capital)

Connects to real sports feeds and live Kalshi market quotes. Computes signals
and tracks positions, but never sends an order to the exchange (`--dry-run`
is hardcoded into `npm run paper`).

### 1. Get a `.env`

```bash
cp .env.example .env
```

Paper mode reads only **public** Kalshi market data — no Kalshi API key
required. Supabase is also optional in paper mode; the durable record is the
JSONL journal at `logs/paper-*.jsonl`.

If you want Supabase persistence (Phase 0 observation, future Phase 2 paper
records), fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and run:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

### 2. Run

```bash
npm run paper
```

The pipeline polls ESPN, NBA, NFL, and MLB feeds. It prints a `[pipeline]
event | …` line whenever a scoring play or NFL turnover is detected, plus
fair-value, signal, position-open, and exit lines. Heartbeats every 30 s
report tracked games and realized P&L. If no games are live the heartbeat
ticks but no signals fire — that's expected.

`Ctrl+C` (or SIGINT/SIGTERM) prints a closing summary:

```
[pipeline] summary | closed=N wins=W losses=L realized=±Xc
```

### 3. Read the journal

```bash
npm run replay
# or, for one specific file:
npm run replay -- logs/paper-2026-05-03Txx-xx.jsonl
```

`replay` reads every `paper-*.jsonl` it finds and prints realized P&L,
hit rate, target-vs-timeout split, median hold time, average entry slippage,
and a per-series breakdown. Phase 1's record-of-truth check.

---

## Mode 3 — Observation Mode (Phase 0)

Records Kalshi price snapshots at T+0/+15s/+30s/+60s/+120s after every
detected event. No orders placed. Used to quantify the edge empirically
before committing capital. Requires Supabase setup.

```bash
npm run observe
```

Writes to the `events` and `edge_log` tables. View in the Supabase Table
Editor or run the analyzer:

```bash
npx ts-node observation/analyzer.ts
```

---

## Mode 4 — Live Trading (Phase 2 — gated by edge data)

> Only attempt this after observation data and paper-mode JSONL replay
> together show the edge survives the spread. Read `presentation.md` first —
> "Modeling Defects We Know About" lists what's still wrong.

Live mode requires the Kalshi RSA-PSS API key:

```
KALSHI_API_KEY=your-api-key
KALSHI_API_SECRET=./keys/kalshi_private.pem   # path to RSA private key
KALSHI_ENV=demo                                # optional: target sandbox
DRY_RUN=false                                  # required: actually send orders
```

Then:

```bash
npm run paper
```

The pipeline will place real limit orders. Positions are held up to 60
seconds and exited at target or on timeout. Same JSONL journal records
real fills.

---

## Environment Variables

| Variable | Required for | Description |
|---|---|---|
| `SUPABASE_URL`              | observe, future Phase 2 | Supabase project URL |
| `SUPABASE_ANON_KEY`         | observe, future Phase 2 | Publishable API key |
| `SUPABASE_SERVICE_ROLE_KEY` | observe, future Phase 2 | Secret API key (server-side only) |
| `KALSHI_API_KEY`            | live (Phase 2)          | Kalshi account API key |
| `KALSHI_API_SECRET`         | live (Phase 2)          | Path to RSA-PSS private key file |
| `KALSHI_ENV`                | optional                | Set to `demo` for Kalshi sandbox |
| `POLL_INTERVAL_MS`          | optional                | Feed poll rate in ms (default: 500) |
| `MIN_EDGE_CENTS`            | optional                | Minimum post-slippage edge to trade (default: 5) |
| `MAX_SPREAD_CENTS`          | optional                | Max spread to consider tradeable (default: 10) |
| `MAX_QUANTITY`              | optional                | Contracts per order (default: 10) |
| `DRY_RUN`                   | optional                | Set to `false` for live orders (default: true) |
| `ESPN_USER_AGENT`           | optional                | Polite UA on ESPN requests |

---

## Trade journal (Phase 1)

Every paper-trade run writes:

```
logs/paper-<timestamp>.log     # human-readable mirror of console output
logs/paper-<timestamp>.jsonl   # one structured record per kind
```

Record kinds: `event`, `signal`, `open`, `exit`, `skip`. Each `exit` record
carries the realized P&L computed against the cross-spread fill prices —
buy at ask, sell at bid — so the numbers reflect the friction a live order
would actually pay. The format is self-describing; aggregate offline with
`npm run replay` or your own script.

---

## Running Tests

```bash
npm test
```

20 jest tests cover detector, fair-value (including clock decay, points
scale, and contract-type scaling), router (including post-slippage edge
check), exit manager (id-keyed multi-position support), and the bid/ask
fill helpers. No API keys or database needed.

---

## More Detail

`presentation.md` is the slide-form technical design — architecture, market
resolver algorithm, fair-value model with worked example, slippage math,
persistence, and the full list of known modeling and operational defects.
Read it before sending real orders.
