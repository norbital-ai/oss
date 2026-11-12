# Internationalization

The base catalog is the source of truth; each locale mirrors its keys.

- `src/i18n/+messages.ts` is the base; `+<locale>.messages.ts` keys are a subset of it. No other catalog file is read.
- Flat dot-namespaced keys. Keep `{placeholders}` identical in every locale.
- Ship `zh` beside the base from the first commit, mirroring base strings until translated.
- A `Msg` in a declaration (app title, page titles, notices, secret labels) is a catalog key, never a literal. Model, sync, automation, integration and custom-field kinds carry no inline `label` or `help`. Use the implemented native namespaces below; custom views translate their own text through `ctx.t`.
- Reuse platform keys such as `common.save`.
- `ctx.t(key, vars?)` is typed from the base; an unknown key is a type error. `ctx.locale` is the viewer's; the shell owns the toggle. Derive composites with `$derived`.

## Raw text

Every user-facing string in a page or representation comes from `ctx.t`: text nodes and quoted props that render. Not flagged: `aria-hidden` text, `alt`, comments, identifiers, URLs, seed data, logs, model `description`s.

## Key conventions

- `app.<app>.title`, `.description`, `.tab_<name>`; `app.<group>.title`.
- `models.<c>.label`, `.singular`, `.fields.<f>`, `.fields.<f>.<value>`. Views read these themselves; captions fall back to the humanized name. Add an override when the wording needs it instead of duplicating the fallback.
- `component.<name>` for shared labels.
- Plurals: `{count}` with separate keys where languages differ.

Native field text uses these prefixes; each caption is `<prefix>.fields.<field>` and its help is
`<prefix>.help.<field>`:

| Native editor | Prefix |
| --- | --- |
| Model form | `models.<model>` |
| Automation input form | `automations.<name>.input` |
| Integration configuration | `integrations.<definition>.configuration` |

Nested JSON, custom values and output descriptors do not imply another native help renderer.
Standalone UI `Field` label/help props and Std/UI kind presentation overrides remain available
to explicit views.

## Resolution

Stored choice, then browser languages, then workspace `locale`. Mail and server pages resolve `?lang=` then `Accept-Language`.
