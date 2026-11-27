# Typography

Use semantic roles first; each token sets its own weight, leading and tracking. Product UI is fixed-size and capped at `text-heading` (18px) for titles and `text-metric` (20px) for KPI figures — never use viewport-fluid marketing tokens (`text-marketing-*`).

| Roles | Use | Sizes | Use |
| --- | --- | --- | --- |
| `text-metric` | KPI figures, counters, summary totals (20px, 510, `tabular-nums`) | `text-subhead` | prominent sub-headings, prose `h3` (20px, 400) |
| `text-overline` | group/section/band heading (11px, 590, uppercase, muted) | `text-heading` | surface, record, sheet, dialog, pane & card titles (18px, 510) |
| `text-label` | control & field label (12px, 510, muted — distinct from collected data; never for KPI figures or headings) | `text-base` / `text-sm` | reading / default product UI (16px / 14px) |
| `text-meta` | timestamps, counts, statuses, help (12px, 400, muted) | `text-xs` / `text-micro` / `text-tiny` | secondary / dense studio / compact (12px / 11px / 10px) |
| `text-caption` | attached note (14px, 400, muted) | | |
| `text-body` | long-form reading (16px, 400) | | |

## Rules

- Never pair a role/token with `font-*`, `leading-*`, `tracking-*`, `uppercase` or colour (a size + colour like `text-sm text-muted-foreground` is fine). Never restate roles built into `FieldControl`, `Label`, `Card.Title`, `Dialog.Title`, `Sheet.Title`.
- Banned outside prose/markdown: `font-semibold`, `font-bold`, `<b>`/`<strong>`, `text-lg`/`xl`/`2xl`–`9xl`, marketing display tokens (`text-marketing-*`), arbitrary `text-[...]` (min 10px), text opacity (`text-foreground/70`), and literal palette shades (`text-brand-700`, `bg-brand-100`).
- Use semantic tokens: `text-brand-text`, `bg-brand-muted`, `text-brand` (theme overrides live in `+workspace.ts`).
- Geist Mono (11–13px) is for code, JSON, logs, IDs and technical data only.
