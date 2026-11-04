-- #80. Run only against an isolated test database with all migrations applied.
-- Includes real function calls and injected failures; all fixtures/DDL roll back.
-- psql -v ON_ERROR_STOP=1 -f supabase/tests/pick_integrity_test.sql TEST_DATABASE
begin;

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-000000000080', 'authenticated', 'authenticated', 'pick-a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000080', 'authenticated', 'authenticated', 'pick-b@test.invalid');
insert into public.places (id, name, lat, lon, category_id) values
  ('synthetic:pick-a', 'Synthetic A', 1.001, 2, 'thai'),
  ('synthetic:pick-b', 'Synthetic B', 1.002, 2, 'thai');
insert into public.sessions (id, user_id, timezone, local_date, meal_slot, lat, lon, budget_level, solo)
select ('11111111-0080-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'aaaaaaaa-0000-0000-0000-000000000080', 'America/New_York', '2026-11-03',
  'lunch', 1, 2, 3, true from generate_series(1, 12) n;
insert into public.sessions (id, user_id, timezone, local_date, meal_slot, lat, lon)
values ('bbbbbbbb-0080-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000080',
  'America/New_York', '2026-11-03', 'lunch', 1, 2);
insert into public.recommendation_events
  (user_id, session_id, round, place_id, event, rank, slot, decision_budget_level)
select user_id, id, 1, 'synthetic:pick-a', 'shown', 1, 'discovery', 1
from public.sessions where user_id = 'aaaaaaaa-0000-0000-0000-000000000080';
insert into public.recommendation_events
  (user_id, session_id, round, place_id, event, rank, slot, decision_budget_level)
values ('bbbbbbbb-0000-0000-0000-000000000080', 'bbbbbbbb-0080-0000-0000-000000000001',
  1, 'synthetic:pick-a', 'shown', 1, 'discovery', 2);
insert into public.recommendation_events
  (user_id, session_id, round, place_id, event, rank, slot, decision_budget_level)
values
  ('aaaaaaaa-0000-0000-0000-000000000080', '11111111-0080-0000-0000-000000000001',
   2, 'synthetic:pick-a', 'shown', 1, 'discovery', 3),
  ('aaaaaaaa-0000-0000-0000-000000000080', '11111111-0080-0000-0000-000000000001',
   1, 'synthetic:pick-b', 'shown', 2, 'discovery', 1),
  ('aaaaaaaa-0000-0000-0000-000000000080', '11111111-0080-0000-0000-000000000003',
   4, 'synthetic:pick-a', 'shown', 1, 'discovery', 2);
-- A legacy shown event has no budget snapshot even though the session now has 3.
update public.recommendation_events set decision_budget_level = null
where session_id = '11111111-0080-0000-0000-000000000002';

-- #75: this fixture's solo answer is explicitly confirmed for each displayed round.
update public.recommendation_events set decision_company='{"confirmed":true,"solo":true,"companion_ids":[]}'
where event='shown' and user_id='aaaaaaaa-0000-0000-0000-000000000080';

create function public.test_pick_assert(ok boolean, label text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'assertion failed: %', label; end if;
end; $$;
grant execute on function public.test_pick_assert(boolean, text) to authenticated;

create function public.test_pick_fail() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'recommendation_events' then
    if new.event <> 'picked' then return new; end if;
  end if;
  if current_setting('wte80.fail', true) = 'skip_closure' and tg_table_name = 'sessions' then
    return null;
  end if;
  if current_setting('wte80.fail', true) = tg_table_name then
    raise exception 'injected failure' using errcode = 'P0080';
  end if;
  return new;
end; $$;
create trigger test_pick_meal before insert on public.meals
  for each row execute function public.test_pick_fail();
create trigger test_pick_event before insert on public.recommendation_events
  for each row execute function public.test_pick_fail();
create trigger test_pick_closure before update on public.sessions
  for each row execute function public.test_pick_fail();

select public.test_pick_assert(not (select prosecdef from pg_proc
  where oid = 'public.save_recommendation_pick(uuid,integer,text,integer)'::regprocedure),
  'function is SECURITY INVOKER');
select public.test_pick_assert(not has_function_privilege('anon',
  'public.save_recommendation_pick(uuid,integer,text,integer)', 'execute'), 'anon cannot execute');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000080","role":"authenticated"}', true);

do $$
declare
  sid constant uuid := '11111111-0080-0000-0000-000000000001';
  saved record;
  replay record;
  before_meal jsonb;
  before_session jsonb;
  before_event jsonb;
begin
  select * into saved from public.save_recommendation_pick(sid, 1, 'synthetic:pick-a', 123);
  perform public.test_pick_assert(saved.status = 'saved' and saved.meal_id is not null, 'new save');
  perform public.test_pick_assert((select budget_level = 1 and distance_m = 123 and solo
    and category_id = 'thai' and ate_at is null and eaten_on = '2026-11-03' and meal_slot = 'lunch'
    from public.meals where id = saved.meal_id), 'original budget and meal context');
  perform public.test_pick_assert((select outcome = 'picked' and ended_at = m.picked_at
    from public.sessions s join public.meals m on m.session_id = s.id where s.id = sid),
    'closure and meal commit together');
  perform public.test_pick_assert((select count(*) = 1 from public.recommendation_events
    where session_id = sid and event = 'picked' and round = 1 and place_id = 'synthetic:pick-a'),
    'original picked identity');

  -- Exact retry after a lost response must preserve later real food/feedback too.
  perform public.save_meal_feedback(saved.meal_id, p_went => true);
  perform public.save_meal_feedback(saved.meal_id, p_category => 'pizza', p_dish => 'Synthetic dish');
  perform public.save_meal_feedback(saved.meal_id, p_stars => 4::smallint);
  perform public.save_meal_feedback(saved.meal_id, p_price_tap => 2::smallint);
  select to_jsonb(m) into before_meal from public.meals m where m.id = saved.meal_id;
  select to_jsonb(s) into before_session from public.sessions s where s.id = sid;
  select to_jsonb(e) into before_event from public.recommendation_events e
    where e.session_id = sid and e.event = 'picked';
  select * into replay from public.save_recommendation_pick(sid, 1, 'synthetic:pick-a', 999);
  perform public.test_pick_assert(replay.status = 'replayed' and replay.meal_id = saved.meal_id,
    'exact retry returns original ID');
  perform public.test_pick_assert(before_meal = (select to_jsonb(m) from public.meals m
    where m.id = saved.meal_id), 'retry leaves ALL meal data unchanged');
  perform public.test_pick_assert((select category_id = 'thai' from public.places
    where id = 'synthetic:pick-a'), 'food answer never relabels the restaurant');
  perform public.test_pick_assert(before_session = (select to_jsonb(s) from public.sessions s
    where s.id = sid), 'retry leaves session timestamps unchanged');
  perform public.test_pick_assert(before_event = (select to_jsonb(e) from public.recommendation_events e
    where e.session_id = sid and e.event = 'picked'), 'retry leaves picked event unchanged');
  perform public.test_pick_assert((select count(*) = 1 from public.meals where session_id = sid),
    'one meal after retry');
  perform public.test_pick_assert((select status = 'conflict' from
    public.save_recommendation_pick(sid, 1, 'synthetic:pick-b', 200)), 'different place conflicts');
  perform public.test_pick_assert((select status = 'conflict' from
    public.save_recommendation_pick(sid, 2, 'synthetic:pick-a', 200)), 'different round conflicts');
end; $$;

do $$
declare r record;
begin
  select * into r from public.save_recommendation_pick(
    '11111111-0080-0000-0000-000000000002', 1, 'synthetic:pick-a', null);
  perform public.test_pick_assert((select budget_level is null and distance_m is null
    from public.meals where id = r.meal_id), 'legacy snapshot remains unknown');
  select * into r from public.save_recommendation_pick(
    '11111111-0080-0000-0000-000000000003', 4, 'synthetic:pick-a', 200);
  perform public.test_pick_assert((select budget_level = 2 from public.meals where id = r.meal_id),
    'cap uses displayed round, not first shown or current session budget');
end; $$;

-- Inject failures at each core write, AFTER any previous writes in the function.
-- The exception block is a real PostgreSQL subtransaction: it must roll back them all.
do $$
declare
  n integer := 4;
  sid uuid;
  target text;
  result record;
begin
  foreach target in array array['meals', 'recommendation_events', 'sessions'] loop
    sid := ('11111111-0080-0000-0000-' || lpad(n::text, 12, '0'))::uuid;
    perform set_config('wte80.fail', target, true);
    begin
      perform public.save_recommendation_pick(sid, 1, 'synthetic:pick-a', 200);
      raise exception 'failure did not fire' using errcode = 'P0099';
    exception when sqlstate 'P0080' then null;
    end;
    perform set_config('wte80.fail', '', true);
    perform public.test_pick_assert((select outcome is null and ended_at is null
      from public.sessions where id = sid), target || ': closure rolled back');
    perform public.test_pick_assert(not exists (select 1 from public.meals where session_id = sid),
      target || ': meal rolled back');
    perform public.test_pick_assert(not exists (select 1 from public.recommendation_events
      where session_id = sid and event = 'picked'), target || ': picked event rolled back');
    select * into result from public.save_recommendation_pick(sid, 1, 'synthetic:pick-a', 200);
    perform public.test_pick_assert(result.status = 'saved', target || ': explicit retry succeeds');
    n := n + 1;
  end loop;
end; $$;

do $$
declare sid constant uuid := '11111111-0080-0000-0000-000000000012';
begin
  perform set_config('wte80.fail', 'skip_closure', true);
  begin
    perform public.save_recommendation_pick(sid, 1, 'synthetic:pick-a', 200);
    raise exception 'skipped closure was accepted' using errcode = 'P0099';
  exception when check_violation then null;
  end;
  perform set_config('wte80.fail', '', true);
  perform public.test_pick_assert((select outcome is null from public.sessions where id = sid),
    'zero-row closure stays open');
  perform public.test_pick_assert(not exists (select 1 from public.meals where session_id = sid),
    'zero-row closure rolls back meal');
  perform public.test_pick_assert(not exists (select 1 from public.recommendation_events
    where session_id = sid and event = 'picked'), 'zero-row closure rolls back event');
end; $$;

do $$
declare
  sid constant uuid := '11111111-0080-0000-0000-000000000007';
begin
  perform public.test_pick_assert((select status = 'not_found' from
    public.save_recommendation_pick('bbbbbbbb-0080-0000-0000-000000000001', 1,
      'synthetic:pick-a', 200)), 'another owner rejected');
  perform public.test_pick_assert((select status = 'not_found' from
    public.save_recommendation_pick(sid, 99, 'synthetic:pick-a', 200)), 'unshown round rejected');
  update public.sessions set outcome = 'none' where id = sid and outcome is null;
  perform public.test_pick_assert((select status = 'conflict' from
    public.save_recommendation_pick(sid, 1, 'synthetic:pick-a', 200)), 'none conflicts');
  perform public.test_pick_assert(not exists (select 1 from public.meals where session_id = sid),
    'no invented meal after none');
end; $$;

-- Legacy partial states are failures, never silently repaired or confirmed.
update public.sessions set outcome = 'picked'
where id in ('11111111-0080-0000-0000-000000000008', '11111111-0080-0000-0000-000000000009',
             '11111111-0080-0000-0000-000000000010');
insert into public.recommendation_events (user_id, session_id, round, place_id, event)
values ('aaaaaaaa-0000-0000-0000-000000000080', '11111111-0080-0000-0000-000000000009',
  1, 'synthetic:pick-a', 'picked');
insert into public.meals (user_id, source, session_id, place_id, category_id, eaten_on)
values ('aaaaaaaa-0000-0000-0000-000000000080', 'live',
  '11111111-0080-0000-0000-000000000010', 'synthetic:pick-a', 'thai', '2026-11-03');
do $$
declare n integer;
begin
  for n in 8..10 loop
    perform public.test_pick_assert((select status = 'inconsistent' from
      public.save_recommendation_pick(('11111111-0080-0000-0000-' || lpad(n::text,12,'0'))::uuid,
        1, 'synthetic:pick-a', 200)), 'legacy orphan ' || n || ' is not success');
  end loop;
end; $$;

insert into public.recommendation_events
  (user_id, session_id, round, place_id, event, rank, slot, decision_budget_level)
values ('aaaaaaaa-0000-0000-0000-000000000080', '11111111-0080-0000-0000-000000000011',
  1, 'synthetic:pick-a', 'shown', 1, 'discovery', 2);
select public.test_pick_assert((select status = 'inconsistent' from public.save_recommendation_pick(
  '11111111-0080-0000-0000-000000000011', 1, 'synthetic:pick-a', 200)),
  'contradictory duplicate context is never guessed');

do $$
begin
  begin
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, rank, slot, decision_budget_level)
    values ('aaaaaaaa-0000-0000-0000-000000000080', '11111111-0080-0000-0000-000000000012',
      1, 'synthetic:pick-a', 'shown', 1, 'discovery', 5);
    raise exception 'out-of-range snapshot accepted' using errcode = 'P0099';
  exception when check_violation then null;
  end;
  begin
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, decision_budget_level)
    values ('aaaaaaaa-0000-0000-0000-000000000080', '11111111-0080-0000-0000-000000000012',
      1, 'synthetic:pick-a', 'picked', 1);
    raise exception 'snapshot on non-shown event accepted' using errcode = 'P0099';
  exception when check_violation then null;
  end;
  begin
    perform public.save_recommendation_pick('11111111-0080-0000-0000-000000000012',
      0, 'synthetic:pick-a', 200);
    raise exception 'invalid round accepted' using errcode = 'P0099';
  exception when sqlstate '22023' then null;
  end;
end; $$;

select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000080","role":"authenticated"}', true);
select public.test_pick_assert((select status = 'not_found' from public.save_recommendation_pick(
  '11111111-0080-0000-0000-000000000001', 1, 'synthetic:pick-a', 123)),
  'other user cannot replay the first user meal');
select public.test_pick_assert((select status = 'saved' from public.save_recommendation_pick(
  'bbbbbbbb-0080-0000-0000-000000000001', 1, 'synthetic:pick-a', 123)),
  'second user can save own shown recommendation');
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  begin
    perform public.save_recommendation_pick('bbbbbbbb-0080-0000-0000-000000000001',
      1, 'synthetic:pick-a', 123);
    raise exception 'missing identity accepted' using errcode = 'P0099';
  exception when sqlstate '28000' then null;
  end;
end; $$;

reset role;
do $$ begin raise notice 'pick integrity: all checks passed'; end; $$;
rollback;
