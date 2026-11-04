# #75 implementation and targeted verification

Branch: `juan-wte-food-companion`. Base/HEAD reviewed: `7aca3076ae09734692f5fec581101cbf5d342982`. These are uncommitted working-tree changes, not merged, deployed or production-verified behavior.

## Decisions and approved conflicts

- Juan approved date plus known slot chronology for “last meal”; ties and unknown slots require a choice. No timestamp was invented.
- Juan approved disposable ReportLab tooling in `/tmp/wte75-pdf-tooling`; application dependency files were not changed.
- Named matching accepts exact normalized provider names or exact provider brands. It does not invent a fuzzy score/threshold or accept a closest guess. This can miss aliases. The existing maximum is 40,234 m. This week uses the existing ISO calendar convention, Monday through today.
- Deterministic chip-generated recommendation rounds keep template reasons with zero Muse calls. Typed recommendation rounds retain optional signed progressive enhancement. This follows the approved zero-call chip policy while retaining the existing signed enhancement mechanism.
- The approved assignment supersedes the old exactly-three rule in local agent/product text, the ordinary implementation-approval pause, protected-file restrictions for named model/history/evaluation files, and permission requirements for the explicitly approved migration/Meta/Geoapify work. No agent/configuration file was changed. The mandatory targeted-testing restrictions remain in force.

## Implemented behavior

- Fixed greeting, multi-field parsing/correction, explicit uncertainty, recommend-now, up to three necessary questions, separate exclusions and per-field provenance using the existing server gate.
- One validated parsing response per message; action precedence; one pending action; explicit side-effect confirmation; second actions offered rather than silently executed; deterministic acknowledgments/chips.
- Session exclusions before selection, preserved refinement chips and the approved first-rejection invitation. Existing ranking, widening, cap and signed-reason paths remain; no scoring parameters or new models.
- Chat meals with actual food/date, editable unknown optional fields, duplicate warning, persisted idempotency and no invented place/session/companions. Feedback and eligible historical edits use shared owned/versioned SQL logic.
- Confirmed company snapshots per displayed round. Initial pick copying runs inside the pick RPC under the meal transaction. A subtransaction catches optional link failures without losing the core pick; exact replays never restore edited links. RLS denies legacy/predicted-context companion copying.
- Provider-backed Nearby name lookup, bounded history ranges and genuine existing chart components, shared audited persistent preferences and Profile taste editing.
- Name redaction on mixed-message parsing; a failed name read sends no free text to Muse. Content-free operational logs, fixed provider limits and bounded new network calls.
- Requirements v1.8 Markdown/PDF, privacy and retrieval-limit documentation, preserved historical evaluation report, and tunnel URL restoration.

## Files changed

