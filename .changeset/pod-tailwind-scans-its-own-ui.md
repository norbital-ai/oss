---
'@norbital-ai/pod': patch
---

Let Tailwind read Pod's own UI again, which is what put the "Ask agent" button back.

`app.css` still scanned `./{client,runtime}/**` after those directories became `./ui/**`, so the
glob matched nothing and no tenant stylesheet carried a utility that only a Pod component uses.
Anything the shell shares with `@norbital-ai/ui` — the other glob — kept working, which is why the
workspace looked right and only the odd class went missing.

The agent launcher was the visible one. It rendered on every workspace and it was `position: fixed`,
but `bottom-[calc(env(safe-area-inset-bottom)+1rem)]` and `sm:bottom-6` are asked for nowhere else,
so nothing set `bottom`, and a fixed element with no `bottom` falls back to its static position —
just past a `h-dvh` shell, 44px below the viewport.
