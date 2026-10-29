-- P1-06: Row Level Security on every table.
-- The API writes with the service role, which bypasses RLS, so there are no write policies.
-- Signed-in users can only read their own rows; anon can read nothing.

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.taste_profiles enable row level security;
alter table public.companions enable row level security;
alter table public.places enable row level security;
alter table public.sessions enable row level security;
alter table public.session_companions enable row level security;
alter table public.messages enable row level security;
alter table public.meals enable row level security;
alter table public.meal_companions enable row level security;
alter table public.recommendation_events enable row level security;

-- (select auth.uid()) is evaluated once per query instead of once per row.

create policy "Read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "Read categories" on public.categories
  for select to authenticated using (true);

create policy "Read own taste profile" on public.taste_profiles
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Read own companions" on public.companions
  for select to authenticated using (user_id = (select auth.uid()));

-- Shared Geoapify places, plus the user's own unresolved backfill places.
create policy "Read shared and own places" on public.places
  for select to authenticated
  using (owner_user_id is null or owner_user_id = (select auth.uid()));

create policy "Read own sessions" on public.sessions
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Read own session companions" on public.session_companions
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Read own messages" on public.messages
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Read own meals" on public.meals
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Read own meal companions" on public.meal_companions
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Read own recommendation events" on public.recommendation_events
  for select to authenticated using (user_id = (select auth.uid()));
