# Composing novel interactive UIs

When a screen goes beyond a standard `Table`, `Board`, or `RecordShell` — e.g. a split-pane workbench, collapsible tree navigator, keyboard-driven triage queue, drag-and-drop sequence editor, custom inspector popover, or interactive scheduler — compose from three layers without adding external UI packages or hand-rolling keyboard, ARIA, focus, drag, overlay, persistence, or debounce plumbing.

## Hard rule — never hand-roll behaviors

Before writing any interactive Svelte handler in a tenant workspace, check this table. If a behavior exists in `@norbital-ai/ui` or `@norbital-ai/ui/behaviors`, **always compose from it** — never hand-roll raw `keydown` arrow/Escape loops, `document.addEventListener('click')`, `localStorage`, `setTimeout` debouncers, `pointermove` drags/resizes, or manual ARIA wiring:

| Never hand-roll | Use instead |
| --- | --- |
| Manual `ArrowUp`/`Down`/`Left`/`Right` tabindex or `querySelectorAll` focus loops | `create_roving_focus`, `create_toolbar`, `create_listbox`, `create_menu`, `create_tree`, `create_grid_focus` |
| Manual `Escape` or outside-click listeners (`document.addEventListener`, `<svelte:window onkeydown>`) | `<Dialog.Root>`, `<Popover.Root>`, `<Sheet>`, or `create_dismiss` + `create_floating` + `portal` |
| Manual focus trap, background `inert`, or `document.body.style.overflow = 'hidden'` | `<Dialog.Root>` / `<Sheet>`, or `create_focus_trap`, `inert_outside`, `lock_scroll` |
| Manual `role="switch"`, `role="radiogroup"`, `aria-pressed` toggle strips, `role="tablist"`, `role="menu"` | `<Checkbox>`, `<Tabs>` / `<TabStrip>`, or `create_switch`, `create_radio_group`, `create_toggle_group`, `create_checkbox_group`, `create_menu`, `create_menubar`, `create_navigation_menu` |
| Manual `<input type="range">` or pointer scrubbers / split-pane drag handles | `create_slider`, `create_resize`, `create_resize_box`, `create_panel_group` |
| Manual `pointerdown`/`pointermove`/`pointerup` drag, reorder, Kanban transfer, or drawer swipe | `bind_drag`, `create_reorder`, `create_transfer`, `create_tree_reorder`, `create_auto_scroll`, `create_drawer`, `create_swipe_actions` |
| Manual tag/chip inputs, `@`/`/` mention menus, file dropzones, password reveal, inline cell edit | `create_token_input`, `create_trigger_menu`, `create_file_dropzone`, `create_password_input`, `create_inline_edit` |
| Manual `localStorage` / `sessionStorage` / cookie reads, `setTimeout` debounce, `navigator.clipboard` | `PersistedState`, `create_cookie_storage`, `Debounced`, `use_debounce`, `create_clipboard` |
| Manual chat scroll-to-bottom latching or pager clamping | `create_stick_to_bottom`, `create_pagination`, `page_range` |
| Manual `hover` timers for tooltips/popovers/hover cards or exit-animation unmounting | `<Tooltip>`, `<Popover.Trigger open_on_hover>`, `create_hover_card`, `create_hover_intent`, `create_presence`, `bind_findable` |
| Unobservable bespoke widgets invisible to Norbius | `register_control` inside `$effect` (plus `data-agent-confirm`, `data-agent-secret`, `data-agent-hidden`) |

## 1. Visual layer: `<Surface>`, layout primitives & semantic tokens

- Wrap panels, cards, sidebars, and lanes in `<Surface tone="card|subtle|muted|lane|popover" padding="none|xs|sm|md|lg" radius="control|inset|overlay" interactive?>` from `@norbital-ai/ui` (or `@norbital-ai/ui/layout`).
- Arrange layout with `@norbital-ai/ui/layout`: `Stack`, `Inline`, `Grid`, `Cluster`, `Bound`, `Scroll`.
- Style states and chrome exclusively with semantic tokens (`bg-surface-card`, `bg-surface-subtle`, `bg-surface-active`, `bg-surface-hover`, `text-content-primary`, `text-content-secondary`, `text-content-tertiary`, `border-border-subtle`, `border-border-control`, `bg-tone-{success,warning,info,destructive,neutral}-bg`, `text-tone-*-text`, `border-tone-*-border`). Zero `dark:` color overrides and zero raw Tailwind palette shades (`amber-500`, `emerald-600`, `slate-200`).

