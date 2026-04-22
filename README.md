# Fintech-Predictions

predictions project

## Quick start (database)

```bash
cp .env.example .env           # fill in keys from team chat
npm install
npm run db:start               # starts local Postgres + Auth in Docker
npm run db:reset               # applies migrations + seed data
```

Full schema, auth flow, and setup details: [`db/README.md`](db/README.md).

## Kalshi Paper Trader MVP Product Spec

Goal: Build a paper trading app where users can browse real Kalshi prediction markets and place simulated trades for realistic trading experience backed by live market data.

### 1. Target Audience

Someone curious about prediction markets who wants to practice trading without risking real money. They might be a student, a quant-curious hobbyist, or someone new to Kalshi who wants to get comfortable before trading for real.

Not catered to:

- A professional trader looking for execution speed or advanced order types
- Someone who needs a real brokerage account as this is a simulator only

### 2. The Problem

Prediction markets like Kalshi are unfamiliar to most people. There's no low-stakes way to learn how they work. New users either trade real money before they're ready, or never engage at all.

Example: A user hears about a contract on whether the Fed will cut rates. They want to trade it, but don't understand how yes/no contracts work, what "82¢" means, or how their P&L would move. A paper trader lets them figure this out risk-free.

### 3. MVP Scope (Weeks 1–3)

A working web app with four core flows:

| Flow | What the user can do | In v1? |
| :---- | :---- | :---: |
| **Sign up / Log in** | Create an account or sign in; session is persisted | Yes |
| **Browse markets** | See a list of live Kalshi markets with current prices | Yes |
| **Market detail** | See contract info, current odds, and place a simulated trade | Yes |
| **Portfolio** | See cash balance, open positions, and order history with P&L | Yes |
| Real-time prices | Prices update live from Kalshi (not just on page load) | v2 |
| Price history charts | See how a contract's price has moved over time | v2 |
| Leaderboard | Compare P&L with other users | v2 |
| Limit orders | Place orders at a specific price instead of market price | v2 |

Trading rules for v1:

- Market orders only, trades fill instantly at current price
- Each new user starts with $1,000 in simulated cash
- No partial fills, orders are fully filled or rejected

### 4. Must-Have Pages

| Page | Contents |
| :---- | :---- |
| **Login / Signup** | Email + password form; redirect to markets on success |
| **Markets** | List of active Kalshi contracts with title, category, and current price |
| **Market Detail** | Contract description, yes/no price, buy/sell toggle, quantity input, submit order |
| **Portfolio** | Cash balance, open positions with current value, closed trades and P&L |

### 5. Not in v1

- Real money or real order execution (simulation only)
- Live price streaming (polling or static data fine for v1)
- Price history charts
- Social features (leaderboard, sharing)
- Limit orders or advanced order types
- Mobile app

### 6. Done When

- A new user can sign up, browse markets, place a simulated trade, and see it in their portfolio
- Market data is pulled from a real Kalshi data source (not hardcoded)
- All four pages exist and are connected
- Backend, frontend, and database all run together in a shared environment
- The team agrees: this is ready to demo
