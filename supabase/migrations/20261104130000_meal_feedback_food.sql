-- P1-17 follow-up: "What did you have?" between went and stars. The meal records the food
-- (category, optional dish); the place keeps its own category. Order: went -> what you had ->
-- stars -> price. Runs after 20261104120000_meal_feedback.sql and replaces its function.

-- Meals: the food answer. ate_at marks it as given (dish is optional, so it can't).
alter table public.meals
  add column dish text check (char_length(dish) between 1 and 60),
  add column ate_at timestamptz;

-- Funnel: a new 'ate' event with what was eaten.
alter table public.recommendation_events
  add column ate_category_id text references public.categories,
  add column dish text check (char_length(dish) between 1 and 60);

-- Replace the event checks (the column check and the per-event check from P1-06; both
-- unnamed there) with named versions that include 'ate'.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.recommendation_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%''price_tap''%'
  loop
    execute format('alter table public.recommendation_events drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.recommendation_events
  add constraint recommendation_events_event_type check (
    event in ('shown', 'interested', 'rejected', 'picked', 'went', 'ate', 'stars', 'price_tap')
  ),
  add constraint recommendation_events_event_fields check (
    (event = 'shown' and rank is not null and slot is not null)
    or (event = 'interested' and interest_kind is not null)
    or (event = 'rejected' and reject_reason is not null)
    or event = 'picked'
    or (event = 'went' and went is not null)
    or (event = 'ate' and ate_category_id is not null)
    or (event = 'stars' and stars is not null)
    or (event = 'price_tap' and price_level is not null)
  );

drop function if exists public.save_meal_feedback(uuid, boolean, smallint, smallint);

-- One answer per call: p_went, p_category (+ optional p_dish), p_stars, or p_price_tap.
-- The one correction: went true -> false before the food answer and before stars.
create function public.save_meal_feedback(
  p_meal_id uuid,
  p_went boolean default null,
  p_category text default null,
  p_dish text default null,
  p_stars smallint default null,
  p_price_tap smallint default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  m public.meals%rowtype;
  answers int := (p_went is not null)::int + (p_category is not null)::int
                 + (p_stars is not null)::int + (p_price_tap is not null)::int;
  clean_dish text := nullif(btrim(coalesce(p_dish, '')), '');
  pick_round smallint;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if answers <> 1 or (p_dish is not null and p_category is null) then
    raise exception 'send exactly one answer' using errcode = '22023';
  end if;

  select * into m from public.meals
  where id = p_meal_id and user_id = uid and source = 'live'
  for update;
  if not found or m.session_id is null or m.place_id is null then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;

  -- The round the place was picked in; else the latest round it was shown in.
  select coalesce(
    (select e.round from public.recommendation_events e
     where e.session_id = m.session_id and e.place_id = m.place_id and e.event = 'picked'
     order by e.created_at desc limit 1),
    (select max(e.round) from public.recommendation_events e
     where e.session_id = m.session_id and e.place_id = m.place_id and e.event = 'shown'),
    1
  ) into pick_round;

  if p_went is not null then
    if m.went is null
       or (m.went is true and p_went is false and m.ate_at is null and m.stars is null) then
      update public.meals set went = p_went where id = m.id;
      insert into public.recommendation_events
        (user_id, session_id, round, place_id, event, went)
      values (uid, m.session_id, pick_round, m.place_id, 'went', p_went);
    else
      raise exception 'went already answered' using errcode = '23514';
    end if;

  elsif p_category is not null then
    if m.went is not true or m.ate_at is not null then
      raise exception 'food answer not allowed now' using errcode = '23514';
    end if;
    if not exists (select 1 from public.categories k where k.id = p_category and k.predictable) then
      raise exception 'unknown category' using errcode = '22023';
    end if;
    if char_length(clean_dish) > 60 then
      raise exception 'dish must be 60 characters or fewer' using errcode = '22023';
    end if;
    update public.meals
      set category_id = p_category, dish = clean_dish, ate_at = now()
      where id = m.id;
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, ate_category_id, dish)
    values (uid, m.session_id, pick_round, m.place_id, 'ate', p_category, clean_dish);

  elsif p_stars is not null then
    if p_stars not between 1 and 5 then
      raise exception 'stars must be 1 to 5' using errcode = '22023';
    end if;
    if m.went is not true or m.ate_at is null or m.stars is not null then
      raise exception 'stars not allowed now' using errcode = '23514';
    end if;
    update public.meals set stars = p_stars where id = m.id;
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, stars)
    values (uid, m.session_id, pick_round, m.place_id, 'stars', p_stars);

  else
    if p_price_tap not between 1 and 4 then
      raise exception 'price must be 1 to 4' using errcode = '22023';
    end if;
    if m.stars is null or m.price_tap is not null then
      raise exception 'price not allowed now' using errcode = '23514';
    end if;
    update public.meals set price_tap = p_price_tap where id = m.id;
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, price_level)
    values (uid, m.session_id, pick_round, m.place_id, 'price_tap', p_price_tap);
  end if;
end;
$$;

revoke execute on function public.save_meal_feedback(uuid, boolean, text, text, smallint, smallint)
  from public, anon;
grant execute on function public.save_meal_feedback(uuid, boolean, text, text, smallint, smallint)
  to authenticated;