## 2. Built-in styled primitives (`@norbital-ai/ui`)

Reuse styled controls for common chrome before writing bespoke markup — in particular, **always prefer `<Popover.Root>`, `<Dialog.Root>`, `<Sheet>`, `<Tooltip>`, and `<Accordion.Root>`** for standard overlays, drawers, and accordions instead of hand-positioning with `create_floating` + `portal` (reserve `create_floating` / `create_dismiss` for bespoke non-popover surfaces like slash menus or floating toolbars):
- Actions & feedback: `Button`, `Badge`, `StateBadge`, `Progress`, `EmptyState`, `confirm_action`, `toast`.
- Inputs: `Input`, `Textarea`, `Checkbox`, `Combobox`, `Picker`, `PinInput`, `TimeInput`, `TimeRangeInput`, `MoneyInput`, `PhoneInput`, `FileInput`, `PointInput`.
- Navigation & overlays: `Tabs`, `TabStrip`, `Accordion`, `Dialog`, `Sheet`, `Popover`, `Tooltip`.

## 3. Composable headless behaviors (`@norbital-ai/ui/behaviors`)

Every built-in `@norbital-ai/ui` component runs on these Svelte-5 runes behaviors — use the exact same primitives in custom widgets. Inspect full parameter types anytime with `skill { name: 'bolt-contract', file: 'behaviors.md' }` or `workspace_lang`.

### Navigation, lists, menus, search & trees

| Need | Behavior | Key wiring |
| --- | --- | --- |
| Collapsible hierarchy / folder tree | `create_tree`, `tree_from_paths`, `tree_checked_states`, `toggle_tree_checked` | `{...tree.root_attrs()}`, `{@attach tree.item(r.id)}`, `{...tree.item_attrs(r.id)}`, `tree.toggle_expand(r.id)` |
| Filterable keyboard list / combobox / command menu | `create_listbox` | `query`, `items`, `focus: 'dom' \| 'virtual'`, `{...lb.input_attrs()}`, `{...lb.list_attrs()}`, `{...lb.option_attrs(item.value)}` |
| Fuzzy search scoring & match highlight spans | `fuzzy_score`, `match_ranges`, `match_segments` | Pair with `create_listbox` / custom command palettes to rank & highlight matched characters |
| Async / paginated remote options | `create_async_options` | Debounced abortable fetch, `items`, `status`, `has_more`, `load_more()` |
| Action / context / bar / mega menus | `create_menu`, `create_menubar`, `create_navigation_menu`, `create_hover_card` | `open_at({ x, y })`, `{...menu.menu_attrs()}`, `{...menu.item_attrs(id)}`, `menuitemcheckbox` / `menuitemradio` |
| Roving tabindex toolbar / segmented list | `create_roving_focus`, `create_toolbar`, `create_typeahead` | `{@attach roving.item(key)}`, `{...roving.item_attrs(key)}`, `{...roving.root_attrs()}` (auto focus recovery on unmount) |
| Responsive overflow into "More" menu | `create_overflow` | `{@attach overflow.list}`, `{@attach overflow.measure}`, `overflow.visible`, `overflow.hidden` |
| Collapsible panel / accordion / find-in-page | `create_disclosure`, `create_accordion`, `bind_findable`, `supports_hidden_until_found` | `{...d.trigger_attrs()}`, `{...d.content_attrs()}`, `{@attach bind_findable(...)}` (`hidden="until-found"`) |
| Large virtualized list / 2D grid | `virtual_list`, `virtual_grid` | `{@attach v.anchor}`, `{@attach v.measure(key)}`, `v.before`, `v.after`, `v.total`, `v.slice(rows)` (or `size` fixed fast path) |
| Pager / carousel / clipboard / chat scroll | `create_pagination`, `page_range`, `create_carousel`, `create_clipboard`, `create_stick_to_bottom` | `pager.previous()`, `pager.next()`, `carousel.slide_attrs(i)`, `copy()`, `{@attach tail.viewport}`, `tail.scroll_to_bottom()` |

