# Padding and spacing

Who owns the space.

| The space is | Owner | Mechanism |
| --- | --- | --- |
| between siblings | their parent | `gap` |
| inside a visible boundary | the element drawing it | its own padding |
| between the shell edge and content | that region's scrollport | the app inset |

- Margin is banned in an app file: `mt-*`, `mb-*`, `ml-*`, `space-y-*` mean a parent lacks a `gap`.
- A cramped card is the card's fault: never pad its parent.

## The app inset

One value owned by the UI package. Never write it; put `inset` on a `Bound` or `Scroll`. A literal `px-4 sm:px-6` in an app file bypasses it.

**The scrollport owns the inset.** Exactly one element pads the edge per region, and it scrolls. A layout context enforces it:

| Element | Pads when | After it |
| --- | --- | --- |
| `Scroll inset`, `Bound inset` | no ancestor pads | flush |
| a `Tabs` panel | no ancestor pads, until a `Scroll` or `Bound inset` inside claims it | flush |
| the tab strip | no ancestor pads | |
| `Sheet`, `Dialog`, `Popover` | always a new region: padded owns it, `flush` leaves it to the first scrollport | |

- `inset` on a nested box is harmless: it pads only if nothing above does.
- A panel holding a `Table` is padded by the panel; holding `Scroll inset`, by the `Scroll`.
- Nested `Tabs` add no second gutter. There is no `content_padding` prop or region padding class.

## App surfaces

| `AppShell` body | Write |
| --- | --- |
| one view | default `page` variant plus the surface |
| `Tabs` | `variant="full"` plus `Tabs`: panels pad |
| flowing content | `variant="full"` plus `<Scroll name size="fill" inset>` |

## Failures

- Zero-pad: a `full` body with no `Tabs`, `inset` scrollport or padded panel.
- Double-pad: a literal padding class on a region wrapper.
- Check: `[data-bound-inset]`, `[data-scroll-inset]` and padded tab panels appear exactly once between the shell edge and any content.

## Scale

`gap` and `pad` tokens: `none` 0, `xs` 0.25rem, `sm` 0.5rem, `md` 1rem, `lg` 1.5rem; `xl` 2rem for `gap` only. `pad` is a boundary's interior; `inset` is the page edge: do not combine them. Defaults: `Cover gap="md" pad="none"`, `Bound pad="none"`.
