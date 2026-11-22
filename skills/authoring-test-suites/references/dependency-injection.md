# Supplying dependencies

Use the subject's real seam: Effect `Context.Service` layers for I/O (`ports` on `TestWorkspace.layer`), plain inputs for pure functions.

- Replace only unavailable I/O, time or identity — never mock the authorization, parsing, or DB constraint being tested.
- Unexpected facilities must fail loudly (`t.fakes.links` fails on unscripted calls; unavailable layers fail instead of succeeding silently). Dispose scoped services on failure paths.
- Module mocking is last-resort only for import-time closures (`importOriginal`, import subject after mock, never mock the tested rule).
- Supply config via `ConfigProvider.fromUnknown`/`layer` (keep `process.env` in provider setup); pass explicit absent values when testing missing config; use synthetic credentials and assert masking at the real response boundary.
