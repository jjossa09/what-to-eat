-- P1-15: funnel logging (ML8, R3). User-owned rows are now written by the API as the user
-- (the user's JWT through PostgREST), so RLS checks every write. The shared places cache is
-- still written with the service role, from one API function only (app/funnel.py).

-- Which writer produced the shown card's reason (Muse or the deterministic template).
alter table public.recommendation_events
  add column reasons_source text check (reasons_source in ('muse', 'template'));

-- Sessions: create your own; update your own (answers, outcome, ended_at).
create policy "Insert own sessions" on public.sessions
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy "Update own sessions" on public.sessions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Funnel events: your own, and only on a session you own.
create policy "Insert own recommendation events" on public.recommendation_events
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sessions s
      where s.id = session_id and s.user_id = (select auth.uid())
    )
  );

-- Live meals at pick time: your own, on a session you own. Backfill stays service-side.
create policy "Insert own live meals" on public.meals
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and source = 'live'
    and exists (
      select 1 from public.sessions s
      where s.id = session_id and s.user_id = (select auth.uid())
    )
  );
