-- Enable Row Level Security on all public tables.
-- Policies are intentionally NOT defined here — Eric adds per-endpoint policies
-- when wiring up the backend. Until then, only the service role can read/write
-- these tables (which is what the backend uses anyway).
--
-- The signup trigger `handle_new_user` is SECURITY DEFINER, so signup
-- continues to work even with no policy on public.users.

alter table public.users         enable row level security;
alter table public.markets       enable row level security;
alter table public.price_history enable row level security;
alter table public.orders        enable row level security;
alter table public.fills         enable row level security;
alter table public.positions     enable row level security;
