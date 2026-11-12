# APIs and execution

Page code receives `ctx` as a prop. Server bodies are Effect generators and call `yield* ctx.…`.
A click handler can `await ctx.query(...)`. Run other Effects with `run`, `fork` or `attach`
from `@norbital-ai/ui/effect`. Returned values retain their declared ids, decimals and dates.

| API                           | Page                | Write transform           | Policy verdict            | Automation           | Sync                          | Effect                 |
| ----------------------------- | ------------------- | ------------------------- | ------------------------- | -------------------- | ----------------------------- | ---------------------- |
| `query`                       | live / once         | `ctx.query`, workspace | `ctx.query`, workspace | its policies         | file: caller; remote: trusted | writer                 |
| `act`                         | yes                 | return sets and carried writes | none (returns a verdict) | yes                  | return changes                | writer                 |
| `run` / `schedule`             | `ctx.run`           | none                      | none                      | jobs / calls; schedule jobs | none                     | yes                    |
| `ai`                          | start an automation | none                      | none                      | infer, decide, embed | none                          | without extra tools    |
| `request`                     | none                | none                      | none                      | selected instance    | own instance                  | selected instance      |
| `send` / `notify`              | none                | none                      | none                      | yes                  | remote write                  | yes                    |
| `convert`                     | `preview_pdf`       | none                      | none                      | yes                  | file export document          | yes                    |
| `web`, `files`, `geo`          | upload / file_url   | none                      | none                      | yes                  | selected file facilities      | yes                    |
| `browser`                     | none                | none                      | none                      | run-scoped tab       | none                          | run-scoped tab         |
| `history`                     | yes                 | none                      | none                      | its policies         | none                          | writer                 |
| `approvals`, restore          | yes                 | none                      | none                      | none                 | none                          | none                   |
| `device`                      | yes                 | none                      | none                      | none                 | none                          | none                   |

Each guest invocation has 3 s cumulative CPU and 256 MiB heap. Ordinary bodies allow 40 facility
crossings; a write callback or policy check may cross at most 10 times. Automations allow 10,000 crossings, and
streamed progress refreshes the 20 s idle deadline of a host I/O response. CPU admission is
released while waiting for host I/O. Budgets apply per invocation, including each 1000-row write
chunk; business I/O belongs in an automation or remote sync, not a transform.

## query: live and once

