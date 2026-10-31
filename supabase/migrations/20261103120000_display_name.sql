-- P1-22: the user's display name, asked once after the taste quiz. set_display_name() is the
-- only write path: profiles keeps read-only RLS, so users cannot edit onboarded_at or
-- input_mode directly.

create function public.set_display_name(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  clean text := btrim(coalesce(p_name, ''));
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if char_length(clean) < 1 or char_length(clean) > 40 then
    raise exception 'name must be 1 to 40 characters' using errcode = '22023';
  end if;
  update public.profiles set display_name = clean where id = uid;
end;
$$;

revoke execute on function public.set_display_name(text) from public, anon;
grant execute on function public.set_display_name(text) to authenticated;
