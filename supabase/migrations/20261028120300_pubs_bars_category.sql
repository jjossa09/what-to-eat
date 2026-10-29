-- P1-20: ML2 adds Pubs/Bars (24 categories plus Other). Other moves to the end.
-- Safe to re-run: existing rows are updated in place.

insert into public.categories (id, name, sort_order, predictable) values
  ('pubs_bars', 'Pubs/Bars', 24, true),
  ('other', 'Other', 25, false)
on conflict (id) do update
  set name = excluded.name,
      sort_order = excluded.sort_order,
      predictable = excluded.predictable;