### Grids, selection, drag, motion & direct manipulation

| Need | Behavior | Key wiring |
| --- | --- | --- |
| Single / multi / Shift-range selection | `create_selection` | `choose`, `toggle`, `extend`, `toggle_all`, `clear`, `selected`, `is_selected`, `{...sel.item_attrs(key)}` |
| 2D spreadsheet grid focus, cell range & edit-in-place | `create_grid_focus`, `create_cell_range`, `create_inline_edit` | `cells_to_text`, `text_to_cells`, `cell_bounds`, `{@attach edit.input}`, `{...edit.input_attrs()}` |
| Pointer drag, auto-scroll, preview, reorder & cross-list transfer | `bind_drag`, `bind_drag_preview`, `create_auto_scroll`, `create_reorder`, `move_item`, `create_transfer`, `create_tree_reorder`, `subtree_end` | `{@attach reorder.item(key)}` or `{...reorder.item_attrs(key)}`, `Alt+Arrow`, `create_transfer` across Kanban lanes |
| Split-pane / panel group / 2D box resize | `create_resize`, `create_resize_box`, `create_panel_group` | `{...resize.handle_attrs()}`, `{...panels.handle_attrs(i)}` (pointer capture + `Arrow`/`Shift+Arrow`/`Home`/`End`, collapsible panes) |
| Numeric single / multi-thumb slider & scrubbers | `create_slider` | `{@attach slider.track}`, `{...slider.thumb_attrs(i)}`, `slider.percent`, vertical & RTL |
| Physics drawers & gesture math | `create_drawer`, `rubber_band`, `create_velocity_tracker`, `nearest_snap_point`, `step_spring` | Snap-point bottom/side sheet gestures, velocity fling, rubber-band over-drag |
| Canvas, spatial editors, timeline, waterfall & touch gestures | `create_move`, `create_area`, `create_spans`, `is_span_free`, `stack_spans`, `create_lasso`, `create_viewport`, `create_connect`, `create_swipe_actions`, `bind_scroll_picker`, `create_timeline`, `create_waterfall`, `create_image_cropper` | Pan/zoom, snap/nudge, lasso hit-test, edge linking, multi-track scrub/zoom, Gantt/waterfall bars, aspect-locked crop |

### Overlays, focus, platform & accessibility

| Need | Behavior | Key wiring |
| --- | --- | --- |
| Custom anchored overlay & virtual cursor anchor | `create_floating`, `portal`, `set_portal_target`, `get_portal_target` | `{@attach floating.anchor}` or `anchor: { x, y }`, `{@attach floating.content}`, `style={floating.style}`, `--available-width` / `--available-height` |
| LIFO Escape / outside-click & overlay stacking | `create_dismiss`, `create_overlay_stack` | `{@attach dismiss.surface}`, `dismiss.topmost`, `dismiss.depth`, nested z-index/backdrop coordination |
| Modal focus trapping, background inert & scroll lock | `create_focus_trap`, `tabbable_elements`, `inert_outside`, `lock_scroll` | `{@attach trap.container}` (`modal`, `prevent_scroll`, `topmost`, `on_open_auto_focus`, `on_close_auto_focus`) |
| Safe-polygon hover intent & exit presence | `create_hover_intent`, `bridge_between`, `reset_hover_group`, `create_presence` | Diagonal transit corridor + warm group; `data-starting-style` / `data-ending-style` |
| Live-region announcements & focus recovery | `announce`, `prepare_announcements`, `set_announcer`, `create_focus_recovery`, `keep_focus` | Singleton polite/assertive announcer (exempt from `inert_outside`), `{@attach recovery.item(key)}` |
| Viewport, soft-keyboard, pointer & modality detection | `bind_viewport`, `bind_avoid_keyboard`, `pointer_kind_of`, `create_pointer_kind`, `is_focus_from_keyboard`, `current_modality`, `color_scheme_of`, `create_color_scheme`, `color_scheme_script` | `--viewport-height`, `--keyboard-height`, `--keyboard-inset`, coarse vs fine pointer, keyboard vs pointer focus ring modality |
| ARIA & RTL conformance checks (for tests) | `check_pattern`, `check_direction` | Assert WAI-ARIA roles/attributes (`listbox`, `menu`, `tabs`, `tree`, `grid`, `dialog`, `radiogroup`, `slider`, `toolbar`) |

