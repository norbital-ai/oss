---
'@norbital-ai/std': patch
---

Republish the packages with complete build output.

Several published tarballs are missing whole directories their own `package.json` declares exports
for. `@norbital-ai/std@4.0.0` ships no `build/json`, `cache`, `error`, `finance`, `result`, `string`,
`text`, `tree` or `truncate`; `@norbital-ai/platform-utils@3.0.0` ships no `build/system/collections.js`.
Nothing failed at publish time, because a tarball that disagrees with its manifest is only wrong one
layer down — it surfaced in tenant builds as `Cannot find module '@norbital-ai/std/build/json/index.js'`
and `.../platform-utils/build/system/collections.js`.

The cause was the concurrent `prepack` race now fixed in the release workflow. `changeset publish`
packs the packages in parallel; several of those packs rebuild the same dependency, and
`scripts/build-package.mjs` opens by removing the staging directory it is about to compile into. A
package was therefore packed from a directory another process was part-way through rebuilding. The
workflow now builds every publishable package once up front, so each prepack is a turbo cache hit and
no two packs ever compile the same package concurrently.

Registry versions are immutable, so the affected versions stay as they are and this republishes the
same source under a new one.
