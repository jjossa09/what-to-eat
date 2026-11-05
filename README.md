# What to eat! 🦦

**Your personal food decision companion.**

*The middleman between you and your food decision.*

Imagine having a friend who remembers what you eat, how much you spend, which restaurants you enjoy, and what you usually crave.

That friend is **Otis**, the food companion behind What to eat!

What to eat! is an AI-powered iOS application that combines machine learning with Meta's Muse to help people decide where to eat. Instead of endlessly scrolling through restaurants, users have a natural conversation, receive personalized recommendations, and help the system improve through their actual eating history.

Built as a solo project for the **Meta Global AI Developer Hackathon 2026, Indie Developer Track**.

## What makes it different?

**Algorithms predict. Muse explains. Code validates.**

What to eat! is more than a chatbot connected to a restaurant API.

The recommendation engine and conversational AI have separate responsibilities:

- **Machine learning:** Analyzes recorded meals, recognizes patterns, estimates preferences, and ranks restaurant candidates.
- **Meta Muse Spark:** Understands natural-language requests, interprets user intent, and explains recommendations using structured evidence.
- **Backend validation:** Ensures Muse cannot invent restaurants, alter algorithmic rankings, or execute unsupported actions.

Recommendations are grounded in real restaurant data and actual user information, rather than unsupported AI guesses.

## How it works

1. **Tell Otis what you want.** Share a craving, budget, distance preference, or simply ask for suggestions.
2. **Discover real restaurants.** Geoapify retrieves nearby places from OpenStreetMap data.
3. **Get personalized recommendations.** The backend combines your preferences, context, and meal history to rank eligible restaurants.
4. **Refine your choices.** Ask for something cheaper, closer, or entirely different without restarting the conversation.
5. **Record your experience.** After choosing a restaurant, the app can ask whether you went and collect feedback about the meal.
6. **Improve future decisions.** Confirmed meal history and feedback become evidence for subsequent recommendations.

Over time, the goal is to make the system better at anticipating what you might want to eat.

## App features

### Eat: Meet Otis

The conversational home of What to eat!

- Talk naturally about your cravings.
- Receive three ranked restaurant recommendations with concise reasons.
- Refine suggestions by cuisine, price, and distance.
- Reject recommendations and explore alternatives.
- Use adaptive questions informed by existing preferences and context.
- Continue the conversation after receiving recommendations.

### Map: Explore nearby

An interactive view of real food spots around you.

- Discover nearby restaurants.
- Explore locations visually.
- View restaurant recommendations on the map.
- Open navigation through Apple Maps.

Restaurant discovery uses **Geoapify Places**, backed by OpenStreetMap data.

### Meals: Remember what you ate

Your actual eating history is the foundation of personalization.

- Review previous meals and restaurants.
- Record meal categories and available contextual information.
- Rate completed visits.
- Track recorded spending.
- Use confirmed feedback as learning evidence.

**Important:** The system learns from the food actually eaten, not automatically from the restaurant's cuisine classification.

### Profile and Insights: Understand your taste

Your preferences and recorded behavior in one place.

- View favorite cuisines and most-eaten categories.
- Review typical budget and meal companions.
- Edit your original taste quiz.
- Explore personal eating patterns through Insights.
- See statistics calculated from recorded meal data.

Favorites and most-eaten categories are different signals. A favorite comes from an expressed preference, while most-eaten statistics come from recorded behavior.

## The intelligence behind Otis

### 1. Recommendation models

The recommendation engine uses deterministic algorithms and recorded user data.

Its components include:

- **Cuisine preference model:** Uses meal history and context, including recency weighting and fallback behavior when data is limited.
- **Place preference model:** Evaluates past visits, feedback, and familiarity with individual restaurants.
- **Context and confidence logic:** Supports predicted preferences and selects useful follow-up questions.
- **Candidate ranking:** Applies available category, budget, distance, and preference constraints.

The models determine which restaurants to recommend. Muse does not control the ranking.

### 2. Meta Muse Spark

Muse Spark 1.3 provides the natural-language layer.

Its responsibilities include:

- Interpreting free-text user requests.
- Producing validated structured intents and answer updates.
- Explaining recommendations from supplied evidence.
- Supporting conversational interactions and factual explanations based on backend-computed data.

Muse receives bounded context, and its output is validated by application code before use.

To reduce unnecessary API calls:

- Greetings, acknowledgments, and chip actions do not require Muse.
- A typed message uses at most one parsing call.
- Chip-driven recommendation rounds can use deterministic explanation templates.
- Typed recommendation rounds may receive optional Muse-generated explanations.
- If explanation generation fails, the original recommendations and template reasons remain available.

**Muse handles language. The algorithms handle decisions.**

### 3. Learning from feedback

The application's learning loop uses confirmed information rather than treating every conversational statement as a fact.

- Actual meals provide cuisine training labels.
- Confirmed ratings and historical corrections provide feedback evidence.
- Predicted companions are not recorded as confirmed meal companions.
- Temporary exclusions affect the current search without rewriting permanent preferences.

