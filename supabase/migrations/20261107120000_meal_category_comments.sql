-- P2-02: category meaning, comment only (no schema change). Replaces the stale inline
-- comments on meals.category_id and the unresolved places note in 20261028120000_schema.sql.

comment on column public.meals.category_id is
  'The food eaten. Backfill: the CSV category. Live: the "What did you have?" answer; until '
  'it is given (ate_at is null) it holds the place category at pick time and the cuisine '
  'model ignores it. Never Other for a counted meal. Never changes the place''s category.';

comment on column public.places.category_id is
  'The ML2 mapping only (exact-name overrides, then tags, chains, and name keywords). '
  'May be Other. Never set from a meal label, backfill or live. Unresolved places are mapped '
  'from the name alone.';
