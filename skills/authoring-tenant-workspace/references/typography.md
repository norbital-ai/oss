# Typography

Use semantic roles first; each token sets its own weight, leading and tracking.

| Roles | Use | Sizes | Use |
| --- | --- | --- | --- |
| `text-overline` | group/section/band heading | `text-display` | marketing hero (once/page) |
| `text-label` | control label | `text-title` / `text-section` | `h1` / `h2`, empty titles |
| `text-meta` | timestamps, counts, statuses, help | `text-subhead` / `text-heading` | `h3` / `h4`, pane/dialog/card titles |
| `text-caption` | attached note | `text-base` / `text-sm` | reading / default product UI |
| `text-body` | long-form reading | `text-xs` / `text-micro` / `text-tiny` | secondary / dense studio / compact |
| `text-eyebrow` / `text-lede` | marketing intro | | |

## Rules

- Never pair a role/token with `font-*`, `leading-*`, `tracking-*`, `uppercase` or colour (a size + colour like `text-sm text-muted-foreground` is fine). Never restate roles built into `Label`, `Card.Title`, `Dialog.Title`, `Sheet.Title`.
- Banned outside prose/markdown: `font-semibold`, `font-bold`, `<b>`/`<strong>`, `text-lg`/`xl`/`2xl`/`3xl`, arbitrary `text-[...]` (min 10px), text opacity (`text-foreground/70`), and literal palette shades (`text-brand-700`, `bg-brand-100`).
- Use semantic tokens: `text-brand-text`, `bg-brand-muted`, `text-brand` (theme overrides live in `+workspace.ts`).
- Geist Mono (11–13px) is for code, JSON, logs, IDs and technical data only.