This separation protects the learning system from training on assumptions or casual requests.

## Expanded conversational capabilities

The current documentation for **issue #75, Intelligent Food Companion**, describes an expanded assistant workflow. Its deployment status and required database migration still need final verification.

The documented behavior includes:

- Multiple answers in one message, corrections, uncertainty, and requests for immediate recommendations.
- Temporary exclusions versus explicitly confirmed permanent preference changes.
- Meal logging through editable confirmation cards.
- Requests to rate meals or correct eligible historical records.
- Named-restaurant searches using verified nearby matches, separate from personalized recommendations.
- Questions about recent meals, spending, and companion activity using backend-computed information.
- Existing Insights charts displayed within supported chat responses.

The design maintains idempotency and version checks for supported writes. Ambiguous meal references require clarification, and missing meal information remains unknown rather than being invented.

## Technology stack

| Component | Technology |
|---|---|
| iOS application | Expo, React Native, TypeScript |
| Backend | Python, FastAPI |
| Conversational AI | Meta Muse Spark 1.3 |
| Speech transcription integration | Muse Voice Transcribe |
| Recommendation engine | Python-based statistical and scoring models |
| Database and authentication | Supabase |
| Restaurant discovery | Geoapify Places API |
| Places dataset | OpenStreetMap |
| Maps and directions | Apple Maps |

### Architecture

**User → Expo mobile app → FastAPI backend**

The backend coordinates the recommendation pipeline:

- **Supabase** supplies authenticated history, profiles, and confirmed feedback.
- **Geoapify** supplies real restaurant candidates.
- **Recommendation models** score and rank eligible places.
- **Muse Spark** interprets language and can generate evidence-grounded explanations.
- **Validation code** checks Muse output and controls permitted actions.

Results return to the mobile app as restaurant cards, map locations, conversational responses, and personalized insights.

## Privacy and responsible AI

What to eat! is designed to minimize unnecessary model calls and restrict the information sent to Muse.

### Data handling

- Saved companion names are replaced with anonymous references in supported interpretation contexts.
- Recommendation-reason requests receive bounded evidence, without coordinates, addresses, or companion names.
- Insights explanations use computed statistics and anonymous companion references.
- Operational Muse logs contain timing, token counts, and validation outcomes rather than prompt or response text.
- Chat meal creation and preference audits do not retain the raw source message.

Users may still voluntarily enter identifying information in free text, which can be transmitted for interpretation. The application does not claim comprehensive anonymization or zero data retention.

### Model processing

The documented Muse Spark 1.3 Standard-service terms exclude submitted content from model training while permitting processing and retention for service, safety, and related purposes. Contributor-model terms differ.

Production routing and account-specific settings still require owner verification.

References:

- [Meta Model API terms](https://dev.meta.ai/legal/terms-of-service)
- [Meta model designations](https://dev.meta.ai/legal/geographic-use-policy)

## Evaluation and limitations

The project includes an offline evaluation using historical meal records and comparison baselines.

See [Offline Evaluation](https://github.com/jjossa09/what-to-eat/blob/main/docs/EVALUATION.md).

The committed evaluation retains its November 1, 2026 aggregate results and sample sizes. Those results have not been rerun for issue #75, so no improved accuracy is claimed.

### Current limitations and verification

- Unverified menus, seating, opening hours, health information, and restaurant amenities are not invented.
- Restaurant-name matching is conservative and may miss legitimate aliases.
- Refinement-distance information is limited to available retrieved candidates.
- One-card-per-chain behavior belongs to [issue #73](https://github.com/jjossa09/what-to-eat/issues/73). Existing ID and co-location deduplication do not establish that guarantee.
- The expanded #75 application paths require their database migration and environment verification before production use.
- Passing local tests does not establish that migrations have been deployed or that all features work on a physical iPhone.

The project distinguishes implemented code, validated behavior, and functionality requiring additional verification.

## Documentation

The project requirements are maintained as version 1.8:

- [Requirements (Markdown)](https://github.com/jjossa09/what-to-eat/blob/main/docs/REQUIREMENTS.md)
- [Requirements (PDF)](https://github.com/jjossa09/what-to-eat/blob/main/docs/REQUIREMENTS.pdf)
- [Offline Evaluation](https://github.com/jjossa09/what-to-eat/blob/main/docs/EVALUATION.md)
- [GitHub Project Board](https://github.com/users/jjossa09/projects/1)

The requirements PDF can be regenerated using `python docs/build_requirements.py`, with ReportLab used as a documentation tool outside the application dependency set.

## Project status

**Meta Global AI Developer Hackathon 2026**

- Track: Indie Developer
- Development: Solo project
- Submission date: November 4, 2026
- Status: Active development and submission verification

The application has a recorded demonstration covering Otis, restaurant discovery, meal history, Profile, and Insights.

Additional features, integration checks, and deployment verification remain tracked in the GitHub project board.

## Attribution

Restaurant data is powered by Geoapify using OpenStreetMap data.

**© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)**

---

**What to eat!**

*Less guessing. Better food decisions.*