| File | Purpose |
|---|---|
| `api/app/conversation.py` | Strict one-call language protocol, survey provenance, uncertainty, exclusions and existing-gate decisions. |
| `api/app/companion_actions.py` | Validated action payloads, owned bounded meal/profile reads, last-meal ambiguity and sanitized RPC transport. |
| `api/app/main.py` | Registered conversation/action/history/correction/profile routes and conservative Nearby search; survey handoff and shown-round provenance. |
| `api/app/funnel.py` | Explicit session/round company provenance; primary pick RPC owns companion copying, with no secondary network write. |
| `api/app/places.py` | Documented name filter, provider brand capture and deterministic exact normalized matching. |
| `api/app/history.py` | Read genuine chat food/place evidence and confirmed historical ratings. |
| `api/app/cuisine_model.py` | Count confirmed chat food under the existing temporal and category rules; no formula changes. |
| `api/app/place_model.py` | Count verified actual chat visits; no formula changes. |
| `api/app/companion_metrics.py` | Count actual chat participation and report its source. |
| `api/app/insight_metrics.py` | Report unknown chat distances as missing. |
| `api/app/insights.py` | Bounded calendar/slot filters and genuine chat records through existing aggregations. |
| `api/scripts/evaluate.py` | Report chat source counts only; replay, baselines and parameters unchanged. |
| `mobile/lib/companion.ts` | Typed protocol, name anonymization, deterministic action precedence, acknowledgments and runtime parsing validation. |
| `mobile/lib/companionActions.ts` | Editable action drafts, shared profile mutations, bounded named-result cache and exact confirmation payload checks. |
| `mobile/lib/api.ts` | Bounded authenticated companion calls; nullable survey inputs and chat source types. |
| `mobile/lib/profile.ts` | Optional fail-closed companion loading for outbound parsing, preserving existing fallback callers. |
| `mobile/lib/meals.ts` | Actual-food display, explicit place status, eligible historical edits and versioned correction requests. |
| `mobile/components/Chat.tsx` | Fixed greeting, server-owned variable gate, mixed intents, pending cards, refinement, Nearby/history, private parsing and chronological chart placement. |
| `mobile/components/CompanionCards.tsx` | Editable meal/rating/preference confirmation, ambiguity resolution, Nearby cards and existing Insights charts. |
| `mobile/components/MealCard.tsx` | Historical/food/company/amount editing, Solo cleanup and explicit unknown/unresolved place display; frosted frame retained. |
| `mobile/screens/MealsScreen.tsx` | Pass ownership context into meal editing. |
| `mobile/screens/ProfileScreen.tsx` | Editable taste quiz through the same audited writer as chat. |
| `supabase/migrations/20261112120000_food_companion.sql` | Chat source, revisions, owned pending actions, confirmation/idempotency, audits, shared correction/profile writers, round company snapshot, atomic optional copying and stricter companion-insert provenance. |
| `api/tests/test_food_companion.py` | Synthetic protocol, gate, action, range, named-search, ranking and provenance regressions. |
| `api/tests/test_history.py` | Directly superseded historical-rating assertion now preserves genuine ratings. |
| `api/tests/test_companion_context.py` | Explicit confirmed snapshot fixture and RPC-copy contract; real copying is exercised in SQL. |
| `api/tests/test_pick_integrity.py` | Assert no secondary companion write; retain primary identity/retry protections. |
| `mobile/lib/companion.test.mjs` | Privacy, validation, isolated state, precedence, date, profile and confirmation behavior. |
| `mobile/components/companionFlow.test.mjs` | Real Chat callbacks with mocked boundaries, confirmation, zero-call chips, privacy fallback and chronological history. |
| `mobile/components/saveRace.test.mjs` | Adapt protocol fixtures and superseded question assumptions; retain all 19 save/race/retry assertions. |
| `supabase/tests/food_companion_test.sql` | Real owned mutations, retries, duplicate handling, audits, historical edits, privacy/provenance and optional-copy failure. |
| `supabase/tests/pick_integrity_test.sql` | Existing explicit-Solo fixture now supplies its shown-round provenance. |
| `supabase/tests/companion_writes_test.sql` | Existing permitted-copy fixture now includes the confirmed picked-round evidence; ownership/anonymous checks retained. |
| `scripts/dev-tunnel.sh` | Restore the original public API URL on exit while retaining other/user-edited settings. |
| `scripts/test_dev_tunnel.py` | Synthetic LF/CRLF restoration and user-change regressions; never reads an actual environment file. |
| `README.md` | Supported behavior, transmitted text/privacy, provenance, unsupported dimensions, candidate-refinement limit and deployment/dependency limits. |
| `docs/REQUIREMENTS.md` | Approved v1.8 FR4/ML6, action and provenance contracts. |
| `docs/REQUIREMENTS.pdf` | Regenerated eight-page v1.8 counterpart. |
| `docs/build_requirements.py` | Repeatable Markdown-to-PDF generation with disposable ReportLab tooling. |
| `docs/EVALUATION.md` | Preserve the November 1 results and document the conversational/provenance boundary. |
| `docs/VERIFICATION_75.md` | This implementation and verification handoff. |

