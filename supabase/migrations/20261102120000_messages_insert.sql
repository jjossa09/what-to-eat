-- P1-09/P1-10: the chat transcript is written by the API as the user (the user's JWT through
-- PostgREST), in the same request as the first round, once the session exists.

create policy "Insert own messages" on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sessions s
      where s.id = session_id and s.user_id = (select auth.uid())
    )
  );
