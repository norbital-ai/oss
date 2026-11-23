# Composing novel interactive UIs

When a screen goes beyond a standard `Table`, `Board`, or `RecordShell` — e.g. a split-pane workbench, collapsible tree navigator, keyboard-driven triage queue, drag-and-drop sequence editor, custom inspector popover, or interactive scheduler — compose from three layers without adding external UI packages or hand-rolling keyboard/ARIA/overlay plumbing.

## 1. Visual layer: `<Surface>`, layout primitives & semantic tokens

- Wrap panels, cards, sidebars, and lanes in `<Surface tone="card|subtle|muted|lane|popover" padding="none|xs|sm|md|lg" radius="control|inset|overlay" interactive?>` from `@norbital-ai/ui` (or `@norbital-ai/ui/layout`).
- Arrange layout with `@norbital-ai/ui/layout`: `Stack`, `Inline`, `Grid`, `Cluster`, `Bound`, `ScrollArea`.
- Style states and chrome exclusively with semantic tokens (`bg-surface-card`, `bg-surface-subtle`, `bg-surface-active`, `bg-surface-hover`, `text-content-primary`, `text-content-secondary`, `text-content-tertiary`, `border-border-subtle`, `border-border-control`, `bg-tone-{success,warning,info,destructive,neutral}-bg`, `text-tone-*-text`, `border-tone-*-border`). Zero `dark:` color overrides and zero raw Tailwind palette shades (`amber-500`, `emerald-600`, `slate-200`).

## 2. Built-in styled primitives (`@norbital-ai/ui`)

Reuse styled controls for common chrome before writing bespoke markup — in particular, **always prefer `<Popover.Root>`, `<Dialog.Root>`, `<Sheet>`, `<Tooltip>`, and `<Accordion.Root>`** for standard overlays, drawers, and accordions instead of hand-positioning with `create_floating` + `portal` (reserve `create_floating` / `create_dismiss` for bespoke non-popover surfaces like slash menus or floating toolbars):
- Actions & feedback: `Button`, `Badge`, `StateBadge`, `Progress`, `CopyText`, `EmptyState`, `toast`.
- Inputs: `Input`, `Textarea`, `Checkbox`, `Combobox`, `Picker`, `PinInput`, `TimeInput`, `TimeRangeInput`, `MoneyInput`, `PhoneInput`, `FileInput`.
- Navigation & overlays: `Tabs`, `TabStrip`, `Accordion`, `Dialog`, `ConfirmDialog`, `Sheet`, `Popover`, `Tooltip`.

## 3. Composable headless behaviors (`@norbital-ai/ui/behaviors`)

Every built-in `@norbital-ai/ui` component runs on these Svelte-5 runes behaviors — use the exact same primitives in custom widgets:

| Need | Behavior | Key wiring |
| --- | --- | --- |
| Collapsible hierarchy / folder tree | `create_tree` | `{...tree.root_attrs()}`, `{...tree.item_attrs(r.id)}`, `tree.toggle_expand(r.id)` |
| Filterable keyboard list / command menu | `create_listbox` | `query`, `filtered`, `{...lb.list_attrs()}`, `{...lb.option_attrs(item)}` |
| Single / multi / Shift-range selection | `create_selection` | `toggle`, `select`, `select_all`, `clear`, `selected`, `is_selected` |
| Drag-and-drop + `Alt+Arrow` reorder | `create_reorder` | `{...reorder.item_attrs(key)}` (sets `draggable`, `data-dragging`, `data-drop-target`) |
| Split-pane / sidebar drag handle | `create_resize` | `{...resize.handle_attrs()}` (pointer drag + Arrow keys, clamped `min`/`max`) |
| Global keyboard shortcuts | `create_shortcuts` | Call directly at top level with `{ keys, handler, allow_in_input? }` (skips inputs automatically) |
| Custom anchored overlay | `create_floating` + `portal` | `{@attach floating.anchor}`, `{@attach floating.content}`, `style={floating.style}` |
| LIFO Escape / outside-click layer | `create_dismiss` | `{@attach dismiss.surface}`, `dismiss.topmost` |
| Modal focus trapping | `create_focus_trap` | `{@attach trap.container}` |
| Roving tabindex toolbar / segmented list | `create_roving_focus` | `{@attach roving.item(key)}`, `{...roving.item_attrs(key)}`, `{...roving.root_attrs()}` |
| Responsive overflow into "More" menu | `create_overflow` | `{@attach overflow.container}`, `{@attach overflow.item(k)}`, `overflow.hidden` |
| Collapsible panel / accordion | `create_disclosure`, `create_accordion` | `{...d.trigger_attrs()}`, `{...d.content_attrs()}` |
| Numeric range slider / scrubber | `create_slider` | `{...slider.thumb_attrs()}`, `slider.percent` |
| Pager / clipboard / chat scroll | `create_pagination`, `create_clipboard`, `create_stick_to_bottom` | `page_range`, `copy()`, `{@attach stick.container}` |
| Segmented date/time/calendar/PIN | `create_date_field`, `create_time_field`, `create_calendar`, `create_pin_input` | `segment_attrs`, `day_attrs`, `input_attrs()` |
| Reactive watchers / debounce / storage | `watch`, `watch.pre`, `Debounced`, `use_debounce`, `PersistedState` | Zero external reactive packages |
| Large virtualized list | `virtual_list` | `{@attach v.container}`, `v.slice`, `v.total_height` |
| Expose custom widget to Norbius | `register_control` | Call inside `$effect` with `{ id, kind, label, state, actions }` |

## 4. Composition checklist

- **Full-height split-pane workbenches:** the host's `AppShell` already owns the viewport frame; size the outer workbench grid with `h-full min-h-0 overflow-hidden` (or wrap in `<Bound size="viewport">`) and give each scrolling pane `min-h-0 overflow-y-auto` — never guess magic viewport offsets like `calc(100dvh - 9rem)`.
- Persist user layout preferences (e.g. resized pane width, collapsed sidebar) with `PersistedState`, never raw `localStorage.getItem`/`setItem` calls.
- Debounce search/filter inputs with `Debounced` or `use_debounce`, never raw `setTimeout` timers.
- Register every custom stateful widget (tree selection, active queue item, inspector open/close) with `register_control` inside `$effect` so Norbius can inspect and drive it through `page`.
- Every visible label, shortcut hint, empty state, and tooltip comes from `ctx.t(...)`.
- Pair workspace-wide visual identity with `theme: { palette, accent, radius }` in `src/+workspace.ts`.
