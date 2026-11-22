# Interface ideology

Five axioms driving layout, scroll and spacing:

1. **An element never spaces or sizes itself** — space comes from parent `gap` or its own boundary `pad`.
2. **One primitive, one job** — compose primitives instead of adding classes.
3. **Intrinsic over breakpoints** — layouts respond to container width, not viewport.
4. **One owner per responsibility, per axis, per level** — scroll, padding and height each have one ancestor owner.
5. **Tokens, never arbitrary values** — no `p-[13px]` or `w-[420px]`.

Density: no overlap except `Imposter` in a `relative` parent; never show one value twice in a region; keep chart axis layout in shared `Chart`; summarize narrow tables with `record_label` (or UUID) and supporting columns via `Show`/`Field`.
