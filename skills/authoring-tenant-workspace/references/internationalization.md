# Internationalization

Every workspace is internationalized by contract. The base catalog is the source of truth; each
further locale mirrors its keys.

## Authored files

```text
src/i18n/
├── +messages.ts        # the base locale's keys (exactly one when i18n/ exists)
└── +zh.messages.ts     # another locale; its keys ⊆ the base (tsc)
```

```ts
// src/i18n/+messages.ts
import { messages } from "@norbital-ai/bolt";
export default messages({
  "app.quotes.title": "Quotes",
  "app.quotes.description": "Draft, send and track customer quotes.",
  "component.doc_no": "Document {no}",
});
```

- Flat key → string maps, dot-namespaced. Keep `{placeholders}` identical in every locale.
- Every workspace ships `zh` beside its base locale from the first commit. When the market is
  base-locale-only today, the `zh` file mirrors the base strings so the wiring is ready the day a
  translation arrives.
- `Msg` in a declaration (`app.title`, `pages.*.title`, notification titles, `label`, `help`) is a
  catalog key. An app's title and description are keys (`app.<app>.title`), never literals.
- Every visible string has a key in `+messages.ts` and in `+zh.messages.ts`. No other catalog file
  (`messages.en.json` and the like) is read.
- A key only the platform defines (`common.save`) is reused, not duplicated.

## Using it in pages

```svelte
<script lang="ts">
	import { bolt } from '$bolt';
	import { AppShell } from '@norbital-ai/ui/layout';
</script>

<AppShell icon="lucide:file-text" title={bolt.t('app.quotes.title')} description={bolt.t('app.quotes.description')}>
	…
</AppShell>
```

`bolt.t(key, vars?)` is typed from the base catalog: an unknown key is a tsc error. `bolt.locale` is
the viewer's locale; the shell owns the language toggle. Derive composite strings with `$derived`.

## The raw-text rule

Every user-facing string in a page or representation comes from `bolt.t(…)`: a text node with a word
character, and a quoted literal passed to a component prop that renders (`title="Requests"`). A raw
string is a missing catalog entry; name it with file and line in review.

Not flagged: decorative `aria-hidden` text, `alt` on media, comments, identifiers, URLs, seed data,
log messages, and model `description`s (single-language data semantics).

## Key conventions

- `app.<app>.title` / `app.<app>.description`, `app.<app>.tab_<name>`, `app.<group>.title`.
- `models.<c>.label` — a model's name; `models.<c>.singular` — one record of it (a record
  sheet's overline); `models.<c>.fields.<f>` — a field's label;
  `models.<c>.fields.<f>.<value>` — an enum or state value. Views, record sheets and pickers read these
  on their own; a missing key shows the humanized name, which is a missing entry, not a default.
- `component.<name>` for labels shared across pages.
- Plurals: `{count}` with separate keys where the languages differ.

## Locale resolution

Stored choice → browser languages → the workspace `locale`. `Intl.*` formatting follows the locale.
Mail and server-rendered pages resolve from `?lang=` then `Accept-Language`.
