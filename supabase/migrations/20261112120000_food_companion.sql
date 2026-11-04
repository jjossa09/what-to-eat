-- #75. No anonymous writes. Pending actions and their mutations are bound to auth.uid().
-- New chat meals have no recommendation session and may have no place at all.
alter table public.meals drop constraint meals_source_check;
alter table public.meals add constraint meals_source_check
  check (source in ('live', 'backfill', 'chat'));
alter table public.meals add column revision bigint not null default 0;

create function public.bump_meal_revision() returns trigger language plpgsql
set search_path = '' as $$ begin new.revision := old.revision + 1; return new; end $$;
create trigger meal_revision before update on public.meals
  for each row execute function public.bump_meal_revision();

create table public.companion_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  conversation_id uuid not null,
  client_key text not null check (char_length(client_key) between 1 and 100),
  kind text not null check (kind in ('log_meal','rate_meal','preference_change','edit_meal')),
  arguments jsonb not null check (jsonb_typeof(arguments) = 'object'),
  state text not null default 'pending' check (state in ('pending','cancelled','confirmed')),
  result jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, conversation_id, client_key)
);
create unique index one_pending_companion_action
  on public.companion_actions(user_id, conversation_id) where state = 'pending';
alter table public.companion_actions enable row level security;
create policy "Read own companion actions" on public.companion_actions
  for select to authenticated using (user_id = (select auth.uid()));

create table public.preference_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  action_id uuid not null unique references public.companion_actions,
  old_value jsonb not null,
  new_value jsonb not null,
  source text not null check (source in ('chat','profile')),
  created_at timestamptz not null default now()
);
alter table public.preference_changes enable row level security;
create policy "Read own preference changes" on public.preference_changes
  for select to authenticated using (user_id = (select auth.uid()));

create table public.meal_corrections (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  meal_id uuid not null references public.meals on delete cascade,
  old_value jsonb not null,
  new_value jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.meal_corrections enable row level security;
create policy "Read own meal corrections" on public.meal_corrections
  for select to authenticated using (user_id = (select auth.uid()));

create function public.prepare_companion_action(
  p_conversation_id uuid, p_client_key text, p_kind text, p_arguments jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); a public.companion_actions%rowtype;
begin
  if uid is null then raise exception 'not signed in' using errcode='28000'; end if;
  if p_conversation_id is null or p_client_key is null or char_length(p_client_key) not between 1 and 100
     or p_kind not in ('log_meal','rate_meal','preference_change','edit_meal')
     or p_arguments is null or jsonb_typeof(p_arguments) <> 'object'
     or octet_length(p_arguments::text) > 12000 then
    raise exception 'invalid action' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || p_conversation_id::text, 0));
  select * into a from public.companion_actions
    where user_id=uid and conversation_id=p_conversation_id and client_key=p_client_key for update;
  if found then
    if a.kind <> p_kind or a.state <> 'pending' then
      return to_jsonb(a);
    end if;
    update public.companion_actions set arguments=p_arguments where id=a.id returning * into a;
  else
    update public.companion_actions set state='cancelled'
      where user_id=uid and conversation_id=p_conversation_id and state='pending';
    insert into public.companion_actions(user_id,conversation_id,client_key,kind,arguments)
      values(uid,p_conversation_id,p_client_key,p_kind,p_arguments) returning * into a;
  end if;
  return to_jsonb(a);
end $$;

