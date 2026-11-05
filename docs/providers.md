# Providers: model IDs, list prices and free-tier limits

Every value below was taken from the provider's own documentation or its `/models` endpoint on the
date shown. Nothing here is estimated, except where a row says "derived" and shows the arithmetic.
The deployments are in [apps/gateway/config/models.json](../apps/gateway/config/models.json); the
list prices are inserted by [db/migrations/0006_provider-prices.sql](../db/migrations/0006_provider-prices.sql)
(ADR 016, ADR 024); the quotas are the `quota` blocks in the models file (ADR 025).

All of these deployments are `billing: free_tier`: each key in `.env.example` is meant to be a free
account with no credit card. If you put a paid key in, set that deployment's `billing` to `paid`.
Free tiers may use what you send to improve the provider's products (Google says so for the
Gemini API free tier); never send real data through them.

## Deployments

| Deployment | Provider | Model ID | ID source (checked) | List price per 1M tokens, input / output | Price source (checked) |
| --- | --- | --- | --- | --- | --- |
| `groq-gpt-oss-20b` | Groq | `openai/gpt-oss-20b` | <https://console.groq.com/docs/models> (2026-10-21) | $0.075 / $0.30 | <https://console.groq.com/docs/model/openai/gpt-oss-20b> (2026-10-21) |
| `groq-gpt-oss-120b` | Groq | `openai/gpt-oss-120b` | <https://console.groq.com/docs/model/openai/gpt-oss-120b> (2026-11-03) | $0.15 / $0.60 | same page (2026-11-03) |
| `groq-qwen3.8-27b` | Groq (preview model) | `qwen/qwen3.8-27b` | <https://console.groq.com/docs/models> (2026-10-28) | $0.80 / $4.00 | same page (2026-10-28) |
| `gemini-3.5-flash-lite` | Gemini API | `gemini-3.5-flash-lite` | <https://ai.google.dev/gemini-api/docs/pricing> (2026-10-21) | $0.30 / $2.50 (paid tier) | same page (2026-10-21; unchanged on 2026-11-03) |
| `gemini-3.8-flash` | Gemini API | `gemini-3.8-flash` | <https://aistudio.google.com/docs/pricing> (2026-11-03; the ai.google.dev page now redirects there) | $0.75 / $3.75 (paid tier, through 2026-12-31; $1.50 / $7.50 announced from 2027-01-01, not yet added) | same page (2026-11-03) |
| `gemini-3.1-flash-lite` | Gemini API | `gemini-3.1-flash-lite` | <https://aistudio.google.com/docs/pricing> (2026-11-03) | $0.25 / $1.50 (paid tier, text/image/video input) | same page (2026-11-03) |
| `mistral-small-2603` | Mistral | `mistral-small-2603` (Mistral Small 4) | <https://docs.mistral.ai/models/mistral-small-4-0-26-03> (2026-11-03) | $0.15 / $0.60 | same page; order confirmed by OpenRouter's `mistralai/mistral-small-2603` (2026-11-03) |
| `mistral-large-4` | Mistral (public preview) | `mistral-large-4` (Mistral Large 4) | <https://docs.mistral.ai/models/mistral-large-4-0> (2026-11-03) | $0.70 / $2.10 | same page (2026-11-03) |
| `nvidia-deepseek-v4.1-flash` | NVIDIA NIM | `deepseek-ai/deepseek-v4.1-flash` | <https://integrate.api.nvidia.com/v1/models> (2026-11-03) | $0.30 / $1.20: DeepSeek's own API for the same model (`deepseek-flash`, DeepSeek-V4.1-Flash-1017), standard (peak) cache-miss rate | <https://api-docs.deepseek.com/quick_start/pricing> (2026-11-03) |
| `openrouter-gemma-4-31b-free` | OpenRouter | `google/gemma-4-31b-it:free` | <https://openrouter.ai/api/v1/models> (2026-11-03) | $0.20 / $0.40: OpenRouter's paid `google/gemma-4-31b-it` (the Gemini API offers Gemma 4 free only) | <https://openrouter.ai/api/v1/models> (2026-11-03) |
| `cloudflare-llama-4-scout` | Cloudflare Workers AI | `@cf/meta/llama-4-scout-17b-16e-instruct` | <https://developers.cloudflare.com/workers-ai/platform/pricing/> (2026-11-03, page updated 2026-10-20) | $0.270 / $0.850 (beyond the free Neurons) | same page (2026-11-03) |
| `zai-glm-4.7-flash` | Z.AI | `glm-4.7-flash` | GLM-4.7-Flash is listed as free on <https://docs.z.ai/guides/overview/pricing> (2026-11-03); the docs print API codes in lower case (`glm-5.3-flash` for GLM-5.3-Flash), but not this one; confirmed by real calls through the live demo that answered 200 (2026-11-04) | $0.0605 / $0.40: OpenRouter's paid `z-ai/glm-4.7-flash` (Z.AI sells it free only) | <https://openrouter.ai/api/v1/models> (2026-11-03) |

