-- #73: retain actual provider brand evidence. Apply before deploying chain-aware reads.
-- No guessed historical labels or real-user rewrites. Existing import ownership, atomicity,
-- duplicate protection and shared-cache conflict behavior remain unchanged.

alter table public.places
  add column brand text check (brand is null or
    (brand=btrim(brand) and char_length(brand) between 1 and 200 and position(';' in brand)=0)),
  add column brand_wikidata text check
    (brand_wikidata is null or brand_wikidata ~ '^Q[1-9][0-9]*$');

comment on column public.places.brand is 'Provider/OSM brand evidence; null means unknown.';
comment on column public.places.brand_wikidata is
  'OSM brand:wikidata, never the individual place Wikidata ID.';

-- An omitted provider field is unknown, not evidence that a known brand disappeared.
-- A positively changed identity must not inherit a conflicting old name or Wikidata ID.
create function public.retain_place_brand_evidence()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.brand is null and (new.brand_wikidata is null
      or new.brand_wikidata is not distinct from old.brand_wikidata) then
    new.brand := old.brand;
  end if;
  if new.brand_wikidata is null and (new.brand is null
      or new.brand is not distinct from old.brand) then
    new.brand_wikidata := old.brand_wikidata;
  end if;
  return new;
end $$;
create trigger retain_place_brand_evidence before update on public.places
  for each row execute function public.retain_place_brand_evidence();

