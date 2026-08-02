---
'@norbital-ai/ui': patch
---

Stop `SidebarMenuButton` and `SidebarMenuSubButton` styling every direct child span.

Both carried `[&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate` in their base class, which reached
every direct child span rather than the label it was written for. `Badge` renders a span when it has
no `href`, so a trailing badge was stretched across the row and had to be beaten back with
`!w-fit !min-w-fit !flex-none`, and a chevron column had to be a `div` to escape the same rule. Every
label span in this repository already sets `min-w-0 flex-1 truncate` locally, so the blanket rule was
load-bearing for nothing here.

**Behavioural change for external consumers.** A caller whose sidebar label span relied on the
inherited rule now needs `min-w-0 flex-1 truncate` on that span itself, or the label stops flexing
and truncating. Conversely, any `!w-fit !min-w-fit !flex-none` workaround written to escape the rule
can be dropped. Nothing else about the buttons changes.
