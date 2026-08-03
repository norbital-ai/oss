---
'@norbital-ai/platform-utils': patch
---

Let a host publish each model's context window.

`AiModelOption` gains an optional `contextLength`. It is model metadata rather than usage — a guest
holds the token counts but cannot turn them into "how full is the window" without the denominator,
and inventing one would misreport every conversation. Hosts that omit it get an absolute token count
and no percentage.

`chat_session` gains cumulative `usage_cost_usd`, `usage_total_tokens`, `usage_turns_counted` and
`usage_turns_unreported`, and `chat_turn` gains `usage_settled_at` as the idempotency key for
accumulating into them.
