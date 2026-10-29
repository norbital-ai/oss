# Template Repository Metadata and READMEs

One directory per template at the repository root. Authors declare identity and marketing facts in
the template itself — not in a host or a website checkout.

| File / path              | Supplies                                                 |
| ------------------------ | -------------------------------------------------------- |
| `norbital.template.json` | handle, catalogue copy, tags, visibility and counts      |
| `README.md`              | the detail page body, rendered as markdown               |
| `assets/thumbnail.svg`   | **marketing thumbnail** for website cards and `og:image` |

## Marketing thumbnail (declare once)

The gallery card image and Open Graph image are **one** file, found by convention:

```text
<directory>/assets/thumbnail.svg
```

Drop that file; there is no manifest field for it. Optionally embed the same path from the README so
GitHub's preview matches the website. Target about 1600×900.

In-product media is separate: an app's `banner` in `+app.ts` and `AppShell`'s `banner` / `thumbnail`
point at workspace assets under `assets/` (for example `assets/app-media/`), which ship in the
artifact. Reuse the marketing file there only when you want the same art inside the product — see
[apps-and-server-roles.md](apps-and-server-roles.md#apps-pages-and-groups).

## Two names: the directory and the handle

A template has a **directory** and a **handle**, and they are not the same string.

| Name          | Where it comes from              | What it decides                                                    |
| ------------- | -------------------------------- | ------------------------------------------------------------------ |
| **directory** | the path at the repository root  | repository path and public URL slug when the template is published |
| **handle**    | `norbital.template.json`'s `key` | organization / tenant id when the workspace is hosted              |

`hr-payroll/` carries the handle `norbital_hr`; `field-operations/` carries `norbital_bca`. Renaming
a directory moves its releases and public URL; renaming a handle does not touch either. Do not
assume one from the other, and do not rename one to make them match.

The `<directory>` written in paths always means the directory, never the handle.

## The manifest (`norbital.template.json`)

```json
{
	"schemaVersion": 1,
	"key": "norbital_service_desk",
	"name": "Service Desk",
	"description": "Client agreements, service work and configured fees.",
	"industry": "Professional Services",
	"visibility": "public",
	"counts": { "models": 2, "apps": 1, "automations": 0 },
	"tags": ["Service", "Operations"],
	"name_zh": "服务台",
	"description_zh": "管理客户协议、服务工作和费用规则。"
}
```

| Field                             | Required | Meaning                                                                  |
| --------------------------------- | -------- | ------------------------------------------------------------------------ |
| `schemaVersion`                   | yes      | `1`                                                                      |
| `key`                             | yes      | the workspace handle                                                     |
| `name`, `description`, `industry` | yes      | nonempty English strings                                                 |
| `name_zh`, `description_zh`       | no       | maintained Chinese catalogue copy                                        |
| `tags`                            | yes      | card chips                                                               |
| `visibility`                      | yes      | `public` or `unlisted`                                                   |
| `counts`                          | yes      | nonnegative model, app and automation counts matching the current source |

The repository's metadata check compares declared counts to source. Refresh them when entities or
roles change; do not hard-code counts in a website or host. The manifest has no `seed` block: the
private bank tree is named by `seed/+seeder.ts` (`bank.tree`) and read only by `bolt seed`. Whether source is public is decided by the
directory the template lives in: moving a private template to the public repository publishes it
with nothing inside it changed.

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
degrades gracefully while it is missing. The manifest's `name_zh` and `description_zh` entries follow the same rule: present
only when the translation is kept current.

## What this means for template authors

- Change the template's narrative → edit `README.md`.
- Change a card title or chips → edit `norbital.template.json`.
- Change the marketing thumbnail → replace `assets/thumbnail.svg`.
- Add Chinese support → add `README.zh.md` and `name_zh` and `description_zh` beside the English copy.
