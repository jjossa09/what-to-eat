-- P1-06: tables, indexes, profile trigger, and the R3 session_log view.
-- Writes go through the API (service role). RLS is in the next migration.
--
-- Source of truth: meals is the source of truth for the models (backfill and live, one shape).
-- recommendation_events is the funnel log (ML8). Feedback is written to both.
--
-- Conventions:
-- - Levels ($ to $$$$) are smallint 1-4. Stars are smallint 1-5.
-- - Small value sets are text + check, not enums, so they are easy to change.
-- - Every user-owned table has user_id, so RLS and indexes are the same everywhere.
-- - Local date and meal slot come from the device's local time, written by the API.
--   Breakfast 05:00-10:59, lunch 11:00-15:59, dinner 16:00-20:59, late 21:00-04:59.
--   Late meals after midnight count on the previous day's local date.
-- - Weekday is ISO (1 = Mon, 7 = Sun). Weekend = Sat or Sun.

-- Users ---------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  input_mode text not null default 'text' check (input_mode in ('text', 'voice')), -- FR12
  onboarded_at timestamptz, -- null until the taste quiz is done
  created_at timestamptz not null default now()
);

-- Create a profile row for every new auth user.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Categories (ML2). Seeded in a later migration.

create table public.categories (
  id text primary key, -- slug, e.g. 'japanese_sushi'
  name text not null, -- e.g. 'Japanese/Sushi'
  sort_order smallint not null,
  predictable boolean not null default true -- false only for Other: shown, never predicted
);

-- Quiz prior (FR1, FR2). Category arrays hold category ids; the API validates them.

create table public.taste_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  favorite_categories text[] not null default '{}',
  hard_no_categories text[] not null default '{}', -- hard filter, never shown
  budget_level smallint check (budget_level between 1 and 4), -- typical budget per own meal
  mostly_solo boolean,
  updated_at timestamptz not null default now()
);

create table public.companions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index companions_user_name_key on public.companions (user_id, lower(name));

-- Places --------------------------------------------------------------------

-- Shared cache of Geoapify results (storage allowed; attribution shown per NFR5).
-- id: 'node/123', 'way/456', 'relation/789' from OSM; else 'geoapify:<place_id>'.
-- Unresolved backfill places: id 'unresolved:<uuid>', CSV name and category, owned by
-- the importing user, no coordinates. They count for the cuisine model only.
create table public.places (
  id text primary key,
  name text not null,
  lat double precision,
  lon double precision,
  category_id text not null references public.categories,
  geoapify_categories text[] not null default '{}', -- raw, so places can be re-mapped
  address text,
  unresolved boolean not null default false,
  owner_user_id uuid references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (unresolved and owner_user_id is not null)
    or (not unresolved and owner_user_id is null and lat is not null and lon is not null)
  )
);

-- One unresolved place per name per user, so backfill re-imports don't duplicate.
create unique index places_unresolved_name_key
  on public.places (owner_user_id, lower(name))
  where unresolved;

-- Sessions and chat ---------------------------------------------------------

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  timezone text not null, -- device IANA zone, e.g. 'America/New_York'
  local_date date not null, -- see the late-meal rule at the top
  day_of_week smallint generated always as (extract(isodow from local_date)::smallint) stored,
  is_weekend boolean generated always as (extract(isodow from local_date) in (6, 7)) stored,
  meal_slot text not null check (meal_slot in ('breakfast', 'lunch', 'dinner', 'late')),
  lat double precision not null, -- session location, for distance (FR-R1)
  lon double precision not null,
  -- Answers (R3). Current values after any refinement; each raw answer is in messages.
  craving_category_id text references public.categories,
  budget_level smallint check (budget_level between 1 and 4),
  radius_m integer, -- distance chips: Walk 1500, Short drive 5000, Worth the drive 15000
  solo boolean, -- null = not known; who is in session_companions
  search_radius_m integer, -- radius actually searched; cold start 5000 (FR-R3)
  outcome text check (outcome in ('picked', 'none')) -- null = no decision yet
);

create table public.session_companions (
  session_id uuid not null references public.sessions on delete cascade,
  companion_id uuid not null references public.companions on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (session_id, companion_id)
);

create table public.messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('assistant', 'user')),
  body text not null,
  round smallint not null default 0, -- 0 = the 3 questions, 1+ = refinement rounds
  question_key text check (
    question_key in ('craving', 'budget', 'distance', 'company', 'refine', 'open')
  ),
  answer jsonb, -- structured answer on user messages (chip, or parsed by Muse)
  input_mode text check (input_mode in ('chip', 'text', 'voice', 'prefill')),
  created_at timestamptz not null default now()
);

-- Meals (source of truth for the models) ------------------------------------

