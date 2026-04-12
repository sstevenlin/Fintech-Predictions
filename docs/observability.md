# Observability & Logging Strategy

## 1. Error Tracking
- **Tool:** Sentry (Free Tier)
- **Goal:** Capture all unhandled exceptions in production.
- **Action:** Eric to initialize the Sentry SDK in the main backend entry point.

## 2. Request Logging (Middleware)
- All incoming HTTP requests to the backend must log:
  - Timestamp
  - HTTP Method (GET, POST, etc.)
  - Path (/markets, /trade)
  - Response Status Code (200, 400, 500)

## 3. Order Event Audit (Crucial for Prediction Market)
To ensure we can audit simulated trades, the following must be logged at the `INFO` level:
- `ORDER_PLACED`: user_id, market_id, side, price, qty
- `ORDER_FILLED`: order_id, fill_price, timestamp
- `BALANCE_UPDATE`: user_id, old_balance, new_balance

## 4. Monitoring Stack
- **Uptime:** Better Uptime (pings our `/health` endpoint every 60s).
- **Log Aggregation:** Railway/Vercel built-in logs for MVP.