## Targeted API commands and output

Working directory: `api/`. The wrapper disables dotenv loading before pytest imports application settings. All inputs/upstreams are synthetic. Parameterized selectors account for the test counts. Runs overlap; do not add the counts as unique tests. FastAPI tests used approved sandbox escalation; no live providers or user database were used.

Integration run before the final atomic-copy change. Its old companion-copy selector was subsequently renamed; the current replacement and retry cases were verified separately below.

```sh
timeout --signal=INT 45s .venv/bin/python -B -c 'from app.config import Settings; Settings.model_config["env_file"] = None; import pytest; raise SystemExit(pytest.main(["-q","-p","no:cacheprovider","tests/test_food_companion.py","tests/test_places.py::test_one_call_with_expected_params","tests/test_places.py::test_route_response_shape","tests/test_places.py::test_route_validation","tests/test_history.py::test_genuine_historical_stars_are_kept_and_went_false_is_dropped","tests/test_companion_context.py::test_a_pick_copies_the_session_companions_to_the_meal","tests/test_companion_context.py::test_a_pick_without_companions_makes_no_meal_companions_call","tests/test_reasons.py::test_round_templates_signed_evidence_and_zero_muse_calls","tests/test_reasons.py::test_one_call_reorders_to_signed_ids_and_never_writes","tests/test_evaluate.py::test_cuisine_replay_never_sees_same_day_or_later_meals","tests/test_evaluate.py::test_csv_mode_end_to_end_and_report_has_no_private_values"]))'
```

```text
.....................................                                    [100%]
37 passed in 0.99s
```

New correction, company-validation, ranking and cancellation cases, plus the directly affected transition regressions.

```sh
timeout --signal=INT 45s .venv/bin/python -B -c 'from app.config import Settings; Settings.model_config["env_file"] = None; import pytest; raise SystemExit(pytest.main(["-q","-p","no:cacheprovider","tests/test_food_companion.py::test_explicit_correction_can_restore_a_previously_excluded_food","tests/test_food_companion.py::test_conflicting_absolute_and_relative_corrections_cannot_overwrite_state","tests/test_food_companion.py::test_ambiguous_or_contradictory_meal_company_is_rejected","tests/test_food_companion.py::test_survey_contract_reaches_real_ranking_and_logs_prediction_provenance","tests/test_food_companion.py::test_context_cancellation_is_owned_and_does_not_require_a_lost_action_id","tests/test_food_companion.py::test_all_values_in_one_message_need_zero_questions","tests/test_food_companion.py::test_relative_steps_use_existing_rules_once_and_excludes_precede_ranking"]))'
```

```text
........                                                                 [100%]
8 passed in 0.60s
```

Food-specific feedback must use confirmed food.

```sh
timeout --signal=INT 45s .venv/bin/python -B -c 'from app.config import Settings; Settings.model_config["env_file"] = None; import pytest; raise SystemExit(pytest.main(["-q","-p","no:cacheprovider","tests/test_food_companion.py::test_food_feedback_lookup_never_matches_a_provisional_restaurant_category"]))'
```

```text
.                                                                        [100%]
1 passed in 0.36s
```

Final atomic-copy boundary and existing pick identity/retry regressions.

```sh
timeout --signal=INT 45s .venv/bin/python -B -c 'from app.config import Settings; Settings.model_config["env_file"] = None; import pytest; raise SystemExit(pytest.main(["-q","-p","no:cacheprovider","tests/test_companion_context.py::test_a_pick_delegates_confirmed_companion_copy_to_the_atomic_rpc","tests/test_companion_context.py::test_a_pick_without_companions_makes_no_meal_companions_call","tests/test_pick_integrity.py::test_pick_never_makes_a_secondary_companion_write","tests/test_pick_integrity.py::test_saved_and_verified_replay_return_same_meal_identity","tests/test_pick_integrity.py::test_endpoint_retry_preserves_existing_data_and_does_not_repeat_primary_writes","tests/test_pick_integrity.py::test_rpc_failure_stays_retryable_and_lost_response_can_replay"]))'
```