```svelte
<script lang="ts">
	import type { Id } from '@norbital-ai/bolt';
	import type { PageContext } from '@norbital-ai/bolt/page';
	let { ctx, customer }: { ctx: PageContext; customer: Id<'customers'> } = $props();
	const day = ctx.clock('day');
	const open = $derived(
		ctx.query({
			orders: { where: { customer: { eq: customer }, status: { ne: 'shipped' } }, limit: 50 }
		})
	);
	// one read request: a root, its declared layers and a second root; then a pure src/lib helper
	const book = $derived(
		ctx.query({
			orders: { where: { due_on: { lt: day.today } }, fields: ['number', 'total', 'due_on'], party: { fields: ['name'] } },
			commercial_settings: { limit: 1 }
		})
	);
	const aging = $derived(book.current && ar_aging(book.current, day.today));
	async function export_open() {
		const snapshot = await ctx.query({ orders: { where: { status: { eq: 'placed' } } } });
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
`as_of` on the root (or `history(…, { at: { revision } })` for revisions), and an index search is
`query({ trials: { search: { colour: input }, limit: 20 } })`, its rows carrying `$distance`.

Server `query` exposes `ReadFailed` for recoverable read failures. Page reads also expose
`TransportFailed`. Historical revision changes retain their schema version and archived wire values;
they are not typed as today's row. Server history corruption remains an engine defect.

A read request is one nested JSON tree, the same on a page (`ctx.query({...})`), in server code
(`ctx.query({...})`), in a policy verdict (`ctx.query({...})`) and for the agent's `read` tool. Each
top-level key is a root with `outputs.default`, at most once per request. A root reads one of its
model's outputs (`output`, `default` when absent), which a held policy must grant; relation nodes
are nested under their parent, never dotted keys. A layer takes `where`,
`fields` (without it, every field the output's layer declares), `order_by`, `limit`, `search` and `aggregate`;
a root also takes `output`, `after` and `as_of`. `history(model, id, { output })` names one too. Unknown keys and options are refused. Every
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

Time is explicit: `ctx.clock('day').today` or `ctx.clock('minute' | 'hour').now` updates at that
grain, while server transforms and automations use invocation-bound `ctx.today`/`ctx.now`. Live clocks tick only while the page is visible;
`ctx.clock()` without a unit is a fixed page-opening snapshot.
Read predicates, including grant scopes, contain literal date/instant values, not clock operators.

## act and run

`yield* ctx.act({ 'orders.update': [{ target: order, set: { notes } }] })` plans one
atomic map of generated writes. Its successful output is keyed by the same callable names.
`create`, `update` and `delete` take batches; update and delete targets carry the observed row
and its revision. A transform may carry dependent rows into the same commit. Independent writes
that must commit together are entries in the same map. A runtime-indexed map crosses the same
strict native decoder. There are no `many` or `checked` variants.

A model with a declared `import_key` supports `import`: `{ rows, on_conflict, on_missing?, prune?,
dry_run? }`. It matches by that key, runs the ordinary per-verb callbacks in one transaction and
reports each row's resolution. `on_conflict` is `update`, `keep` or `refuse`; `on_missing` defaults
to `create` and may be `skip`. A dry run runs the callbacks and writes nothing. Imports own their
conflict policy; acts have none.

Pages, bodies and the test kit use this map contract. The agent's `act` tool accepts one
`{ callable, input }`, then uses that same native map decoder and commit path. A successful write
is `committed` or `pending_approval`; the latter carries `request_id` for the provisional write.
Handle `ActRefused`, `ActConflict` and `ActUnknown` through the typed failure channel. `key` supplies
explicit idempotency; a run retry may repeat earlier writes.

Business operations live in named automations with explicit typed inputs.

A write based on a previously read row carries its observed revision. The engine checks the revision before it commits. A transform can read workspace data and carry related rows into the same commit.

`ctx.run(name, input)` invokes a declared automation: server code gets a durable handle for a job
or the declared output for a call. On a page a job handle exposes `.id`, `.ids` and `.automation`;
yielding it confirms queue admission through the normal outcome, not completed execution. A page
call yields its output. `ctx.schedule(name, input, { at?, key? })` queues jobs after commit; a key
replaces queued work with that key. Use the runs catalogue for progress and result. An automation declares `policies` (at least one); every run executes as the reserved
system identity (`ctx.actor.kind === 'system'`) holding exactly them, whoever started it. The run
records who did as `sys_run.trigger`, read in the body as `ctx.run.trigger`: `{ kind: 'person', actor,
agent? }` for a manual start (`agent: { conversation }` when Norbius started it for them), else
`{ kind: 'system', cause }` — `cron`, `effect` (with the `model`, `verb` and `records` whose
effect scheduled it) or `schedule` (with `by`, the run whose code scheduled it). The trigger never
grants authority: `{ var: 'requestor.*' }` in a run names the system identity, so a requestor-scoped
grant matches nothing there and a ref's `requestor.id` default does not apply. Code that acts for its
starter checks the trigger explicitly — "a customer cancels only their own booking" reads the booking
and refuses unless its customer is `trigger.actor.party`. A policy's `capabilities.automations` grants manual starts
only (a person or the agent), with a quota of 30 starts per automation and starter per minute; code that
schedules needs no start grant. Automations cannot approve requests. The Command center's
Automations list and run detail show each run's trigger.

A model's `create.effect`, `update.effect` or `delete.effect` is the work that follows a committed write: a
durable run `<model>.effect.<verb>` per committed batch, queued by the write's own statement,
retried for over an hour on a transient failure and never rate limited. It receives changes with
`before`, `set`, `after` and `changed(...fields)` as the root fields of the writer's output of the
model (`default` when it holds it, else the first named output it holds) and runs as the writer —
the member, envoy, visitor or automation run (that run's policies) — holding no policy of its own,
with an automation's ctx (`EffectCtx`). An effect's writes run effects one level deeper; past 8 levels the
run is recorded failed with `depth`. The writer sees its effect run's status and error code; an
administrator sees its input. Approval-held write effects keep frozen changes and their original
writer until final approval releases them atomically; rejection discards them. Lifecycle moves
instead arrive with empty changes and `ctx.event.kind === 'approval'`. Cached calls have no starter
metadata and cannot write, send, notify or schedule.

## I/O and notices

Automations use `ctx.request(instance, operation)` and `ctx.send(instance, message)` through sealed
host links. Remote syncs request through their own instance. Decode provider answers once.

`ctx.send` returns the durable `sys_message` id after queue admission. An account that is not paired keeps the message
queued without spending provider attempts; connecting releases its queue, including after a host restart. Save that id
on the business record. With an explicit `sys_message` output grant, read its actual status and `sent_at` before marking
the business record Sent. Queue admission, an in-app notification and provider-id registration are separate from external
acceptance. Queued messages have no sent timestamp; an uncertain send must not be automatically sent again unless the
provider guarantees idempotency.

`ctx.browser` owns one tab for the run and carries no person's cookies. `navigate` and `snapshot`
answer `BrowserSnapshot`; `act` takes typed `BrowserStep` refs from that snapshot, `evaluate`
answers JSON, and `download(url, { for })` stores supported media. The tab closes when the run's
scope ends, including failure or interruption; `close` ends it early. Use `ctx.web.read(url)` for
page text that needs no interaction. The host must provide the browser facility; no fake or
source declaration proves live access to a target site.
`ai.sys_2.infer`, `ai.sys_1.decide` and `ai.embed` are automation facilities; inference progress is
described in [the runtime overview](./README.md#authoring-and-pages).

`ctx.ai.sys_1.decide({ state, questions })` batches independent questions into one call.
State accepts text, an object, or an array. Question instructions, Choice descriptions,
Score levels, and Noul true/false descriptions accept strings, objects, arrays, or null;
Noul criteria and question instructions may be omitted. Structured entries preserve
nested JSON values. Stored FileRefs must be resolved before calling System 1. Inline PNG/JPEG
evidence uses `{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } }`
in state; remote URLs are rejected. The adapter sends actual image parts/assets, never base64 as text.
The smart throttle prepares bounded images, voice transcripts, and extracted document/text content
before its one decision call, reusing the ingestion cache. Unreadable or truncated attachments cannot
be discarded as noise. Native audio is not a Jev input. Decision images are omitted from retained logs.

```ts
function* choose_filter(ctx: AutomationCtx) {
	const { answers } = yield* ctx.ai.sys_1.decide({
		state: { description: 'Show open jobs' },
		questions: {
			filter: {
				type: 'choice',
				instructions: { question: 'Which filter does `description` request?' },
				criteria: {
					open: { where: { status: { eq: 'open' } } },
					none: { where: null }
				}
			}
		}
	});
	return answers.filter.choice; // 'open' | 'none'; code selects that entry's where.
}
```

Choice returns the supplied option key and probabilities. Score returns its numeric
expected score, probabilities, and the selected structured level; Noul returns the
probability of true. Code composes the selected entries and validates the resulting
read filter. Structured criteria do not request arbitrary JSON Schema generation.
The `decisions_system_1` adapter uses Jev/OpenRouter's Decisions wire format;
`structured_system_1` implements the same contract over structured-output chat completions.
For OpenAI's native `/v1/decisions`, set `decisions_system_1`'s `format: 'openai'`
(or the Bolt server's System 1 provider to `openai-decisions`, with its full endpoint URL).
The adapter translates structured question entries to JSON text and normalizes native
predicate, choice and score answers back to this same Bolt contract.
Each decision also emits the retained `ai.call` resource record (`category: 'decisions'`): model,
provider call identity, input/output tokens, provider cost, elapsed time, request bytes and question count.
The detailed `decision.made` record remains separate. The host meters the provider call once as AI usage.

`ctx.notify` queues [notices](./notifications.md) from automations and per-verb effects.
[Documents](./documents.md) covers conversion, [Device](./device.md) covers browser resources.
`ctx.approvals.decide` and `ctx.restore.preview/run` apply current authority and approval locks;
see [approvals and restore](./README.md#approvals).

## Runtime AI administration

An administrator chooses allowed chat models and monthly spending limits in Settings → Organization. The settings live in `sys_config` under `agent` and apply at the next step without a source release. An empty allowed-model list permits the host catalogue; otherwise the first allowed model is the fallback when a conversation's choice is no longer allowed. The host resolves the `default` model class.

Source `workspace.ai` requires AI facilities and optionally names embedding models; it declares neither allowed chat models nor a chat default. Policy `limits.agent` still limits request rate. Monthly USD caps are separate runtime settings, including the workspace cap, the default member cap and per-policy member caps.