create or replace function public.import_backfill(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  r jsonb;
  p jsonb;
  n int := 0;
  v_eaten_on date;
  v_slot text;
  v_category text;
  v_price numeric;
  v_solo boolean;
  v_names text[];
  v_dish text;
  v_key text;
  v_unresolved boolean;
  v_place_id text;
  v_place_name text;
  v_place_category text;
  v_lat double precision;
  v_lon double precision;
  v_address text;
  v_tags text[];
  v_brand text;
  v_brand_wikidata text;
  v_meal_id uuid;
  v_companion_id uuid;
  v_name text;
  v_count int;
  meals_inserted int := 0;
  meals_skipped int := 0;
  places_inserted int := 0;
  companions_inserted int := 0;
  links_inserted int := 0;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'send 1 to 500 rows' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    n := n + 1;
    if jsonb_typeof(r) <> 'object' then
      raise exception 'row %: not an object', n using errcode = '22023';
    end if;

    -- Date: no future meals. The server has no timezone, so it allows one day of slack;
    -- the script applies the exact late-hour rule.
    v_eaten_on := (r->>'eaten_on')::date;
    if v_eaten_on is null or v_eaten_on > current_date + 1 then
      raise exception 'row %: bad date', n using errcode = '22023';
    end if;

    v_slot := r->>'meal_slot';
    if v_slot is null or v_slot not in ('breakfast', 'lunch', 'dinner', 'late') then
      raise exception 'row %: bad meal slot', n using errcode = '22023';
    end if;

    -- Meal category: the food eaten. Must exist and must not be Other.
    v_category := r->>'category_id';
    if v_category is null or v_category = 'other' or not exists (
      select 1 from public.categories k where k.id = v_category and k.predictable
    ) then
      raise exception 'row %: bad meal category', n using errcode = '22023';
    end if;

    v_price := (r->>'price_amount')::numeric;
    if v_price is not null
       and (v_price < 0 or v_price > 99999.99 or v_price <> round(v_price, 2)) then
      raise exception 'row %: bad price', n using errcode = '22023';
    end if;

    -- Solo: true (alone), false (with the listed people), or null (not known).
    if r->'solo' is not null and jsonb_typeof(r->'solo') not in ('boolean', 'null') then
      raise exception 'row %: bad solo', n using errcode = '22023';
    end if;
    v_solo := (r->>'solo')::boolean;
    if (r->'companions' is not null and jsonb_typeof(r->'companions') not in ('array', 'null'))
       or exists (
         select 1 from jsonb_array_elements(
           case when jsonb_typeof(r->'companions') = 'array' then r->'companions' else '[]' end
         ) as e
         where jsonb_typeof(e) <> 'string'
       ) then
      raise exception 'row %: bad companions', n using errcode = '22023';
    end if;
    -- Trimmed, blanks dropped, case-insensitive duplicates dropped (first spelling kept).
    select coalesce(array_agg(d.nm order by d.ord), '{}') into v_names
    from (
      select distinct on (lower(btrim(t.raw))) btrim(t.raw) as nm, t.ord
      from jsonb_array_elements_text(coalesce(r->'companions', '[]'::jsonb))
        with ordinality as t(raw, ord)
      where btrim(t.raw) <> ''
      order by lower(btrim(t.raw)), t.ord
    ) as d;
    if (v_solo is false) <> (cardinality(v_names) > 0) then
      raise exception 'row %: companions only go with solo = false', n using errcode = '22023';
    end if;
    if cardinality(v_names) > 20
       or exists (select 1 from unnest(v_names) as x where char_length(x) > 40) then
      raise exception 'row %: bad companion names', n using errcode = '22023';
    end if;

    -- Dish: same rule as the live food answer (20261104130000_meal_feedback_food.sql).
    v_dish := nullif(btrim(coalesce(r->>'dish', '')), '');
    if char_length(v_dish) > 60 then
      raise exception 'row %: dish must be 60 characters or fewer', n using errcode = '22023';
    end if;

    v_key := r->>'backfill_key';
    if v_key is null or char_length(v_key) > 300 then
      raise exception 'row %: bad backfill key', n using errcode = '22023';
    end if;

    -- Place ----------------------------------------------------------------
    p := r->'place';
    if p is null or jsonb_typeof(p) <> 'object' then
      raise exception 'row %: place missing', n using errcode = '22023';
    end if;
    if p->'unresolved' is not null and jsonb_typeof(p->'unresolved') <> 'boolean' then
      raise exception 'row %: bad unresolved flag', n using errcode = '22023';
    end if;
    v_unresolved := coalesce((p->>'unresolved')::boolean, false);
    v_place_name := btrim(p->>'name');
    if v_place_name is null or char_length(v_place_name) not between 1 and 200 then
      raise exception 'row %: place name must be 1 to 200 characters', n using errcode = '22023';
    end if;
    -- Place category: its ML2 mapping. Must exist; Other is allowed here.
    v_place_category := p->>'category_id';
    if v_place_category is null or not exists (
      select 1 from public.categories k where k.id = v_place_category
    ) then
      raise exception 'row %: bad place category', n using errcode = '22023';
    end if;

    if v_unresolved then
      if p->>'id' is not null or p->>'lat' is not null or p->>'lon' is not null then
        raise exception 'row %: unresolved place has an id or coordinates', n
          using errcode = '22023';
      end if;
      if v_key not like v_eaten_on::text || '|' || v_slot || '|unresolved:_%' then
        raise exception 'row %: backfill key does not match', n using errcode = '22023';
      end if;

      insert into public.places (id, name, category_id, unresolved, owner_user_id)
      values ('unresolved:' || gen_random_uuid(), v_place_name, v_place_category, true, uid)
      on conflict (owner_user_id, (lower(name))) where unresolved do nothing
      returning id into v_place_id;
      if v_place_id is null then
        -- Reuse only the caller's own unresolved place.
        select pl.id into v_place_id from public.places pl
        where pl.unresolved and pl.owner_user_id = uid
          and lower(pl.name) = lower(v_place_name);
        if v_place_id is null then
          raise exception 'row %: unresolved place not found', n using errcode = 'P0002';
        end if;
      else
        places_inserted := places_inserted + 1;
      end if;
    else
      v_place_id := p->>'id';
      if v_place_id is null or char_length(v_place_id) > 200
         or v_place_id like 'unresolved:%'
         or v_place_id !~ '^((node|way|relation)/[0-9]+|geoapify:.+)$' then
        raise exception 'row %: bad place id', n using errcode = '22023';
      end if;
      if jsonb_typeof(p->'lat') is distinct from 'number'
         or jsonb_typeof(p->'lon') is distinct from 'number' then
        raise exception 'row %: place coordinates missing', n using errcode = '22023';
      end if;
      v_lat := (p->>'lat')::double precision;
      v_lon := (p->>'lon')::double precision;
      if v_lat not between -90 and 90 or v_lon not between -180 and 180 then
        raise exception 'row %: bad place coordinates', n using errcode = '22023';
      end if;
      v_address := nullif(btrim(coalesce(p->>'address', '')), '');
      if char_length(v_address) > 500 then
        raise exception 'row %: place address too long', n using errcode = '22023';
      end if;
      if (p->'geoapify_categories' is not null
          and jsonb_typeof(p->'geoapify_categories') not in ('array', 'null'))
         or exists (
           select 1 from jsonb_array_elements(
             case when jsonb_typeof(p->'geoapify_categories') = 'array'
               then p->'geoapify_categories' else '[]' end
           ) as e
           where jsonb_typeof(e) <> 'string'
         ) then
        raise exception 'row %: bad place tags', n using errcode = '22023';
      end if;
      select coalesce(array_agg(t.tag order by t.ord), '{}') into v_tags
      from jsonb_array_elements_text(coalesce(p->'geoapify_categories', '[]'::jsonb))
        with ordinality as t(tag, ord);
      if v_key <> v_eaten_on::text || '|' || v_slot || '|' || v_place_id then
        raise exception 'row %: backfill key does not match', n using errcode = '22023';
      end if;

      if (p ? 'brand' and jsonb_typeof(p->'brand') not in ('string','null'))
        or (p ? 'brand_wikidata' and jsonb_typeof(p->'brand_wikidata') not in ('string','null')) then
        raise exception 'row %: invalid brand metadata', n using errcode='22023';
      end if;
      v_brand := nullif(btrim(p->>'brand'),'');
      v_brand_wikidata := nullif(btrim(p->>'brand_wikidata'),'');
      if char_length(v_brand)>200 or position(';' in v_brand)>0
        or (v_brand_wikidata is not null and v_brand_wikidata !~ '^Q[1-9][0-9]*$') then
        raise exception 'row %: invalid brand metadata', n using errcode='22023';
      end if;
      insert into public.places
        (id, name, lat, lon, category_id, geoapify_categories, address, brand, brand_wikidata)
      values (v_place_id, v_place_name, v_lat, v_lon, v_place_category, v_tags, v_address,
              v_brand, v_brand_wikidata)
      on conflict (id) do nothing;
      get diagnostics v_count = row_count;
      places_inserted := places_inserted + v_count;
    end if;

    -- Meal -----------------------------------------------------------------
    v_meal_id := null;
    insert into public.meals
      (user_id, source, place_id, category_id, eaten_on, meal_slot, solo, price_amount, dish,
       backfill_key)
    values
      (uid, 'backfill', v_place_id, v_category, v_eaten_on, v_slot, v_solo, v_price, v_dish,
       v_key)
    on conflict (user_id, backfill_key) do nothing
    returning id into v_meal_id;
    if v_meal_id is null then
      meals_skipped := meals_skipped + 1;
      continue;
    end if;
    meals_inserted := meals_inserted + 1;

    -- Companions -----------------------------------------------------------
    foreach v_name in array v_names loop
      v_companion_id := null;
      insert into public.companions (user_id, name) values (uid, v_name)
      on conflict (user_id, (lower(name))) do nothing
      returning id into v_companion_id;
      if v_companion_id is null then
        select c.id into v_companion_id from public.companions c
        where c.user_id = uid and lower(c.name) = lower(v_name);
      else
        companions_inserted := companions_inserted + 1;
      end if;
      insert into public.meal_companions (meal_id, companion_id, user_id)
      values (v_meal_id, v_companion_id, uid)
      on conflict do nothing;
      get diagnostics v_count = row_count;
      links_inserted := links_inserted + v_count;
    end loop;
  end loop;

  return jsonb_build_object(
    'meals_inserted', meals_inserted,
    'meals_skipped', meals_skipped,
    'places_inserted', places_inserted,
    'companions_inserted', companions_inserted,
    'links_inserted', links_inserted
  );
end;
$$;

revoke execute on function public.import_backfill(jsonb) from public, anon;
grant execute on function public.import_backfill(jsonb) to authenticated;
