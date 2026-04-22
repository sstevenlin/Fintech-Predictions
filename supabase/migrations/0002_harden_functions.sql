-- Harden trigger functions: pin search_path to prevent schema-resolution attacks.
-- https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