### Headless form controls, color, shortcuts & reactive state

| Need | Behavior | Key wiring |
| --- | --- | --- |
| Headless widget primitives | `create_switch`, `create_radio_group`, `create_toggle_group`, `create_checkbox_group`, `create_number_input`, `create_rating`, `create_field` | Full WAI-ARIA role/keyboard/control registration |
| Rich inputs: tokens, triggers, dropzone, password, PIN, date/time | `create_token_input`, `create_trigger_menu`, `create_file_dropzone`, `create_password_input`, `create_pin_input`, `create_date_field`, `create_time_field`, `create_calendar` | `{...tokens.input_attrs()}`, `{@attach dropzone.zone}`, `{...pw.input_attrs()}`, `segment_attrs`, `{@attach cal.day_ref(d)}` |
| Color picker & WCAG color math | `create_color_picker`, `parse_color`, `format_color`, `rgb_to_hsl`, `hsl_to_rgb`, `rgb_to_hsv`, `hsv_to_rgb`, `contrast_ratio`, `mix_colors` | 2D SV plane + hue/alpha sliders + hex/rgb/hsl conversion + contrast checks |
| Shortcuts, chords, history, undo, preview & micro-interactions | `create_shortcuts`, `matches_shortcut`, `aria_keyshortcuts`, `format_shortcut`, `create_input_history`, `create_undo_stack`, `create_preview`, `settle_draft`, `bind_hold`, `bind_repeat`, `input_hints`, `nearest_in_direction`, `spatial_move` | Chords (`'g i'`), auto input skipping, hover/focus live preview with revert, optimistic draft settlement, hold-to-confirm, repeat-on-hold, spatial D-pad |
| Reactive watchers, debounce & persistence | `watch`, `watch_pre`, `Debounced`, `use_debounce`, `PersistedState`, `create_cookie_storage` | Zero external reactive packages; safe fallback when storage is unavailable |

### Agent readiness & control observability

| Need | Behavior / attribute | Key wiring |
| --- | --- | --- |
| Expose custom widget to Norbius `page` tool | `register_control`, `page_controls`, `resolve_control`, `invoke_control`, `act_on_control`, `describe_controls` | Call inside `$effect` with `{ id, kind, label, element?, items?, confirm?, secret?, hidden?, state, actions }` |
| Observe control mutations & undo agent edits | `observe_controls`, `notify_control_change`, `create_ui_history`, `with_source`, `current_source` | Tracks `'user' \| 'agent' \| 'program'` origin; `history.undo_source('agent')` |
| Author DOM boundaries for Norbius | `data-agent-confirm="<msg>"`, `data-agent-secret`, `data-agent-hidden` | Enforces confirmation copy, redacts values in summaries/prompts, hides internal chrome from agent bridge |

## 4. Svelte 5 authoring pattern

Import behaviors from `@norbital-ai/ui/behaviors`, pass getter thunks (`items: () => ...`, `value: () => ...`) so Svelte 5 tracks reactive changes without capturing initial props, spread returned `*_attrs()` onto elements, bind DOM lifecycle attachments with `{@attach ...}`, and expose widget state/actions to Norbius via either the behavior's `control: { id, label }` option or `register_control(...)` inside `$effect`. See `skill { name: 'bolt-contract', file: 'behaviors.md' }` for the complete working Svelte 5 composition example and every exported signature.