```text
........                                                                 [100%]
8 passed in 0.79s
```

## Targeted mobile commands and output

Working directory: `mobile/`. Native elements and network boundaries are mocked; production handlers run. These do not prove iPhone layout, native animation or deployed behavior. Node emits the existing module-type warning; configuration files were left unchanged.

The final combined chat/pick-race run after the ownership, privacy, zero-call and retry changes:

```sh
node --test --experimental-test-isolation=none --test-reporter=spec components/companionFlow.test.mjs components/saveRace.test.mjs
```

```text
(node:2) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/juanj/projects/what-to-eat/mobile/lib/companion.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/juanj/projects/what-to-eat/mobile/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ Eat opens with fixed greeting and no Muse or question-plan call (245.052596ms)
✔ multi-field first message renders no repeated questions and makes one redacted parse call (126.911025ms)
✔ deterministic survey chip taps never call Muse parsing (114.12348ms)
✔ first None of these shows the approved invitation and keeps deterministic refinement chips (70.945719ms)
✔ meal intent freezes survey and saves only after one explicit Confirm despite a double tap (70.675483ms)
✔ a failed companion read never uploads an unredacted free-text message (57.565221ms)
✔ two side effects expose only the first until explicit confirmation and another user tap (56.244778ms)
✔ an unrelated parsed message cancels the pending meal without saving it (56.700662ms)
✔ a chip-generated round keeps templates and never schedules Muse reason enhancement (59.473928ms)
✔ current save succeeds once, reports its place and preserves the feedback reminder (66.945986ms)
✔ verified HTTP 200 retry confirms the original operation once after a lost response (70.936161ms)
✔ genuine 409 closes only the original search without a saved claim, celebration or reminder (63.607276ms)
✔ delayed pick success during parsing cannot decide or message the newer conversation (56.249208ms)
✔ delayed pick success during fetching cannot decide or message the newer conversation (60.940252ms)
✔ delayed pick success during results cannot decide or message the newer conversation (54.347611ms)
✔ a not_sure refinement does not restore an older save's conversation ownership (56.993191ms)
✔ a network refinement does not restore an older save's conversation ownership (58.301705ms)
✔ delayed network after refinement stays with its original save (64.985461ms)
✔ delayed conflict after refinement stays with its original save (61.205323ms)
✔ retry success in the unchanged conversation still confirms once without restarting ownership (43.157902ms)
✔ a failed old retry may fail again without cancelling a newer parse or reporting success (45.216447ms)
✔ a stale card press during parsing cannot start a pick or cancel the current operation (41.764724ms)
✔ a stale card event after new results, before card rerender, cannot save the prior round (53.466964ms)
✔ new search reset rejects a delayed earlier success and retains its legitimate saved-meal reminder (70.854618ms)
✔ unmount leaves the legitimate request alive without React, chat, haptic or reminder callbacks (47.843665ms)
✔ final None save ok uses the same ownership guard after refinement (51.148961ms)
✔ final None save network uses the same ownership guard after refinement (50.880397ms)
✔ final None save conflict uses the same ownership guard after refinement (54.275263ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2499.727926
```

After placing history/Nearby outputs at their own chronological turn, only the affected chat file was rerun:

```sh
node --test --experimental-test-isolation=none --test-reporter=spec components/companionFlow.test.mjs
```

