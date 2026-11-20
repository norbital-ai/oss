# Rebuilding an existing application

The source defines behaviour to preserve, not framework or infrastructure to carry over.

## Read the source

1. For an attached source archive, use `read_file { id }` to list it and `read_file { id, path }` for each relevant entry. For a repository URL, call `reference { repository, ref }` once. Use the returned reference name with `read_file` for subsequent listings, searches and reads.
2. If `reference` returns `needs_connection`, open the native workspace GitHub integration setup. An administrator pairs a fine-grained token with Contents read access to the requested repository. Then retry the same reference. An attached archive also works when the person cannot pair a token. Keep credentials in the integration sheet.
3. Record the revision, skipped files and source of the snapshot. Follow the routes to forms, templates, permission checks, calculations and tests. Scope searches to the journey under test. Batch independent reads in `run_js` and return matching paths, symbols or short excerpts. Keep complete source files in the reference. Inspect relevant binary examples through their original attachments.

Keep counts reproducible. Archive listings count entries, search results count matching lines, and neither counts business rules. For a source inventory select distinct paths or domain keys in `run_js`. Read the total and continuation on each page. Use `workspace_grep { count: true }` for exact matching-line and file totals in the target workspace.

## Coverage ledger

- Trace each user journey from its entry point through input, validation, review, completion and history. Compare the visible fields, defaults, allowed choices, attachments and recovery actions for each role. Use the native controls in [ui-standard.md](ui-standard.md).
- Map each task and rule to its Bolt implementation and evidence: roles, transitions, numerical rules, reports, imports, exports, document review.
- Keep a short coverage ledger in the conversation. Record the source path, implementation, test result and remaining gaps as each journey closes. Use the ledger when preparing the merge summary.
- Never turn a missing requirement into a platform difference without checking the capability.

Inventory the modules and shared access rules once. For the journey being built, map its inputs, decisions, outputs and tests to Bolt before editing. Expand the ledger as each journey starts. The final ledger covers models and relationships, outputs and layers, guarded writes and approvals, pages, representations, automations, file and remote sync, field kinds and children, charts, teams, policies, tests and seed.

- A skipped category is a recorded decision with a reason. `workspace_merge` refuses a missing line or a bare skip.
- Access and seed is not prose: declare teams and policies that make pages usable, and seed the members they name. An app empty by permission is not a rebuild.
- Record why each model needs identity, lifecycle, permissions, history or relational queries. See [model-boundaries.md](model-boundaries.md).
- For each new module, finish one user journey through entry, completion, and a denied role before expanding its models. Map source approval steps and history to native policy approvals and the audit trail. For a role journey, sign in an invited test member with `t.sign_in(address)` and pass its authority to `t.as` so the test uses the team's declared policies. If a record names one decision-maker, test that person and a second member of the same team. Use a guarded decision on the record when a team-wide approval would admit that second member; keep subsequent team steps in the native approval flow.
- Discover native capabilities with `workspace_lang` by task; verify fit through types and behaviour; keep the mapping in the ledger.
- A generic record editor is not automatically the source's task flow; domain calculations are legitimate application code.

## Prove the real path

- Test the authored operation and its page's inputs, not only helpers: currency arithmetic, date boundaries, exact and over limits, denied roles, repeated imports, child edits under a locked parent.
- Use synthetic data with known values; scripted provider output for extraction.
- One business decision leaves no partial writes. Test that a refused child leaves everything unchanged.
- Typed JSON renders every declared property. When a source form varies by a selector, render only the active controls and validate the same discriminator in the guarded write. Change the selection in the real form and check which controls remain visible.
- Carry over the source choices, codes and conditional required fields. Test their actual values and meanings against the source, including distinctions that drive posting or access. Exercise a valid attachment and an incomplete submission as the operator.
- When one person has overlapping roles, test that person on both sides of the same record: their permitted personal submission, refused self-review, and a different eligible reviewer who can advance it.
- A financial workflow needs evidence from its guarded writes and automation inputs. A read filter does not establish write ownership. A state-looking enum does not establish a lock.
- Verify conversion on the values a chart really queries, including missing FX and loading and error states.
- Keep native write tests when their harness fails: report the command, revision and error.
- `workspace_test` runs the tests; read the result it sends back. A written test is not an execution.
- Inspect the preview at normal and narrow widths: navigation, long forms, scroll reachability, empty, loading and error states. Invent no operational data.
- A blocked browser check is reported, never marked passed.

## Before merge

- Compare the ledger to the source again; report gaps; separate build, test and visual evidence.
- After approval, verify the live Version and routes.
- Never claim parity from a green build or a test count.
