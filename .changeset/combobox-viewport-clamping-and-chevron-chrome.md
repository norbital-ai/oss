---
'@norbital-ai/ui': minor
---

Combobox: expose viewport clamping for the dropdown, and give the chevron its own chrome.

`avoidCollisions` (default `true`) and `collisionPadding` (default `8`) are now forwarded from
`Combobox` to the underlying floating primitive. When enabled, the dropdown flips its side and
shifts its alignment to stay clamped inside the viewport instead of spilling past an edge, and it
re-evaluates on scroll and resize rather than only when it opens. Both defaults match the previous
behaviour, so existing call sites are unaffected; pass `avoidCollisions={false}` to pin the
dropdown to `align` exactly.

`snapToEnds` is now deprecated. It re-implemented the same clamping by guessing the dropdown width
once at open time, which the primitive already does continuously and with real measurements. It
still works and still defaults to `false`; remove it in favour of `avoidCollisions`.

The trigger chevron now renders as a small rounded control that gains a background and an outline
on hover and on focus-within. The glyph itself stays visible at rest, so the "this is a dropdown"
affordance is never hover-only for keyboard and touch users.
