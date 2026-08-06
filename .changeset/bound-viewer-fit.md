---
'@norbital-ai/ui': minor
---

Give `Bound` a viewer-fit height contract.

`size="fit"` renders `h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]` — a scrollport that claims
the space below a ~14rem chrome band, capped at `tall` and floored at `standard`. Callers who
wanted a pane that tracks the viewport had to spell it as arbitrary-value classes on each surface
(`h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]` on the workspace settings tables); the contract
is now named and countable like the fixed sizes, and the three settings tables use it directly.
