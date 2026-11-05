# Internationalization

The base catalog is the source of truth; each locale mirrors its keys.

- `src/i18n/+messages.ts` is the base; `+<locale>.messages.ts` keys are a subset of it. No other catalog file is read.
- Flat dot-namespaced keys. Keep `{placeholders}` identical in every locale.
- Ship `zh` beside the base from the first commit, mirroring base strings until translated.
- A `Msg` in a declaration (app title, page titles, notices, `label`, `help`) is a catalog key, never a literal.
- Reuse platform keys such as `common.save`.
- `bolt.t(key, vars?)` is typed from the base; an unknown key is a type error. `bolt.locale` is the viewer's; the shell owns the toggle. Derive composites with `$derived`.

## Raw text

Every user-facing string in a page or representation comes from `bolt.t`: text nodes and quoted props that render. Not flagged: `aria-hidden` text, `alt`, comments, identifiers, URLs, seed data, logs, model `description`s.

## Key conventions

- `app.<app>.title`, `.description`, `.tab_<name>`; `app.<group>.title`.
- `models.<c>.label`, `.singular`, `.fields.<f>`, `.fields.<f>.<value>`. Views read these themselves; a missing key shows the humanized name, which is a missing entry.
- `component.<name>` for shared labels.
- Plurals: `{count}` with separate keys where languages differ.

## Resolution

Stored choice, then browser languages, then workspace `locale`. Mail and server pages resolve `?lang=` then `Accept-Language`.