```text
(node:2) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/juanj/projects/what-to-eat/mobile/lib/companion.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/juanj/projects/what-to-eat/mobile/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ Eat opens with fixed greeting and no Muse or question-plan call (259.35241ms)
✔ multi-field first message renders no repeated questions and makes one redacted parse call (112.572628ms)
✔ deterministic survey chip taps never call Muse parsing (83.605326ms)
✔ first None of these shows the approved invitation and keeps deterministic refinement chips (93.74981ms)
✔ meal intent freezes survey and saves only after one explicit Confirm despite a double tap (60.780631ms)
✔ a failed companion read never uploads an unredacted free-text message (55.541269ms)
✔ two side effects expose only the first until explicit confirmation and another user tap (65.972861ms)
✔ an unrelated parsed message cancels the pending meal without saving it (61.711897ms)
✔ a chip-generated round keeps templates and never schedules Muse reason enhancement (63.069223ms)
✔ verified history stays at its own turn and a pure read does not recompute the survey (57.842205ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1302.160625
```

The protocol helper file also passed its 10 cases using this exact command (in an earlier combined run with the then-eight chat cases):

```sh
node --test --experimental-test-isolation=none --test-reporter=spec components/companionFlow.test.mjs lib/companion.test.mjs
```

```text
✔ Eat opens with fixed greeting and no Muse or question-plan call (252.860794ms)
✔ multi-field first message renders no repeated questions and makes one redacted parse call (101.057308ms)
✔ deterministic survey chip taps never call Muse parsing (75.739786ms)
✔ first None of these shows the approved invitation and keeps deterministic refinement chips (84.209697ms)
✔ meal intent freezes survey and saves only after one explicit Confirm despite a double tap (65.069258ms)
✔ a failed companion read never uploads an unredacted free-text message (50.500522ms)
✔ two side effects expose only the first until explicit confirmation and another user tap (46.046038ms)
✔ an unrelated parsed message cancels the pending meal without saving it (50.879783ms)
✔ mixed survey, meal and history messages redact saved companion names before parsing (1.719529ms)
✔ privacy matching preserves words and rejects ambiguous companion associations (0.571146ms)
✔ new conversations share no survey objects, exclusions, answers or questions (0.242841ms)
✔ action precedence exposes only one side effect and requires explicit handling of the second (0.132552ms)
✔ confirmation text is derived from actual validated changes, never a model call (0.102665ms)
✔ invalid patch values and malformed actions fail mobile validation (0.133384ms)
✔ weekday meal references stay unresolved and calendar yesterday crosses month boundaries (17.146132ms)
✔ removing a favorite never creates a permanent exclusion and preserves unrelated preferences (5.556355ms)
✔ chat meal drafts preserve unknown place, time and company without creating a visit (5.660223ms)
✔ preparation alone makes no confirmation call and confirmation uses the exact validated payload (5.447667ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1188.9172
```

## Database commands and output

Disposable PostgreSQL 18, synthetic users, schema migrations applied as setup, only the explicitly named SQL files executed. The local runner bootstraps auth roles/uid and Supabase-style table grants; it does not reproduce hosted PostgREST/auth infrastructure. It starts a Unix-socket database, runs each SQL test transaction, and stops it. No deployed migration was applied. Runner is a local artifact at `/tmp/wte75-pg-runner.py`, not a project dependency or file to stage.

Earlier directly affected edit/pick checks:

```sh
python3 /tmp/wte75-pg-runner.py food_companion_test.sql edit_meal_test.sql pick_integrity_test.sql
```

```text
food_companion_test.sql: PASS
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:84: NOTICE:  #75: confirmation, retry, duplicates, cancellation, rating and profile audit passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:107: NOTICE:  #75: historical edits, solo links and cross-user isolation passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:142: NOTICE:  #75: round-specific confirmed company provenance passed
edit_meal_test.sql: PASS
psql:/home/juanj/projects/what-to-eat/supabase/tests/edit_meal_test.sql:156: NOTICE:  edit_meal: all checks passed
pick_integrity_test.sql: PASS
psql:/home/juanj/projects/what-to-eat/supabase/tests/pick_integrity_test.sql:279: NOTICE:  pick integrity: all checks passed
```

