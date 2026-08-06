# Template Repository Metadata and READMEs

The website (`norbital.ai/templates/*` and the homepage cards) is generated from the template
workspace itself — there is no rewritten copy anywhere. Every display fact comes from two files
in `template_workspaces/<key>/`, fetched at build time:

| File                     | Supplies                                                                        |
| ------------------------ | ------------------------------------------------------------------------------- |
| `norbital.template.json` | name, description, industry, visibility, counts, tags, banner, localized fields |
| `README.md`              | the detail page body, rendered as markdown                                      |

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
	"banner": "assets/banner.svg",
	"tags": ["Sales", "Finance", "Procurement"],
	"name_zh": "CRM",
	"description_zh": "端到端 B2B 交易工作区：账户、报价、采购、履约、开票、库存与收付款。"
}
```

| Field                        | Required | Used by                                              |
| ---------------------------- | -------- | ---------------------------------------------------- |
| `name`                       | yes      | Picker + website card/detail title                   |
| `description`                | yes      | Picker + website card/detail summary                 |
| `industry`                   | yes      | Picker filtering                                     |
| `visibility`                 | yes      | `public` \| `unlisted`                               |
| `counts`                     | yes      | Picker + website detail stat chips                   |
| `banner`                     | no       | Website card + detail hero; repo-relative image path |
| `tags`                       | no       | Website card chips; falls back to `industry`         |
| `name_zh` / `description_zh` | no       | Chinese locale title/summary; falls back to English  |

Keep `banner` pointing at a committed image (e.g. `assets/banner.svg`, 1600×900). When it is
absent, the website uses the first image in the README.

## The README is the page

`README.md` at the template root is the single source of the template detail page body. It is also
what GitHub shows, so write it for both: an intro, an operating model, and pointers to the docs
hub under `docs/` (relative links resolve to the repository on the website). Relative images
(e.g. `assets/banner.svg`) resolve to raw GitHub URLs automatically.

### Chinese locale

The website serves `/zh/templates/<key>` from `README.zh.md` when present, and falls back to
`README.md` otherwise — a template never ships a half-translated page. Translate the README whole,
keep the file name and structure mirrored, and reference the same relative assets:

```text
template_workspaces/hr-payroll/
├── README.md        # English (source of truth)
├── README.zh.md     # Simplified Chinese, same structure
├── assets/banner.svg
└── norbital.template.json
```

Add a zh README only when the English one is stable enough to translate against; the website
degrades gracefully while it is missing. The manifest's `name_zh` / `description_zh` fields follow
the same rule: present only when the translation is kept current.

## What this means for template authors

- Change the template's narrative → edit `README.md`, not a website page.
- Change a card title, chips, or banner → edit `norbital.template.json`.
- Add Chinese support → add `README.zh.md` (and the manifest zh fields) next to the English ones.
- The website rebuild picks the changes up from the repository; nothing else moves.
