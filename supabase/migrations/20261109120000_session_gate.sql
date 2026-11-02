-- P2-05 (ML6, ML10): the confidence gate's decisions, so every question traces to model output.
-- Shape: {"plan": {...the 3 questions, in order, with evidence...},
--         "rounds": {"1": {...the refinement choice after round 1, with gains...}, ...}}
-- Null on sessions from before this migration.

alter table public.sessions add column gate jsonb;

comment on column public.sessions.gate is
  'Confidence gate (ML6) plan and per-round refinement question with information gains (ML10).';

-- Adds one round's entry (and, on round 1, the plan) to the caller's own session, without a
-- read first. SECURITY INVOKER: it runs as the calling user, so RLS applies exactly as for a
-- direct update ("Read own sessions" to find the row, "Update own sessions" to change it). The
-- user_id filter is a second check. Returns false when no row of the caller's matched.
create function public.append_session_gate(
  p_session_id uuid,
  p_round integer,
  p_entry jsonb,
  p_plan jsonb default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_session_id is null or p_round is null or p_round < 1
     or jsonb_typeof(p_entry) is distinct from 'object'
     or (p_plan is not null and jsonb_typeof(p_plan) <> 'object') then
    raise exception 'bad gate entry' using errcode = '22023';
  end if;

  update public.sessions s
     set gate = coalesce(s.gate, '{}'::jsonb)
                || case when p_plan is null then '{}'::jsonb
                        else jsonb_build_object('plan', p_plan) end
                || jsonb_build_object(
                     'rounds',
                     case when jsonb_typeof(s.gate -> 'rounds') = 'object'
                          then s.gate -> 'rounds' else '{}'::jsonb end
                     || jsonb_build_object(p_round::text, p_entry))
   where s.id = p_session_id
     and s.user_id = uid;
  return found;
end;
$$;

revoke execute on function public.append_session_gate(uuid, integer, jsonb, jsonb)
  from public, anon;
grant execute on function public.append_session_gate(uuid, integer, jsonb, jsonb)
  to authenticated;
