# APIs and execution

Page code imports `bolt` from `$bolt`. Server bodies are Effect generators and call `yield* ctx.…`.
A click handler can `await bolt.query(...)`; other Effects cross the page edge through `run`,
`fork` or `attach`. Returned values retain their declared ids, decimals and dates.

| API                           | Page                | Write callback            | Policy check              | Automation           | Sync                          | Notify                 |
| ----------------------------- | ------------------- | ------------------------- | ------------------------- | -------------------- | ----------------------------- | ---------------------- |
| `query`                       | live / once         | `ctx.db.query`, workspace | `ctx.db.query`, workspace | its policies         | file: caller; remote: trusted | workspace              |
| `act`                         | yes                 | return rows               | none (returns a verdict)  | yes                  | return changes                | none                   |
| `transaction`                 | none                | none                      | none                      | native session       | none                          | none                   |
| `start` / `schedule`          | `bolt.start`        | none                      | none                      | yes                  | none                          | none                   |
| `ai`                          | start an automation | none                      | none                      | infer, decide, embed | none                          | none                   |
| `request`                     | none                | none                      | none                      | selected instance    | own instance                  | none                   |
| `send` / `notify`             | none                | none                      | none                      | yes                  | remote write                  | notify returns notices |
| `convert`                     | yes                 | none                      | none                      | yes                  | file export document          | notice attachment      |
| `web`, `files`, `geo`         | upload / fileUrl    | none                      | none                      | yes                  | none                          | none                   |
| `approvals`, history, restore | yes                 | none                      | none                      | none                 | none                          | none                   |
| `device`                      | yes                 | none                      | none                      | none                 | none                          | none                   |

Each guest invocation has 3 s cumulative CPU and 256 MiB heap. Ordinary bodies allow 40 facility
crossings; a write callback or policy check may cross at most 10 times. Automations allow 10,000 crossings, and
streamed progress refreshes the 20 s idle deadline of a host I/O response. CPU admission is
released while waiting for host I/O. Budgets apply per invocation, including each 1000-row write
chunk; business I/O belongs in an automation or remote sync, not a transform.

## query: live and once

```svelte
<script lang="ts">
	import { bolt } from '$bolt';
	let { customer } = $props();
	const day = bolt.clock('day');
	const open = $derived(
		bolt.query({
			orders: { where: { customer: { eq: customer }, status: { ne: 'shipped' } }, limit: 50 }
		})
	);
	// one read request: a root, its declared layers and a second root; then a pure src/lib helper
	const book = $derived(
		bolt.query({
			orders: { where: { due_on: { lt: day.today } }, fields: ['number', 'total', 'due_on'] },
			'orders.party': { fields: ['name'] },
			commercial_settings: { limit: 1 }
		})
	);
	const aging = $derived(book.current && arAging(book.current, day.today));
	async function exportOpen() {
		const snapshot = await bolt.query({ orders: { where: { status: { eq: 'placed' } } } });
		// snapshot is a single decoded answer: snapshot.orders.rows
	}
</script>

{#if open.loading}<p>Loading…</p>{:else if open.current}
	{#each open.current.orders.rows as order (order.id)}<p>{order.number}</p>{/each}
{/if}
```

Reactive reads subscribe on first use, identical calls share a subscription, and the last reader
leaving releases it after a 30 s grace. Outside reactive code, await reads once. `yield*` composes
the same Query as an Effect. `aggregate` and `history` share those semantics. `query` takes only a
read request: one record is `query({ orders: { where: { id: { eq: id } } } })`, a past state is
`asOf` on the root (or `history(…, { at: { revision } })` for revisions), and an index search is
`query({ trials: { search: { colour: input }, limit: 20 } })`, its rows carrying `$distance`.

