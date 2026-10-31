-- Test for save_meal_feedback() (P1-17). Run in the Supabase SQL Editor after applying
-- 20261104120000_meal_feedback.sql and 20261104130000_meal_feedback_food.sql. Everything runs in one transaction and is rolled back:
-- no rows are left behind. Success ends with the notice "meal_feedback: all checks passed".
-- Any failed check raises an error naming it.

begin;

-- Setup (as the SQL Editor's admin role): two throwaway users, a shared place, and four live
-- picks for user A (meal_a: correction path, meal_b: full flow, meal_c: went = false,
-- meal_d: food answer with no dish).

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'feedback-a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'feedback-b@test.invalid');

insert into public.places (id, name, lat, lon, category_id)
values ('node/999999001', 'Test Thai', 33.95, -84.55, 'thai');

insert into public.sessions (id, user_id, timezone, local_date, meal_slot, lat, lon, outcome) values
  ('11111111-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'America/New_York', '2026-11-03', 'dinner', 33.95, -84.55, 'picked'),
  ('11111111-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000a', 'America/New_York', '2026-11-03', 'dinner', 33.95, -84.55, 'picked'),
  ('11111111-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000a', 'America/New_York', '2026-11-03', 'dinner', 33.95, -84.55, 'picked'),
  ('11111111-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-00000000000a', 'America/New_York', '2026-11-03', 'dinner', 33.95, -84.55, 'picked');

insert into public.recommendation_events (user_id, session_id, round, place_id, event) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000a', 2, 'node/999999001', 'picked'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000b', 1, 'node/999999001', 'picked'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000c', 1, 'node/999999001', 'picked'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000d', 1, 'node/999999001', 'picked');

insert into public.meals (id, user_id, source, session_id, place_id, category_id, eaten_on, meal_slot, picked_at) values
  ('22222222-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'live', '11111111-0000-0000-0000-00000000000a', 'node/999999001', 'thai', '2026-11-03', 'dinner', now()),
  ('22222222-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000a', 'live', '11111111-0000-0000-0000-00000000000b', 'node/999999001', 'thai', '2026-11-03', 'dinner', now()),
  ('22222222-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000a', 'live', '11111111-0000-0000-0000-00000000000c', 'node/999999001', 'thai', '2026-11-03', 'dinner', now()),
  ('22222222-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-00000000000a', 'live', '11111111-0000-0000-0000-00000000000d', 'node/999999001', 'thai', '2026-11-03', 'dinner', now());

-- Helper: runs a call that must fail. Created inside this transaction, so the rollback drops it.
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

-- Act as user A, signed in (what the app's session does).
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-00000000000a", "role": "authenticated"}', true);

do $$
declare
  a constant uuid := '22222222-0000-0000-0000-00000000000a';
  b constant uuid := '22222222-0000-0000-0000-00000000000b';
  c constant uuid := '22222222-0000-0000-0000-00000000000c';
  d constant uuid := '22222222-0000-0000-0000-00000000000d';
  r record;
begin
  -- Order and validation.
  perform public.test_expect_error('food before went', format('select public.save_meal_feedback(%L, p_category => ''thai'')', a));
  perform public.test_expect_error('stars before went', format('select public.save_meal_feedback(%L, p_stars => 4::smallint)', a));
  perform public.test_expect_error('price before stars', format('select public.save_meal_feedback(%L, p_price_tap => 2::smallint)', a));
  perform public.test_expect_error('no answer', format('select public.save_meal_feedback(%L)', a));
  perform public.test_expect_error('two answers', format('select public.save_meal_feedback(%L, p_went => true, p_stars => 4::smallint)', a));
  perform public.test_expect_error('dish without category', format('select public.save_meal_feedback(%L, p_dish => ''wings'')', a));

  -- Auto-went, then the one correction (true -> false before the food answer and stars).
  perform public.save_meal_feedback(a, p_went => true);
  select went into r from public.meals where id = a;
  if r.went is not true then raise exception 'meal_a went should be true'; end if;

  perform public.save_meal_feedback(a, p_went => false);
  select went into r from public.meals where id = a;
  if r.went is not false then raise exception 'correction: meal_a went should be false'; end if;

  select count(*) filter (where went is true) as yes, count(*) filter (where went is false) as no,
         min(round) as rnd
    into r from public.recommendation_events
   where session_id = '11111111-0000-0000-0000-00000000000a' and event = 'went';
  if r.yes <> 1 or r.no <> 1 then raise exception 'meal_a should log went true then went false'; end if;
  if r.rnd <> 2 then raise exception 'went events should use the picked round (2)'; end if;

  perform public.test_expect_error('went flip back to true', format('select public.save_meal_feedback(%L, p_went => true)', a));
  perform public.test_expect_error('food after went false', format('select public.save_meal_feedback(%L, p_category => ''thai'')', a));
  perform public.test_expect_error('stars after went false', format('select public.save_meal_feedback(%L, p_stars => 3::smallint)', a));

  -- Full flow: went, what you had, stars, price.
  perform public.save_meal_feedback(b, p_went => true);
  perform public.test_expect_error('stars before food', format('select public.save_meal_feedback(%L, p_stars => 4::smallint)', b));
  perform public.test_expect_error('unknown category', format('select public.save_meal_feedback(%L, p_category => ''sushi'')', b));
  perform public.test_expect_error('Other is not a food answer', format('select public.save_meal_feedback(%L, p_category => ''other'')', b));
  perform public.test_expect_error('dish too long', format('select public.save_meal_feedback(%L, p_category => ''thai'', p_dish => %L)', b, repeat('x', 61)));
  perform public.save_meal_feedback(b, p_category => 'chicken_wings', p_dish => '  wings  ');
  perform public.test_expect_error('food twice', format('select public.save_meal_feedback(%L, p_category => ''thai'')', b));
  perform public.test_expect_error('correction after food', format('select public.save_meal_feedback(%L, p_went => false)', b));

  select category_id, dish, ate_at into r from public.meals where id = b;
  if r.category_id <> 'chicken_wings' or r.dish <> 'wings' or r.ate_at is null then
    raise exception 'meal_b food should be chicken_wings / wings (got %, %, %)', r.category_id, r.dish, r.ate_at;
  end if;
  select category_id into r from public.places where id = 'node/999999001';
  if r.category_id <> 'thai' then raise exception 'the place should keep its own category (thai)'; end if;
  select ate_category_id, dish into r from public.recommendation_events
   where session_id = '11111111-0000-0000-0000-00000000000b' and event = 'ate';
  if r.ate_category_id is distinct from 'chicken_wings' or r.dish is distinct from 'wings' then
    raise exception 'meal_b should log an ate event with chicken_wings / wings';
  end if;

  perform public.test_expect_error('stars out of range', format('select public.save_meal_feedback(%L, p_stars => 6::smallint)', b));
  perform public.save_meal_feedback(b, p_stars => 4::smallint);
  perform public.test_expect_error('stars twice', format('select public.save_meal_feedback(%L, p_stars => 5::smallint)', b));
  perform public.test_expect_error('price out of range', format('select public.save_meal_feedback(%L, p_price_tap => 5::smallint)', b));
  perform public.save_meal_feedback(b, p_price_tap => 2::smallint);
  perform public.test_expect_error('price twice', format('select public.save_meal_feedback(%L, p_price_tap => 3::smallint)', b));

  select went, stars, price_tap, price_level into r from public.meals where id = b;
  if r.went is not true or r.stars <> 4 or r.price_tap <> 2 or r.price_level <> 2 then
    raise exception 'meal_b should be went/4 stars/price 2 (got %, %, %, %)', r.went, r.stars, r.price_tap, r.price_level;
  end if;
  select count(*) as n into r from public.recommendation_events
   where session_id = '11111111-0000-0000-0000-00000000000b' and event in ('went', 'ate', 'stars', 'price_tap');
  if r.n <> 4 then raise exception 'meal_b should log 4 feedback events (got %)', r.n; end if;

  -- Food with no dish: the dish stays empty.
  perform public.save_meal_feedback(d, p_went => true);
  perform public.save_meal_feedback(d, p_category => 'thai', p_dish => '   ');
  select dish, ate_at into r from public.meals where id = d;
  if r.dish is not null or r.ate_at is null then raise exception 'meal_d: blank dish should be stored as null'; end if;

  -- No: went = false, then nothing else.
  perform public.save_meal_feedback(c, p_went => false);
  perform public.test_expect_error('went twice after No', format('select public.save_meal_feedback(%L, p_went => true)', c));
end;
$$;

-- Another user cannot touch user A's meals.
select set_config('request.jwt.claims',
  '{"sub": "bbbbbbbb-0000-0000-0000-00000000000b", "role": "authenticated"}', true);
select public.test_expect_error('other user',
  'select public.save_meal_feedback(''22222222-0000-0000-0000-00000000000c'', p_went => true)');

-- Signed out: anon has no execute grant.
set local role anon;
do $$
begin
  perform public.save_meal_feedback('22222222-0000-0000-0000-00000000000c', p_went => true);
  raise exception 'anon should not be able to call save_meal_feedback';
exception
  when insufficient_privilege then null; -- expected: no execute grant for anon
end;
$$;

do $$ begin raise notice 'meal_feedback: all checks passed'; end $$;

rollback;
