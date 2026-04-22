# Database + Auth

Source of truth for the Fintech-Predictions data layer. Covers the schema, how to run it locally, and how auth works.

## Stack

- **Postgres** (via Supabase) — one hosted project for the team, plus local Docker for offline dev.
- **Supabase Auth** — email + password signup/login, JWT sessions.
- Migrations live in `supabase/migrations/`. Seed data in `supabase/seed.sql`.

## Running locally

Prereqs:
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started) installed

```bash
npm install          # installs supabase CLI as a dev dep
npm run db:start     # boots Postgres + Auth + Studio in Docker
npm run db:reset     # applies all migrations and seeds
npm run db:stop      # tears it down
```

`npm run db:start` prints the local API URL, anon key, and service-role key. Paste them into `.env` if you want the app pointed at local instead of the hosted project.

Studio UI: http://127.0.0.1:54323

## Against the hosted project (no local Docker)

If you just need to read/write the team's shared DB:

1. Copy `.env.example` to `.env` and fill in the keys Sahas gives you.
2. Connect with the `DATABASE_URL` or the `@supabase/supabase-js` client using `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`.

The hosted project already has the migration applied and markets seeded.

## Schema

```
auth.users (Supabase-managed)
    │  (trigger on insert)
    ▼
public.users ──────── public.orders ─── public.fills
                           │
                           ▼
public.markets ──── public.price_history
    │
    └──────────── public.positions (user × market × side)
```

| Table | Purpose |
| :---- | :---- |
| `users` | App profile (1:1 with `auth.users`). Holds `cash_balance` — new users start at `1000.00`. |
| `markets` | Current snapshot of each prediction market. PK is the Kalshi ticker. `yes_price` / `no_price` are integer cents (0–100). |
| `price_history` | Append-only time series of market prices. Princeden's ingestion writes here. |
| `orders` | User order submissions. v1 = market orders only (`limit_price` null). |
| `fills` | Execution record per order. v1 = one fill per order (no partials). |
| `positions` | Current holdings per `(user_id, market_id, side)`. Unique constraint enforces one row per slot. |

### Enums

- `market_status`: `open` / `closed` / `settled`
- `order_side`: `yes` / `no`
- `order_action`: `buy` / `sell`
- `order_status`: `pending` / `filled` / `rejected`

### Triggers

- `on_auth_user_created` → `handle_new_user()` — fires when a new `auth.users` row is inserted. Creates the matching `public.users` row with the default $1000 cash balance.
- `markets_touch_updated_at` / `positions_touch_updated_at` — keep `updated_at` fresh on row updates.

## Auth flow

### Signup
1. Frontend calls `supabase.auth.signUp({ email, password })`.
2. Supabase creates the row in `auth.users`.
3. `on_auth_user_created` trigger fires → inserts into `public.users` with `cash_balance = 1000.00`.
4. Supabase returns a session (access token + refresh token). The frontend client stores it.

### Login
1. Frontend calls `supabase.auth.signInWithPassword({ email, password })`.
2. Supabase returns a session.
3. Client stores it; subsequent API calls include it automatically.

### Logout
```ts
await supabase.auth.signOut()
```

### Protected-session pattern (for Eric's backend + Mason's frontend)

**Session token**: a Supabase JWT, returned on login, stored by the Supabase client.

**Frontend (Mason)**:
- Pages that require auth call `supabase.auth.getSession()` on load. If no session → redirect to `/login`.
- API calls through `supabase-js` include the JWT automatically as `Authorization: Bearer <token>`.

**Backend (Eric)**:
- Incoming requests carry `Authorization: Bearer <jwt>`.
- Verify the JWT using `SUPABASE_JWT_SECRET` (or `supabase.auth.getUser(token)`).
- Extract `user_id` (the `sub` claim) — that's the FK into `public.users`.
- A `requireAuth` middleware rejects requests with missing / invalid JWTs.

**Never** trust a `user_id` in a request body — always derive it from the verified JWT.

## Row-level security (RLS)

**RLS is enabled on every public table** (see `supabase/migrations/0003_enable_rls.sql`).

No policies are defined yet. The effect:
- The **service role** (backend using `SUPABASE_SECRET_KEY`) bypasses RLS — it can still read/write everything. This is how Eric's backend and Princeden's ingestion script operate.
- The **anon role** and **authenticated users** (using `SUPABASE_PUBLISHABLE_KEY` JWTs from the frontend) cannot read or write anything directly through the Supabase REST/JS client until policies are added.
- The `handle_new_user` trigger is `SECURITY DEFINER`, so signup continues to work.

This is the intended Week 1 state: **the frontend goes through the backend**, and the backend speaks to Postgres with the service key. Direct `supabase-js` table access from the browser will start working once Eric adds per-table policies (e.g. "users can SELECT their own orders").

## What's intentionally out of scope (Week 1)

- RLS **policies** (the grants on top of RLS) — Eric adds these when building protected endpoints.
- `requireAuth` middleware implementation — backend task.
- Password reset / email confirmation flows — product decision for later.
- Social login — not in v1.
