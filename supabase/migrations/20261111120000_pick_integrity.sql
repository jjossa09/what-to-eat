-- #80: the displayed round owns its requested budget, including an unknown value.
-- Legacy rows stay NULL. Never infer historical context from the current session.
alter table public.recommendation_events
  add column decision_budget_level smallint
    check (decision_budget_level between 1 and 4),
  add constraint decision_budget_only_shown
    check (decision_budget_level is null or event = 'shown');

comment on column public.recommendation_events.decision_budget_level is
  'Applied budget for this displayed round. NULL means unknown, including legacy rows.';

-- One PostgREST request/transaction owns the core decision. The session row lock also
-- serializes with the existing outcome-is-null PATCH used by None of these.
-- SECURITY INVOKER: the existing user JWT, RLS and user-owned write policies apply.
create function public.save_recommendation_pick(
  p_session_id uuid,
  p_round integer,
  p_place_id text,
  p_distance_m integer
)
returns table(status text, meal_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  decision public.sessions%rowtype;
  meal public.meals%rowtype;
  picked public.recommendation_events%rowtype;
  place public.places%rowtype;
  budget smallint;
  picked_count integer;
  stamp timestamptz;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_session_id is null or p_round is null or p_round < 1 or p_round > 100
     or p_place_id is null or char_length(p_place_id) not between 1 and 200
     or p_distance_m < 0 then
    raise exception 'invalid pick' using errcode = '22023';
  end if;

  select s.* into decision from public.sessions s
    where s.id = p_session_id and s.user_id = uid for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  select e.decision_budget_level into budget from public.recommendation_events e
    where e.user_id = uid and e.session_id = decision.id and e.round = p_round
      and e.place_id = p_place_id and e.event = 'shown'
    order by e.id limit 1;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  -- The old schema permits duplicate shown rows. Never arbitrarily choose between
  -- contradictory snapshots, and never silently repair legacy inconsistent decisions.
  if exists (
    select 1 from public.recommendation_events e
    where e.user_id = uid and e.session_id = decision.id and e.round = p_round
      and e.place_id = p_place_id and e.event = 'shown'
      and e.decision_budget_level is distinct from budget
  ) then
    return query select 'inconsistent'::text, null::uuid;
    return;
  end if;

  select m.* into meal from public.meals m
    where m.session_id = decision.id and m.user_id = uid;
  select count(*) into picked_count from public.recommendation_events e
    where e.session_id = decision.id and e.user_id = uid and e.event = 'picked';
  select e.* into picked from public.recommendation_events e
    where e.session_id = decision.id and e.user_id = uid and e.event = 'picked'
    order by e.id limit 1;

  if decision.outcome = 'picked' then
    if meal.id is null or meal.source <> 'live' or picked_count <> 1
       or picked.place_id is distinct from meal.place_id then
      return query select 'inconsistent'::text, null::uuid;
    elsif meal.place_id = p_place_id and picked.round = p_round then
      -- Do not update any existing meal, event or timestamp on an exact replay.
      return query select 'replayed'::text, meal.id;
    else
      return query select 'conflict'::text, null::uuid;
    end if;
    return;
  end if;
  if meal.id is not null or picked_count <> 0 then
    return query select 'inconsistent'::text, null::uuid;
    return;
  end if;
  if decision.outcome is not null then
    return query select 'conflict'::text, null::uuid;
    return;
  end if;

  select p.* into place from public.places p where p.id = p_place_id;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  stamp := clock_timestamp();
  insert into public.meals
    (user_id, source, session_id, place_id, category_id, eaten_on, meal_slot,
     picked_at, solo, budget_level, distance_m)
  values
    (uid, 'live', decision.id, place.id, place.category_id, decision.local_date,
     decision.meal_slot, stamp, decision.solo, budget, p_distance_m)
  returning * into meal;
  -- category_id remains provisional until the food answer sets ate_at, as before.
  insert into public.recommendation_events
    (user_id, session_id, round, place_id, event, created_at)
  values (uid, decision.id, p_round, place.id, 'picked', stamp);
  update public.sessions s set outcome = 'picked', ended_at = stamp
    where s.id = decision.id and s.user_id = uid and s.outcome is null;
  if not found then
    raise exception 'session closure failed' using errcode = '23514';
  end if;
  -- Any exception above rolls back all three writes. Secondary companion copying
  -- stays outside this RPC, after the core decision has committed.
  return query select 'saved'::text, meal.id;
end;
$$;

revoke execute on function public.save_recommendation_pick(uuid, integer, text, integer)
  from public, anon;
grant execute on function public.save_recommendation_pick(uuid, integer, text, integer)
  to authenticated;
