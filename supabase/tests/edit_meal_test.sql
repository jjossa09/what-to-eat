-- Test for edit_meal() (P1-24). Run in the Supabase SQL Editor after applying
-- 20261105120000_edit_meal.sql. Everything runs in one transaction and is rolled back: no rows
-- are left behind. Success ends with the notice "edit_meal: all checks passed". Any failed
-- check raises an error naming it.

begin;

-- Setup (admin role): two users, a place, and four live picks for user A.
-- meal_a: went = true, nothing else yet (edit before finishing "Went?").
-- meal_b: went = null (not editable). meal_c: went = false (not editable).
-- meal_d: full answers (corrections).
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'authenticated', 'authenticated', 'edit-a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-0000000000e2', 'authenticated', 'authenticated', 'edit-b@test.invalid');

insert into public.places (id, name, lat, lon, category_id)
values ('node/999999101', 'Test Pizza', 33.95, -84.55, 'pizza');

insert into public.sessions (id, user_id, timezone, local_date, meal_slot, lat, lon, outcome) values
  ('11111111-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'America/New_York', '2026-10-31', 'late', 33.95, -84.55, 'picked'),
  ('11111111-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'America/New_York', '2026-10-31', 'late', 33.95, -84.55, 'picked'),
  ('11111111-0000-0000-0000-0000000000e3', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'America/New_York', '2026-10-31', 'late', 33.95, -84.55, 'picked'),
  ('11111111-0000-0000-0000-0000000000e4', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'America/New_York', '2026-10-31', 'late', 33.95, -84.55, 'picked');

insert into public.recommendation_events (user_id, session_id, round, place_id, event) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-0000000000e1', 2, 'node/999999101', 'picked'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-0000000000e2', 1, 'node/999999101', 'picked'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-0000000000e3', 1, 'node/999999101', 'picked'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-0000000000e4', 1, 'node/999999101', 'picked');

insert into public.meals (id, user_id, source, session_id, place_id, category_id, eaten_on, meal_slot, picked_at, solo, went, ate_at, dish, stars, price_tap) values
  ('22222222-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'live', '11111111-0000-0000-0000-0000000000e1', 'node/999999101', 'pizza', '2026-10-31', 'late', now(), true, true, null, null, null, null),
  ('22222222-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'live', '11111111-0000-0000-0000-0000000000e2', 'node/999999101', 'pizza', '2026-10-31', 'late', now(), true, null, null, null, null, null),
  ('22222222-0000-0000-0000-0000000000e3', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'live', '11111111-0000-0000-0000-0000000000e3', 'node/999999101', 'pizza', '2026-10-31', 'late', now(), true, false, null, null, null, null),
  ('22222222-0000-0000-0000-0000000000e4', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'live', '11111111-0000-0000-0000-0000000000e4', 'node/999999101', 'pizza', '2026-10-31', 'late', now(), true, true, now(), 'Pepperoni', 4, 2);

create function public.test_expect_error(label text, call text) returns void language plpgsql as $$
begin
  execute call;
  raise exception using errcode = 'P0099', message = 'expected an error: ' || label;
exception
  when sqlstate 'P0099' then raise;
  when others then null; -- failed as expected
end;
$$;
grant execute on function public.test_expect_error(text, text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-0000000000e1", "role": "authenticated"}', true);

do $$
declare
  a constant uuid := '22222222-0000-0000-0000-0000000000e1';
  b constant uuid := '22222222-0000-0000-0000-0000000000e2';
  c constant uuid := '22222222-0000-0000-0000-0000000000e3';
  d constant uuid := '22222222-0000-0000-0000-0000000000e4';
  r record;
  n int;
begin
  -- Rules.
  perform public.test_expect_error('nothing to change', format('select public.edit_meal(%L)', d));
  perform public.test_expect_error('went null', format('select public.edit_meal(%L, p_stars => 3::smallint)', b));
  perform public.test_expect_error('went false', format('select public.edit_meal(%L, p_stars => 3::smallint)', c));
  perform public.test_expect_error('stars 6', format('select public.edit_meal(%L, p_stars => 6::smallint)', d));
  perform public.test_expect_error('price 5', format('select public.edit_meal(%L, p_price_tap => 5::smallint)', d));
  perform public.test_expect_error('dish 61', format('select public.edit_meal(%L, p_dish => %L)', d, repeat('x', 61)));

  -- Corrections on meal_d: each changed field logs one edited event; unchanged ones log none.
  perform public.edit_meal(d, p_dish => 'Margherita', p_stars => 5::smallint,
                           p_price_tap => 2::smallint, p_solo => false);
  select dish, stars, price_tap, solo into r from public.meals where id = d;
  if r.dish <> 'Margherita' or r.stars <> 5 or r.price_tap <> 2 or r.solo is not false then
    raise exception 'meal_d: values not saved';
  end if;
  select count(*) into n from public.recommendation_events
    where session_id = '11111111-0000-0000-0000-0000000000e4' and edited;
  if n <> 3 then raise exception 'meal_d: expected 3 edited events (dish, stars, solo), got %', n; end if;
  select count(*) into n from public.recommendation_events
    where session_id = '11111111-0000-0000-0000-0000000000e4' and event = 'solo'
      and solo is false and edited and round = 1;
  if n <> 1 then raise exception 'meal_d: solo event missing'; end if;

  -- Same values again: no new events.
  perform public.edit_meal(d, p_dish => ' Margherita ', p_stars => 5::smallint, p_solo => false);
  select count(*) into n from public.recommendation_events
    where session_id = '11111111-0000-0000-0000-0000000000e4' and edited;
  if n <> 3 then raise exception 'meal_d: an unchanged edit logged an event'; end if;

  -- Blank dish clears it.
  perform public.edit_meal(d, p_dish => '  ');
  select dish into r from public.meals where id = d;
  if r.dish is not null then raise exception 'meal_d: blank dish should clear'; end if;

  -- meal_a: edit before finishing "Went?". A dish records the food answer (ate_at set, the
  -- meal's category), and a price. Then the prompt's remaining step (stars) still works, and
  -- its food and price steps are refused (they were answered).
  perform public.edit_meal(a, p_dish => 'Garlic knots', p_price_tap => 1::smallint);
  select ate_at, category_id, dish, price_tap into r from public.meals where id = a;
  if r.ate_at is null or r.category_id <> 'pizza' or r.dish <> 'Garlic knots' or r.price_tap <> 1 then
    raise exception 'meal_a: dish edit should record the food answer';
  end if;
  select count(*) into n from public.recommendation_events
    where session_id = '11111111-0000-0000-0000-0000000000e1' and event = 'ate'
      and ate_category_id = 'pizza' and edited and round = 2;
  if n <> 1 then raise exception 'meal_a: ate event should use the pick round (2)'; end if;

  perform public.test_expect_error('prompt food after edit',
    format('select public.save_meal_feedback(%L, p_category => ''pizza'')', a));
  perform public.save_meal_feedback(a, p_stars => 4::smallint);
  perform public.test_expect_error('prompt price after edit',
    format('select public.save_meal_feedback(%L, p_price_tap => 2::smallint)', a));
  select stars, price_tap into r from public.meals where id = a;
  if r.stars <> 4 or r.price_tap <> 1 then raise exception 'meal_a: stars from prompt, price from edit'; end if;
  select count(*) into n from public.recommendation_events
    where session_id = '11111111-0000-0000-0000-0000000000e1' and event = 'stars' and not edited;
  if n <> 1 then raise exception 'meal_a: prompt stars should not be marked edited'; end if;
end;
$$;

-- Another user cannot edit user A's meals.
select set_config('request.jwt.claims',
  '{"sub": "bbbbbbbb-0000-0000-0000-0000000000e2", "role": "authenticated"}', true);
select public.test_expect_error('other user',
  'select public.edit_meal(''22222222-0000-0000-0000-0000000000e4'', p_stars => 1::smallint)');

-- Signed out: anon has no execute grant.
set local role anon;
do $$
begin
  perform public.edit_meal('22222222-0000-0000-0000-0000000000e4', p_stars => 1::smallint);
  raise exception 'anon should not be able to call edit_meal';
exception
  when insufficient_privilege then null;
end;
$$;

do $$ begin raise notice 'edit_meal: all checks passed'; end $$;

rollback;