A read request is one JSON layer map, the same on a page (`bolt.query({...})`), in server code
(`ctx.query({...})`), in a policy check (`ctx.db.query({...})`) and for the agent's `read` tool. Each
key without a dot is a root (a model with `read`), at most once per request. A root reads one of its
model's outputs (`output`, `default` when absent), which a held policy must grant; `'<root>.<rel>…'`
is a layer of that output, and naming a deep path implies its parents. A layer takes `where`,
`fields` (without it, every field the output's layer declares), `orderBy`, `limit`, `search` and `aggregate`;
a root also takes `output`, `after` and `asOf`. `history(model, id, { output })` names one too. Unknown keys and options are refused. Every
list (a root page, or a nested many-layer per parent row) defaults to `limit` 10,000 and the root's
default order; the 4 MiB page budget still applies. The answer is a tree typed from the named
layers: per root `{ rows, next, total }` (`total` counts every row the root matches under the same
policy, `where` and text search, its `limit` and `after` aside, in the same statement and live with
the page; an index search root has none, and a nested many-layer none per parent), each row with its picked fields, a named ref layer in place of its
FK (the row or `null`) and a many-layer as its rows. The output fixes the fields; only the root's
policy filters the rows of the tree, and a user filter, a prefilter and the policy compose per key
(`where` AND, `limit` capped), so nothing widens the policy. Derive several views of one root on the client from
that one read.
An `aggregate` without `by` answers one row of the measures asked (`count: true` for a count); with
`by` it answers a page of buckets, each with its `key` and row `count` always, plus the other measures.

Time is explicit: `bolt.clock('day').today` or `bolt.clock('minute' | 'hour').now` updates at that
grain, while server transforms and automations use invocation-bound `ctx.today`/`ctx.now`. Live clocks tick only while the page is visible;
`bolt.clock()` without a unit is a fixed page-opening snapshot.
Read predicates, including grant scopes, contain literal date/instant values, not clock operators.

## act and start

`bolt.act('orders.update', [{ target: id, set: { notes } }])` uses the same typed callable catalogue
as `ctx.act`. A generated write (`create`, `update`, `delete`, `upsert`) always takes an array of
rows on every surface (pages, `ctx.act`, the HTTP act route, the agent's `act` tool and the test
kit), so the model's write callback sees the whole batch; a single-row object is refused
`invalidInput`. The agent's `act` takes one `{ callable, input }` per call; several different
callables are separate calls. Success is `committed` or `pendingApproval`; the latter is a provisional write held
by its request. Handle `ActRefused`, `ActConflict` and `ActUnknown` through the typed failure channel.
Carry the observed revision when I/O separates a read from a write.
Model writes expose only `create`, `update`, `delete` and keyed `upsert`. Use `ctx.act.many(...)`
for independent writes that must commit together, and the model's write layers (nested child rows)
for dependent creates.
Business operations live in named automations with explicit typed inputs.

For a read followed by dependent writes, use `ctx.transaction(function* (tx) { ... })`.
`tx.query` reads current model records or pages under the run's authority; `tx.act` applies
the same guarded create, update, upsert and delete verbs. Later reads see earlier writes.
No manual `observed` map is needed. Inner answers contain provisional `output` and `records`;
only the outer answer is `committed` or `pendingApproval`, and the held arm has no callback
output. Refusal or failure rolls the whole transaction back.

The native session has a fixed five-second deadline and requires PostgreSQL 17 or newer.
PGlite explicitly refuses this capability. The callback yields only transaction model reads
and guarded writes: no facilities, nested transactions, async callbacks, raw SQL or captured
outer ctx Effects. Prepare external data before entering it. The platform does not replay the
callback automatically.

`bolt.start(name, input)` starts an automation or file sync. `ctx.schedule(name, input, { at?, key? })`
queues after commit; a key replaces queued work with that key. Use the runs catalogue for progress
and result. An automation declares `policies` (at least one); every run executes as the reserved
system identity (`ctx.actor.kind === 'system'`) holding exactly them, whoever started it. The run
records who did as `sys_run.trigger`, read in the body as `ctx.run.trigger`: `{ kind: 'person', actor,
agent? }` for a manual start (`agent: { conversation }` when Norbius started it for them), else
`{ kind: 'system', cause }` — `cron`, `webhook`, `effect` (with the `model`, `verb` and `records` whose
effect scheduled it) or `schedule` (with `by`, the run whose code scheduled it). The trigger never
grants authority: `{ var: 'requestor.*' }` in a run names the system identity, so a requestor-scoped
grant matches nothing there and a ref's `requestor.id` default does not apply. Code that acts for its
starter checks the trigger explicitly — "a customer cancels only their own booking" reads the booking
and refuses unless its customer is `trigger.actor.party`. A policy's `automations` grants manual starts
only (a person or the agent), rate limited per starter by the automation's `limit`; code that
schedules needs no start grant. Automations cannot approve requests. The Command center's
Automations list and run detail show each run's trigger.

A model's `effect` (`created`, `updated`, `deleted`) is the work that follows a committed write: a
durable run `<model>.effect.<verb>` per committed batch, queued by the write's own statement,
retried 3 times on a transient failure and never rate limited. It receives the rows (`updated`:
`[{ before, after }]` for changes to a stored field) as the root fields of the writer's output of the
model (`default` when it holds it, else the first named output it holds) and runs as the writer —
the member, envoy, visitor or automation run (that run's policies) — holding no policy of its own,
with an automation's ctx (`EffectCtx`). An effect's writes run effects one level deeper; past 8 levels the
run is recorded failed with `depth`. The writer sees its effect run's status and error code; an
administrator sees its input.

## I/O and notices

Automations use `ctx.request(instance, operation)` and `ctx.send(instance, message)` through sealed
host links. Remote syncs request through their own instance. Decode provider answers once.
`ai.sys_2.infer`, `ai.sys_1.decide` and `ai.embed` are automation facilities; inference progress is
described in [the runtime overview](./README.md#authoring-and-pages).

`ctx.notify` accepts the same notices returned by [model notify callbacks](./notifications.md).
[Documents](./documents.md) covers conversion, [Device](./device.md) covers browser resources.
`bolt.approvals.decide` and `bolt.restore.preview/run` apply current authority and approval locks;
see [approvals and restore](./README.md#approvals).
