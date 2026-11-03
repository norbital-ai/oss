# Rebuilding an existing application

Use this for repository migrations and application rebuilds. The source defines the behaviour to preserve;
it does not require carrying its framework or infrastructure into Bolt.

## Private GitHub repository? Do this first

Write these two files as the first authoring action; do not query the declarations for them:

```ts
// src/+secrets.ts
import { secrets } from '@norbital-ai/bolt';
export default secrets({
	GITHUB_MCP_URL: { label: 'GitHub MCP server URL' },
	GITHUB_MCP_TOKEN: { label: 'GitHub token' }
});
```

```ts
// src/agent/mcp/+github.mcp.ts
import { mcp } from '@norbital-ai/bolt';
export default mcp({
	description: 'GitHub',
	url: 'GITHUB_MCP_URL',
	auth: { bearer: 'GITHUB_MCP_TOKEN' }
});
```

Validate, merge and have the person approve. Then `navigate { configure: { capability: 'mcp.configure', record: 'github' } }`
opens the native sheet; the person sets `GITHUB_MCP_URL` to `https://api.githubcopilot.com/mcp/` and
`GITHUB_MCP_TOKEN` to a token that can read the repository. Never ask for the value in chat. The next turn offers
`mcp__github__get_file_contents`, `search_code`, `list_commits` and `get_commit`. If no token is possible, ask for a
source archive instead.

## Establish what was read

Verify repository access before promising a clone. A private repository returning 404 does not prove it is absent.
Use an already authorized connector when the workspace has one; for a private GitHub repository, use the
GitHub MCP server above; otherwise request a source archive or snapshot. Never place a personal Git token in source,
a chat message or a readable configuration model. Record the source revision when provided and distinguish direct
repository access from an attached snapshot. Inventory the source, then read the README, routes, models, business
operations and existing tests. Follow supplied snapshots' file boundaries and pagination: an outline or the first
window is not the whole repository.

## Keep a coverage ledger

Map each user task and source rule to its Bolt implementation and evidence. Include roles, transitions, numerical
rules (currency, units, rounding, dates), reports/charts, imports/exports and document review. Use the existing
goal/checklist tool to retain the ledger across turns. Mark items implemented, verified, deferred or blocked;
do not turn a missing requirement into a platform difference without checking the installed capability.

### Capability pass (required)

Before authoring, list every source capability and choose its Bolt mechanism. At minimum: model/relationship;
read output and layer; guarded write, check and approval; page and task flow; representation/record sheet;
automation (a business operation with typed input, system identity and policies); file or remote sync (import,
export, template, periodic feed); custom field versus built-in kind versus typed JSON versus child model;
chart/summary; team/policy; test; access/seed. A category you skip is a recorded decision with a reason, never a
silent omission. If the rebuild has no automations, syncs, charts or representations, the ledger says why for each.
`access/seed` is not prose: declare the teams and policies that make the demo's pages readable and writable by its
people, and seed the members those policies name. An app whose every table is empty-by-permission is not a rebuild.
`workspace_merge` requires this ledger and refuses a missing category or a skip without a reason.

Before authoring a model, read [model-boundaries.md](model-boundaries.md) and record in the ledger why that
entity needs independent identity, lifecycle, permissions, history or relational queries. A source table or
screen noun is not a model by default. Put structured values, extraction results, per-parent rules and
configurable business variation in typed JSON, custom datatypes or runtime catalogue records. Fewer, richer
entities and runtime configuration absorb later requirements without a new page or model.

Before authoring each surface, discover the relevant native capabilities with `workspace_lang` over the installed declarations. Search by the user's task, inspect candidate symbols and their contracts, and record which native
capability covers each part and which domain behavior remains. Verify fit through types and behavior; a familiar
component name alone is not proof. Reuse a native control or facility when it satisfies the requirement instead of
porting the source application's infrastructure. Keep this mapping in the run's coverage ledger, not in a skill's
static catalogue.

An interface built from native controls can still be incomplete: a generic record editor is not automatically the
source's task flow. Conversely, domain calculations and business snapshots are legitimate application code.

## Prove the path users actually take

Test the authored operation and the inputs its page supplies, not only disconnected helper examples. Include
cross-currency arithmetic, date boundaries, exact/over limits, denied roles, repeated imports, and edits through
child relations when a parent is locked where those rules apply. Use synthetic data, with known expected values.
For extraction, use scripted provider output to test the confirmation boundary without spending live inference.
One business decision must not leave partial writes: use the existing atomic `ctx.act.many` for independent
related writes, or parent write layers for dependent children. Reordering separate acts does not make them atomic.
Test that a refused child change leaves the parent and the other records unchanged. Typed JSON shapes provide
structured native fields; do not make people paste raw JSON to review ordinary business values.
The native test kit is `@norbital-ai/bolt-cli/test`; read its `bolt-cli/test` docs namespace and the
`authoring-test-suites` skill for the supported TestWorkspace APIs.

The agent has scoped source tools and isolate-vm scripts, not a shell or Git command runner. Use the existing
Studio save/validate/diagnose/publish workflow. `workspace_validate` builds; `workspace_diagnose {}` runs the full
compiler/type check. A successful build does not establish type correctness. Author meaningful tests and execute them with workspace_test when
available. It is a fixed sandbox job, not arbitrary shell access. Inspect its parsed failures and exact tested commit;
Preview → Tests shows running, passed, failed and empty results. When the host offers no runner, state that execution
needs the operator and report their actual tested commit and result when supplied. A written
test file, workspace_validate or workspace_diagnose is not a test execution.
Keep native write-path tests when their harness fails. Report the failing command, revision and error; do not delete
them or replace them with helper-only tests. A financial workflow needs evidence from its real guarded writes and
automation inputs, including ownership, locked parents and child/reparenting paths. A read filter does not establish
write ownership. A state-looking enum or boolean does not establish an enforced lock. Verify currency conversion on
the values the chart actually queries, including missing FX and loading/error states, not only a helper's fixtures.
Then validate and inspect the actual preview at normal and narrow widths using `browser_navigate` to the preview when available:
charts and table views, all navigation destinations, long forms, scroll reachability, empty/loading/error states,
and workspace naming. No invented operational data to make a dashboard look populated; use preview fixtures only.
When a browser refuses a local/private address, retain its protection and report the blocked check for an operator.
End with completed, failed or blocked checklist states that match the evidence; do not leave a visual check spinning
after ending the run or request publication as though that check had passed.

Before requesting merge, compare the ledger against the source again. Report remaining gaps and separate build,
test and visual evidence. After approval, verify the published version and routes; a retired change preview is not
the live workspace. Do not claim full parity from a green build or a test count alone.
