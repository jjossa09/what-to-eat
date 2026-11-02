-- Test for append_session_gate() (P2-05). Run in the Supabase SQL Editor after applying
-- 20261109120000_session_gate.sql. Everything runs in one transaction and is rolled back: no
-- rows are left behind. Success ends with the notice "append_session_gate: all checks passed".
-- Any failed check raises an error naming it.

begin;

-- Setup (admin role): two users, one session each.
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a5', 'authenticated', 'authenticated', 'gate-a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-0000000000b5', 'authenticated', 'authenticated', 'gate-b@test.invalid');

insert into public.sessions (id, user_id, timezone, local_date, meal_slot, lat, lon) values
  ('11111111-0000-0000-0000-0000000000a5', 'aaaaaaaa-0000-0000-0000-0000000000a5', 'America/New_York', '2026-11-02', 'dinner', 33.95, -84.55),
  ('11111111-0000-0000-0000-0000000000b5', 'bbbbbbbb-0000-0000-0000-0000000000b5', 'America/New_York', '2026-11-02', 'dinner', 33.95, -84.55);

create function public.test_expect_error(label text, call text) returns void language plpgsql as $$
begin
  execute call;
  raise exception using errcode = 'P0099', message = 'expected an error: ' || label;
exception
  when sqlstate 'P0099' then raise;
  when others then null; -- failed as expected
end;
$$;
grant execute on function public.test_expect_error(text, text) to authenticated, anon;

-- The function must be SECURITY INVOKER (RLS applies as the caller).
do $$
begin
  if (select prosecdef from pg_proc where proname = 'append_session_gate') then
    raise exception 'append_session_gate must be security invoker';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-0000000000a5", "role": "authenticated"}', true);

do $$
declare
  mine constant uuid := '11111111-0000-0000-0000-0000000000a5';
  theirs constant uuid := '11111111-0000-0000-0000-0000000000b5';
  g jsonb;
begin
  -- Round 1: plan + entry.
  if not public.append_session_gate(mine, 1, '{"key": "budget"}', '{"questions": [1]}') then
    raise exception 'round 1 append returned false';
  end if;
  -- Round 2: entry only; the plan and round 1 stay.
  if not public.append_session_gate(mine, 2, '{"key": null}') then
    raise exception 'round 2 append returned false';
  end if;
  -- Round 2 again (a retry) replaces only round 2.
  perform public.append_session_gate(mine, 2, '{"key": "craving"}');
  select gate into g from public.sessions where id = mine;
  if g is distinct from '{"plan": {"questions": [1]},
                          "rounds": {"1": {"key": "budget"}, "2": {"key": "craving"}}}'::jsonb then
    raise exception 'unexpected gate: %', g;
  end if;

  -- Someone else's session: no row matches, nothing changes.
  if public.append_session_gate(theirs, 1, '{"key": "budget"}') then
    raise exception 'appended to another user''s session';
  end if;
  -- An unknown session: false.
  if public.append_session_gate(gen_random_uuid(), 1, '{"key": "budget"}') then
    raise exception 'appended to an unknown session';
  end if;

  -- Bad input.
  perform public.test_expect_error('round 0',
    $q$select public.append_session_gate('11111111-0000-0000-0000-0000000000a5', 0, '{}')$q$);
  perform public.test_expect_error('entry not an object',
    $q$select public.append_session_gate('11111111-0000-0000-0000-0000000000a5', 1, '[1]')$q$);
  perform public.test_expect_error('plan not an object',
    $q$select public.append_session_gate('11111111-0000-0000-0000-0000000000a5', 1, '{}', '3')$q$);
end;
$$;

-- Back to admin: user B's session is untouched.
reset role;
do $$
begin
  if (select gate from public.sessions where id = '11111111-0000-0000-0000-0000000000b5')
     is not null then
    raise exception 'user B''s session was changed';
  end if;
end;
$$;

-- Anonymous callers cannot run it.
set local role anon;
select public.test_expect_error('anon',
  $q$select public.append_session_gate('11111111-0000-0000-0000-0000000000a5', 1, '{}')$q$);
reset role;

do $$ begin raise notice 'append_session_gate: all checks passed'; end; $$;

rollback;
