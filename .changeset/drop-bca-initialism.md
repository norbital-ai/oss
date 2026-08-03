---
'@norbital-ai/std': patch
---

Drop `bca` from the label initialism map.

`humanize` uses the map so a generated label reads the way the domain says it, not the way a column
name is spelled — `api_key` as "API Key" rather than "Api Key". `bca` was in there for one reference
template that named itself after a specific regulator, which is exactly the kind of tenant-specific
vocabulary a shared package should not carry: every workspace using the platform inherited a casing
rule for an acronym that means nothing in their domain, and the only way to find out was to name a
column `bca` and watch it render.

The template it served is now `field-operations`, so the entry has no caller left. A workspace that
genuinely needs a domain acronym cased should get it from its own label overrides rather than by
having the term added here.

`humanize('bca')` now returns `Bca`. Nothing in the monorepo depends on the old result.
