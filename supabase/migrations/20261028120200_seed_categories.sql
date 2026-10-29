-- P1-06: the 23 ML2 categories plus Other (shown, never predicted).
-- Safe to re-run: existing rows are updated in place.

insert into public.categories (id, name, sort_order, predictable) values
  ('burgers', 'Burgers', 1, true),
  ('pizza', 'Pizza', 2, true),
  ('mexican', 'Mexican', 3, true),
  ('latin', 'Latin', 4, true),
  ('chinese', 'Chinese', 5, true),
  ('japanese_sushi', 'Japanese/Sushi', 6, true),
  ('korean', 'Korean', 7, true),
  ('thai', 'Thai', 8, true),
  ('vietnamese', 'Vietnamese', 9, true),
  ('indian', 'Indian', 10, true),
  ('mediterranean', 'Mediterranean', 11, true),
  ('italian', 'Italian', 12, true),
  ('french', 'French', 13, true),
  ('american_diner', 'American/Diner', 14, true),
  ('bbq', 'BBQ', 15, true),
  ('chicken_wings', 'Chicken/Wings', 16, true),
  ('sandwiches', 'Sandwiches', 17, true),
  ('seafood', 'Seafood', 18, true),
  ('salads_bowls', 'Salads/Bowls', 19, true),
  ('breakfast_brunch', 'Breakfast/Brunch', 20, true),
  ('coffee_bakery', 'Coffee/Bakery', 21, true),
  ('smoothies_juice', 'Smoothies/Juice', 22, true),
  ('dessert', 'Dessert', 23, true),
  ('other', 'Other', 24, false)
on conflict (id) do update
  set name = excluded.name,
      sort_order = excluded.sort_order,
      predictable = excluded.predictable;