## 5. Composition checklist

- **Co-locate custom UI; share via `src/lib/` only when reusable:** place custom `.svelte` widgets beside their owning datatype `+renderer.svelte` (`src/data/custom_field/<name>/`), model `+representation.svelte` (`src/data/model/.../<model>/`), or app `+<page>.page.svelte` (`src/app/<app>/`) when specific to that surface. Place custom UI under `src/lib/` (grouped in a feature subfolder when multi-file) only when reused across multiple screens, models, or datatypes. Likewise, structure model-specific services beside `+model.ts` (e.g. `src/data/model/.../<model>/service/`) and keep `src/lib/` for cross-model utilities.
- **Full-height split-pane workbenches:** the host's `AppShell` already owns the viewport frame; size the outer workbench grid with `h-full min-h-0 overflow-hidden` (or wrap in `<Bound size="viewport">`) and give each scrolling pane `min-h-0 overflow-y-auto` — never guess magic viewport offsets like `calc(100dvh - 9rem)`.
- **Floating overlays & motion:** never position a floating surface with `transform` on the same element that runs CSS `animate-in` (`@keyframes enter` owns `transform`, which causes the surface to fly across the screen from `0,0`). Always bind `style={floating.style}` (which uses `left`/`top` + `opacity:0` until measured so autofocus still works), pair with side-aware `origin-*`, and include `motion-reduce:animate-none`.
- **Media:** always render images/photos with `<Image>` from `@norbital-ai/ui` (never raw `<img>`) so pending mosaic placeholders and dissolve transitions work automatically in light and dark themes.
- Persist user layout preferences (e.g. resized pane width, collapsed sidebar) with `PersistedState` (or `create_cookie_storage`), never raw `localStorage.getItem`/`setItem` calls.
- Debounce search/filter inputs with `Debounced` or `use_debounce`, never raw `setTimeout` timers.
- Register every custom stateful widget (tree selection, active queue item, slider, viewer mode, inspector open/close) with `register_control` inside `$effect` (or via a behavior's `control` option) so Norbius can inspect and drive it through `page`.
- Every visible label, shortcut hint, empty state, and tooltip comes from `ctx.t(...)`.
- Pair workspace-wide visual identity with `theme: { palette, accent, radius }` in `src/+workspace.ts`.

## 6. Heavy client-side viewers & interactive canvases (3D / WASM / media)

- **Client-side caching first:** whenever the browser downloads and converts a heavy file into an internal runtime format (e.g. WASM geometry/mesh conversion, large binary decode, tiled pyramids), cache the converted artifact client-side across reloads in browser storage (`CacheStorage` or `IndexedDB`, versioned by cache name) paired with a bounded in-memory LRU keyed by immutable file URL/digest. Never re-download or re-convert multi-megabyte assets on every page reload or tab switch.
- **Parallel cold start & `keep_alive: true`:** kick off runtime initialization, file fetch/cache lookup, and worker module imports in parallel rather than serially, report clear staged loading states (`downloading` → `converting` → `loading`), and set `keep_alive: true` on any enclosing tab so switching tabs keeps the live canvas/WebGL context warm.
- **Intentional selection & effortless navigation:** never bind bare `onclick` selection directly on an orbit/pan canvas (every drag finishes with a click event and triggers accidental taps). Guard picks with a pointer-move drag threshold (`≤ 5px`) and require an explicit modifier (`⌘/Ctrl+Click`) in navigate mode plus an explicit `Inspect` mode toggle. Make navigation effortless on both mice and trackpads: cursor-centered zoom, explicit Pan mode + `Shift+drag` pan, canonical view presets + zoom/fit controls, and canvas-focused keyboard shortcuts (never window-global letter/arrow listeners that hijack sibling inputs).
- **Unobtrusive, compact chrome:** omit redundant viewport headings when the enclosing tab already names the pane, and style floating legends, scrubbers, and inspector cards with the app's compact typography tokens (`text-micro` / `text-tiny` / `text-xs`) so overlays never overpower the canvas.
