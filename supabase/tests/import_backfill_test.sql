-- Test for import_backfill() (P2-11). Run in the Supabase SQL Editor after applying
-- 20261106120000_import_backfill.sql. Everything runs in one transaction and is rolled back:
-- no rows are left behind. Success ends with the notice "import_backfill: all checks passed".
-- Any failed check raises an error naming it.

begin;

-- Setup (as the SQL Editor's admin role): two throwaway users, a shared place already in the
-- cache, and user B's own unresolved place named 'Mystery Spot'.

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'backfill-a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'backfill-b@test.invalid');

insert into public.places (id, name, lat, lon, category_id, geoapify_categories, address)
values ('node/999999100', 'Shared Original', 33.95, -84.55, 'thai', '{catering.restaurant.thai}',
        '1 Test St');

insert into public.places (id, name, category_id, unresolved, owner_user_id)
values ('unresolved:test-b', 'Mystery Spot', 'other', true, 'bbbbbbbb-0000-0000-0000-00000000000b');

-- Helper: an import that must fail; a single row object is sent as a one-row array.
-- Created inside this transaction, so the rollback drops it.
create function public.test_expect_import_error(label text, rows jsonb) returns void
language plpgsql as $$
begin
  perform public.import_backfill(
    case when jsonb_typeof(rows) = 'object' then jsonb_build_array(rows) else rows end);
  raise exception using errcode = 'P0099', message = 'expected an error: ' || label;
exception
  when sqlstate 'P0099' then raise;
  when others then null; -- failed as expected
end;
$$;
grant execute on function public.test_expect_import_error(text, jsonb) to authenticated;

-- Act as user A, signed in (what the script's session does).
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-00000000000a", "role": "authenticated"}', true);

do $$
declare
  a constant uuid := 'aaaaaaaa-0000-0000-0000-00000000000a';
  -- A new resolved place (its mapping is Other), with people, a price, and a dish.
  r1 constant jsonb := '{
    "eaten_on": "2026-10-01", "meal_slot": "dinner", "category_id": "pizza",
    "price_amount": "17.70", "solo": false, "companions": ["Ana", "ana ", " Bob"],
    "dish": "  Pepperoni slice ", "backfill_key": "2026-10-01|dinner|node/999999101",
    "place": {"id": "node/999999101", "name": "Test Slice", "lat": 33.96, "lon": -84.56,
              "address": "2 Test St", "geoapify_categories": ["catering.restaurant"],
              "category_id": "other"}}';
  -- Unresolved, same name as user B's unresolved place.
  r2 constant jsonb := '{
    "eaten_on": "2026-10-02", "meal_slot": "lunch", "category_id": "thai", "solo": true,
    "backfill_key": "2026-10-02|lunch|unresolved:mystery spot",
    "place": {"unresolved": true, "name": "Mystery Spot", "category_id": "other"}}';
  -- The shared place, sent with a different name and coordinates: must not overwrite it.
  r3 constant jsonb := '{
    "eaten_on": "2026-10-03", "meal_slot": "late", "category_id": "burgers",
    "backfill_key": "2026-10-03|late|node/999999100",
    "place": {"id": "node/999999100", "name": "Hacked", "lat": 1, "lon": 1,
              "category_id": "burgers"}}';
  base constant jsonb := '{
    "eaten_on": "2026-10-04", "meal_slot": "breakfast", "category_id": "coffee_bakery",
    "backfill_key": "2026-10-04|breakfast|node/999999102",
    "place": {"id": "node/999999102", "name": "Test Cafe", "lat": 33.9, "lon": -84.5,
              "category_id": "coffee_bakery"}}';
  res jsonb;
  m record;
  pl record;
  b_place_id text;
