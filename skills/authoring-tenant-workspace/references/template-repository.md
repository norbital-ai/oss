# Template repository metadata

One directory per template at the repository root. Identity and marketing facts live in the template.

| Path | Supplies |
| --- | --- |
| `norbital.template.json` | handle, catalogue copy, tags, visibility, counts |
| `README.md` | the detail page body |
| `assets/thumbnail.svg` | website card and `og:image`, by convention, about 1600×900 |

An app's `banner` is separate: workspace assets shipped in the artifact.

## Two names

- Directory: repository path and public URL slug. Kebab-case.
- Handle: the manifest's `key`, the tenant id when hosted. `norbital_*`.
- They may differ. Never assume one from the other or rename one to match. Both are unique across template repositories.

## Manifest

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | `1` |
| `key` | yes | the handle |
| `name`, `description`, `industry` | yes | nonempty English |
| `name_zh`, `description_zh` | no | maintained Chinese copy |
| `tags` | yes | card chips |
| `visibility` | yes | `public` or `unlisted` |
| `counts` | yes | model, app and automation counts matching source |

- The metadata check compares counts to source: refresh them when roles change.
- The manifest has no `seed` block. Public or private is decided by the repository directory.

## README

- `README.md` is the page and GitHub's view: intro, operating model, pointers to `docs/`. Relative links and images resolve to the repository.
- `README.zh.md` serves the Chinese page, else `README.md`. Translate whole, same structure, once English is stable. `name_zh` and `description_zh` follow the same rule.