After the atomic-copy and insert-policy changes:

```sh
python3 /tmp/wte75-pg-runner.py food_companion_test.sql companion_writes_test.sql pick_integrity_test.sql
```

```text
food_companion_test.sql: PASS
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:87: NOTICE:  #75: confirmation, retry, duplicates, cancellation, rating and profile audit passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:110: NOTICE:  #75: historical edits, solo links and cross-user isolation passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:166: NOTICE:  #75: round-specific confirmed company provenance and atomic copying passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:181: NOTICE:  #75: optional companion failure preserves the core pick
companion_writes_test.sql: PASS
psql:/home/juanj/projects/what-to-eat/supabase/tests/companion_writes_test.sql:123: NOTICE:  companion_writes: all checks passed
pick_integrity_test.sql: PASS
psql:/home/juanj/projects/what-to-eat/supabase/tests/pick_integrity_test.sql:279: NOTICE:  pick integrity: all checks passed
```

The final explicit RLS-denial assertion was verified with only the new file:

```sh
python3 /tmp/wte75-pg-runner.py food_companion_test.sql
```

```text
food_companion_test.sql: PASS
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:87: NOTICE:  #75: confirmation, retry, duplicates, cancellation, rating and profile audit passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:110: NOTICE:  #75: historical edits, solo links and cross-user isolation passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:171: NOTICE:  #75: round-specific confirmed company provenance and atomic copying passed
psql:/home/juanj/projects/what-to-eat/supabase/tests/food_companion_test.sql:186: NOTICE:  #75: optional companion failure preserves the core pick
```

The optional-copy test deliberately injects a database link failure. The function emits only a content-free warning and preserves the primary meal/event/session transaction.

## Tunnel regression

```sh
python3 scripts/test_dev_tunnel.py
```

```text
test_preserves_a_url_changed_by_the_user (__main__.TunnelCleanup.test_preserves_a_url_changed_by_the_user) ... ok
test_preserves_user_changes_to_other_settings (__main__.TunnelCleanup.test_preserves_user_changes_to_other_settings) ... ok
test_restores_original_crlf_bytes (__main__.TunnelCleanup.test_restores_original_crlf_bytes) ... ok
test_restores_original_lf_bytes (__main__.TunnelCleanup.test_restores_original_lf_bytes) ... ok

----------------------------------------------------------------------
Ran 4 tests in 0.311s

OK
```

## Targeted lint, types, documentation and repository checks

These are targeted checks, not full validation. Final output for each Ruff invocation was `All checks passed!`; ESLint exited 0 with no output. Formatting findings were corrected without changing test expectations.

From `api/`:

```sh
.venv/bin/ruff check app/conversation.py app/companion_actions.py app/companion_metrics.py app/cuisine_model.py app/funnel.py app/history.py app/insight_metrics.py app/insights.py app/main.py app/place_model.py app/places.py scripts/evaluate.py tests/test_food_companion.py tests/test_companion_context.py tests/test_history.py
.venv/bin/ruff check app/funnel.py tests/test_companion_context.py tests/test_pick_integrity.py
.venv/bin/ruff check ../docs/build_requirements.py ../scripts/test_dev_tunnel.py
```

From `mobile/`, initial exact roots and later changed-file checks:

```sh
node_modules/.bin/eslint components/Chat.tsx components/CompanionCards.tsx components/MealCard.tsx screens/ProfileScreen.tsx screens/MealsScreen.tsx lib/api.ts lib/companion.ts lib/companionActions.ts lib/meals.ts lib/profile.ts
node_modules/.bin/eslint components/Chat.tsx components/MealCard.tsx screens/ProfileScreen.tsx
node /tmp/issue75-typecheck.cjs
```

```text
Targeted TypeScript roots: 9 files, no errors.
```

