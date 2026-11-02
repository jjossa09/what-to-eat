-- P2-06: a dish edit no longer records the food answer. Replaces edit_meal() from
-- 20261105120000_edit_meal.sql (same signature, so grants are kept).
--
-- Before: a dish on a meal with no food answer also set ate_at, so the meal counted for the
-- cuisine model (ML3) with the place's pick-time category, which the user never confirmed.
-- Now: a dish edit saves only the dish. ate_at is set only by the "What did you have?" answer
-- (save_meal_feedback), so the meal counts for cuisine only after a real food answer.
--
-- Live meals with went = true only. Editable: dish, stars, price tap, solo / with people. Not
-- editable: food category, went (the FR11 prompt owns it), place, date, slot, and backfill
-- meals. Each changed field logs its funnel event with edited = true (R3, ML8); an unchanged
-- field logs nothing. A dish edit logs an 'ate' event with the meal's current category_id
-- (it is not a food answer; meals.ate_at is the source of truth for that).

create or replace function public.edit_meal(
  p_meal_id uuid,
  p_dish text default null,
  p_stars smallint default null,
  p_price_tap smallint default null,
  p_solo boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  m public.meals%rowtype;
  clean_dish text := nullif(btrim(coalesce(p_dish, '')), '');
  pick_round smallint;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_dish is null and p_stars is null and p_price_tap is null and p_solo is null then
    raise exception 'nothing to change' using errcode = '22023';
  end if;
  if p_stars is not null and p_stars not between 1 and 5 then
    raise exception 'stars must be 1 to 5' using errcode = '22023';
  end if;
  if p_price_tap is not null and p_price_tap not between 1 and 4 then
    raise exception 'price must be 1 to 4' using errcode = '22023';
  end if;
  if char_length(clean_dish) > 60 then
    raise exception 'dish must be 60 characters or fewer' using errcode = '22023';
  end if;

  select * into m from public.meals
  where id = p_meal_id and user_id = uid and source = 'live'
  for update;
  if not found or m.session_id is null or m.place_id is null then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if m.went is not true then
    raise exception 'edit only after went = true' using errcode = '23514';
  end if;

  -- Same round rule as save_meal_feedback: the pick's round, else the latest shown round.
  select coalesce(
    (select e.round from public.recommendation_events e
     where e.session_id = m.session_id and e.place_id = m.place_id and e.event = 'picked'
     order by e.created_at desc limit 1),
    (select max(e.round) from public.recommendation_events e
     where e.session_id = m.session_id and e.place_id = m.place_id and e.event = 'shown'),
    1
  ) into pick_round;

  -- The dish only; ate_at is left as it is (null stays null).
  if p_dish is not null and clean_dish is distinct from m.dish then
    if m.category_id is null then
      raise exception 'meal has no category' using errcode = '23514';
    end if;
    update public.meals set dish = clean_dish where id = m.id;
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, ate_category_id, dish, edited)
    values (uid, m.session_id, pick_round, m.place_id, 'ate', m.category_id, clean_dish, true);
  end if;

  if p_stars is not null and p_stars is distinct from m.stars then
    update public.meals set stars = p_stars where id = m.id;
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, stars, edited)
    values (uid, m.session_id, pick_round, m.place_id, 'stars', p_stars, true);
  end if;

  if p_price_tap is not null and p_price_tap is distinct from m.price_tap then
    update public.meals set price_tap = p_price_tap where id = m.id;
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, price_level, edited)
    values (uid, m.session_id, pick_round, m.place_id, 'price_tap', p_price_tap, true);
  end if;

  if p_solo is not null and p_solo is distinct from m.solo then
    update public.meals set solo = p_solo where id = m.id;
    insert into public.recommendation_events
      (user_id, session_id, round, place_id, event, solo, edited)
    values (uid, m.session_id, pick_round, m.place_id, 'solo', p_solo, true);
  end if;
end;
$$;

comment on function public.edit_meal(uuid, text, smallint, smallint, boolean) is
  'Meal card edit (P1-24, P2-06): dish, stars, price tap, solo. A dish edit never sets ate_at; '
  'only the "What did you have?" answer does, so the meal counts for cuisine only after it.';
