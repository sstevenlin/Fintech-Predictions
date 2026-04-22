# Database + Auth — Status

Status of Sahas's three tickets (schema / local DB + seed / auth). This started as a forward plan; now it's a record of what's in the repo + what's handed off to teammates.

**Stack:** Supabase (hosted Postgres + Auth) for the team, Supabase CLI (Docker) for local dev. Project ID: `wlxzdvacbchiejgdmlcp`.

**Branch:** `database`.

---

## Ticket 1: Design database schema v1 — DONE

**Migration:** `supabase/migrations/0001_init.sql` (applied to hosted project).

Tables created:

| Table | Purpose | Notes |
| :---- | :---- | :---- |
| `users` | 1:1 with `auth.users`. App profile + `cash_balance`. | $1000 default, `numeric(14,2)`, `>= 0` check. |
| `markets` | Current snapshot of each prediction market. | PK is the Kalshi ticker (text). `yes_price`/`no_price` are integer cents (0–100). |
| `price_history` | Append-only time series of market prices. | Indexed on `(market_id, recorded_at desc)`. |
| `orders` | User order submissions. | v1 = market orders only (`limit_price` null). Indexed on `(user_id, created_at desc)`. |
| `fills` | Execution record per order. | v1 = one fill per order (no partials). |
| `positions` | Holdings per `(user_id, market_id, side)`. | Unique constraint enforces one row per slot. |

Enums: `market_status`, `order_side`, `order_action`, `order_status`.

Triggers:
- `on_auth_user_created` → `handle_new_user()` — every Supabase signup auto-creates a `public.users` row with `cash_balance = 1000.00`. `SECURITY DEFINER` so it keeps working under RLS.
- `markets_touch_updated_at` / `positions_touch_updated_at` — `updated_at` maintained on update.

**Verified:** all 6 tables present in the hosted project; signup trigger tested end-to-end (inserted an `auth.users` row → `public.users` row appeared with $1000 → cleaned up).

---

## Ticket 2: Set up local database + seed flow — DONE

- `supabase/config.toml` — local CLI config. Email confirmation disabled for local dev so signups are instant.
- `supabase/seed.sql` — 10 markets across categories + statuses, 9 price observations for the active markets. No user/order/fill/position seeds — those get created through the real signup + order flow so triggers and Eric's logic run end-to-end.
- `package.json` scripts: `npm run db:start` / `db:reset` / `db:stop` / `db:status`.
- `.env.example` at repo root with placeholders for `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`. Real `.env` is gitignored.
- Top-level `README.md` has a Quick start block pointing at `db/README.md`.

**Hosted project** is already seeded: 10 markets + 9 price observations. Eric and Princeden can query immediately.

---

## Ticket 3: Auth foundation (signup + login) — DONE

- Supabase Auth with email + password. No custom auth endpoints needed — frontend calls `supabase.auth.signUp` / `signInWithPassword` / `signOut` directly.
- Signup flow: `auth.users` insert → `handle_new_user` trigger → `public.users` row with $1000 cash → session returned.
- Protected-session pattern documented in `db/README.md` (JWT in `Authorization: Bearer`, backend verifies via `SUPABASE_JWT_SECRET`, frontend guards pages via `supabase.auth.getSession()`).

**Verified:** signup trigger continues to work under RLS (see next section).

---

## RLS state (post user-applied change)

RLS is enabled on all 6 public tables — captured in `supabase/migrations/0003_enable_rls.sql`.

**Effect today:**
- Service role (backend via `SUPABASE_SECRET_KEY`) bypasses RLS → unaffected.
- Anon role / authenticated user JWTs from the browser cannot read or write tables directly until policies are added.
- Signup still works because `handle_new_user` is `SECURITY DEFINER`.

**What this means for the team:** Week 1 traffic goes frontend → backend (service key) → Postgres. Direct `supabase-js` table access from Mason's UI will return empty until Eric adds per-table policies (e.g. "a user can SELECT their own rows in `orders`, `fills`, `positions`" and "anyone authenticated can SELECT `markets` / `price_history`").

Supabase advisor currently reports only `rls_enabled_no_policy` (INFO level) on those 6 tables — expected; clears once Eric writes policies.

---

## Migrations in the repo

| # | File | What it does |
| :---- | :---- | :---- |
| 0001 | `init.sql` | Full schema + signup trigger + `updated_at` triggers. |
| 0002 | `harden_functions.sql` | Pins `search_path` on `touch_updated_at` (advisor fix). |
| 0003 | `enable_rls.sql` | `alter table ... enable row level security` on all 6 tables. |

All three are applied to the hosted project. `npm run db:reset` replays them locally.

---

## Handoffs to teammates

- **Eric (backend)** — schema is stable; connect with `SUPABASE_SECRET_KEY` (service role) for now. When you build real endpoints, add RLS policies in a new migration (`0004_rls_policies.sql`) and write your `requireAuth` middleware against the Supabase JWT. Pattern is in `db/README.md`.
- **Princeden (market data)** — the `markets` and `price_history` tables are ready. Field names: see `db/README.md`. Use the service key to upsert. If you need fields I didn't include (open interest, volume, etc.), ping me and I'll add a follow-up migration.
- **Mason (frontend)** — use `@supabase/supabase-js` with `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`. Call `supabase.auth.signUp({ email, password })` and `signInWithPassword(...)` directly. For reading markets/portfolio data in Week 1, go through Eric's backend rather than hitting tables directly (RLS blocks direct reads until policies land).
- **Alan (infra)** — the hosted project has email confirmation off for now (to unblock dev). Flip it on via the Supabase dashboard before we deploy to a real staging URL.

---

## What's deliberately not included

- **RLS policies** — Eric's work, not this ticket (pattern documented).
- **`requireAuth` middleware** — backend task, pattern documented.
- **Password reset / email confirmation UI** — product decision for later.
- **Social login** — not in v1 per the MVP spec.
