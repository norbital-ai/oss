---
name: engineering
agent: true
authoring: true
description: General engineering practice for a workspace change.
---

1. Read the source and the authoring primer before writing; a contract card or reference only for what the primer leaves open. Do not guess an API when a type answers it.
2. Make the smallest complete change. No unasked feature, no abstraction without two real call sites, no dead model, page or field.
3. Write Effect code: bodies are function* and yield* their ctx Effects; helpers return Effects with typed failures; no Promise wrappers.
4. src/lib/<domain>/ holds reusable services. Logic a server body and a page both need lives there once and both import it. No lone file: a helper with one caller stays beside that caller.
5. Keep values in the form the platform already gives them; decode at the boundary once. Do not erase types or fabricate partial data.
6. Tests prove this workspace's own flows: which write its policies hold, for whom, and who approves. Never test what the platform already guarantees.
7. Finish the source, then verify in the primer's order: diagnosis and tests on the working tree, commit, preview. Report what failed and what you fixed.
8. When feedback says the result is wrong, remove or merge before adding. A larger diff is not progress.
