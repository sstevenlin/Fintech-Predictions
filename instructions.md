# Running the Project

## Quick Reference

| Command | What it does | Dependencies |
|---|---|---|
| `npm run sim` | Scripted demo, no live data | None |
| `npm run paper` | Live games, no real money | Supabase + Kalshi API |
| `npm run observe` | Record price data for analysis | Supabase + Kalshi API |
| `npm test` | Run unit tests | None |
| `npm run typecheck` | TypeScript type check | None |

---

## Mode 1 — Simulation (no setup required)

Runs three scripted game scenarios through the full pipeline. No API keys, no database.

```bash
npm install
npm run sim
```

You will see the detector fire, fair value estimates, trade signals, and a P&L summary printed to the terminal.

---

## Mode 2 — Paper Trading (live games, no capital)

Connects to real sports feeds and Kalshi market prices. Logs signals but never places real orders (`DRY_RUN=true`).

### 1. Set up Supabase

Create a project at [supabase.com](https://supabase.com), then go to **Project Settings → API** and copy your credentials.

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

Link and push the database schema:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Your project ref is the subdomain in your Supabase URL (e.g. `https://xxxx.supabase.co` → ref is `xxxx`).

### 2. Set up Kalshi

Add your Kalshi API key to `.env`:

```
KALSHI_API_KEY=your-api-key
KALSHI_API_SECRET=./keys/kalshi_private.pem   # path to RSA private key file
```

To use the Kalshi demo environment instead of production, also set:

```
KALSHI_ENV=demo
```

### 3. Run

```bash
npm run paper
```

The pipeline polls ESPN, NBA, NFL, and MLB feeds every 500ms. It prints a signal line whenever an event is detected. Press `Ctrl+C` to stop. If no games are live, it will sit silently — that is expected.

---

## Mode 3 — Observation Mode

Records Kalshi price snapshots at T+0, T+15s, T+30s, T+60s, and T+120s after every detected event. No orders placed. Run for 2–4 weeks before going live to quantify the edge empirically.

Requires the same Supabase and Kalshi setup as paper trading.

```bash
npm run observe
```

Results are written to the `events` and `edge_log` tables in Supabase. View them in the Supabase Table Editor or run the analyzer:

```bash
npx ts-node observation/analyzer.ts
```

---

## Mode 4 — Live Trading

> Only attempt this after running observation mode and confirming a real edge exists.

Same setup as paper trading. Change one line in `.env`:

```
DRY_RUN=false
```

Then run:

```bash
npm run paper
```

The pipeline will place real limit orders on Kalshi. Positions are held up to 60 seconds and exited at the target price or on timeout.

---

## Environment Variables

| Variable | Required for | Description |
|---|---|---|
| `SUPABASE_URL` | paper, observe, live | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | paper, observe, live | Publishable API key |
| `SUPABASE_SERVICE_ROLE_KEY` | paper, observe, live | Secret API key (server-side only) |
| `KALSHI_API_KEY` | paper, observe, live | Kalshi account API key |
| `KALSHI_API_SECRET` | paper, observe, live | Path to RSA private key file |
| `KALSHI_ENV` | optional | Set to `demo` for Kalshi sandbox |
| `POLL_INTERVAL_MS` | optional | Feed poll rate in ms (default: 500) |
| `MIN_EDGE_CENTS` | optional | Minimum edge to trade (default: 5) |
| `DRY_RUN` | optional | Set to `false` for live orders (default: true) |

---

## Running Tests

```bash
npm test
```

Tests cover the detector, fair value estimator, router, and exit manager. No API keys or database needed.
