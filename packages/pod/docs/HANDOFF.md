# Takeover: the Pod refactor

Written to be read cold. Two worktrees, one branch name, one goal: Core and OSS on the new standards,
transitional debt pruned, and the result actually working.

| Worktree                          | Repo                   | Branch                              | Base            |
| --------------------------------- | ---------------------- | ----------------------------------- | --------------- |
| `worktrees/pod-architecture`      | `norbital-ai/oss`      | `codex/pod-architecture-greenfield` | `origin/main`   |
| `worktrees/core-pod-architecture` | `norbital-ai/norbital` | `codex/pod-architecture-greenfield` | `origin/master` |

**Work only inside the worktrees.** Stage explicitly — `git add <paths>`, never `git add -A`. Two
incidents this session: a stray commit into the wrong repo, and 49k lines of a copied test workspace
swept into a commit. Both were caught and reverted, both were avoidable.

## The architecture in one page

> A workspace declares what it is. The host supplies what it needs. Pod owns everything in between.

- **Pod owns** authentication (sessions, invitations, login/code/accept-invite pages), collection ops,
  policy enforcement, approvals, audit, temporal history, sync, and now the agent loop.
- **The host supplies** facilities: `db`, `fileStorage`, `ai`, `maps`, `messaging`, `queue`,
  `integrationDelivery`. The set is closed — there is no authoring surface for a new one.
- **Core is one host**; `pod start` is another. The workspace bundle is identical; only `pod.host.ts`
  differs.
- Under Core a pod is **scale-to-zero serverless** (microsandbox child per tenant, 15-minute idle
  eviction, no network or timers in the isolate). Anything long-lived belongs to the host. Facility
  bindings cross that boundary by structured clone, so **they cannot carry callbacks** — that is why
  `integrationDelivery` and `HostQueue` live on the host config rather than in the bindings.

## What landed in OSS (109 commits)

