# Rebuilding an existing application

The source defines behaviour to preserve, not framework or infrastructure to carry over.

## Private GitHub repository

1. First write `src/+secrets.ts` declaring `GITHUB_MCP_URL` and `GITHUB_MCP_TOKEN`, and `src/agent/mcp/+github.mcp.ts` with `description`, and `url` and `auth.bearer` naming those secrets.
2. Commit, diagnose, test, preview and merge; the person approves the merge.
3. `page { path, configure: { capability: 'mcp.configure', record: 'github' } }`, with `path` from `describe_workspace { names: ['system'] }`, opens the native sheet. The person sets the URL to `https://api.githubcopilot.com/mcp/` and a read token. Never ask for a value in chat.
4. The next turn offers the server's tools. If no token is possible, ask for a source archive.

## Establish what was read

- Verify access before promising a clone. A private repository's 404 does not prove absence.
- Use an authorized connector, the MCP server above, or a source archive. Never place a personal token in source, chat or a model.
- Record the source revision and whether access was direct or a snapshot.
- Inventory, then read README, routes, models, operations and tests. Follow pagination: a first window is not the repository.

## Coverage ledger

- Map each task and rule to its Bolt implementation and evidence: roles, transitions, numerical rules, reports, imports, exports, document review.
- Keep it in the goal tool across turns. Mark implemented, verified, deferred or blocked.
- Never turn a missing requirement into a platform difference without checking the capability.

Before authoring, pick a mechanism for every source capability: model and relationship; output and layer; guarded write, check, approval; page and task flow; representation; automation; file or remote sync; custom field vs kind vs JSON vs child; chart; team and policy; test; access and seed.

- A skipped category is a recorded decision with a reason. `workspace_merge` refuses a missing line or a bare skip.
- Access and seed is not prose: declare teams and policies that make pages usable, and seed the members they name. An app empty by permission is not a rebuild.
- Record why each model needs identity, lifecycle, permissions, history or relational queries. See [model-boundaries.md](model-boundaries.md).
- Discover native capabilities with `workspace_lang` by task; verify fit through types and behaviour; keep the mapping in the ledger.
- A generic record editor is not automatically the source's task flow; domain calculations are legitimate application code.

## Prove the real path

- Test the authored operation and its page's inputs, not only helpers: currency arithmetic, date boundaries, exact and over limits, denied roles, repeated imports, child edits under a locked parent.
- Use synthetic data with known values; scripted provider output for extraction.
- One business decision leaves no partial writes. Test that a refused child leaves everything unchanged.
- Typed JSON gives native fields; never make people paste raw JSON.
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
