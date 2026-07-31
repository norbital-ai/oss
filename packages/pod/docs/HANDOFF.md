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

## What landed in OSS (80 commits)

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

1. **Templates still get policies from Core's seed.** Only `crm` declares one. See the checklist in
   [CORE_REFACTOR.md](./CORE_REFACTOR.md).
2. **Integrations work in both directions, except inbound webhooks.** A `+integrations.ts` connection
   compiles into the manifest, an HTTP `send` reaches a real socket with the connection's credential
   resolved host-side, a `pull` binding runs on its schedule and lands rows, and a `systemEvent` send
   reaches its matching `receive`. All four are proven in
   `packages/pod/tests/standalone/integration-delivery-e2e.test.ts` and shown non-vacuous. A `webhook`
   binding still receives nothing — `pod start` warns; see D1b in [CORE_REFACTOR.md](./CORE_REFACTOR.md).
3. **Notifications are proven; automations and hooks are not.** `notification-e2e` drives the whole
   chain against real Postgres — a hook calls `sendNotification`, the in-app row and the outbox row
   land in one transaction, `workspaceJobs`' drain hands the delivery to the host's `messaging`
   binding over the private control plane, a refusal retries, and the row replicates to its
   recipient and to nobody else. The shell renders it (`runtime/notifications-menu.svelte`), live
   through the sync engine; that component's _rendering_ is unverified for want of a browser runner.
   Automations and hooks still have no manual end-to-end pass.
4. **Channels route, thinly.** Inbound → agent under the declared policy → reply over the transport,
   proven end to end against real Postgres. Inbound is host-driven (`channels` on the host config),
   never a public route — Pod holds no transport credential and cannot verify a webhook. Telegram is
   built in over long polling. Core's archive, contact-linking, attachments, and batching are not
   ported; see B3 in [CORE_REFACTOR.md](./CORE_REFACTOR.md).
5. **Agent UI is one panel**, not Core's ~40 components. It reads its transcript from the replica
   now, so a reply from a channel or another tab appears without a refresh. Rendering is unverified —
   no jsdom or browser runner in this package.
6. **Core has been migrated too**, in `worktrees/core-pod-architecture` (41 commits, 231 tests, 23
   svelte-check errors against `origin/master`'s own 43). Landed: better-auth deleted and both tenant
   and ops sign-in rebuilt on Pod's `cookieSession` + `emailOtpIdentity`; roles migrated to
   `admin|advanced|basic`; policies reconciled at the migrate seam with the seed steps deleted; host
   plugins moved off a request header onto the `configure` frame; a `host-command` frame sender, so
   automations run at all — they had been POSTing a route that does not exist; the routing index; and
   the `ai` binding taught tool calling, which it had never supported. `apps/core/docs/POD_MIGRATION.md`
   is the reader-by-reader record, and `CORE_REFACTOR.md`'s checklist marks what is left.

   Two conclusions there ran against expectation and are worth reading before revisiting them:
   `live_object` and `@durable-streams` are **not** superseded by Pod's sync — sync runs inside the
   tenant microVM over the _tenant_ database, and every consumer is a Core-plane surface over Core's
   _system_ database, which has no outbox. And Core's ~40 agent components are not deletable: that loop
   serves the **builder** agent over the sandbox, which stays in Core by design.

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
pnpm lint && pnpm vitest run --no-file-parallelism   # 371 passing, 0 skipped
```

Two rules the numbers depend on. Run the suite with `--no-file-parallelism`: the container-backed e2e
files contend for resources otherwise, and different ones fail each run. And never run `svelte-check`
concurrently with `oxlint` — that reports ~222 spurious "cannot find module" errors while the symlinks
are demonstrably intact, so a baseline taken that way is fiction.

`pnpm deps:sync` is not optional: templates resolve `@norbital-ai/*` through physical copies, so a
rebuilt package is invisible until it is re-injected — a correct change looks broken.

For a manual standalone run, copy a template into `.test-workspaces/` (**inside** the repo, so pnpm's
relative symlinks resolve), write a `pod.host.ts` with `emailOtp` + `consoleNotifications('email')` +
`secureCookies: false`, then `build`, `migrate`, `start`. The login code prints to the log.
