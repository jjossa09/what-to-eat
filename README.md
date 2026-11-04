# What to eat!

The middleman between you and your food decision.

## How it works
- Algorithms predict what you want from your own meal history.
- Muse interprets language into validated intents and patches; algorithms choose questions and rank places.
- Every pick is a real nearby place and traces to your data.

## Built with
Muse Spark and Muse Voice Transcribe (Meta Model API), Geoapify Places (OpenStreetMap data), Apple Maps, Expo, FastAPI, Supabase.

Places data © OpenStreetMap contributors, powered by Geoapify.

## Status
In development for the Meta Global AI Developer Hackathon. Submission Nov 4, 2026.

## Links
- [Requirements](docs/REQUIREMENTS.md)
- [Project board](https://github.com/users/jjossa09/projects/1)

## Intelligent food companion (#75)

Eat opens with “Hey! What are we eating today?” Give several answers together, change an earlier answer, say you are unsure, or ask for picks immediately. The server asks up to three necessary follow-ups. Predictions remain distinct from explicit answers and actual meals.

- “Not Chinese today” filters this search only. “Remove Chinese from my favorites” opens a permanent-change confirmation; it does not automatically add a hard exclusion.
- Log food and a date through an editable confirmation card. Unknown places and meal times stay unknown. Confirmed chat meals use `source=chat`; no restaurant or recommendation session is invented.
- Request a rating for a real meal, or correct an eligible historical meal. Ambiguous references require a choice. Retries use persisted idempotency and version checks.
- Ask for a restaurant by name. **Nearby** results are verified name/brand matches sorted by distance, separate from personalized recommendations. Searches may widen once to 25 miles and disclose that change.
- Ask about recent food or spending, or request a companion chart. Existing backend computations provide the data; the reply displays its calendar range and any incomplete-data warning. “Lately” means the last seven days. Existing chart components render in chat.
- Edit the taste quiz from Profile or confirm a chat preference request. The same writer checks versions and valid profiles, and records old/new values for audit.

Only confirmed food eaten is a cuisine training label. A predicted companion can influence recommendations but does not become a confirmed meal companion. Genuine feedback and confirmed historical corrections remain learning evidence. Temporary exclusions never train a model or alter the permanent taste profile.

## Language and privacy

The backend uses Muse Spark 1.3 for structured interpretation and optional evidence-grounded recommendation reasons. Code validates output and executes actions; Muse never independently selects, adds, removes or reorders cards. Greetings, acknowledgments and chip actions use no Muse call. Each typed message uses at most one parsing call. Chip-generated rounds keep template reasons without a Muse call; typed recommendation rounds can use signed progressive enhancement. Cards retain template reasons if enhancement fails; history can use deterministic factual text without a generation call.

The phone sends the current typed message for interpretation, with saved companion names replaced by anonymous references, plus the active question and allowed references. Other names or personal details entered voluntarily in free text may still be transmitted. This is not a claim of general personal-data anonymization. Do not enter confidential information. Chat meal creation and preference audits do not store the raw source message.

Reasons receive bounded structured evidence, including provider place IDs and recorded behavior, without coordinates, addresses or companion names. The existing Insights takeaway uses computed facts and anonymous companion placeholders. Operational Muse logs contain timing, token counts and validation outcomes, not prompts or response text.

Meta lists Muse Spark 1.3 as a Standard model. Its Standard-service terms exclude submitted content from model training, while allowing retention/processing for service, safety and related purposes. Contributor models have different training terms. Promotional credits alone do not establish privacy mode, and this project does not claim zero retention. See [Meta model designations](https://dev.meta.ai/legal/geographic-use-policy) and [Meta Model API terms](https://dev.meta.ai/legal/terms-of-service), verified November 4, 2026. Account-specific terms and actual production routing still require owner verification.

## Limits and verification

- Available category, budget and distance constraints are enforced by code. Unverified menu, seating, hours, health and amenity requests are acknowledged as unsupported; no provider facts or new scoring signals are invented.
- Refinement distance gain evaluates only currently retrieved candidates, including eligible stored places merged into that set. It cannot measure the value of farther restaurants that have not been retrieved.
- Name matching is conservative and may miss aliases; an unrelated nearby business is never substituted.
- #73 owns one-card-per-chain ranking. It is not implemented by the current ID/co-location deduplication, so that guarantee remains dependent on #73.
- Code, local migrations and synthetic tests are separate from deployed database state, production timing and iPhone verification. Apply the #75 migration before using the new application paths.
- The committed [offline evaluation](docs/EVALUATION.md) retains the November 1 aggregate results and sample sizes. It has not been rerun for #75; no improved accuracy is claimed.

## Requirements document

Requirements v1.8 is maintained in [Markdown](docs/REQUIREMENTS.md) and [PDF](docs/REQUIREMENTS.pdf). Regenerate with `python docs/build_requirements.py` using ReportLab as a documentation tool, outside the application dependency set.

The development tunnel restores the previous public mobile API URL when it exits, provided that URL was not changed by the user while the tunnel ran. Restart Metro after a URL change.
