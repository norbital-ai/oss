# Typography

Reach for the role first: a role class is the whole answer. Sizes answer how big; roles answer what text is for.

## Roles

| Class | Use |
| --- | --- |
| `text-overline` | heading over a group: list section, filter group, column band |
| `text-label` | name of a control |
| `text-meta` | timestamps, counts, statuses, helper text |
| `text-caption` | a note attached to something else |
| `text-body` | long-form reading text |
| `text-eyebrow` | line above a marketing heading |
| `text-lede` | intro paragraph under a heading |

## Sizes

| Token | Use |
| --- | --- |
| `text-display` | marketing hero, once per page |
| `text-title` | page titles, prose `h1` |
| `text-section` | section headings, `h2`, empty-state titles |
| `text-subhead` | sub-sections, `h3` |
| `text-heading` | pane, dialog and card titles, `h4` |
| `text-base` | default reading text |
| `text-sm` | default product UI text |
| `text-xs` | secondary metadata with no role |
| `text-micro` | dense labels in studio and agent surfaces |
| `text-tiny` | compact indicators |

Each token sets its own weight, leading and tracking.

## Rules

- Never compose a role or token with `font-*`, `leading-*`, `tracking-*`, `uppercase` or colour. If text matches a role row, it gets that one class.
- Never restate what a primitive applies: `Label`, `Card.Title`, `Dialog.Title`, `Sheet.Title` carry their role.
- `font-bold` never appears. Weights are 400 reading, 510 UI, 590 headings. Nothing renders below 10px. No arbitrary sizes such as `text-[13px]`.
- A size plus a colour is fine: `text-sm text-muted-foreground` is the way to de-emphasise.

## Colour

- Colour mutes; size does not. Never write a text opacity (`text-foreground/70`).
- `text-brand-text` for accent text on a tinted surface, `bg-brand-muted` for that surface, `text-brand` for artwork and focus. Never `text-brand-700` or `bg-brand-100`: they vanish in the dark theme.

## Monospace

Geist Mono is for code, data values, JSON, logs, ids and technical metadata at 11 to 13px. Never prose or marketing.

## New roles

A new role is a class in the UI package's base CSS, added when one combination recurs at two call sites for one reason.
