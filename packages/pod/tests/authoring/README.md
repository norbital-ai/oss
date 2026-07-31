# Authoring and the compiler

**What this pillar protects:** that what an author writes becomes the schema and the build they
meant, and that a rebuild does not quietly destroy data or leak server code into the browser bundle.

## Why these tests exist

Compiler output is the one artefact nobody reads. It is generated, committed, and trusted, so a
mistake in it is discovered by its consequences: a constraint that was dropped and re-added on every
deploy, a migration that re-ran because its fingerprint moved for no reason, a server module pulled
into the client bundle by an import that looked harmless.

| File                            | Owns                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exclusion-ddl.test.ts`         | Exclusion constraints apply against a real server, re-apply without work, and reject an overlap with SQLSTATE `23P01`.                             |
| `schema-extensions.test.ts`     | Generated DDL is guarded rather than unconditional (never a bare `DROP`/`ADD` pair), and unsafe names or elements are refused rather than escaped. |
| `migration-fingerprint.test.ts` | The fingerprint changes when the schema or migration history changes, and does not change because of the marker itself.                            |
| `vite-server-isolation.test.ts` | The isolated Vite server process does not instantiate client plugin factories.                                                                     |

Generated SQL is executed, not snapshotted. A snapshot proves the string is stable; only running it
proves it is correct.

## Not here

Whether the built runtime _works_ — that is proved by every suite that boots a template through
`bootPodRuntime`, which builds and migrates the workspace as its first step and fails the run if
either fails.
