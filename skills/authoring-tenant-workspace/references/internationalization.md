# Internationalization

English (`'en'`) is always the workspace basis; `src/i18n/+messages.ts` is the base catalog and every additional declared language mirrors its keys.

- Declare supported languages in `src/+workspace.ts` via `languages: ['en', ...]` (BCP-47 tags; default `['en']`). Omitting `'en'` fails `check/messages-base-en`.
- `src/i18n/+messages.ts` is the base; each non-English language in `languages` requires `src/i18n/+<lang>.messages.ts` mirroring its keys (`check/messages-locale-missing`, `check/messages-missing`, `check/messages-extra`), matching `{placeholders}` (`check/messages-placeholders`), and containing no empty strings (`check/messages-empty`). Native model captions (`models.<model>.label|singular|fields.<field>…`) may exist only in a locale: the base humanizes the declared name, so English needs no entry.
- Built-in framework translations ship for `en` and `zh`. Any workspace `+<lang>.messages.ts` may override Bolt shell, `@norbital-ai/ui` view, or `ui.<key>` chrome keys; when a workspace declares a non-native language (e.g. `ja`, `ms`, `th`), `bolt check` requires `+<lang>.messages.ts` to cover every framework key (`check/messages-framework-missing`) so no English chrome leaks inside the workspace.
- Every declared locale ships; when `languages.length > 1`, the shell account menu and access frame render a Globe (`lucide:globe`) multi-language picker listing each language's native endonym, selecting at boot and falling back to the workspace `locale` (hidden when only one language is declared).
- Flat dot-namespaced keys. Keep `{placeholders}` identical in every locale.
- Static `t('key')`, `ctx.t('key')` and `ctx.refuse('key')` calls must reference a declared key in `+messages.ts`, a declared native `models.*` key, or a framework key (`check/messages-undeclared-key`).
- A `Msg` in a declaration (app title, page titles, notices, secret labels) is a catalog key, never a literal. Model, sync, automation, integration and custom-field kinds carry no inline `label` or `help`. Use the implemented native namespaces below; custom views translate their own text through `ctx.t`.
- Reuse platform keys such as `common.save`.
- `ctx.t(key, vars?)` is typed from the base; an unknown key is a type error. `ctx.locale` is the viewer's; the shell owns the picker. Derive composites with `$derived`.

## Raw text

In multi-language workspaces (`languages.length > 1`), `bolt check` (`check/untranslated-text`) flags raw alphabetic text nodes and static literal `title`, `description`, `label`, `placeholder`, `hint` and `aria-label` attributes in `.svelte` files. Every user-facing string comes from `ctx.t(...)`. Not flagged: `<code>`, `<pre>`, `<svg>`, `aria-hidden="true"`, numbers/punctuation, ISO currency codes (`USD`, `SGD`), URLs, non-visible props (`name`, `icon`, `variant`, `class`, `href`), and lines suppressed with `<!-- bolt-check:allow untranslated-text -->`.

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