**Security.** OTP verification was unbounded — `/login/code` never rate-limited while `POST /login`
handed the challenge cookie to whoever asked, for any address. Now five guesses, keyed by the challenge
digest, single-use enforced server-side. Sync no longer discloses `invitation` / `host_event_outbox`
(the replica DDL shipped `token_hash` column names; the stream leaked a per-row "an invitation was just
minted" oracle).

**Standalone was unusable and no test caught it.** Found by booting a template and driving it by hand:
`writeWebResponse` collapsed multi-`set-cookie` responses, so sign-in set no session at all. Plus a
hardcoded `Secure` on the challenge cookie, the app shell served before auth, and 303-to-HTML for API
callers. All fixed; the manual walkthrough now works end to end.

**Authoring.** Policies (`+<name>.policy.ts`) and channels (`+<name>.channel.ts`) are declarations,
discovered by filename. Generated unions (`CollectionName`, `PolicyName`, `AppName`, `AgentToolName`,
`ChannelName`) make cross-references compile-checked. Three silent-failure classes closed: misspelled
role directories, the object-form automation erasing `scope`, and system events nobody emits.

**Agent port, 6 steps.** `agent_run_step` retired; the loop stores `AiMessage` verbatim in
`chat_message.parts` so replay is a read, not a reconstruction. `chat_session.automation_run_id`
distinguishes an automation run from an interactive one — one transcript model, not two.

**Pruning.** ~15 dead exports, a dead context builder, a drifted duplicate permission block, duplicated
custom-type schemas.

## What is NOT done

1. ~~**Templates still get policies from Core's seed.** Only `crm` declares one.~~ **Done.** All five
   templates declare their own: 10 `+<name>.policy.ts` files, and each template's
   `.norbital/generated/authoring-types.ts` carries the `PolicyName` union built from them
   (`bca` 2, `construction` 3, `crm` 1, `hr-payroll` 3, `reclamation` 1). Core's
   `seed/<template>/steps/policies.ts` are deleted.
2. **Integrations work in both directions.** A `+integrations.ts` connection compiles into the
   manifest, an HTTP `send` reaches a real socket with the connection's credential resolved host-side,
   a `pull` binding runs on its schedule and lands rows, a `systemEvent` send reaches its matching
   `receive`, and a signed `webhook` delivery arrives on a listener the host owns and lands rows
   through the declared binding. All five are proven in
   `packages/pod/tests/standalone/integration-delivery-e2e.test.ts` and shown non-vacuous. What is
   still missing around webhooks is narrower than it was: signature schemes over anything but the raw
   body, replay windows, `events` narrowing, and any pruning of the inbound ledger. See D1b in
   [CORE_REFACTOR.md](./CORE_REFACTOR.md).
3. **Notifications, automations, and mutation hooks are proven.** `notification-e2e` drives the whole
   chain against real Postgres — a hook calls `sendNotification`, the in-app row and the outbox row
   land in one transaction, `workspaceJobs`' drain hands the delivery to the host's `messaging`
   binding over the private control plane, a refusal retries, and the row replicates to its
   recipient and to nobody else. The shell renders it (`runtime/notifications-menu.svelte`), live
   through the sync engine. `automation-hooks-e2e` covers create/update/delete and bulk variants,
   rollback, policy-gated approvals and withdrawals, lock release, stamp clearing, and hook timing
   against real Postgres.
4. **Channels route, thinly.** Inbound → agent under the declared policy → reply over the transport,
   proven end to end against real Postgres. Inbound is host-driven (`channels` on the host config),
   never a public route — Pod holds no transport credential and cannot verify a webhook. Telegram is
   built in over long polling. Core's archive, contact-linking, attachments, and batching are not
   ported; see B3 in [CORE_REFACTOR.md](./CORE_REFACTOR.md).
5. **Agent UI is one panel**, not Core's ~40 components. It reads its transcript from the replica
   now, so a reply from a channel or another tab appears without a refresh — which is proven by
   mounting the panel, not only by typechecking it. See **Rendering** below.
6. **Core has been migrated too**, in `worktrees/core-pod-architecture` (53 commits, 257 tests, 19
   svelte-check errors — measure Core's with `--tsconfig ./tsconfig.check.json`, never
   `./tsconfig.json`, whose `include: ["**/*"]` overrides the inherited one and, because TS globs skip
   dot-directories, drops `.svelte-kit/env.d.ts` and reports ~7425 phantom errors). Landed:
   Core-side inbound webhook and channel listeners calling Pod's own verifier over the
   `host-command` plane, replacing Core's parallel `IntegrationRuntime.ingestWebhook` — two dedupe
   authorities for one binding, of which Core's dropped `eventId` so every provider retry
   re-imported. Also: better-auth deleted and both tenant
   and ops sign-in rebuilt on Pod's `cookieSession` + `emailOtpIdentity`; roles migrated to
   `admin|advanced|basic`; policies reconciled at the migrate seam with the seed steps deleted; host
   plugins moved off a request header onto the `configure` frame; a `host-command` frame sender, so
   automations run at all — they had been POSTing a route that does not exist; the routing index; and
   the `ai` binding taught tool calling, which it had never supported. `apps/core/docs/POD_MIGRATION.md`
   is the reader-by-reader record, and `CORE_REFACTOR.md`'s checklist marks what is left.

   C6 is resolved. Core advertises Pod's `/agent` route and provides `HostAgentTool` implementations,
   one-turn inference, and encrypted channel credentials/listeners. Pod owns the loop, tool dispatch,
   sessions, runs, messages, channel conversations, UI, and every transcript row. Core's duplicate
   agent UI/routes/loop/system tables and the Durable Streams service are deleted. `live_object`
   remains only for Core's own host-plane activity; it is not an agent transcript transport.

## Rendering: what a component test here proves, and what it does not

`packages/pod` has a second vitest project, `components`, running in **happy-dom**. Both projects run
under one `pnpm vitest run`; the node project keeps its real Postgres and its serial execution
untouched. happy-dom rather than a browser runner because the alternative is a Playwright download and
a second test command, for three surfaces whose open questions are all about data flow.

The replica is faked at the live-query seam (`tests/support/fake-replica.svelte.ts`) rather than by
standing up a database. The fake answers **late** — the first load and every write afterwards are
delivered a turn after they are asked for — because a query that already holds its rows at mount would
let every assertion pass against a component that read once and never listened again, which is the
exact failure these three exist to rule out.

**Covered.**

- **Agent panel** (`tests/components/agent-chat-panel.test.ts`). The prompt appears before anything is
  awaited; the stored row replaces the echo instead of duplicating it; a failed send keeps the echo so
  the person can copy it; and a reply written by the loop, plus a turn sent from another tab, both
  appear with nothing touched locally. That last is the bug the panel was rewritten for.
- **Notification bell** (`tests/components/notifications-menu.test.ts`). The unread count is the
  replica's, including one raised while the menu was already open; marking all read issues one
  mutation per row and the count follows the replica back down rather than being cleared by the click;
  another recipient's notification never appears.
- **Host plugins in the sidebar** (`tests/components/system-navigation.test.ts`).
  `buildSystemNavigation` is mounted through the shell's own section component: an `adminOnly` entry is
  absent from the markup for a non-admin, `aria-current` follows the current path, and no plugins
  renders no section at all. `/studio-archive` is checked alongside `/studio/collections`, because a
  plain prefix match passes the first and quietly fails the second.

Each claim was checked by mutation: breaking the re-fire, the `where` filter, the `adminOnly` filter or
the active-path match fails exactly the tests that assert them, and nothing else.

**Not covered, and a DOM-only runner cannot cover it.**

- **Layout and CSS.** happy-dom computes no styles and no geometry. Nothing here would notice a popover
  rendering off-screen, a truncated label, an unreadable contrast ratio, or the sidebar's collapsed and
  expanded widths.
- **The accessibility tree.** The tests read `aria-label` and `aria-current` as attributes. What a
  screen reader announces, focus order, and whether the popover traps focus are not observed.
- **Real event semantics.** Clicks are dispatched, not performed — no hit testing, no pointer capture,
  no scrolling, no IME. `ResizeObserver` is a no-op stub and `@iconify/svelte` is stubbed so the suite
  does not fetch glyphs over the network.
- **The shell itself.** `pod-shell.svelte` is still mounted nowhere. The navigation test covers the
  section it feeds, not the shell's composition of it, and the manual standalone walkthrough remains
  the only thing that has run the whole page.

## Ground rules that earned their keep

- **Run it, don't just test it.** Four real bugs — including total auth failure — survived 262 green
  tests and died within minutes of a manual walkthrough.
- **A test that passes for the wrong reason is worse than none.** Two here did: a transcript-isolation
  test passed because the user owned no sessions (denied outright, proving nothing about filtering),
  and a negative type test "passed" against a grep for the wrong error string.
- **Don't ship what you cannot demonstrate.** Two type-level fixes were reverted after probes showed
  they changed nothing; the gap was documented instead.
- **Verify the environment before believing it.** "Docker unavailable" blocked work for most of a
  session; `podman machine start` fixed it on the first try.

## Running it

```bash
podman machine start                      # the test suite needs a Docker-compatible socket
pnpm packages:build && pnpm deps:sync     # injected template copies go stale silently
pnpm lint && pnpm vitest run --no-file-parallelism   # 432 passing, 0 skipped
```

Two rules the numbers depend on. Run the suite with `--no-file-parallelism`: the container-backed e2e
files contend for resources otherwise, and different ones fail each run. And never run `svelte-check`
concurrently with `oxlint` — that reports ~222 spurious "cannot find module" errors while the symlinks
are demonstrably intact, so a baseline taken that way is fiction.

**The two worktrees are coupled, and it looks like a flaky test.** The Core worktree resolves
`@norbital-ai/*` through symlinks into _this_ worktree's `packages/`, and `pnpm packages:build` runs
`rm -rf build && tsc`. So while a build is in flight here, Core's suite fails over there — on the same
commit, with nothing wrong. Observed in one sitting: 249/249, then 247 with 2 failures, then 222 with
6, then 249/249 again.

The tell is the **total**, not the failures: a changing test count means files failed to load, not that
assertions broke. `ERR_MODULE_NOT_FOUND` on `@norbital-ai/std/build/index.js` is the usual shape.
Check `ls packages/std/build` here, then re-run there. Do not go looking for a regression, and do not
take a Core baseline while a build is running in this worktree.

`pnpm deps:sync` is not optional: a rebuilt package is invisible to a template until it is
re-injected, so a correct change looks broken. (Templates resolve `@norbital-ai/*` through relative
links into `packages/`, not through physical copies — this file claimed copies for a long time.
Check with `ls -la template_workspaces/<t>/node_modules/@norbital-ai/` rather than trusting either
claim.)

**Never run `pnpm` with a working directory inside `template_workspaces/<name>`.** It triggers an
install that prunes that template's `node_modules/@norbital-ai/` entries, and then fails against
`npm.pkg.github.com`. The template is left resolving nothing, or — worse — silently falling through
to the hoisted copy at the repository root, so only some imports break.

The recovery is `pnpm deps:sync`, from the repository root. `pnpm install` does **not** fix it: the
lockfile has not changed, so pnpm answers "Already up to date" and repairs nothing, `--force`
included. `deps:sync` re-creates each declared entry as a relative link into `packages/`, then
verifies that every template can resolve everything it declares and fails loudly naming the template
and packages if not. It is idempotent, so running it when nothing is wrong costs nothing.

**`pnpm templates:lock:check` is not hermetic, and a failure there usually says nothing about your
change.** It resolves each template's `package.json` in a temp directory against the live registry and
diffs the result against the committed lockfile — but it copies _only_ `package.json`, leaving behind
the `pnpm-workspace.yaml` that carries the minimum-release-age gate. The committed lockfiles were
generated with that gate; the comparison is generated without it. So the check goes red the moment any
transitive dependency publishes, with no commit involved.

Observed inside a single session: all five templates reported `up to date`, and thirty minutes later
all five reported drift. The whole difference was `enhanced-resolve` 5.24.4 → 5.24.5, a third-party
patch release. Before believing this check, reproduce one template's resolve by hand and read the diff
— if the only delta is a version of something nobody here depends on directly, it is the gate, not you.

For a manual standalone run, copy a template into `.test-workspaces/` (**inside** the repo, so pnpm's
relative symlinks resolve), write a `pod.host.ts` with `emailOtp` + `consoleNotifications('email')` +
`secureCookies: false`, then `build`, `migrate`, `start`. The login code prints to the log.
