-- Test for the companion insert policies (P2-07). Run in the Supabase SQL Editor after applying
-- 20261110120000_companion_writes.sql. Everything runs in one transaction and is rolled back:
-- no rows are left behind. Success ends with the notice "companion_writes: all checks passed".
-- Any failed check raises an error naming it.

begin;

-- Setup (admin role): two users, each with a companion, a session, and a live meal. User A
-- also has a backfill meal (meal_companions for backfill go through import_backfill only).
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000c7', 'authenticated', 'authenticated', 'comp-a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-0000000000c7', 'authenticated', 'authenticated', 'comp-b@test.invalid');

insert into public.companions (id, user_id, name) values
  ('c0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'Test Friend A'),
  ('c0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-0000000000c7', 'Test Friend B');

insert into public.sessions (id, user_id, timezone, local_date, meal_slot, lat, lon) values
  ('11111111-0000-0000-0000-0000000000a7', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'America/New_York', '2026-11-02', 'dinner', 33.95, -84.55),
  ('11111111-0000-0000-0000-0000000000b7', 'bbbbbbbb-0000-0000-0000-0000000000c7', 'America/New_York', '2026-11-02', 'dinner', 33.95, -84.55);

insert into public.meals (id, user_id, source, session_id, category_id, eaten_on, meal_slot, picked_at) values
  ('22222222-0000-0000-0000-0000000000a7', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'live', '11111111-0000-0000-0000-0000000000a7', 'thai', '2026-11-02', 'dinner', now()),
  ('22222222-0000-0000-0000-0000000000b7', 'bbbbbbbb-0000-0000-0000-0000000000c7', 'live', '11111111-0000-0000-0000-0000000000b7', 'thai', '2026-11-02', 'dinner', now());
insert into public.meals (id, user_id, source, category_id, eaten_on, meal_slot) values
  ('22222222-0000-0000-0000-0000000000a8', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'backfill', 'pizza', '2026-10-30', 'lunch');

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

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-0000000000c7", "role": "authenticated"}', true);

do $$
declare
  me constant uuid := 'aaaaaaaa-0000-0000-0000-0000000000c7';
  them constant uuid := 'bbbbbbbb-0000-0000-0000-0000000000c7';
  my_session constant uuid := '11111111-0000-0000-0000-0000000000a7';
  their_session constant uuid := '11111111-0000-0000-0000-0000000000b7';
  my_friend constant uuid := 'c0000000-0000-0000-0000-0000000000a1';
  their_friend constant uuid := 'c0000000-0000-0000-0000-0000000000b1';
  my_meal constant uuid := '22222222-0000-0000-0000-0000000000a7';
  my_backfill constant uuid := '22222222-0000-0000-0000-0000000000a8';
  their_meal constant uuid := '22222222-0000-0000-0000-0000000000b7';
  n int;
begin
  -- session_companions: own session + own companion + own user_id.
  insert into public.session_companions (session_id, companion_id, user_id)
  values (my_session, my_friend, me);

  perform public.test_expect_error('session: someone else''s session', format(
    'insert into public.session_companions (session_id, companion_id, user_id) values (%L, %L, %L)', their_session, my_friend, me));
  perform public.test_expect_error('session: someone else''s companion', format(
    'insert into public.session_companions (session_id, companion_id, user_id) values (%L, %L, %L)', my_session, their_friend, me));
  perform public.test_expect_error('session: another user_id', format(
    'insert into public.session_companions (session_id, companion_id, user_id) values (%L, %L, %L)', my_session, my_friend, them));

  -- meal_companions: own live meal + own companion + own user_id.
  insert into public.meal_companions (meal_id, companion_id, user_id)
  values (my_meal, my_friend, me);

  perform public.test_expect_error('meal: a backfill meal', format(
    'insert into public.meal_companions (meal_id, companion_id, user_id) values (%L, %L, %L)', my_backfill, my_friend, me));
  perform public.test_expect_error('meal: someone else''s meal', format(
    'insert into public.meal_companions (meal_id, companion_id, user_id) values (%L, %L, %L)', their_meal, my_friend, me));
  perform public.test_expect_error('meal: someone else''s companion', format(
    'insert into public.meal_companions (meal_id, companion_id, user_id) values (%L, %L, %L)', my_meal, their_friend, me));
  perform public.test_expect_error('meal: another user_id', format(
    'insert into public.meal_companions (meal_id, companion_id, user_id) values (%L, %L, %L)', my_meal, my_friend, them));

  -- The caller reads back exactly their two rows.
  select count(*) into n from public.session_companions;
  if n <> 1 then raise exception 'expected 1 own session_companions row, saw %', n; end if;
  select count(*) into n from public.meal_companions;
  if n <> 1 then raise exception 'expected 1 own meal_companions row, saw %', n; end if;
end;
$$;

-- Anonymous callers cannot insert either.
reset role;
set local role anon;
select public.test_expect_error('anon: session_companions',
  $q$insert into public.session_companions (session_id, companion_id, user_id) values ('11111111-0000-0000-0000-0000000000a7',
     'c0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000c7')$q$);
select public.test_expect_error('anon: meal_companions',
  $q$insert into public.meal_companions (meal_id, companion_id, user_id) values ('22222222-0000-0000-0000-0000000000a7',
     'c0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000c7')$q$);
reset role;

-- Admin view: user B's session and meal, and A's backfill meal, got nothing.
do $$
declare n int;
begin
  select count(*) into n from public.session_companions
  where session_id = '11111111-0000-0000-0000-0000000000b7';
  if n <> 0 then raise exception 'user B''s session got a companion'; end if;
  select count(*) into n from public.meal_companions
  where meal_id in ('22222222-0000-0000-0000-0000000000b7', '22222222-0000-0000-0000-0000000000a8');
  if n <> 0 then raise exception 'a backfill or other user''s meal got a companion'; end if;
end;
$$;

do $$ begin raise notice 'companion_writes: all checks passed'; end; $$;

rollback;
