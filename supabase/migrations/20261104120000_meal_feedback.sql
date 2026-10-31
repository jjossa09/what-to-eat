-- P1-17: Went? + stars + optional price tap (FR11, ML8, R3). The app calls save_meal_feedback()
-- once per answer. It is the only write path: meals keeps read-only RLS. Each call updates the
-- live meal and logs the matching funnel event (went / stars / price_tap) in one transaction.
--
-- Order: went (null -> true/false), then stars (1-5, only if went), then price tap (1-4, only
-- after stars). One correction is allowed: went true -> false before stars are set (an
-- auto-detected visit the user says didn't happen); it is logged as a went event with false.

create function public.save_meal_feedback(
  p_meal_id uuid,
  p_went boolean default null,
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
  answers int := (p_went is not null)::int + (p_stars is not null)::int
                 + (p_price_tap is not null)::int;
  pick_round smallint;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if answers <> 1 then
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
       or (m.went is true and p_went is false and m.stars is null) then
      update public.meals set went = p_went where id = m.id;
      insert into public.recommendation_events
        (user_id, session_id, round, place_id, event, went)
      values (uid, m.session_id, pick_round, m.place_id, 'went', p_went);
    else
      raise exception 'went already answered' using errcode = '23514';
    end if;

  elsif p_stars is not null then
    if p_stars not between 1 and 5 then
      raise exception 'stars must be 1 to 5' using errcode = '22023';
    end if;
    if m.went is not true or m.stars is not null then
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

revoke execute on function public.save_meal_feedback(uuid, boolean, smallint, smallint)
  from public, anon;
grant execute on function public.save_meal_feedback(uuid, boolean, smallint, smallint)
  to authenticated;
