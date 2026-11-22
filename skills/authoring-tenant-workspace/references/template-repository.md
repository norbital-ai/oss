# Template repository metadata

One directory per template at repo root:

- `norbital.template.json`: `schema_version: 1`, `key` (`norbital_*` handle), `name`, `description`, `industry`, optional `name_zh`/`description_zh`, `tags`, `visibility` (`public` | `unlisted`), generated `counts` (updated by `bolt build`; omit in new templates; no `seed` block). Directory slug (kebab-case) and `key` (`norbital_*`) may differ — both must be unique across template repos.
- `README.md` (and `README.zh.md` translated whole once English stabilizes): intro, operating model, `docs/` links.
- `docs/screenshots/application.webp` (1920×1080): template card, README lead, `og:image` and picker thumbnail (separate from app `banner` assets).