create function public.cancel_companion_action(p_id uuid, p_conversation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='28000'; end if;
  update public.companion_actions set state='cancelled'
    where (p_id is null or id=p_id) and conversation_id=p_conversation_id
      and user_id=auth.uid() and state='pending';
end $$;

-- Shared correction writer. Called only by user-bound RPCs; never callable directly.
create function public.correct_meal_fields(p_id uuid, p_changes jsonb, p_revision bigint default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); m public.meals%rowtype; n public.meals%rowtype;
  ids uuid[]; cid uuid; cat text; dish text; v_stars smallint; v_price smallint;
  r smallint; old_links jsonb; new_links jsonb;
begin
  if uid is null then raise exception 'not signed in' using errcode='28000'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes='{}'::jsonb
    or exists(select 1 from jsonb_object_keys(p_changes) k
      where k not in ('dish','category_id','stars','price_tap','price_amount','solo','companion_ids')) then
    raise exception 'invalid correction' using errcode='22023';
  end if;
  select * into m from public.meals where id=p_id and user_id=uid for update;
  if not found or (m.source='live' and m.went is not true) then
    raise exception 'meal not eligible' using errcode='23514';
  end if;
  if p_revision is not null and m.revision <> p_revision then
    raise exception 'meal changed; reload' using errcode='40001';
  end if;
  n := m;
  if p_changes ? 'category_id' then
    cat := p_changes->>'category_id';
    if not exists(select 1 from public.categories where id=cat and predictable) then
      raise exception 'invalid food' using errcode='22023';
    end if;
    n.category_id := cat; n.ate_at := coalesce(n.ate_at,now());
  end if;
  if p_changes ? 'dish' then
    dish := nullif(btrim(p_changes->>'dish'),'');
    if char_length(dish)>60 then raise exception 'dish too long' using errcode='22023'; end if;
    n.dish := dish; -- never changes ate_at or the category
  end if;
  if p_changes ? 'stars' then
    v_stars := (p_changes->>'stars')::smallint;
    if v_stars is null or v_stars not between 1 and 5 then
      raise exception 'invalid rating' using errcode='22023'; end if;
    n.stars := v_stars;
  end if;
  if p_changes ? 'price_tap' then
    v_price := (p_changes->>'price_tap')::smallint;
    if v_price is null or v_price not between 1 and 4 then
      raise exception 'invalid price' using errcode='22023'; end if;
    n.price_tap := v_price;
  end if;
  if p_changes ? 'price_amount' then
    if m.source <> 'backfill' then raise exception 'amount is historical only' using errcode='22023'; end if;
    n.price_amount := (p_changes->>'price_amount')::numeric;
    n.price_tap := null; -- the explicitly corrected amount is the paid evidence
    if n.price_amount < 0 or n.price_amount > 99999.99 or round(n.price_amount,2)<>n.price_amount then
      raise exception 'invalid amount' using errcode='22023'; end if;
  end if;
  if p_changes ? 'solo' then n.solo := (p_changes->>'solo')::boolean; end if;
  select coalesce(jsonb_agg(companion_id order by companion_id),'[]') into old_links
    from public.meal_companions where meal_id=m.id and user_id=uid;
  if p_changes ? 'companion_ids' then
    select coalesce(array_agg(distinct x::uuid),'{}') into ids
      from jsonb_array_elements_text(p_changes->'companion_ids') x;
    if cardinality(ids)>20 or exists(select 1 from unnest(ids) x
      where not exists(select 1 from public.companions c where c.id=x and c.user_id=uid)) then
      raise exception 'invalid companions' using errcode='22023'; end if;
    if n.solo is true and cardinality(ids)>0 then
      raise exception 'solo cannot have companions' using errcode='22023'; end if;
    if cardinality(ids)>0 then n.solo := false; end if;
    delete from public.meal_companions where meal_id=m.id and user_id=uid;
    insert into public.meal_companions(meal_id,companion_id,user_id)
      select m.id,x,uid from unnest(ids) x;
  end if;
  if n.solo is true then
    delete from public.meal_companions where meal_id=m.id and user_id=uid;
  end if;
  select coalesce(jsonb_agg(companion_id order by companion_id),'[]') into new_links
    from public.meal_companions where meal_id=m.id and user_id=uid;
  if n is distinct from m or old_links<>new_links then
    update public.meals set category_id=n.category_id, ate_at=n.ate_at, dish=n.dish,
      stars=n.stars, price_tap=n.price_tap, price_amount=n.price_amount, solo=n.solo where id=m.id returning * into n;
    insert into public.meal_corrections(user_id,meal_id,old_value,new_value)
      values(uid,m.id,to_jsonb(m)||jsonb_build_object('companions',old_links),
             to_jsonb(n)||jsonb_build_object('companions',new_links));
  end if;
  -- Keep the existing live funnel contract, one event per changed field.
  if m.session_id is not null and m.place_id is not null then
    select coalesce(max(round),1) into r from public.recommendation_events
      where session_id=m.session_id and place_id=m.place_id and event='picked';
    if n.dish is distinct from m.dish or n.category_id is distinct from m.category_id then
      insert into public.recommendation_events(user_id,session_id,round,place_id,event,ate_category_id,dish,edited)
        values(uid,m.session_id,r,m.place_id,'ate',n.category_id,n.dish,true);
    end if;
    if n.stars is distinct from m.stars then
      insert into public.recommendation_events(user_id,session_id,round,place_id,event,stars,edited)
        values(uid,m.session_id,r,m.place_id,'stars',n.stars,true); end if;
    if n.price_tap is distinct from m.price_tap then
      insert into public.recommendation_events(user_id,session_id,round,place_id,event,price_level,edited)
        values(uid,m.session_id,r,m.place_id,'price_tap',n.price_tap,true); end if;
    if n.solo is distinct from m.solo then
      insert into public.recommendation_events(user_id,session_id,round,place_id,event,solo,edited)
        values(uid,m.session_id,r,m.place_id,'solo',n.solo,true); end if;
  end if;
end $$;
revoke all on function public.correct_meal_fields(uuid,jsonb,bigint) from public,anon,authenticated;

create or replace function public.edit_meal(p_meal_id uuid,p_dish text default null,
  p_stars smallint default null,p_price_tap smallint default null,p_solo boolean default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.correct_meal_fields(p_meal_id,jsonb_strip_nulls(jsonb_build_object(
    'dish',p_dish,'stars',p_stars,'price_tap',p_price_tap,'solo',p_solo)));
end $$;

create function public.confirm_companion_action(p_id uuid,p_conversation_id uuid,p_arguments jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); a public.companion_actions%rowtype; v jsonb;
  mid uuid; cat text; eaten date; slot text; ids uuid[]; solo boolean; stars smallint;
  profile public.taste_profiles%rowtype; fav text[]; hard text[]; new_profile jsonb;
  existing jsonb;
begin
  if uid is null then raise exception 'not signed in' using errcode='28000'; end if;
  select * into a from public.companion_actions
    where id=p_id and conversation_id=p_conversation_id and user_id=uid for update;
  if not found then raise exception 'action not found' using errcode='P0002'; end if;
  if a.state='confirmed' then
    if a.arguments<>p_arguments then raise exception 'action changed' using errcode='40001'; end if;
    return a.result;
  end if;
  if a.state<>'pending' or a.arguments<>p_arguments then
    raise exception 'action is no longer pending' using errcode='40001'; end if;
  v := a.arguments;
  if a.kind='log_meal' then
    cat := v->>'category_id'; eaten := (v->>'eaten_on')::date; slot := v->>'meal_slot';
    if not exists(select 1 from pg_timezone_names where name=v->>'timezone') then
      raise exception 'invalid timezone' using errcode='22023'; end if;
    if not exists(select 1 from public.categories where id=cat and predictable)
      or eaten is null or eaten>(now() at time zone (v->>'timezone'))::date
      or (slot is not null and slot not in ('breakfast','lunch','dinner','late')) then
      raise exception 'invalid meal' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended(uid::text||cat||eaten::text||coalesce(slot,''),0));
    if not coalesce((v->>'allow_duplicate')::boolean,false) and exists(
      select 1 from public.meals where user_id=uid and eaten_on=eaten and category_id=cat
        and meal_slot is not distinct from slot
        and (source='backfill' or (went is true and ate_at is not null))) then
      return jsonb_build_object('status','duplicate');
    end if;
    select coalesce(array_agg(distinct x::uuid),'{}') into ids
      from jsonb_array_elements_text(coalesce(v->'companion_ids','[]')) x;
    solo := (v->>'solo')::boolean; stars := (v->>'stars')::smallint;
    if cardinality(ids)>20 or (solo is true and cardinality(ids)>0) or exists(
      select 1 from unnest(ids) x where not exists(
        select 1 from public.companions c where c.id=x and c.user_id=uid)) then
      raise exception 'invalid companions' using errcode='22023'; end if;
    if v->>'place_id' is not null and not exists(select 1 from public.places p
      where p.id=v->>'place_id' and not p.unresolved
        and (p.owner_user_id is null or p.owner_user_id=uid)) then
      raise exception 'unverified place' using errcode='22023'; end if;
    insert into public.meals(user_id,source,place_id,category_id,eaten_on,meal_slot,dish,
      ate_at,went,solo,stars) values(uid,'chat',v->>'place_id',cat,eaten,slot,
        nullif(btrim(v->>'dish'),''),now(),true,
        case when cardinality(ids)>0 then false else solo end,stars) returning id into mid;
    insert into public.meal_companions(meal_id,companion_id,user_id)
      select mid,x,uid from unnest(ids) x;
  elsif a.kind in ('rate_meal','edit_meal') then
    mid := (v->>'meal_id')::uuid;
    perform public.correct_meal_fields(mid,v->'changes',(v->>'revision')::bigint);
  else
    select * into profile from public.taste_profiles where user_id=uid for update;
    if not found or profile.updated_at is distinct from (v->>'expected_updated_at')::timestamptz then
      raise exception 'profile changed; reload' using errcode='40001'; end if;
    select array_agg(distinct x order by x) into fav from jsonb_array_elements_text(v->'favorites') x;
    select coalesce(array_agg(distinct x order by x),'{}') into hard
      from jsonb_array_elements_text(v->'hard_nos') x;
    if coalesce(cardinality(fav),0) not between 1 and 5 or fav && hard or exists(
      select 1 from unnest(fav||hard) x where not exists(
        select 1 from public.categories c where c.id=x and c.predictable))
      or v->>'budget' is null or (v->>'budget')::int not between 1 and 4
      or v->>'mostly_solo' is null
      or v->>'source' not in ('chat','profile') then
      raise exception 'invalid profile' using errcode='22023'; end if;
    update public.taste_profiles set favorite_categories=fav,hard_no_categories=hard,
      budget_level=(v->>'budget')::smallint,mostly_solo=(v->>'mostly_solo')::boolean,
      updated_at=clock_timestamp() where user_id=uid;
    select to_jsonb(t) into new_profile from public.taste_profiles t where user_id=uid;
    insert into public.preference_changes(user_id,action_id,old_value,new_value,source)
      values(uid,a.id,to_jsonb(profile),new_profile,v->>'source');
  end if;
  a.result := jsonb_build_object('status','saved','meal_id',mid);
  update public.companion_actions set state='confirmed',result=a.result where id=a.id;
  return a.result;
end $$;

revoke all on function public.prepare_companion_action(uuid,text,text,jsonb),
  public.cancel_companion_action(uuid,uuid),public.confirm_companion_action(uuid,uuid,jsonb)
  from public,anon;
grant execute on function public.prepare_companion_action(uuid,text,text,jsonb),
  public.cancel_companion_action(uuid,uuid),public.confirm_companion_action(uuid,uuid,jsonb)
  to authenticated;

-- Provenance of recommendation company is separate from confirmed meal company.
alter table public.sessions add column company_confirmed boolean not null default false;
comment on column public.sessions.company_confirmed is
  'Only an explicit chip or typed company answer can authorize meal companion labels.';

-- A displayed round carries its own confirmed company snapshot. A prediction may be
-- recommendation context, but is never a meal label, including when an older round is picked.
alter table public.recommendation_events add column decision_company jsonb
  check (decision_company is null or event='shown');

create or replace function public.save_recommendation_pick(
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
  company jsonb;
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

  select e.decision_budget_level, e.decision_company into budget, company from public.recommendation_events e
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
      and (e.decision_budget_level is distinct from budget
           or e.decision_company is distinct from company)
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
     decision.meal_slot, stamp, case when company->>'confirmed'='true'
       then (company->>'solo')::boolean else null end, budget, p_distance_m)
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
  -- Core failures above roll back all three writes. Optional links have their own
  -- subtransaction, under the meal lock; a failed copy cannot lose the core pick.
  -- Exact replays returned earlier, so they never restore subsequently edited links.
  if company->>'confirmed'='true' and meal.solo is false then
    begin
      insert into public.meal_companions(meal_id,companion_id,user_id)
        select meal.id,c.id,uid from public.companions c
        where c.user_id=uid and (company->'companion_ids') ? c.id::text;
    exception when others then
      raise warning 'Optional confirmed companion write failed';
    end;
  end if;
  return query select 'saved'::text, meal.id;
end;
$$;


-- Direct API inserts cannot turn a legacy/predicted context into meal labels. Explicit
-- manual corrections and chat confirmations retain their owned SECURITY DEFINER writers.
drop policy "Insert own meal companions" on public.meal_companions;
create policy "Insert own meal companions" on public.meal_companions
  for insert to authenticated with check (
    user_id=(select auth.uid())
    and exists(select 1 from public.companions c
      where c.id=companion_id and c.user_id=(select auth.uid()))
    and exists(select 1 from public.meals m
      join public.recommendation_events picked on picked.session_id=m.session_id
        and picked.place_id=m.place_id and picked.event='picked'
      join public.recommendation_events shown on shown.session_id=picked.session_id
        and shown.place_id=picked.place_id and shown.round=picked.round and shown.event='shown'
      where m.id=meal_id and m.user_id=(select auth.uid()) and m.source='live'
        and m.solo is false and m.revision=0
        and shown.decision_company->>'confirmed'='true'
        and (shown.decision_company->'companion_ids') ? companion_id::text)
  );
