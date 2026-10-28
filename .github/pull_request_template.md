## Problem
<!-- What is wrong or missing, in one or two lines. Link the ticket: Closes #N (P1-XX). -->

## Change
<!-- What this PR does. Short bullets. -->

## Before merge
- [ ] api/: `uv run ruff check . && uv run pytest`
- [ ] mobile/: `npx expo lint && npx tsc --noEmit`
- [ ] New env vars added to api/.env.example
- [ ] No keys, secrets, or Meta/Geoapify endpoints in mobile/
- [ ] API and app request/response shapes match
- [ ] Supabase schema and types match on both sides
- [ ] Product rules R1-R3 and NFR5 (attribution, no health claims) still hold

## Not addressed
<!-- Known gaps or follow-ups, with ticket IDs. "None" if nothing. -->

## Tests
<!-- What you ran and what you checked by hand (e.g. iPhone via Expo Go). -->
