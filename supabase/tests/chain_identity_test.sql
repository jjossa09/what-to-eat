-- Focused #73 regression. Run only in a disposable synthetic database after migrations.
-- This file and the new migration are deliberately not executed by this assignment.
begin;

insert into public.places
  (id,name,lat,lon,category_id,geoapify_categories,brand,brand_wikidata)
values ('geoapify:synthetic-chain-73-a','Synthetic branch',1,2,'chinese',
        array['catering.restaurant.chinese'],'Synthetic Chain','Q730001');

-- A later provider response that omits optional metadata retains known evidence.
update public.places set brand=null, brand_wikidata=null
where id='geoapify:synthetic-chain-73-a';
do $$ begin
  assert (select brand='Synthetic Chain' and brand_wikidata='Q730001'
          from public.places where id='geoapify:synthetic-chain-73-a'),
    'Missing metadata must not erase known brand evidence';
end $$;

-- Positively changed brand evidence cannot inherit an unrelated old identity.
update public.places set brand='Other Synthetic Chain', brand_wikidata=null
where id='geoapify:synthetic-chain-73-a';
do $$ begin
  assert (select brand='Other Synthetic Chain' and brand_wikidata is null
          from public.places where id='geoapify:synthetic-chain-73-a'),
    'A changed brand must not inherit the previous brand Wikidata ID';
end $$;
update public.places set brand=null, brand_wikidata='Q730002'
where id='geoapify:synthetic-chain-73-a';
do $$ begin
  assert (select brand is null and brand_wikidata='Q730002'
          from public.places where id='geoapify:synthetic-chain-73-a'),
    'A changed Wikidata ID must not inherit an unrelated old brand name';
end $$;

-- Equal independent names remain unknown; the database never manufactures identities.
insert into public.places(id,name,lat,lon,category_id)
values ('geoapify:synthetic-independent-73-a','Synthetic Independent',1,2,'chinese'),
       ('geoapify:synthetic-independent-73-b','Synthetic Independent',3,4,'chinese');
do $$ begin
  assert (select count(*)=2 from public.places
          where id in ('geoapify:synthetic-independent-73-a','geoapify:synthetic-independent-73-b')
            and brand is null and brand_wikidata is null),
    'Equal independent names cannot imply a chain';
  begin
    update public.places set brand_wikidata='not-a-brand-id'
      where id='geoapify:synthetic-chain-73-a';
    raise exception 'Malformed Wikidata ID was accepted';
  exception when check_violation then
    null;
  end;
end $$;

rollback;