The local TypeScript runner uses the existing tsconfig options with noEmit and incremental=false, and only these roots plus their imported dependency closure: Chat.tsx, CompanionCards.tsx, MealCard.tsx, ProfileScreen.tsx, MealsScreen.tsx, api.ts, companion.ts, companionActions.ts, meals.ts. It is not the entire TypeScript gate. The runner is a local artifact, not a file to stage.

From repository root:

```sh
PYTHONPATH=/tmp/wte75-pdf-tooling api/.venv/bin/python docs/build_requirements.py
git diff --check
git check-ignore AGENTS.md
git rev-parse HEAD
rg -n '#[0-9a-fA-F]{3,8}\\b|rgba?\\(' mobile/components/Chat.tsx mobile/components/CompanionCards.tsx mobile/components/MealCard.tsx mobile/screens/ProfileScreen.tsx mobile/screens/MealsScreen.tsx mobile/lib/api.ts mobile/lib/companion.ts mobile/lib/companionActions.ts mobile/lib/meals.ts mobile/lib/profile.ts
```

```text
Generated REQUIREMENTS.pdf from 215 Markdown lines.
AGENTS.md
7aca3076ae09734692f5fec581101cbf5d342982
```

`git diff --check` exited 0 with no output. The color search exited 1 with no matches, the expected success condition. A stdlib PDF stream check found v1.8, FR4, ML6, companion contracts, date/schema sections and eight pages. It does not prove visual page layout. Tooling is Python 3.12-compatible; the first attempt with system Python 3.14 failed to import its Pillow extension, then the matching existing API interpreter generated the PDF successfully.

## Remaining dependencies, limits and owner actions

- Juan must apply `20261112120000_food_companion.sql` in order, then deploy the API and updated mobile client together. The existing core schema already permits unknown places and optional slots. This change adds no environment variables or application dependencies.
- Legacy routes remain. Legacy requests without explicit provenance cannot authorize company training labels; the new RLS boundary deliberately prevents legacy inference from becoming confirmed meal links. Coordinate database/API/mobile rollout.
- #73 is unfinished in this base: existing ID/co-location deduplication does not prove one card per chain. #75 did not change ranking/deduplication or claim this guarantee.
- Production Meta structured-output acceptance/semantic quality, free-credit/account privacy terms, Geoapify real-name coverage, hosted auth/PostgREST policies and production timings remain unverified. No live model/provider calls or real-user evaluation were made.
- The gate and recommendation endpoints both read bounded history. Pure action messages avoid unnecessary gate reads, and no per-candidate database queries were added. End-to-end response time includes parsing and gate work; the approximate eight-second round target needs deployed measurement. Existing parse/round/Places/reasons deadlines remain.
- iPhone layout, keyboard/confirmation/chart interaction, native animation and complete deployed end-to-end paths require device verification. Tests mock native hosts. The tunnel script was tested only with synthetic configuration files.
- No unresolved Claude decision remains after Juan's date/slot and disposable-tooling clarifications. Conservative name matching and the #73 dependency are stated limits, not invented provider/model capabilities.
- Latest published evaluation remains November 1: 24 cuisine meals (23 backfill, 1 live), 18 resolved-place meals. Cold-start model cuisine top-3 8/24; quiz-prior run 9/24; place top-3 7/18 in both. No new evaluation or improved result was claimed. Historical corrections change future inputs, not past published results.
- Initial race regressions failed during parsing until ownership invalidation was restored at message start. The same 19 cases passed afterward. Existing ownership/anonymous SQL checks were retained; transport-only companion assertions moved to a stronger real-SQL copying/failure regression. Genuine historical ratings intentionally replace the old discard assertion. No test was weakened to hide a defect.
- No Git writes, branch switches/fetches, GitHub changes, environment/agent/configuration edits or full quality gates were performed. AGENTS.md remains ignored. Approved out-of-sandbox work was limited to the disposable tooling installation and named local tests.
