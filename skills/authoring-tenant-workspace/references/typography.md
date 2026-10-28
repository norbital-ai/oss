# Typography

Which class a piece of text gets. Derived from [interface-ideology.md](interface-ideology.md) axioms
4 (one owner per responsibility) and 5 (tokens, never values).

There are two vocabularies and they answer different questions. Sizes answer _how big_. Roles answer
_what this text is for_. Reach for the role first: if the text has a job the scale alone cannot
describe — a group heading, a field name, a caption — the role class is the whole answer and you
write nothing else.

## The roles

Every one of these is complete: size, weight, leading, tracking, case and colour. Composing one with
a `font-*`, `leading-*`, `tracking-*`, `uppercase` or colour utility means either the role is wrong
or a new role is missing.

| Class           | Renders as                               | Use                                                                                 |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `text-overline` | 11px / 600 / +0.08em / uppercase / muted | Heading over a group of things — a section of a list, a filter group, a column band |
| `text-label`    | 14px / 500 / leading 1                   | The name of a control: field, switch, filter                                        |
| `text-meta`     | 12px / 400 / muted                       | Secondary metadata: timestamps, counts, statuses, helper text                       |
| `text-caption`  | 14px / 400 / muted                       | A note attached to something else                                                   |
| `text-body`     | 16px / 400 / 1.75                        | Long-form reading text                                                              |
| `text-eyebrow`  | 14px / 500 / muted                       | The line above a marketing heading                                                  |
| `text-lede`     | 18px / 400 / 1.75 / muted                | Intro paragraph under a heading                                                     |

## The sizes

Headings and dense text that carry no role beyond their size. Each token already sets its own
weight, leading and tracking, so the utility is the full recipe here too.

| Token          | Size               | Use                                              |
| -------------- | ------------------ | ------------------------------------------------ |
| `text-display` | clamp(30px → 48px) | Marketing hero only, once per page               |
| `text-title`   | clamp(28px → 36px) | Page titles, prose `h1`                          |
| `text-section` | clamp(22px → 30px) | Section headings, prose `h2`, empty-state titles |
| `text-subhead` | 20px               | Sub-sections, prose `h3`                         |
| `text-heading` | 18px               | Pane, dialog and card titles, prose `h4`         |
| `text-base`    | 16px               | Default reading text                             |
| `text-sm`      | 14px               | Default product UI text                          |
| `text-xs`      | 12px               | Secondary metadata with no role                  |
| `text-micro`   | 11px               | Dense labels in studio and agent surfaces        |
| `text-tiny`    | 10px               | Compact indicators                               |

Three weights exist: 400 reading, 500 UI, 600 headings. `font-bold` never appears — hierarchy comes
from size, colour and tracking. Nothing renders below 10px. There are no arbitrary sizes:
`text-[13px]` in an app file is always wrong.

## The failure mode

One defect accounts for nearly all of them: **reassembling a role from its parts.**

```svelte
<!-- WRONG: this is a text-overline, spelled out -->
<p class="text-micro font-semibold tracking-[0.08em] text-muted-foreground uppercase">Contacts</p>
<p class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">Contacts</p>
<p class="text-xs font-medium tracking-wider text-muted-foreground uppercase">Contacts</p>

<!-- RIGHT -->
<p class="text-overline">Contacts</p>
```

Each of those three lines is plausible written on its own. They only reveal themselves as a defect
when two land on the same screen at different sizes and weights — which is precisely the moment it
is expensive to fix. That is why the rule is mechanical rather than a judgement: if the text matches
a row in the roles table, it gets that one class.

The same defect applies to the size tokens, which bundle weight and leading of their own:

```svelte
<!-- WRONG: text-lg + font-semibold is text-heading with the leading left loose -->
<h2 class="text-lg font-semibold text-foreground">Members</h2>

<!-- RIGHT -->
<h2 class="text-heading">Members</h2>
```

The second failure mode follows from the first: **re-stating what a primitive already applies.**
`Label`, `Card.Title`, `Dialog.Title`, `Sheet.Title` and the sidebar group headings all carry their
role already. Passing `class="text-sm font-medium"` to a `Label` does not make it more correct, it
makes it a fourth definition of the same thing.

What is **not** a defect: a size and a colour together. `text-sm text-muted-foreground` is the
prescribed way to de-emphasise text and needs no role. Ask whether the combination encodes a job —
a group heading, a control name, a caption — or merely a size and a shade. Only the first earns a
name; the second is already as small as it goes.

## Colour

Colour does the muting; size does not. To de-emphasise text, shift colour and keep the size:

```svelte
<span class="text-sm text-muted-foreground">Updated 3 minutes ago</span>
```

Never write an arbitrary opacity for text (`text-foreground/70`, `text-white/60`). If a role needs a
softened colour, the role class owns that value — that is the point of `text-body`, which carries
the one softened reading colour in the system so no page has to pick an opacity.

## Monospace

Geist Mono is for code, data values, JSON, logs, ids and technical metadata, at 11–13px. Never for
prose, never for marketing copy, and never to make an interface look technical.

## Adding a role

If a piece of text has a job that no row above describes, the answer is a new role class in
`packages/ui/src/base.css`, not a new combination in a component. A role is worth adding when the
same combination has been written at two call sites for the same reason — before that, it is a size
plus a colour and belongs inline.
