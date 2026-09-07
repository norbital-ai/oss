# @norbital-ai/test-utilities

The helpers every isolated suite boots with. Templates, Bolt, bolt-server and Colony each import
this package and nothing of each other; the rules are in the realm's `RFC/testing.md`.

| Export | Job |
| --- | --- |
| `withSelfHost`, `startSelfHostSession`, `guestCommand`, `jsonSqlParameter` | Boot a compiled template artifact on the bolt-server embedder with PGlite, run guest commands, stop and remove. |
| `startPglite` | A throwaway PGlite database for a suite. |
| `loadPublicSeed`, `PublicSeedBankPathError` | Load `tests/fixtures/seed/<collection>.json` through the production seeder's stages. Refuses any path under `seed_bank`. |
| `simpleWorkspace` | The blank workspace fixture Bolt and Colony suites run against. |
| `launchChromium`, `launchChromiumOrSkip`, `guestUrlForChromium`, `isHeadedRun`, `MissingChromiumError` | Playwright Chromium for headed rows (`PLAYWRIGHT_HEADED=1` to watch). The only browser driver; no suite boots Obscura. |
| `catalogAi`, `recordedAi`, `cassetteAi`, `cassetteTranscript`, `cassetteMessage`, `cassetteVerdict`, `readCassetteFile` | Model outputs replayed from JSON cassettes under each suite's `tests/assets/`; one live probe is recorded once with a key, suites replay offline. Cassettes carry provider outputs only, never the key. |
| `memoryFiles` | An in-memory `files` facility for seeds with `file()` columns. |
| `walkImportSpecifiers`, `importsMatching`, `specifiersInSource`, `specifierContainsPath`, `listFiles`, `SOURCE_EXTENSIONS` | The isolation walker each package's `architecture-isolation.test.ts` runs. |
| `postGuestCommand`, `systemHeaders`, `bearerHeaders`, `requireOk`, `requireAccepted`, `rowsOf`, `pageOf`, `mutationPush`, `mutationResolution`, `commandSentence`, `asRecord` | HTTP helpers for talking to a booted guest. |
| `authoredSeedStages`, `manifestSeedStages`, `requireReleaseBundle` | Read a template's release bundle and seed stages. |

Prohibitions this package enforces or expects: no private-bank I/O, no product template inside a
Bolt or Colony suite, no seeded outputs, no live provider as a default dependency.