-- Live meals are created at pick time (went = null until the Went? check).
-- Backfill fields stay null when missing, never guessed.
create table public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  source text not null check (source in ('backfill', 'live')),
  session_id uuid unique references public.sessions on delete cascade, -- live only
  place_id text references public.places,
  -- Backfill: the CSV label (overrides the place's ML2 mapping for this user).
  -- Live: the place's category at pick time.
  category_id text references public.categories,
  eaten_on date not null, -- local date, late-meal rule applies
  day_of_week smallint generated always as (extract(isodow from eaten_on)::smallint) stored,
  is_weekend boolean generated always as (extract(isodow from eaten_on) in (6, 7)) stored,
  meal_slot text check (meal_slot in ('breakfast', 'lunch', 'dinner', 'late')),
  picked_at timestamptz, -- live; starts the FR11 window
  solo boolean, -- null = not known; who is in meal_companions
  budget_level smallint check (budget_level between 1 and 4), -- live, copied from the session
  price_tap smallint check (price_tap between 1 and 4), -- live, what it cost
  price_amount numeric(7, 2) check (price_amount >= 0), -- backfill, USD paid for own meal
  -- What was paid as a level: the tap, else the amount ($ <15, $$ 15-30, $$$ >30-60, $$$$ >60).
  price_level smallint generated always as (
    case
      when price_tap is not null then price_tap
      when price_amount is null then null
      when price_amount < 15 then 1
      when price_amount <= 30 then 2
      when price_amount <= 60 then 3
      else 4
    end
  ) stored,
  distance_m integer, -- live, straight line from session location (FR-R1)
  went boolean,
  stars smallint check (stars between 1 and 5),
  backfill_key text, -- lets the backfill import skip rows already imported
  created_at timestamptz not null default now(),
  check ((source = 'live') = (session_id is not null)),
  unique (user_id, backfill_key)
);

create table public.meal_companions (
  meal_id uuid not null references public.meals on delete cascade,
  companion_id uuid not null references public.companions on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (meal_id, companion_id)
);

-- Funnel log (ML8) ----------------------------------------------------------

-- One row per event. 'shown' rows are the cards; round 1 shown = the top 3.
create table public.recommendation_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  session_id uuid not null references public.sessions on delete cascade,
  round smallint not null, -- 1 = first round
  place_id text not null references public.places,
  event text not null check (
    event in ('shown', 'interested', 'rejected', 'picked', 'went', 'stars', 'price_tap')
  ),
  rank smallint check (rank between 1 and 3), -- shown
  slot text check (slot in ('familiar', 'discovery')), -- shown
  score real, -- shown
  pick_reason text, -- shown: the Muse one-liner
  interest_kind text check (interest_kind in ('card', 'directions')), -- interested
  reject_reason text, -- rejected
  went boolean, -- went
  stars smallint check (stars between 1 and 5), -- stars
  price_level smallint check (price_level between 1 and 4), -- price_tap
  created_at timestamptz not null default now(),
  check (
    (event = 'shown' and rank is not null and slot is not null)
    or (event = 'interested' and interest_kind is not null)
    or (event = 'rejected' and reject_reason is not null)
    or event = 'picked'
    or (event = 'went' and went is not null)
    or (event = 'stars' and stars is not null)
    or (event = 'price_tap' and price_level is not null)
  )
);

-- Indexes -------------------------------------------------------------------

create index meals_user_time_idx on public.meals (user_id, eaten_on desc);
create index meals_user_context_idx on public.meals (user_id, meal_slot, is_weekend);
create index meals_user_place_idx on public.meals (user_id, place_id);
create index meal_companions_companion_idx on public.meal_companions (companion_id);

create index sessions_user_time_idx on public.sessions (user_id, started_at desc);
create index session_companions_companion_idx on public.session_companions (companion_id);

create index messages_session_time_idx on public.messages (session_id, created_at);

create index recommendation_events_session_idx on public.recommendation_events (session_id, round);
create index recommendation_events_user_place_idx
  on public.recommendation_events (user_id, place_id, event);

-- R3 view: one row per session with every logged field. Runs with the caller's RLS.

create view public.session_log with (security_invoker = true) as
select
  s.id as session_id,
  s.user_id,
  s.started_at,
  s.local_date,
  s.day_of_week,
  s.is_weekend,
  s.meal_slot,
  s.craving_category_id,
  s.budget_level,
  s.radius_m,
  s.solo,
  (
    select array_agg(c.name order by c.name)
    from public.session_companions sc
    join public.companions c on c.id = sc.companion_id
    where sc.session_id = s.id
  ) as companions,
  (
    select array_agg(e.place_id order by e.rank)
    from public.recommendation_events e
    where e.session_id = s.id and e.round = 1 and e.event = 'shown'
  ) as top3_place_ids,
  (
    select jsonb_agg(
      jsonb_build_object('round', e.round, 'place_id', e.place_id, 'reason', e.reject_reason)
      order by e.created_at
    )
    from public.recommendation_events e
    where e.session_id = s.id and e.event = 'rejected'
  ) as rejected,
  s.outcome,
  m.place_id as final_place_id,
  m.distance_m,
  m.price_tap,
  m.went,
  m.stars
from public.sessions s
left join public.meals m on m.session_id = s.id;
