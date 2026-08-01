---
'@norbital-ai/ui': patch
'@norbital-ai/pod': patch
---

Render streamed markdown one block at a time, and keep the organization-switch module runtime-free.

`ReadonlyMarkdown` put the whole document through a single `{@html}`. `{@html}` cannot patch — it
assigns `innerHTML` — so every chunk of a streaming assistant message discarded and rebuilt every
node in that message, and the browser re-laid-out and repainted all of it. Parsing was never the
cost (marked is under a millisecond even at 14KB); the DOM churn was, and it grew with the length of
the message. Lexing still covers the whole document, so reference definitions and footnotes resolve
exactly as before, but each top-level block is parsed and rendered on its own — an unchanged
paragraph produces a byte-identical string, Svelte's equality check skips it, and only the block
being written is rebuilt.

`switchOrganization` no longer holds its own `$state`. Runes compile only in `.svelte`/`.svelte.ts`,
so a plain module reaching for one throws at runtime while `svelte-check` stays quiet. The shell owns
the flag instead, which is also what lets the switch contract be tested without a Svelte runtime.
