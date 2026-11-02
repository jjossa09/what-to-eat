-- P2-07 (FR15, ML1): who the user ate with, recorded on the live path. The API writes, with the
-- user's JWT (so RLS applies), one session_companions row per selected companion at round 1,
-- and copies them to meal_companions at pick. Insert only: these rows are never edited here.
-- Backfill keeps its own write path (import_backfill(), SECURITY DEFINER), so meal_companions
-- inserts here are limited to live meals.
--
-- Each policy checks, for the calling user: the row is theirs (user_id), the session or meal is
-- theirs, and the companion is theirs. The subqueries run under the caller's own read policies.

create policy "Insert own session companions" on public.session_companions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sessions s
      where s.id = session_id and s.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.companions c
      where c.id = companion_id and c.user_id = (select auth.uid())
    )
  );

create policy "Insert own meal companions" on public.meal_companions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.meals m
      where m.id = meal_id and m.user_id = (select auth.uid()) and m.source = 'live'
    )
    and exists (
      select 1 from public.companions c
      where c.id = companion_id and c.user_id = (select auth.uid())
    )
  );
