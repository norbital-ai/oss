# `@norbital-ai/ui`

Svelte views, field inputs, primitives, design tokens and layout primitives for Bolt workspaces.

See the [UI package overview](./docs/README.md) for goals, layering, and styling boundaries.

Public entries: `.` (views, inputs, editors, primitives), `./layout`, `./brand` (brand and access
artwork), `./effect`
(the mounted Svelte Effect edge) and `./base.css`; `./assets/*` holds the logo and favicons.

```svelte
<script lang="ts">
	import { Button, Table } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
</script>
```

Import `@norbital-ai/ui/base.css` once at the application root. Bolt's generated client entry imports
it automatically, so tenant apps do not add a second base stylesheet or Tailwind integration.

Do not import from `build/` or `src/` directly.

**One tab size.** Every tab strip in the realm (an app's page strip, a page's `Tabs`, Workspace
Studio, Command Center, settings, record sheets, a calendar's view switch, a `Split` switch) is the
same compact size: a 1.75rem trigger with `px-3`, `text-xs` and a `size-3.5` icon, in a 2rem strip
(`src/primitives/tabs/style.ts`). There is no size prop. The three types, segmented (the default),
underline and chips, differ in appearance only; the nesting level picks the type (`level` overrides
it). `Tabs` (a strip with bodies) and `TabStrip` (a strip alone: page links, or buttons switching a
view the caller renders) are the only tab implementations: never hand-roll a `role="tab"` strip or
restyle a trigger's height, padding or font. On touch screens a tab's minimum target is 32px; other
controls retain the standard 44px. A horizontal `Tabs` strip moves the tabs that do not fit under
More; a `TabStrip` scrolls horizontally.

**One control size.** Every form and toolbar control is the tab strip's compact size: a 2rem box
with `px-2.5`, `text-xs` and a `size-3.5` icon (`CONTROL_SIZE` in `src/kinds/classes.ts`). That is
every input (text, number, money, date, time, period, tags, file), a textarea's first line, every
select or combobox (`Combobox`, `Picker`, `CountryPicker`, a place picker), filter chips and the
toolbar search, and `Button` (`default` and `icon`; `lg` only for a lone call to action outside forms
and toolbars, such as a kiosk). There are no other sizes: a caller sets a width, never a control's
height, padding or font. On touch screens the minimum target is 32px, as a tab's.

**A section groups at least two controls, or one large control** (a structure, a list of
objects, a map, code, long text or a custom datatype's editor: a field that spans its row). A `Section` whose content is a single other field
folds away: no heading, no rule, never collapsed; the field joins the flow under its own label. A
large field alone keeps its section and does not repeat the section's title as its own heading
(its rows and add control stay).

**One border per visual container.** `StructuredData` draws one frame; a nested object or list
inside it is a ruled band of that frame (a list's table draws only its row lines), never a second
card. A disclosure opens and closes without moving anything above it; content that loads or grows
on its own takes its height at once, and only a viewer's toggle animates height. A nested object
lays out on its parent's grid (same label column, same input column) under one header band. A
field is one control high: its reset or clear button is an adornment at the control's end, shown on
hover or focus; a list cell's expand mark shows on its cell's hover or focus.

**Datatypes in JSON Schema.** `StructuredData` (forms, tables and popover cells alike) picks a
datatype's control at one dispatch, `json_schema_kind`: explicitly by `format: '<datatype>'`
(`period`, `point`, `money`, `duration`, `currency`; `x-norbital.datatype` for a custom one), else
implicitly when an object's shape is exactly a datatype's (std's `DATATYPE_SHAPES`: a date or
instant period, a point). A native kind in a list cell keeps its own editor and renderer; only a
structure opens the cell popover. `bolt check`/`build` reject a seeded schema naming a datatype in
another shape.

**Popovers stay attached.** `align="start"`/`"end"` is a preference: content that does not fit on
that side of its trigger takes the other edge, and no popover grows taller than the room on its
side (it scrolls), so it never covers its own trigger.

## Development

```sh
pnpm --filter @norbital-ai/ui build
pnpm --filter @norbital-ai/ui lint
```

## Filter composition

The editor and Norbius use the engine's typed filter catalogue as the source of
available fields, operators, operands and relationship paths. System 1 authors
model fields, relations and read outputs; it does not invent a second query language.

| Scope            | Presentation                                       | Meaning                                                                                                                                    |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Prefilter        | Lock and “Always”, read-only sentence              | Author scope always applies; Clear all removes only user conditions and sorting.                                                           |
| Condition        | One sentence with directly editable words          | A typed comparison; unary checks need no value.                                                                                            |
| Condition group  | All / Any / None scope with indented children      | Boolean composition at the current record scope.                                                                                           |
| Related records  | Plain-language record scope with indented children | Some / none / every related record satisfies the child conditions. All child conditions inside one scope refer to the same related record. |
| Single reference | Full field path in the field picker                | Navigate a referenced record without changing the enclosing Boolean scope.                                                                 |

Compose business queries from these primitives: equality and ordered comparisons,
sets and text matching, missing/empty checks, date and period conditions, typed
values, single references, related-record quantifiers, and catalogue-supported
counts and totals. Search and semantic similarity stay backed by the engine's
indexes. Only offer operations supported for the selected type and current read
output; an unavailable capability must never become a silently ignored condition.
A lowered condition must read back through the same grammar: the builder refuses
an operator its field kind cannot take, and a decoder failure drops the clause with
one notice instead of sending an unchecked predicate.

Each condition has one representation. Field, operator and value controls are the
sentence itself; there is no duplicate summary or per-condition accordion. Scope
headers explain how child conditions combine. The caret only hides a scope's
children. A single Add menu creates a condition or a set of alternatives. Remove
and comparison-mode controls appear on hover or keyboard focus, and remain visible
on touch devices. Literal operand kinds (“a date”, “a value”) stay in the advanced
comparison menu rather than interrupting a business rule.

Field icons identify text, numbers, dates, date ranges, choices, structured values,
single linked records and related collections. A `ref` field is a foreign key and
resolves as a linked record wherever the live catalogue offers it; a text column
with a company-like name stays text. A related-record scope currently offers the
child's own scalar fields, not the child's one-relations inside that scope.
Expanding a linked record in the picker reveals its available fields; a bent-arrow
icon identifies a field reached through that link. Hover labels name the type, and
the picker explains the icons without adding a permanent legend to every rule.

Field and operator changes form one typed transition: selecting the same field
does nothing, compatible values survive, and incompatible inputs clear only in
the edited rule. A single choice can become a one-item list and back; multiple
choices never silently become the first item. Changing a relationship target
starts a fresh scope; reselecting the same target keeps its child conditions.
Date, period, number and record inputs never carry stale controls or operators
into a different field type. Aggregate thresholds follow the selected child
field's type too.

Use one related-record scope for “an open order placed before September”. Two
separate scopes mean two potentially different orders. Use an Any group for
alternatives, and All for intersecting requirements. Empty related collections
satisfy None and Every; require Some as well when the business rule needs at least
one record. Filter the parent by a relationship predicate when deciding which
parents qualify; a nested read's own filter controls which children are returned.

No finite filter editor guarantees every business outcome. Derived business facts
belong in declared model/query outputs or server automations when the catalogue
cannot express them. Norbius should inspect the catalogue, build the same typed
predicate, and preserve author scope; source authors should add a reusable domain
output rather than embedding arbitrary executable code in a user's filter.

The current editor catalogue bounds relationship traversal to two hops, and a
many-record scope exposes the child's own fields. Typed JSON values currently
use containment in this editor; arbitrary typed inline paths and inline-list
quantifiers are supported by native reads but are not exposed by this catalogue.
Keep that boundary explicit when planning a business view: use a declared read or
query for deeper traversal or inline-list logic until catalogue discovery and the
editor support those operations together. Do not describe these as editable UI
conditions or flatten a same-item predicate into unrelated clauses. The browser
editor fixture is a synthetic UI catalogue; it is not evidence that the live
catalogue offers a path.

For future filter extensions, keep these design rules:

- Discover fields and operations within the selected scope instead of expanding
  every relationship recursively into one enormous list.
- Present structured objects as a field path; present inline lists as “Items in
  [field]” with Some / None / Every, distinct from “Related records”. Both preserve
  same-item semantics and allow nested Boolean groups.
- Keep existence tests, counts and aggregates explicit. “Every” includes an empty
  collection; “At least one, and every” is a composed rule rather than a hidden
  change to its meaning.
- Validate the same predicate through the native decoder for manual edits,
  Norbius-generated filters and authored queries. Reject unsupported paths with
  an actionable error. Keep policy and author prefilters outside user-editable
  predicate state.
- Show aggregate scope (“all related records” or a specific child filter) before
  its comparison. Never imply that a child display filter changes the parent's
  qualification or the aggregate's input set.
