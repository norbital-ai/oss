# Releases

A release is one `bolt build` of a template, named by digests. It is built once, in the template repository's CI,
and the same bytes run on staging and production.

## Parts

`bolt build` writes three parts under `.norbital/` and, last, `release.json` naming them:

| Part           | Holds                                                            | Used by                                                                                                                                              |
| -------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle/`      | manifest, guest, client and server pages, assets, migrations     | the host runs it                                                                                                                                     |
| `source/`      | the authored tree without tests or generated/installed folders   | Studio edits it (a customer workspace's starting source)                                                                                             |
| `seed/<pack>/` | `base` (public, from `seed/public/`), `test` (from `seed/test/`) | `base`: provision and reset; `test` only for the template's own tests, never published. Private rows never enter a release ([seeding](./seeding.md)) |

```json
{
	"format": 1,
	"handle": "norbital_hr",
	"bundle": "<sha256>",
	"source": "<sha256>",
	"seed": { "base": "<sha256>" }
}
```

Each digest is a SHA-256 over the part's file tree, leaving out `*.map` (the bundler writes random names into source
maps). Identical source gives an identical bundle digest, and a comment-only edit keeps it.
`release.json` is written last: a reader that finds it finds every part it names.

## From push to tenants

```
template push (main)
  -> CI per template: bun install --frozen-lockfile, bolt check,
     bolt build (the ONE build), bolt test
  -> bolt templates publish --out=<dir>
       bundle/<b>.tar.gz  source/<s>.tar.gz  seed/<p>.tar.gz
       template/<directory>/<b>.json   (the release.json)
  -> upload to R2 under releases/, every object named by its digest

env deploy promote --target=staging --template=<directory> --release=<b>
  -> Colony reads releases/template/<directory>/<b>.json,
     records it as the template's current release
  -> fetches each part from R2, verifies its digest
  -> cuts the template's demo workspaces over
       same schema: flip, no pause
       changed schema: pause, migrate, flip
  -> open pages reload

production: promote the SAME <b>
```

Nothing reaches a tenant until `promote` names the bundle digest. A pull request runs the checks, the build and the
tests, but uploads nothing.

## Tethered tenants never rebuild

Colony builds no template release: it serves the bundle CI built, by digest, on every host. Wiping a host's volume
loses nothing; the parts are fetched from R2 again. Promote moves only the template's demo workspaces. A customer
workspace owns its source (Studio) and never follows a template release; Studio's own previews build that source.

## Untethered hosts

An untethered host takes the same `bundle/` and activates it with its own facilities ([hosts](./hosts.md)). How it
receives bundles is its own business; the needs check at activation is the only gate.
