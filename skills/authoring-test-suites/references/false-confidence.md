# False confidence

Name the production edit that breaks each test; if removing the rule keeps it green, the test is hollow. Watch for:

1. **Early failure posing as refusal:** pair every denied/malformed case with an admitted case through the same route.
2. **Invented fixtures / projections:** validate fixtures against real declarations/vendor shapes and query a real database so omitted `fields` fail.
3. **Wiring over behaviour:** assert persisted rows, values, order or refusals — not just `toHaveBeenCalled()` or absence of an error.
4. **Duplicated logic:** drive the real compiled runtime with real identities, never a test-side copy of grants or math.
5. **Plausible emptiness & partial pages:** pair empty with populated cases; test beyond page boundaries; follow receipt IDs instead of scanning fake logs.
6. **Dead-code tests & unexecuted gates:** delete tests whose only caller is the test; check exit codes, globs and skips.