begin
  -- First import: 3 meals, 2 new places (r3's place already exists), 2 companions, 2 links.
  res := public.import_backfill(jsonb_build_array(r1, r2, r3));
  if res <> '{"meals_inserted": 3, "meals_skipped": 0, "places_inserted": 2,
              "companions_inserted": 2, "links_inserted": 2}'::jsonb then
    raise exception 'first import counts: %', res;
  end if;

  select * into m from public.meals where user_id = a and backfill_key = r1->>'backfill_key';
  if m.source <> 'backfill' or m.category_id <> 'pizza' or m.price_amount <> 17.70
     or m.price_level <> 2 or m.solo is not false or m.dish <> 'Pepperoni slice'
     or m.ate_at is not null or m.session_id is not null or m.place_id <> 'node/999999101' then
    raise exception 'r1 meal fields: %', row_to_json(m);
  end if;
  if (select count(*) from public.meal_companions mc where mc.meal_id = m.id) <> 2 then
    raise exception 'r1 links';
  end if;
  if (select array_agg(c.name order by c.name) from public.companions c where c.user_id = a)
     <> '{Ana,Bob}' then
    raise exception 'companion names';
  end if;

  -- Place category is the place's mapping (Other allowed), not the meal's food.
  select * into pl from public.places where id = 'node/999999101';
  if pl.category_id <> 'other' or pl.unresolved or pl.owner_user_id is not null then
    raise exception 'r1 place fields';
  end if;

  -- The shared place is unchanged.
  select * into pl from public.places where id = 'node/999999100';
  if pl.name <> 'Shared Original' or pl.lat <> 33.95 or pl.category_id <> 'thai' then
    raise exception 'shared place was overwritten';
  end if;

  -- r2 got A's own new unresolved place, not B's place with the same name.
  select * into m from public.meals where user_id = a and backfill_key = r2->>'backfill_key';
  if m.place_id = 'unresolved:test-b' then
    raise exception 'reused another user''s unresolved place';
  end if;
  select * into pl from public.places where id = m.place_id;
  if not pl.unresolved or pl.owner_user_id <> a or pl.category_id <> 'other'
     or pl.lat is not null or m.solo is not true or m.price_amount is not null then
    raise exception 'r2 fields';
  end if;

  -- Re-run: nothing new.
  res := public.import_backfill(jsonb_build_array(r1, r2, r3));
  if res <> '{"meals_inserted": 0, "meals_skipped": 3, "places_inserted": 0,
              "companions_inserted": 0, "links_inserted": 0}'::jsonb then
    raise exception 're-run counts: %', res;
  end if;

  -- A new meal at the same unresolved place (any case) reuses A's place.
  res := public.import_backfill(jsonb_build_array(
    r2 || '{"eaten_on": "2026-10-05", "backfill_key": "2026-10-05|lunch|unresolved:mystery spot"}'
       || jsonb_build_object('place', (r2->'place') || '{"name": "MYSTERY SPOT"}')));
  if (res->>'meals_inserted')::int <> 1 or (res->>'places_inserted')::int <> 0 then
    raise exception 'unresolved reuse counts: %', res;
  end if;
  if (select count(*) from public.places p where p.unresolved and p.owner_user_id = a) <> 1 then
    raise exception 'unresolved place duplicated';
  end if;

  -- The base row is valid.
  res := public.import_backfill(jsonb_build_array(base));
  if (res->>'meals_inserted')::int <> 1 then
    raise exception 'base row: %', res;
  end if;

  -- Validation. Each bad call writes nothing.
  perform public.test_expect_import_error('not an array', '"rows"');
  perform public.test_expect_import_error('empty', '[]');
  perform public.test_expect_import_error('over 500 rows',
    (select jsonb_agg(base) from generate_series(1, 501)));
  perform public.test_expect_import_error('future date',
    base || jsonb_build_object('eaten_on', current_date + 5));
  perform public.test_expect_import_error('bad slot', base || '{"meal_slot": "brunch"}');
  perform public.test_expect_import_error('blank slot', base - 'meal_slot');
  perform public.test_expect_import_error('meal category other', base || '{"category_id": "other"}');
  perform public.test_expect_import_error('unknown meal category', base || '{"category_id": "tapas"}');
  perform public.test_expect_import_error('negative price', base || '{"price_amount": "-1"}');
  perform public.test_expect_import_error('3 decimals', base || '{"price_amount": "1.234"}');
  perform public.test_expect_import_error('price too big', base || '{"price_amount": "100000"}');
  perform public.test_expect_import_error('dish 61 chars',
    base || jsonb_build_object('dish', repeat('x', 61)));
  perform public.test_expect_import_error('solo with companions',
    base || '{"solo": true, "companions": ["Ana"]}');
  perform public.test_expect_import_error('with people but no names', base || '{"solo": false}');
  perform public.test_expect_import_error('companion not a string',
    base || '{"solo": false, "companions": [5]}');
  perform public.test_expect_import_error('key mismatch',
    base || '{"backfill_key": "2026-10-04|lunch|node/999999102"}');
  perform public.test_expect_import_error('unknown place category',
    jsonb_set(base, '{place,category_id}', '"tapas"'));
  perform public.test_expect_import_error('lat 91', jsonb_set(base, '{place,lat}', '91'));
  perform public.test_expect_import_error('lon -181', jsonb_set(base, '{place,lon}', '-181'));
  perform public.test_expect_import_error('lat missing', base #- '{place,lat}');
  perform public.test_expect_import_error('blank place name', jsonb_set(base, '{place,name}', '"  "'));
  perform public.test_expect_import_error('place name 201 chars',
    jsonb_set(base, '{place,name}', to_jsonb(repeat('x', 201))));
  perform public.test_expect_import_error('resolved id unresolved:',
    jsonb_set(base || '{"backfill_key": "2026-10-04|breakfast|unresolved:x"}',
              '{place,id}', '"unresolved:x"'));
  perform public.test_expect_import_error('unresolved with coordinates',
    r2 || jsonb_build_object('place', (r2->'place') || '{"lat": 1, "lon": 1}'));
  perform public.test_expect_import_error('unresolved bad key',
    r2 || '{"backfill_key": "2026-10-02|lunch|node/1"}');

  -- One transaction: a valid row followed by a bad one leaves nothing behind.
  perform public.test_expect_import_error('atomic', jsonb_build_array(
    base || '{"eaten_on": "2026-10-06", "backfill_key": "2026-10-06|breakfast|node/999999102"}',
    base || '{"category_id": "other"}'));
  if exists (select 1 from public.meals where user_id = a and eaten_on = '2026-10-06') then
    raise exception 'partial import was kept';
  end if;
end;
$$;

-- User B's unresolved place is untouched, and B sees none of A's meals.
select set_config('request.jwt.claims',
  '{"sub": "bbbbbbbb-0000-0000-0000-00000000000b", "role": "authenticated"}', true);
do $$
begin
  if (select count(*) from public.meals) <> 0 then
    raise exception 'user B can see meals';
  end if;
  if not exists (select 1 from public.places where id = 'unresolved:test-b' and name = 'Mystery Spot') then
    raise exception 'user B''s unresolved place changed';
  end if;
end;
$$;

-- Signed out: anon has no execute grant.
set local role anon;
do $$
begin
  perform public.import_backfill('[]');
  raise exception 'anon should not be able to call import_backfill';
exception
  when insufficient_privilege then null; -- expected: no execute grant for anon
end;
$$;

do $$ begin raise notice 'import_backfill: all checks passed'; end $$;

rollback;