Base URLs: Groq `https://api.groq.com/openai/v1`; Gemini
`https://generativelanguage.googleapis.com/v1beta/openai`; Mistral `https://api.mistral.ai/v1`;
NVIDIA `https://integrate.api.nvidia.com/v1`; OpenRouter `https://openrouter.ai/api/v1`;
Cloudflare `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1`
(<https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/>, checked
2026-11-03; the account ID is filled from the environment); Z.AI `https://api.z.ai/api/paas/v4`
(<https://docs.z.ai/guides/overview/quick-start>, checked 2026-11-03).

Health checks: Cloudflare's OpenAI endpoint answers `GET /models` with 405 (checked 2026-11-03),
and Z.AI documents no model list, so both use `healthCheck: "none"`. NVIDIA's and OpenRouter's
`GET /models` answer without a key, so their check proves the API is up but not that the key is
valid. A `GET /models` check never proves a model is served either: it can list a model the
provider answers with 404 (NVIDIA's Nemotron 3 Super, 2026-11-03), and a passing check half-opens
the breaker those 404s opened, so requests try the deployment again. Since M12, NVIDIA's
deployment uses `healthCheck: "chat"` (ADR 026): while its breaker is open, a request for one token
a minute after the last, then 2, 4, 8 minutes and so on up to an hour while it keeps failing, which
keeps the breaker open. Nemotron 3 Super was removed from the models file after M12, since NVIDIA
answers it with "Not found for account"; its price rows stay in migration 0006 (ADR 016).

## Free-tier limits and the quotas configured

| Provider | Published free limit | Source (checked) | `quota` in the models file |
| --- | --- | --- | --- |
| Groq | Per model on the free plan: 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day for `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and `qwen/qwen3.8-27b`. Responses carry `x-ratelimit-limit/remaining-requests` (per day) and `-tokens` (per minute). | <https://console.groq.com/docs/rate-limits>, "Free Plan Limits" (2026-11-03) | each Groq deployment: 30/min, 1,000/day, 8,000 tokens/min, 200,000 tokens/day |
| Gemini API | Not published on the docs page: "can be viewed in Google AI Studio" per project. | <https://aistudio.google.com/docs/rate-limits> (2026-11-03) | none |
| Mistral | Free mode exists with "restrictive" limits shown only in the console (admin.mistral.ai); which models it allows is not published. | <https://docs.mistral.ai/deployment/laplateforme/tier> via search (2026-11-03) | none |
| NVIDIA NIM | No official figure found; forum posts report 40 requests/min for build.nvidia.com free access, for development, not production. | NVIDIA developer forum (2026-11-03), not official | none |
| OpenRouter | `:free` models: 20 requests/min; 50 requests/day with fewer than 10 credits ever purchased (1,000/day with 10 or more). Per account, across all `:free` models. | <https://openrouter.ai/docs/api/reference/limits> (2026-11-03) | `openrouter-gemma-4-31b-free`: 20/min, 50/day (the only `:free` deployment, so the per-account limit applies to it alone) |
| Cloudflare Workers AI | 10,000 Neurons/day free, reset at 00:00 UTC; text generation 300 requests/min. Llama 4 Scout costs 24,545 Neurons per million input tokens and 77,273 per million output tokens. | <https://developers.cloudflare.com/workers-ai/platform/pricing/> and <https://developers.cloudflare.com/workers-ai/platform/limits/> (2026-11-03) | 300/min; 129,000 tokens/day (derived: 10,000 / 77,273 x 1,000,000 = 129,411 tokens if every token were output; input costs fewer Neurons, so 129,000 tokens a day stay within 10,000 Neurons) |
| Z.AI | GLM-4.7-Flash is free; no rate limit on the official pricing or model pages (secondary sources say one request at a time). | <https://docs.z.ai/guides/overview/pricing>, <https://docs.z.ai/guides/llm/glm-4.7> (2026-11-03) | none |

Deployments without a quota are still protected by the provider's own 429: the gateway puts the
deployment on a cooldown shared by every instance for the `Retry-After` it sends, or
`PROVIDER_COOLDOWN_MS` (ADR 025).

## Reference prices (never routed)

Rows in `model_prices` with `reference = true` are prices of paid models no deployment calls,
used only by the cost comparison (`GET /admin/analytics/cost-comparison`). They are listed with
their sources in [db/migrations/0009_reference-prices.sql](../db/migrations/0009_reference-prices.sql).

## Real calls

No provider key was set in the environment where M11 was built (2026-11-03). Every deployment was
called through the live demo on 2026-11-04, and the failed ones again after the fixes; the results
are in the "M11 real-provider checks" tables of
[PLAN-NOTES.md](PLAN-NOTES.md#m11-real-provider-checks).
Groq and Gemini were checked with real keys on 2026-10-21.
