# Interface Ideology

The axioms every layout, scroll, and spacing decision in a Bolt workspace derives from. Read this
before [layout-and-scrolling.md](layout-and-scrolling.md) or
[padding-and-spacing.md](padding-and-spacing.md) — those two are the behaviour that falls out of
these principles, not independent rule sets.

The model is [Every Layout](https://every-layout.dev/) and
[Bedrock Layout](https://www.bedrock-layout.dev/): layout is a small set of composable primitives
with one job each, and content is layout-agnostic.

## The five axioms

### 1. An element never spaces or sizes itself

Space is granted by a parent, or claimed inside a boundary the element itself draws. A component
that sets its own outer margin, width, or growth is broken: it renders differently depending on
where it is dropped, so it cannot be composed. Content is a passenger; the parent chooses the
algorithm.

Consequence: **no margins in an app file.** `mt-*`, `mb-*`, `space-y-*` between siblings means a
parent is missing a `gap`. See [padding-and-spacing.md](padding-and-spacing.md).

### 2. One primitive, one job

`Stack` does vertical rhythm and nothing else. `Split` does two adaptive regions and nothing else.
Composition, not configuration, produces complex layouts. A primitive that grows a second
responsibility (a `Grid` that also scrolls, a `Bound` that also draws a card) is a design smell —
nest the two primitives instead.

| Intent                        | Primitive            |
| ----------------------------- | -------------------- |
| Vertical rhythm               | `Stack`              |
| One row / wrapping group      | `Inline` / `Cluster` |
| Two adaptive regions          | `Split`              |
| Intrinsic cells / exact spans | `Grid` / `Columns`   |
| Top, main, bottom             | `Cover`              |
| Readable measure / media crop | `Center` / `Frame`   |
| Height contract / page inset  | `Bound`              |
| Scroll ownership              | `Scroll`             |
| Sanctioned overlap            | `Imposter`           |

The catalogue with its Every Layout / Bedrock names is in
[layout-and-scrolling.md](layout-and-scrolling.md#the-primitive-catalogue). The doctor `layoutPack`
enforces it in every template, Colony and `oss`.

### 3. Intrinsic over breakpoints

Layouts respond to the space they are actually given, not to the browser window. Apps render inside
a `[container-name:bolt-app]` container query; the sidebar and shell chrome change available width
without changing viewport width, so viewport breakpoints lie.

Use `Grid minimum="…"` (auto-fit), `Split`/`Columns` `collapse` (each measures itself), and
`min-w-0` shrinking.
Do not write viewport breakpoint recipes or hard-coded widths. The only `sm:` in the system is the
shared spacing scale — see [padding-and-spacing.md](padding-and-spacing.md).

### 4. Exactly one owner per responsibility, per axis, per level

Scroll, padding, and height each have a single owner in any ancestor chain. Two owners is always a
defect, and the two defects look opposite but share one cause: nobody decided who owns it.

- two scroll owners on one axis → a scroll trap; the user gets stuck in the inner region
- two padding owners → content sits two gutters in and misaligns with its own chrome
- zero owners → content flush against the shell edge

The ownership ladders are in [layout-and-scrolling.md](layout-and-scrolling.md) (scroll) and
[padding-and-spacing.md](padding-and-spacing.md) (padding). They are the same ladder walked twice.

### 5. Tokens, never values

Every space, size, ratio, and breakpoint is a named token on a shared scale: `gap`/`pad`
(`none`/`xs`/`sm`/`md`/`lg`), `Bound size`, `Grid minimum`, `Split ratio`/`collapse`, and the app
inset. An arbitrary `p-[13px]`, `w-[420px]`, or `md:` in an app file is a bug, not a preference: it
is a value that no other surface can agree with, and agreement is the whole point of a scale.

## Information density

**No overlapping — except through `Imposter`.** No raw `absolute`/`fixed`/`sticky`, no z-index
layering. When an overlap is the design (a badge pinned to a card corner, a camera guide over a
video, a scrim), it is an `Imposter` inside a `relative` parent, so every overlap in the product is
findable by one name.

**No duplication.** Never show the same data value twice in the same visual region. Views render
each field through its kind; forms use `Field`, which does the same. Do not pair a read-only label
with a `Show` of the same field. Section headings are not duplication — they describe the section,
not a value.

Readonly records show values and the record's state without repeating a write restriction under
every field. Native `Field` explains locked or source-managed values when the operator enters
Edit. Preserve that disclosure instead of adding permanent permission or lock paragraphs.

Use charts only when they answer a comparison or trend question. Check the plotted labels in
the actual narrow record panel: root-width checks alone miss axis labels clipped inside an SVG.
Keep axis layout in the shared Chart rather than patching each template's chart margins.

**Kinds first.** Use `Show` / `Field` before hand-rolling display. Author a custom field
(`src/data/custom_field/<f>/+renderer.svelte`) only for a value the built-in kinds cannot express.

| Kind             | Renders as                                 | Edit with        |
| ---------------- | ------------------------------------------ | ---------------- |
| `text`           | plain text (email, phone, url formatted)   | `Input`          |
| `int`, `decimal` | `Intl.NumberFormat`                        | `Input`          |
| `money`          | currency format                            | `MoneyInput`     |
| `date`           | date, same for every viewer                | `TimeInput`      |
| `instant`        | date + time in the shell's configured zone | `TimeInput`      |
| `period`         | from – to                                  | `TimeRangeInput` |
| `bool`           | Yes / No                                   | `Checkbox`       |
| `enum`, `state`  | the value's label, a badge for state       | option list      |
| relation         | the target's `label`                       | `Picker`         |
| `point`          | coordinates or address                     | `PointInput`     |
| `file`           | file name, preview                         | `FileInput`      |

## Records are summaries, not database rows

Narrow `Table` layouts are record summaries, not database inspectors. Give every model a
human-readable `label`, and choose `columns` / `Board` `card` fields that say what the record is.

Never expose `id`, UUID fields, or `*_id` relationship keys as a list title or description.
Use the named record or relationship label; IDs remain internal keys for links, mutations, and
diagnostics.
