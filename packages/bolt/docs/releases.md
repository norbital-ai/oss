# Releases

A release is one `bolt build` of a template, named by digests. It is built once, in the template repository's CI,
and the same bytes run in every environment.

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
	"handle": "<handle>",
	"bundle": "<sha256>",
	"source": "<sha256>",
	"seed": { "base": "<sha256>" }
}
```

Each digest is a SHA-256 over the part's file tree, leaving out `*.map` (the bundler writes random names into source
maps). Identical source gives an identical bundle digest, and a comment-only edit keeps it.
`release.json` is written last: a reader that finds it finds every part it names.

## From push to workspaces

```
template push (main)
  -> CI per template: bun install --frozen-lockfile, bolt check,
     bolt build (the ONE build), bolt test
  -> bolt templates publish --out=<dir>
       bundle/<b>.tar.gz  source/<s>.tar.gz  seed/<p>.tar.gz
       template/<directory>/<b>.json   (the release.json)
  -> the host stores every part by its digest

the host is told to serve bundle <b>
  -> fetches each part, verifies its digest
  -> cuts the template's demo workspaces over
       same schema: flip, no pause
       changed schema: pause, migrate, flip
  -> running automations get 60 s, then turns stop at a step, at most 90 s
  -> open pages reconnect, and reload for a new client
```

Nothing reaches a workspace until the host names the bundle digest, and every environment serves the same digest.
A pull request runs the checks, the build and the tests, but publishes nothing.

## Hosts never rebuild

A host builds no template release: it serves the bundle CI built, by digest. Only a template's demo workspaces follow
its releases. A customer workspace owns its source (Studio) and never follows a template release; Studio's own previews
build that source. Any host takes the same `bundle/` and activates it with its own facilities ([hosts](./hosts.md));
the needs check at activation is the only gate.
