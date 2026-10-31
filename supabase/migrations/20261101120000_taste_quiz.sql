-- P1-08: taste quiz (FR1, FR2, ML2). The app calls save_taste_quiz() directly under the user's
-- session. It is the only write path for taste_profiles and companions: those tables keep
-- read-only RLS, and this function (security definer) validates every answer, then saves the
-- profile, the companions, and profiles.onboarded_at in one transaction.

create function public.save_taste_quiz(
  p_favorites text[],
  p_hard_nos text[],
  p_budget smallint,
  p_mostly_solo boolean,
  p_companions text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  favorites text[];
  hard_nos text[];
  names text[];
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  -- De-duplicated, in a stable order.
  select coalesce(array_agg(distinct c order by c), '{}') into favorites
  from unnest(coalesce(p_favorites, '{}')) as c;
  select coalesce(array_agg(distinct c order by c), '{}') into hard_nos
  from unnest(coalesce(p_hard_nos, '{}')) as c;

  -- Every id must be a predictable ML2 category (Other is never a quiz answer).
  if exists (
    select 1 from unnest(favorites || hard_nos) as c
    where not exists (
      select 1 from public.categories k where k.id = c and k.predictable
    )
  ) then
    raise exception 'unknown category' using errcode = '22023';
  end if;
  if cardinality(favorites) < 1 or cardinality(favorites) > 5 then
    raise exception 'pick 1 to 5 favorites' using errcode = '22023';
  end if;
  if favorites && hard_nos then
    raise exception 'favorite is also a hard no' using errcode = '22023';
  end if;
  if p_budget is null or p_budget not between 1 and 4 then
    raise exception 'budget must be 1 to 4' using errcode = '22023';
  end if;
  if p_mostly_solo is null then
    raise exception 'solo answer missing' using errcode = '22023';
  end if;

  -- Trimmed, blanks dropped, case-insensitive duplicates dropped (first spelling kept).
  select coalesce(array_agg(n order by ord), '{}') into names
  from (
    select distinct on (lower(btrim(raw))) btrim(raw) as n, ord
    from unnest(coalesce(p_companions, '{}')) with ordinality as t(raw, ord)
    where btrim(raw) <> ''
    order by lower(btrim(raw)), ord
  ) as d;
  if cardinality(names) > 20 then
    raise exception 'too many companions' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(names) as n where char_length(n) > 40) then
    raise exception 'companion name too long' using errcode = '22023';
  end if;

  insert into public.taste_profiles
    (user_id, favorite_categories, hard_no_categories, budget_level, mostly_solo, updated_at)
  values (uid, favorites, hard_nos, p_budget, p_mostly_solo, now())
  on conflict (user_id) do update
    set favorite_categories = excluded.favorite_categories,
        hard_no_categories = excluded.hard_no_categories,
        budget_level = excluded.budget_level,
        mostly_solo = excluded.mostly_solo,
        updated_at = excluded.updated_at;

  insert into public.companions (user_id, name)
  select uid, n from unnest(names) as n
  on conflict (user_id, (lower(name))) do nothing;

  update public.profiles set onboarded_at = now()
  where id = uid and onboarded_at is null;
end;
$$;

revoke execute on function public.save_taste_quiz(text[], text[], smallint, boolean, text[])
  from public, anon;
grant execute on function public.save_taste_quiz(text[], text[], smallint, boolean, text[])
  to authenticated;
