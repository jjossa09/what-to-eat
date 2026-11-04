-- #75. Synthetic fixtures only. Run in an isolated database with migrations applied.
begin;
insert into auth.users(id,aud,role,email) values
 ('aaaaaaaa-0000-0000-0000-000000000075','authenticated','authenticated','a75@test.invalid'),
 ('bbbbbbbb-0000-0000-0000-000000000075','authenticated','authenticated','b75@test.invalid');
insert into public.companions(id,user_id,name) values
 ('cccccccc-0000-0000-0000-000000000075','aaaaaaaa-0000-0000-0000-000000000075','Synthetic Alex'),
 ('cccccccc-0000-0000-0000-000000000076','aaaaaaaa-0000-0000-0000-000000000075','Synthetic Blake');
insert into public.taste_profiles(user_id,favorite_categories,hard_no_categories,budget_level,mostly_solo)
 values('aaaaaaaa-0000-0000-0000-000000000075',array['pizza','chinese'],array['thai'],2,true);

create function public.assert75(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %',label; end if; end $$;
grant execute on function public.assert75(boolean,text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-0000-0000-000000000075"}',true);
do $$
declare
 uid constant uuid := 'aaaaaaaa-0000-0000-0000-000000000075';
 conv constant uuid := '11111111-0000-0000-0000-000000000075';
 a jsonb; b jsonb; args jsonb; result jsonb; mid uuid; revision bigint;
 old_version timestamptz; profile_args jsonb;
begin
 args := jsonb_build_object('category_id','chicken_wings','eaten_on',current_date-1,'timezone','UTC',
   'allow_duplicate',false);
 a := public.prepare_companion_action(conv,'turn:1','log_meal',args);
 perform public.assert75((select count(*)=0 from public.meals where user_id=uid),'intent never saves');
 result := public.confirm_companion_action((a->>'id')::uuid,conv,args);
 mid := (result->>'meal_id')::uuid;
 perform public.assert75((select source='chat' and place_id is null and session_id is null
   and meal_slot is null and solo is null and category_id='chicken_wings' and ate_at is not null
   from public.meals where id=mid),'unknown place and food provenance');
 perform public.assert75(public.confirm_companion_action((a->>'id')::uuid,conv,args)=result,'retry identity');
 perform public.assert75((select count(*)=1 from public.meals where user_id=uid),'retry not duplicate');
 b := public.prepare_companion_action(conv,'turn:2','log_meal',args);
 perform public.assert75(public.confirm_companion_action((b->>'id')::uuid,conv,args)->>'status'='duplicate',
   'matching meal needs explicit add-another');
 args := args||'{"allow_duplicate":true}'::jsonb;
 b := public.prepare_companion_action(conv,'turn:2','log_meal',args);
 perform public.confirm_companion_action((b->>'id')::uuid,conv,args);
 perform public.assert75((select count(*)=2 from public.meals where user_id=uid),'legitimate second meal');
 a := public.prepare_companion_action(conv,'turn:3','log_meal',args);
 perform public.cancel_companion_action((a->>'id')::uuid,conv);
 begin
   perform public.confirm_companion_action((a->>'id')::uuid,conv,args);
   raise exception 'cancelled action executed';
 exception when serialization_failure then null; end;
 a := public.prepare_companion_action(conv,'turn:4','log_meal',args);
 b := public.prepare_companion_action(conv,'turn:5','log_meal',args);
 perform public.assert75((select state='cancelled' from public.companion_actions where id=(a->>'id')::uuid),
   'one pending per conversation');
 perform public.cancel_companion_action(null,conv);
 perform public.assert75((select state='cancelled' from public.companion_actions where id=(b->>'id')::uuid),
   'cancel by context survives a lost preparation response');
 -- Genuine historical corrections have no invented session or restaurant.
 select m.revision into revision from public.meals m where id=mid;
 args := jsonb_build_object('meal_id',mid,'revision',revision,'changes',jsonb_build_object('stars',5));
 a := public.prepare_companion_action(conv,'rating','rate_meal',args);
 perform public.confirm_companion_action((a->>'id')::uuid,conv,args);
 perform public.confirm_companion_action((a->>'id')::uuid,conv,args);
 perform public.assert75((select stars=5 from public.meals where id=mid),'rating saved');
 perform public.assert75((select count(*)=1 from public.meal_corrections where meal_id=mid),'single rating audit');
 b := public.prepare_companion_action(conv,'stale-rating','rate_meal',args);
 begin
   perform public.confirm_companion_action((b->>'id')::uuid,conv,args);
   raise exception 'stale correction executed';
 exception when serialization_failure then null; end;
 perform public.cancel_companion_action((b->>'id')::uuid,conv);
 select updated_at into old_version from public.taste_profiles where user_id=uid;
 profile_args := jsonb_build_object('favorites',jsonb_build_array('pizza'),'hard_nos',jsonb_build_array('thai'),
   'budget',2,'mostly_solo',true,'expected_updated_at',old_version,'source','chat');
 a := public.prepare_companion_action(conv,'preference','preference_change',profile_args);
 perform public.confirm_companion_action((a->>'id')::uuid,conv,profile_args);
 perform public.confirm_companion_action((a->>'id')::uuid,conv,profile_args);
 perform public.assert75((select favorite_categories=array['pizza'] and hard_no_categories=array['thai']
   from public.taste_profiles where user_id=uid),'remove favorite does not exclude');
 perform public.assert75((select count(*)=1 from public.preference_changes where user_id=uid
   and source='chat' and old_value->'favorite_categories' @> '["chinese"]'::jsonb
   and not new_value->'favorite_categories' @> '["chinese"]'::jsonb),'reversible preference audit');
 b := public.prepare_companion_action(conv,'stale-profile','preference_change',profile_args);
 begin
   perform public.confirm_companion_action((b->>'id')::uuid,conv,profile_args);
   raise exception 'stale profile executed';
 exception when serialization_failure then null; end;
 perform public.cancel_companion_action((b->>'id')::uuid,conv);
 raise notice '#75: confirmation, retry, duplicates, cancellation, rating and profile audit passed';
end $$;

reset role;
insert into public.meals(id,user_id,source,category_id,eaten_on,solo)
 values('dddddddd-0000-0000-0000-000000000075','aaaaaaaa-0000-0000-0000-000000000075',
 'backfill','pizza',current_date-2,false);
insert into public.meal_companions(meal_id,companion_id,user_id) values
 ('dddddddd-0000-0000-0000-000000000075','cccccccc-0000-0000-0000-000000000075',
 'aaaaaaaa-0000-0000-0000-000000000075');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-0000-0000-000000000075"}',true);
select public.edit_meal('dddddddd-0000-0000-0000-000000000075',p_dish=>'Synthetic dish',p_solo=>true);
select public.assert75((select solo and ate_at is null and category_id='pizza' and session_id is null
  from public.meals where id='dddddddd-0000-0000-0000-000000000075'),'dish-only historical edit');
select public.assert75(not exists(select 1 from public.meal_companions
 where meal_id='dddddddd-0000-0000-0000-000000000075'),'solo removes links atomically');
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-0000-0000-000000000075"}',true);
select public.assert75(not exists(select 1 from public.preference_changes),'audit RLS');
do $$ begin
 perform public.edit_meal('dddddddd-0000-0000-0000-000000000075',p_stars=>1::smallint);
 raise exception 'cross-user edit succeeded';
exception when check_violation then null; end $$;
reset role;
do $$ begin raise notice '#75: historical edits, solo links and cross-user isolation passed'; end $$;

-- Predicted session company must not become an actual meal label. Older cards keep
-- their own explicit answer even if a later round has different company.
insert into public.places(id,name,lat,lon,category_id)
 values('synthetic:75','Synthetic place',1,2,'pizza');
insert into public.sessions(id,user_id,timezone,local_date,meal_slot,lat,lon,solo,company_confirmed)
select ('77777777-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'aaaaaaaa-0000-0000-0000-000000000075','UTC',current_date,'dinner',1,2,true,true
 from generate_series(1,5) n;
insert into public.recommendation_events(user_id,session_id,round,place_id,event,rank,slot,decision_company)
select user_id,id,1,'synthetic:75','shown',1,'discovery',
 case when id='77777777-0000-0000-0000-000000000001'::uuid then null
 when id in ('77777777-0000-0000-0000-000000000004'::uuid,
             '77777777-0000-0000-0000-000000000005'::uuid) then
 '{"confirmed":true,"solo":false,"companion_ids":["cccccccc-0000-0000-0000-000000000075","cccccccc-0000-0000-0000-000000000076"]}'::jsonb
 else '{"confirmed":true,"solo":true,"companion_ids":[]}'::jsonb end
 from public.sessions where id::text like '77777777-%';
insert into public.recommendation_events(user_id,session_id,round,place_id,event,rank,slot,decision_company)
 values('aaaaaaaa-0000-0000-0000-000000000075','77777777-0000-0000-0000-000000000002',
 2,'synthetic:75','shown',1,'discovery','{"confirmed":false,"solo":null,"companion_ids":[]}'),
 ('aaaaaaaa-0000-0000-0000-000000000075','77777777-0000-0000-0000-000000000003',
 1,'synthetic:75','shown',1,'discovery','{"confirmed":true,"solo":false,"companion_ids":[]}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-0000-0000-000000000075"}',true);
do $$ declare saved record; prepared jsonb; args jsonb; begin
 select * into saved from public.save_recommendation_pick(
   '77777777-0000-0000-0000-000000000001',1,'synthetic:75',10);
 perform public.assert75(saved.status='saved' and (select solo is null from public.meals
   where id=saved.meal_id),'no legacy/predicted company label');
 begin
   insert into public.meal_companions(meal_id,companion_id,user_id) values(saved.meal_id,
     'cccccccc-0000-0000-0000-000000000075','aaaaaaaa-0000-0000-0000-000000000075');
   raise exception 'legacy context became a confirmed companion';
 exception when insufficient_privilege then null; end;
 perform public.save_meal_feedback(saved.meal_id,p_went=>true);
 args := jsonb_build_object('category_id','pizza','eaten_on',current_date,'meal_slot','dinner',
   'timezone','UTC','allow_duplicate',false);
 prepared := public.prepare_companion_action('11111111-0000-0000-0000-000000000075',
   'actual-food','log_meal',args);
 perform public.assert75(public.confirm_companion_action((prepared->>'id')::uuid,
   '11111111-0000-0000-0000-000000000075',args)->>'status'='saved',
   'provisional restaurant category is not a matching eaten-food duplicate');
 select * into saved from public.save_recommendation_pick(
   '77777777-0000-0000-0000-000000000002',1,'synthetic:75',10);
 perform public.assert75(saved.status='saved' and (select solo from public.meals
   where id=saved.meal_id),'older card retains explicit company');
 perform public.assert75((select status='inconsistent' from public.save_recommendation_pick(
   '77777777-0000-0000-0000-000000000003',1,'synthetic:75',10)),
   'contradictory displayed company snapshots cannot save');
 select * into saved from public.save_recommendation_pick(
   '77777777-0000-0000-0000-000000000004',1,'synthetic:75',10);
 perform public.assert75((select array_agg(companion_id order by companion_id)=array[
   'cccccccc-0000-0000-0000-000000000075'::uuid,'cccccccc-0000-0000-0000-000000000076'::uuid]
   from public.meal_companions where meal_id=saved.meal_id),'exact two confirmed companions copied');
 perform public.save_meal_feedback(saved.meal_id,p_went=>true);
 perform public.edit_meal(saved.meal_id,p_solo=>true);
 perform public.save_recommendation_pick('77777777-0000-0000-0000-000000000004',1,'synthetic:75',10);
 perform public.assert75(not exists(select 1 from public.meal_companions where meal_id=saved.meal_id),
   'pick replay never restores links after a Solo edit');
 raise notice '#75: round-specific confirmed company provenance and atomic copying passed';
end $$;
reset role;
create function public.fail75_companion() returns trigger language plpgsql as $$
begin raise exception 'synthetic link failure'; end $$;
create trigger fail75_companion before insert on public.meal_companions
 for each row execute function public.fail75_companion();
set local role authenticated;
do $$ declare saved record; begin
 select * into saved from public.save_recommendation_pick(
   '77777777-0000-0000-0000-000000000005',1,'synthetic:75',10);
 perform public.assert75(saved.status='saved' and exists(select 1 from public.meals where id=saved.meal_id),
   'optional companion failure preserves committed primary pick');
 perform public.assert75(not exists(select 1 from public.meal_companions where meal_id=saved.meal_id),
   'optional failure rolls back all partial links');
 raise notice '#75: optional companion failure preserves the core pick';
end $$;
reset role;
rollback;
