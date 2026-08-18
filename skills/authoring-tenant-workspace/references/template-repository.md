# Template Repository Metadata and READMEs

Templates live in their own repositories, one directory per key at the repository root:
`norbital-ai/templates` (public) and `norbital-ai/templates-private`. The split decides one thing
only — **whether a template is advertised**. The website generates its gallery from the templates
the public repository publishes, so a template in the private one is structurally invisible to it.
A host resolves both remotes into one catalogue, so a private template is a first-class template in
the picker, in seeding, and in tenant forking.

The website (`norbital.ai/templates/*` and the homepage cards) is generated from the template
workspace itself — there is no rewritten copy anywhere, and no list of slugs. Every display fact
comes from the template tree, fetched at build time:

| File / path              | Supplies                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `norbital.template.json` | name, description, industry, visibility, counts, tags, optional thumbnail override, localized fields |
| `README.md`              | the detail page body, rendered as markdown                                                           |
| `assets/thumbnail.svg`   | **marketing thumbnail** for website cards and `og:image` (declare once by dropping this file)        |

## Marketing thumbnail (declare once)

The gallery card image and Open Graph image share **one** file:

```text
<key>/assets/thumbnail.svg
```

- Drop that file. Do **not** also put a `thumbnail` (or legacy `banner`) field in
  `norbital.template.json` unless the image lives at a different path.
- The website resolves `assets/thumbnail.svg` by convention (`TEMPLATE_DEFAULT_THUMBNAIL`).
- Optionally reference the same path from the README (`![…](assets/thumbnail.svg)`) so GitHub's
  preview matches the website — that is a pointer to the same file, not a second configuration.
- Target about 1600×900. Prefer SVG or a light raster committed under `assets/`.

| Kind                         | How you declare it                                              | Consumed by                                       |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Template marketing thumbnail | `assets/thumbnail.svg` (optional manifest `thumbnail` override) | Website gallery cards, homepage cards, `og:image` |
| App overview card            | `<meta name="bolt:thumbnail" …>` in the app                      | Workspace `/` overview, omni finder               |
| App shell background         | `<meta name="bolt:banner" …>` in the app                         | Shell `AppMediaHeader`                            |
| Record detail banner         | `<meta name="bolt:banner" …>` in `+representation.svelte`        | Collection detail sheet                           |

Do not reuse the marketing file as `bolt:thumbnail` / `bolt:banner` unless you intentionally want the
same art inside the product. App and record media normally live under `assets/app-media/` and
`assets/record-media/` and are wired with `/api/template-seed-assets/<key>/…` URLs — see
[apps-and-server-roles.md](apps-and-server-roles.md#app-media--icons-thumbnails-banners).

Legacy manifests may still carry `"banner": "…"`. Hosts and the website map that onto `thumbnail`
during parse; new templates should not use `banner`.

## The manifest (`norbital.template.json`)

```json
{
	"schemaVersion": 1,
	"key": "crm",
	"name": "CRM",
	"industry": "Sales",
	"description": "B2B trade workspace integrating sales quotes and purchase orders with the company's system of record.",
	"visibility": "public",
	"counts": { "collections": 17, "apps": 2, "automations": 1 },
	"tags": ["Sales", "Finance", "Procurement"],
	"name_zh": "CRM",
	"description_zh": "端到端 B2B 交易工作区：账户、报价、采购、履约、开票、库存与收付款。"
}
```

| Field                        | Required | Used by                                                               |
| ---------------------------- | -------- | --------------------------------------------------------------------- |
| `name`                       | yes      | Picker + website card/detail title                                    |
| `description`                | yes      | Picker + website card/detail summary                                  |
| `industry`                   | yes      | Picker filtering                                                      |
| `visibility`                 | yes      | `public` \| `unlisted`                                                |
| `counts`                     | yes      | Picker + website detail stat chips                                    |
| `thumbnail`                  | no       | Override path for the marketing image; default `assets/thumbnail.svg` |
| `tags`                       | no       | Website card chips; falls back to `industry`                          |
| `name_zh` / `description_zh` | no       | Chinese locale title/summary; falls back to English                   |

## The README is the page

`README.md` at the template root is the single source of the template detail page body. It is also
what GitHub shows, so write it for both: an intro, an operating model, and pointers to the docs
hub under `docs/` (relative links resolve to the repository on the website). Relative images
(e.g. `assets/thumbnail.svg`) resolve to raw GitHub URLs automatically.

### Chinese locale

The website serves `/zh/templates/<key>` from `README.zh.md` when present, and falls back to
`README.md` otherwise — a template never ships a half-translated page. Translate the README whole,
keep the file name and structure mirrored, and reference the same relative assets:

```text
hr-payroll/
├── README.md            # English (source of truth)
├── README.zh.md         # Simplified Chinese, same structure
├── assets/thumbnail.svg # marketing thumbnail (website + optional README embed)
└── norbital.template.json
```

Add a zh README only when the English one is stable enough to translate against; the website
degrades gracefully while it is missing. The manifest's `name_zh` / `description_zh` fields follow
the same rule: present only when the translation is kept current.

## What this means for template authors

- Change the template's narrative → edit `README.md`, not a website page.
- Change a card title or chips → edit `norbital.template.json`.
- Change the marketing thumbnail → replace `assets/thumbnail.svg` (one file; website picks it up).
- Add Chinese support → add `README.zh.md` (and the manifest zh fields) next to the English ones.
- The website rebuild picks the changes up from the repository; nothing else moves.
- Publish a template to the public repository and it is advertised; publish it to the private one
  and it is not. There is no third place to update.
