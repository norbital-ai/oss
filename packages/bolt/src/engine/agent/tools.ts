// The fixed tool set (rule 58): `query` (records, aggregates, search indexes, declared queries), `act` (guarded writes,
// approval decisions, automation and sync starts), the plan, goal and compaction tools, skills, `history`, `runs` (members), `logs` (administrators), `geocode`, `read_messages` on
// envoy turns, `read_attachment`, `read_output`, `docs` and `workspace_search` for staff,
// `document` when it binds a converter, `download` for staff in the app when files are stored, `run_js` (HTTP when a policy names `http`), `subagent` and `wait` under delegation, MCP tools a held policy's
// capabilities name (a sub-agent has no plan or sub-agents, and asks its delegating agent with `ask_parent`), and host tools (Workspace Studio, browser, personal skills) only on in-app turns of staff members. The catalogue lists only
// what the actor may invoke; every call runs as the actor, so a refusal is the engine's answer, never the agent's judgement.
import { Validator } from '@cfworker/json-schema';
import { Deferred, Effect, FiberMap, Option, Predicate, Schedule, Schema } from 'effect';
import * as EffectArray from 'effect/Array';
import type { Docs, Geo, LogsShape } from '../ports.ts';
import { Port, type PortFailure } from '../port.ts';
import type { EngineError } from '../errors.ts';
import { RUN_VIEW_COLUMNS, RunViewRow, runView } from '../runs/index.ts';
import { actorRef } from '../write/commit.ts';
import { readLog } from '../guest/telemetry.ts';
import { readableFile } from '../decisions/index.ts';
import type { Json } from '../../decl/values.ts';
import { encodeWire } from '@norbital-ai/std/wire';
import {
	CONVERT_MIME,
	type Authority,
	type Bindings,
	type Downloaded,
	type Outcome
} from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { AgentEngine as Engine } from './index.ts';
import { lowerRead } from '../query/engine.ts';
import { BOUNDS, bound, bounded, filesOf, localTime, outputText, page, size } from './context.ts';
import { MODEL_FILES } from './ai.ts';
import { REFERENCE, ReferenceIndex, RUN_JS, runFile, runJs } from './run-js.ts';
import { SKILL_FILE, type SkillSpec } from '../manifest.ts';
import { row as systemRow } from '../system/rows.ts';
import type { McpSessions, McpTool } from './mcp.ts';
import {
	ambient,
	authorOf,
	type ConversationRow,
	type Goal,
	type MessageRow,
	type Receipt
} from './schema.ts';
import { routesApproval } from '../approvals/lock.ts';
import type { StudioRole } from '../../shell/studio/model.ts';
export type { StudioRole };
/** What a host tool learns of its call: the person (a Studio draft is theirs), the conversation (its attachments), the key. */
export type HostToolContext = {
	actor: Authority['actor'];
	conversation: string;
	turn: string;
	callId: string;
	/** The person's latest message, when the turn has one (a search host ranks by it). */
	question?: string;
	/** An image the model sees on its next step (a screenshot). */
	attach(file: { mime: string; bytes: Uint8Array }): void;
	/** A file the host stored (a download), recorded as the person's and offered on the step; the model sees only its reference. */
	keep?(file: Downloaded): void;
};

/** A host capability (`capabilities.tools`): offered to staff members in the app only; `readOnly` ones also while planning. */
export type HostTool = {
	name: string;
	description: string;
	input: Json;
	readOnly?: boolean;
	studio?: StudioRole;
	call(input: Json, ctx: HostToolContext, signal: AbortSignal): Promise<Json>;
};
/** A skill the agent may read and whose scripts it may run: its tree's listing, and each file's bytes by its path. */
export type Skill = SkillSpec & {
	readonly read: (path: string) => Effect.Effect<Uint8Array, EngineError | PortFailure>;
};
/** Reads a message's file through the host; PDF and image bytes go to the model as file parts. */
export type AttachmentPort = {
	read(
		file: Json,
		as: 'text' | 'image' | 'sheet' | 'document',
		sheet?: number
	): Effect.Effect<
		| Json
		| {
				mime: string;
				bytes: Uint8Array;
		  },
		EngineError | PortFailure
	>;
};
/** The released workspace as built (`artifact/workspace/`): its source files. Every host binds it. */
export type WorkspacePort = {
	files(): Promise<readonly string[]>;
	read(path: string): Promise<string | null>;
};
/** Long work the model collects with `wait`: a host call past 30 s, a sub-agent. At most 10 minutes each. */
export const JOBS = { inlineMs: 30000, hostMs: 600000, waitMs: 600000 } as const;
type Jobs = Effect.Success<ReturnType<typeof jobs>>;
/** Every job is a child of the turn scope; collecting a job never detaches it. */
export const jobs = Effect.fn('AgentTool.jobs')(function* () {
	const fibers = yield* FiberMap.make<string, Json>();
	const all = new Map<
		string,
		{
			label: string;
			result: Deferred.Deferred<Json>;
			done: boolean;
		}
	>();
	return {
		add: Effect.fn('AgentTool.jobAdd')(function* (
			label: string,
			work: Effect.Effect<Json, EngineError | PortFailure>
		) {
			const id = globalThis.crypto.randomUUID().slice(0, 8),
				result = yield* Deferred.make<Json>();
			const item = { label, result, done: false };
			all.set(id, item);
			yield* FiberMap.run(
				fibers,
				id,
				work.pipe(
					Effect.catch((error) => Effect.succeed({ error: error.message })),
					Effect.tap((value) => Deferred.succeed(result, value)),
					Effect.tap(() =>
						Effect.sync(() => {
							item.done = true;
						})
					)
				)
			);
			return id;
		}),
		wait: Effect.fn('AgentTool.jobWait')(function* (ids: readonly string[], ms: number) {
			const open = [...all].filter(([id]) => ids.length === 0 || ids.includes(id));
			if (open.length === 0) return null;
			const got = yield* Effect.raceAll(
				open.map(([id, item]) => Deferred.await(item.result).pipe(Effect.as(id)))
			).pipe(Effect.timeoutOption(ms));
			if (Option.isNone(got)) return null;
			const item = all.get(got.value);
			if (item === undefined) return null;
			const result = yield* Deferred.await(item.result);
			all.delete(got.value);
			return { job: got.value, label: item.label, result };
		}),
		pending: () => [...all].map(([id, item]) => ({ job: id, label: item.label, done: item.done })),
		has: (id: string) => all.has(id)
	};
});
export type ToolContext = {
	engine: Engine;
	conv: ConversationRow;
	authority: Authority;
	bindings: Bindings;
	turn: string;
	mode: 'agent' | 'plan';
	/** The person's own IANA zone when their client sent one (their clock, rule 57). */
	tz?: string | undefined;
	/** The person's latest message (`HostToolContext.question`). */
	question?: string | undefined;
	/** Envoy turns have no confirmation card: `confirm` executes directly there (§3.9). */
	inApp: boolean;
	delegation: boolean;
	/** A sub-agent's turn: no plan of its own and no sub-agents (one level deep); it keeps its own checklist. */
	child: boolean;
	mcp: McpSessions;
	/** The host's runtime log (`logs`, `automation_runs { id }`). */
	logs: LogsShape;
	mcpTools: readonly McpTool[];
	hostTools: readonly HostTool[];
	attachments?: AttachmentPort | undefined;
	workspace?: WorkspacePort | undefined;
	/** The author's Studio draft (`workspace_search { draft: true }`); absent when this person authors nothing here. */
	draft?: WorkspacePort | undefined;
	geocoder?: Geo['Service'] | undefined;
	/** This release's API reference (the host's `Docs`). */
	docs?: Docs['Service'] | undefined;
	skills: { readonly [name: string]: Skill };
	agents: readonly string[];
	receipts: Receipt[];
	files: {
		mime: string;
		bytes: Uint8Array;
	}[];
	jobs: Jobs;
	inlineMs?: number | undefined;
	setPlan(body: string): Effect.Effect<void, EngineError>;
	setGoals(goals: Goal[]): Effect.Effect<void, EngineError>;
	compact(reason: string): boolean;
	/** A sub-agent's question for its delegating agent: its turn ends on it, and the delegating agent's `message` resumes it. */
	ask(question: string): void;
	/** An instance's history: `unread` = ambient rows not yet read, oldest first, marked read by `key`; else newest first before `before`. */
	messages(o: {
		unread: boolean;
		limit: number;
		before?: number;
		key: string;
	}): Effect.Effect<readonly MessageRow[], EngineError>;
	row(seq: number): Effect.Effect<MessageRow | undefined, EngineError>;
	/** The whole output of a clipped call; `null` names the latest clipped call. */
	output(callId: string | null): Effect.Effect<Json | undefined, EngineError>;
	history(query: string, scope: 'this' | 'mine', limit: number): Effect.Effect<Json, EngineError>;
	subagent: {
		spawn(task: string, agent: string | null): Effect.Effect<Json, EngineError>;
		list(): Effect.Effect<Json, EngineError>;
		read(conversation: string): Effect.Effect<Json, EngineError>;
		message(conversation: string, text: string): Effect.Effect<Json, EngineError>;
		stop(conversation: string): Effect.Effect<Json, EngineError>;
		/** How many of this conversation's sub-agents are working. */
		running(): Effect.Effect<number, EngineError>;
		/** Whether a sub-agent's report arrived here within `ms`. */
		report(ms: number): Effect.Effect<boolean, EngineError>;
	};
};
/** `confirm`: an in-app call the person must approve first; it executes later under key `(turn, callId)`. */
/** `bounded`: the tool already bounded its result with the caller's selection (rule 62), so the loop does not clip it again. */
type ToolAnswer =
	| {
			result: Json;
			bounded?: true;
	  }
	| {
			confirm: true;
	  };
export type Tool = {
	name: string;
	description: string;
	input: Schema.Top;
	studio?: StudioRole;
	/** Its answer depends only on its arguments within a turn: the same call again straight after is not run. */
	pure?: true;
	run(input: unknown, callId: string): Effect.Effect<ToolAnswer>;
};
/** Filter operators supported by period fields (`…_range`). */
const PERIODS =
	"A period field (effective_range and the like) takes contains: a date (today's date from Now: in force today), or overlaps / within: { from, to } (to null is open).";
/** JSON tool parameters spell every value kind so model routers retain arrays and records. */
const ToolJson: Schema.Codec<Json> = Schema.suspend(() =>
	Schema.Union([
		Schema.Null,
		Schema.Boolean,
		Schema.Number.check(Schema.isFinite()),
		Schema.String,
		Schema.Array(ToolJson),
		Schema.Record(Schema.String, ToolJson)
	])
).annotate({ identifier: 'ToolJson' });
/** `act { actions }`: at most this many writes in one call. */
const BATCH = 20;
export const ReadInput = Schema.Struct({
	collection: Schema.optionalKey(Schema.String.annotate({ description: 'collection' })),
	id: Schema.optionalKey(Schema.String.annotate({ description: 'one record' })),
	where: Schema.optionalKey(
		Schema.Record(Schema.String, ToolJson).annotate({ description: 'filter' })
	),
	select: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Union([Schema.Boolean, Schema.Record(Schema.String, ToolJson)])
		).annotate({
			description:
				'fields: { field: true }; relation: { relation: { select: { field: true } } }; inverse many-relation: { children: { select: { field: true }, limit: 5 } }'
		})
	),
	orderBy: Schema.optionalKey(
		Schema.Union([
			Schema.String,
			Schema.Record(Schema.String, ToolJson),
			Schema.Array(ToolJson)
		]).annotate({
			description:
				'order: a field, { field: "asc" | "desc" }, a related field through one-relations (at most two hops) as { relation: { field: "asc" } }, or a list of up to 4 of these'
		})
	),
	search: Schema.optionalKey(
		Schema.Union([Schema.String, Schema.Record(Schema.String, ToolJson)]).annotate({
			description:
				'text search; or { index: input } for a declared search index; or { semantic: text | { record: id } }'
		})
	),
	limit: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
	after: Schema.optionalKey(Schema.String.annotate({ description: 'cursor' })),
	aggregate: Schema.optionalKey(
		Schema.Struct({
			count: Schema.optionalKey(Schema.Boolean.annotate({ description: 'count the rows' })),
			sum: Schema.optionalKey(
				Schema.Array(Schema.String).annotate({ description: 'numeric fields to total' })
			),
			avg: Schema.optionalKey(
				Schema.Array(Schema.String).annotate({ description: 'numeric fields to average' })
			),
			min: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: 'fields' })),
			max: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: 'fields' })),
			by: Schema.optionalKey(
				Schema.Union([
					Schema.String,
					Schema.Record(Schema.String, ToolJson),
					Schema.Array(ToolJson)
				]).annotate({
					description:
						'group by: a field name, { day | week | month | quarter | year: dateField } for time buckets, or a list of these'
				})
			)
		})
	),
	asOf: Schema.optionalKey(
		Schema.String.annotate({ description: 'an instant: the record as it was (with id)' })
	),
	query: Schema.optionalKey(
		Schema.String.annotate({
			description:
				'collection.query to run instead of a read; with collection, the short query name also works'
		})
	),
	input: Schema.optionalKey(
		Schema.Record(Schema.String, ToolJson).annotate({ description: 'the query input' })
	)
});
type ReadInput = typeof ReadInput.Type;
export const WriteInput = Schema.Struct({
	callable: Schema.optionalKey(
		Schema.String.annotate({
			description: 'collection.verb, approvals.decide, automation.<name> or collection.sync.<sync>'
		})
	),
	input: Schema.optionalKey(ToolJson.annotate({ description: 'the input the callable accepts' })),
	inputFile: Schema.optionalKey(
		Schema.String.annotate({
			description: 'instead of input: the id of a JSON file of yours; its contents are the input'
		})
	),
	actions: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				callable: Schema.String,
				input: Schema.optionalKey(ToolJson)
			})
		)
			.check(Schema.isMaxLength(BATCH))
			.annotate({ description: 'several writes, in order' })
	)
});
/** A tool aggregate as the read API takes it: grouped (`by`) states its page, the tool's limit when the model gave none. */
const groups = (aggregate: Json, limit: number, where: Json | undefined): Json => {
	if (!Predicate.isObject(aggregate)) return aggregate;
	return {
		...aggregate,
		...(aggregate['by'] !== undefined &&
		aggregate['limit'] === undefined &&
		aggregate['all'] === undefined
			? { limit }
			: {}),
		...(where === undefined ? {} : { where })
	};
};
const ok = (result: Json): ToolAnswer => ({ result });
/** A JSON value within `bytes` as the model reads it, or its leading text with a note. */
const clipJson = (v: Json, bytes: number): Json =>
	size(v) <= bytes ? v : `${JSON.stringify(v).slice(0, bytes)}... [clipped, ${size(v)} bytes]`;
/** `runs { id }`: the run's latest log lines. */
const RUN_LOG_LINES = 100;
const err = (
	message: string
): {
	result: Json;
} => ({ result: { error: message } });
const VERBS = ['create', 'update', 'delete', 'upsert'] as const;
/** `act`'s callable for a decision on an approval request (`bolt.approvals.decide`). */
const APPROVE = 'approvals.decide';
const Decide = Schema.Struct({
	requestId: Schema.String,
	decision: Schema.Literals(['approve', 'reject', 'requestChanges']),
	reason: Schema.optionalKey(Schema.String)
});
/** `act { callable: 'automation.<name>' }` starts an automation now; `<collection>.sync.<sync>` runs a sync now. */
const AUTOMATION = 'automation';
/**
 * Every sync a run starts, by its startable name (`<collection>.sync.<sync>`): a remote sync's read (`{}`), or a file
 * sync's import or export.
 */
const syncsOf = (m: Engine['manifest']) =>
	new Map<string, { readonly collection: string; readonly file: boolean }>(
		Object.entries(m.collections).flatMap(([c, spec]) =>
			Object.entries(spec.syncs ?? {}).flatMap(([s, x]) =>
				x.with === 'file' || x.read === true
					? [[`${c}.sync.${s}`, { collection: c, file: x.with === 'file' }] as const]
					: []
			)
		)
	);
type Spec = {
	agent?: 'direct' | 'confirm' | 'never';
	description?: string;
};
/** `---\ndescription: …\n---` then `##` sections. */
function skillOf(text: string): {
	description: string;
	body: string;
	sections: string[];
} {
	const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const description = fm === null ? '' : (/^description:\s*(.*)$/m.exec(fm[1]!)?.[1] ?? '').trim();
	const body = fm === null ? text : text.slice(fm[0].length);
	return {
		description,
		body,
		sections: [...body.matchAll(/^##\s+(.+)$/gm)].map((x) => x[1]!.trim())
	};
}
function section(body: string, title: string): string | undefined {
	const parts = body.split(/^(?=##\s)/m);
	return parts.find(
		(p) =>
			p
				.replace(/^##\s+/, '')
				.split('\n')[0]!
				.trim()
				.toLowerCase() === title.toLowerCase()
	);
}
/** What the actor may use, by collection: generated verbs and queries offered to the agent (rules 33a, 58). */
function callablesFor(
	e: Pick<Engine, 'manifest'>,
	a: Authority
): {
	reads: string[];
	acts: Map<string, Spec>;
	queries: Map<string, Spec>;
} {
	const m = e.manifest;
	const reads: string[] = [],
		acts = new Map<string, Spec>(),
		queries = new Map<string, Spec>();
	for (const [c, spec] of Object.entries(m.collections)) {
		const ca = a.collections[c];
		if (a.admin || (ca?.read.length ?? 0) > 0) reads.push(c);
		for (const v of VERBS) {
			const arms =
				v === 'upsert'
					? (ca?.create.length ?? 0) && (ca?.update.length ?? 0)
					: (ca?.[v].length ?? 0);
			const declared =
				v === 'upsert'
					? spec.create !== undefined && spec.update !== undefined
					: (
							spec as {
								[k: string]: unknown;
							}
						)[v] !== undefined;
			if (declared && (a.admin || arms > 0)) acts.set(`${c}.${v}`, { agent: 'direct' });
		}
		for (const [n, q] of Object.entries(spec.queries ?? {}) as [string, Spec][])
			if (q.agent !== 'never' && (a.admin || (ca?.queries ?? []).includes(n)))
				queries.set(`${c}.${n}`, q);
	}
	for (const c of Object.keys(a.collections))
		if (c.startsWith('sys_') && !reads.includes(c) && a.collections[c]!.read.length > 0)
			reads.push(c);
	// a decision on a pending approval: the approvals engine admits only the step's approvers; the person confirms in the app
	if (mayDecide(m, a))
		acts.set(APPROVE, {
			agent: 'confirm',
			description:
				'decide a pending approval: { requestId, decision: approve | reject | requestChanges, reason? } (a reason for reject and requestChanges)'
		});
	return { reads, acts, queries };
}
/**
 * A member who may decide some approval: a staff member of a workspace whose grants route writes to approval. A flow
 * names its approvers (teams or members) per request, so the engine judges each decision.
 */
function mayDecide(m: Engine['manifest'], a: Authority): boolean {
	return (
		a.actor.kind === 'member' &&
		!a.actor.external &&
		Object.values(m.policies).some((policy) => Object.values(policy.grants).some(routesApproval))
	);
}
/** The fields the actor may read: the union of its read arms' fields (rule 14); a masked field is not described. */
function visible(a: Authority, c: string, fields: readonly string[]): readonly string[] {
	const arms = a.collections[c]?.read ?? [];
	if (a.admin || arms.length === 0 || arms.some((x) => x.fields === 'all')) return fields;
	const allowed = new Set(arms.flatMap((x) => (x.fields === 'all' ? [] : x.fields)));
	return fields.filter((f) => allowed.has(f));
}
/** The step's facts, in the closing note (never the prompt, which is static): the time and whom the turn acts for. */
export function turnFacts(e: Engine, a: Authority, b: Bindings, tz?: string): string {
	const x = a.actor,
		person = x.kind === 'member' ? x : x.kind === 'envoy' ? x.linked : undefined,
		wtz = e.manifest.workspace.tz;
	const who =
		x.kind === 'envoy'
			? `envoy ${x.envoy} on ${x.instance} for ${x.sender}${person === undefined ? '' : `, linked to ${person.email ?? person.id} (member id ${person.id})`}`
			: person === undefined
				? x.kind
				: `${person.email ?? person.id} (member id ${person.id})${person.teamPath.length > 0 ? ` (${person.teamPath.join(' › ')})` : ''}${person.external ? ', external' : ''}`;
	return (
		`Now: ${localTime(b.now, wtz)} (${wtz}, ${b.now})${tz === undefined || tz === wtz ? '' : `; theirs ${localTime(b.now, tz)} (${tz})`}. ` +
		`You act for ${who}${a.admin ? ', an administrator' : ''}; policies ${a.policies.join(', ') || 'none'}.`
	);
}
function receipt(callable: string, o: Outcome): Receipt | null {
	if (o.kind === 'committed')
		return {
			outcome: 'committed',
			callable,
			records: o.records.map(({ collection, id }) => ({ collection, id }))
		};
	if (o.kind === 'pendingApproval')
		return {
			outcome: 'pendingApproval',
			callable,
			requestId: o.requestId,
			records: o.records.map(({ collection, id }) => ({ collection, id }))
		};
	return null;
}
const perform = Effect.fn('AgentTool.perform')(function* (
	x: Pick<ToolContext, 'engine' | 'authority' | 'bindings' | 'turn' | 'receipts'>,
	callable: string,
	input: Json,
	callId: string
) {
	if (callable === APPROVE) {
		const d = Option.getOrUndefined(Schema.decodeUnknownOption(Decide)(input));
		if (d === undefined)
			return {
				error: `${APPROVE} takes { requestId, decision: approve | reject | requestChanges, reason? }`
			};
		return encodeWire(
			yield* x.engine.approvals.decide({
				...d,
				authority: x.authority,
				now: x.bindings.now
			})
		);
	}
	// a sync is its collection's (`<c>.sync.<s>`), run as the platform run of that name
	const started = callable.startsWith(`${AUTOMATION}.`)
		? callable.slice(AUTOMATION.length + 1)
		: syncsOf(x.engine.manifest).has(callable)
			? callable
			: null;
	if (started !== null) {
		const automation = started,
			args = input ?? {};
		if (
			callable.startsWith(`${AUTOMATION}.`) &&
			x.engine.manifest.automations[automation]?.agent === 'never'
		)
			return { error: `You may not run '${callable}'.` };
		// the same automation over the same input, queued or running, is that run: a model asking again must not queue a
		// second one (a local probe started one review three times while the first placed 426 photos)
		const [active] = yield* x.engine.db.read([
			{
				text: `SELECT id FROM sys_run WHERE automation = $1 AND state IN ('queued', 'running')
			AND input = $2::jsonb ORDER BY due_at LIMIT 1`,
				params: [automation, JSON.stringify(args)]
			}
		]);
		const existing = active?.rows[0]?.['id'];
		if (typeof existing === 'string') return { run: existing, alreadyActive: true };
		const run = globalThis.crypto.randomUUID();
		const outcome = yield* x.engine.calls.start({
			automation,
			runs: [{ id: run, input: args }],
			authority: x.authority,
			bindings: x.bindings
		});
		// This receipt commits the queue admission; the run records its business result after execution.
		const rc = receipt(callable, outcome);
		if (rc !== null) x.receipts.push(rc);
		return { run, outcome: encodeWire(outcome) };
	}
	const dot = callable.lastIndexOf('.');
	const [collection, name] = [callable.slice(0, dot), callable.slice(dot + 1)];
	const common = {
		authority: x.authority,
		bindings: x.bindings,
		invocationId: `${x.turn}:${callId}`,
		key: `agent:${x.turn}:${callId}`,
		issuedAt: x.bindings.now
	};
	// an upsert updates the record its row's id names (rule 28); a model that wrote `onConflict` into the row means the option
	const row =
		name === 'upsert' && Predicate.isObject(input)
			? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'onConflict'))
			: input;
	const onConflict =
		name === 'upsert' && Predicate.isObject(input) && input['onConflict'] === 'keep'
			? 'keep'
			: 'update';
	if (!Schema.is(Schema.Literals(VERBS))(name))
		return {
			error: `There is no generated write '${callable}'. Start a declared automation for a workflow.`
		};
	const r = yield* x.engine.act({
		...common,
		mode: { _tag: 'Direct' },
		collection,
		verb: name,
		input: name === 'upsert' && !Array.isArray(input) ? row : input,
		...(name === 'upsert' ? { onConflict } : {})
	});
	const rc = receipt(callable, r.outcome);
	if (rc !== null) x.receipts.push(rc);
	if (r.outcome.kind !== 'committed' || name === 'delete') return encodeWire(r.outcome);
	const reads = r.outcome.records
		.filter((c) => c.collection in x.engine.manifest.collections)
		.slice(0, 20);
	const stored =
		reads.length === 0
			? []
			: yield* x.engine
					.read(
						reads.map((c) => lowerRead(x.engine.manifest, 'get', [c.collection, c.id])),
						{ as: 'caller', authority: x.authority },
						x.bindings
					)
					.pipe(
						Effect.tapCause(Effect.logWarning),
						Effect.catch(() => Effect.succeed([]))
					);
	// the event runs this write queued carry its record ids (`queueTriggered`): answer them, so the model can `wait` on one
	const ids = r.outcome.records.map((c) => c.id);
	const [queued] =
		ids.length === 0
			? [undefined]
			: yield* x.engine.db
					.read([
						{
							text: `SELECT id, automation FROM sys_run
		WHERE state IN ('queued', 'running') AND cause IN ('created', 'updated', 'deleted')
		AND input -> 'ids' ?| ARRAY(SELECT jsonb_array_elements_text($1::jsonb))`,
							params: [JSON.stringify(ids)]
						}
					])
					.pipe(
						Effect.tapCause(Effect.logWarning),
						Effect.catch(() => Effect.succeed([undefined]))
					);
	const runs = (queued?.rows ?? []).map((row) => ({
		run: String(row['id']),
		automation: String(row['automation'])
	}));
	return { ...r.outcome, stored: encodeWire(stored), ...(runs.length === 0 ? {} : { runs }) };
});
/** `act`'s writes: one `{ callable, input }`, or `actions` of them. */
export const writesOf = (input: typeof WriteInput.Type): { callable: string; input: Json }[] =>
	(input.actions ?? [{ callable: input.callable ?? '', input: input.input ?? null }]).map(
		(write) => ({ callable: write.callable, input: write.input ?? null })
	);
/**
 * Runs `act`'s writes in order, each under its own key (`callId`, then `callId#1`, …), stopping at the first that does
 * not commit or await approval: a later write may depend on it. One write answers its outcome as before.
 */
export const performAll = Effect.fn('AgentTool.performAll')(function* (
	x: Parameters<typeof perform>[0],
	writes: readonly {
		callable: string;
		input: Json;
	}[],
	callId: string
) {
	const results: Json[] = [];
	for (const [n, w] of writes.entries()) {
		const r = yield* perform(x, w.callable, w.input, n === 0 ? callId : `${callId}#${n}`);
		results.push(r);
		const kind = Predicate.isObject(r) ? r['kind'] : undefined;
		if (kind !== 'committed' && kind !== 'pendingApproval' && kind !== 'decided') {
			if (writes.length > 1 && n < writes.length - 1)
				return {
					results,
					stopped: `write ${n + 1} did not commit; the ${writes.length - n - 1} after it did not run`
				};
			break;
		}
	}
	return writes.length === 1 ? results[0]! : { results };
});
const attach = (
	files: {
		mime: string;
		bytes: Uint8Array;
	}[],
	file: {
		mime: string;
		bytes: Uint8Array;
	}
): number => {
	if (file.bytes.byteLength > MODEL_FILES.bytes) return 1;
	files.push(file);
	let dropped = 0;
	while (
		files.length > MODEL_FILES.count ||
		files.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) > MODEL_FILES.bytes
	) {
		files.shift();
		dropped++;
	}
	return dropped;
};
const guard = (
	work: Effect.Effect<ToolAnswer, EngineError | PortFailure>
): Effect.Effect<ToolAnswer> =>
	work.pipe(Effect.catch((error) => Effect.succeed(err(error.message))));
/** Effect has no importer for active JSON Schema conditionals; the ABI validator keeps their meaning. */
const runtimeInput = (json: Json) => {
	if (!Predicate.isObject(json))
		throw BoltError.make('invalidSpec', 'decode', 'a tool input schema must be an object');
	const validator = new Validator(json, '2020-12', false);
	return Schema.Json.check(
		Schema.makeFilter<Json>(
			(value) => {
				const checked = validator.validate(value);
				return (
					checked.valid ||
					checked.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join('; ')
				);
			},
			{ toJsonSchema: () => ({ ...json }) }
		)
	);
};
/** A tool whose input is decoded once; a failure is the model's answer, never the turn's. */
const tool = <S extends Schema.Top & { readonly DecodingServices: never }>(
	name: string,
	description: string,
	input: S,
	run: (input: S['Type'], callId: string) => Effect.Effect<ToolAnswer, EngineError | PortFailure>
): Tool => ({
	name,
	description,
	input,
	run: Effect.fn(`AgentTool.${name}`)((value: unknown, id: string) =>
		guard(
			Schema.decodeUnknownEffect(input)(value).pipe(
				Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error)),
				Effect.flatMap((decoded) => run(decoded, id))
			)
		)
	)
});
/** What `read` needs: the engine's reads (and its queries, when `queries`), as `authority` at `bindings`. */
export type ReadToolContext = {
	engine: Pick<Engine, 'manifest' | 'read' | 'calls'>;
	authority: Authority;
	bindings: Bindings;
	/** The invocation id prefix of a query call. */
	turn: string;
	/** Offer `{ query, input }` (agent mode). */
	queries: boolean;
	/** A `confirm` query waits on the person's card (in-app turns only). */
	inApp: boolean;
};
/** `query` (rule 58): records, aggregates, search indexes and declared queries, each one engine read bounded by rule 62; `undefined` when nothing is readable. */
export function readTool(x: ReadToolContext): Tool | undefined {
	const e = x.engine,
		a = x.authority,
		can = callablesFor(e, a),
		agent = x.queries;
	const runQuery = Effect.fn('AgentTool.work2')(function* (i: ReadInput, id: string) {
		const requested = i.query;
		if (requested === undefined) return err('Give query.');
		const name =
			requested.includes('.') || typeof i.collection !== 'string'
				? requested
				: `${i.collection}.${requested}`;
		const spec = can.queries.get(name);
		if (!agent || spec === undefined)
			return err(
				`You may not run '${name}'.${can.queries.size > 0 ? ` Queries: ${[...can.queries.keys()].join(', ')}.` : ''}`
			);
		if (spec.agent === 'confirm' && x.inApp) return { confirm: true } as const;
		const dot = name.lastIndexOf('.');
		return ok(
			yield* e.calls.query({
				authority: a,
				bindings: x.bindings,
				invocationId: `${x.turn}:${id}`,
				from: 'Client',
				collection: name.slice(0, dot),
				query: name.slice(dot + 1),
				input: i.input ?? {}
			})
		);
	});
	const readOne = Effect.fn('AgentTool.work4')(function* (i: ReadInput, id: string) {
		if (i.query !== undefined) {
			const r = yield* runQuery(i, id);
			return 'confirm' in r ? err('A query that needs confirmation runs alone, not in reads.') : r;
		}
		const c = i.collection;
		if (c === undefined) return err('Give collection.');
		if (!can.reads.includes(c))
			return err(`You may not read '${c}'. Collections you may read: ${can.reads.join(', ')}.`);
		const sel = i.select;
		const keep = sel === undefined ? [] : Object.keys(sel);
		const pick = (limit: number) =>
			Object.fromEntries(
				(['where', 'select', 'orderBy', 'search', 'after'] as const)
					.flatMap((k) => (i[k] === undefined ? [] : [[k, i[k]]]))
					.concat([['limit', limit]])
			);
		// `{ semantic }` or `{ <index>: input }`: one ranked page; a text search is an ordinary list read
		const ranked = typeof i.search === 'object' ? Object.entries(i.search)[0] : undefined;
		const scoped = (limit: number) => ({
			limit,
			...(i.where === undefined ? {} : { where: i.where }),
			...(sel === undefined ? {} : { select: sel })
		});
		const run = Effect.fn('AgentTool.work3')(function* (limit: number) {
			const ir = yield* Effect.try({
				try: () =>
					i.id !== undefined && i.asOf !== undefined
						? lowerRead(e.manifest, 'history', [c, i.id, i.asOf])
						: i.id !== undefined
							? lowerRead(e.manifest, 'get', [c, i.id, sel === undefined ? {} : { select: sel }])
							: i.aggregate !== undefined
								? lowerRead(e.manifest, 'aggregate', [
										c,
										groups(encodeWire(i.aggregate), limit, i.where)
									])
								: ranked === undefined
									? lowerRead(e.manifest, 'read', [c, pick(limit)])
									: ranked[0] === 'semantic'
										? lowerRead(e.manifest, 'similar', [
												c,
												{
													to: Predicate.isObject(ranked[1])
														? { record: { id: ranked[1]['record'] ?? null } }
														: ranked[1],
													...scoped(limit)
												}
											])
										: lowerRead(e.manifest, 'similar', [c, ranked[0], ranked[1], scoped(limit)]),
				catch: (cause) =>
					cause instanceof BoltError
						? cause
						: BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
			});
			return (yield* e.read([ir], { as: 'caller', authority: a }, x.bindings))[0] ?? null;
		});
		let limit = Math.max(1, Math.min(i.limit ?? 50, 200));
		return yield* Effect.gen(function* () {
			let out = bounded(yield* run(limit), keep);
			const clipped = Schema.decodeUnknownOption(Schema.Struct({ clipped: Schema.String }))(
				out.value
			);
			// rows dropped for size: re-read exactly the rows shown, so the cursor pages on from the last of them
			const list = i.id === undefined && i.aggregate === undefined && ranked === undefined;
			while (list && out.kept !== null && out.kept > 0 && out.kept < limit)
				out = bounded(yield* run((limit = out.kept)), keep);
			const finalPage = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
				out.value
			);
			return {
				result:
					Option.isSome(clipped) && Option.isSome(finalPage)
						? { ...finalPage.value, clipped: clipped.value.clipped }
						: out.value,
				bounded: true
			} as const;
		}).pipe(
			Effect.catch((x) => {
				if (!(x instanceof BoltError) || x.code !== 'invalid') return Effect.fail(x);
				// what the model may name instead, so its next call differs
				return Effect.succeed({
					result: {
						error: x.message,
						fields: [...visible(a, c, Object.keys(e.manifest.models[c]?.fields ?? {}))],
						relations: [
							...new Set(
								Object.entries(e.manifest.relationships).flatMap(([k, r]) =>
									k.startsWith(`${c}.`)
										? [k.slice(c.length + 1)]
										: r.to === c && can.reads.includes(k.split('.')[0]!)
											? [r.inverse].filter((name): name is string => name !== undefined)
											: []
								)
							)
						],
						hint:
							`A filter is { field: { eq, ne, lt, lte, gt, gte, in, nin, isNull or like: value } }, combined with and, or, not; a date is YYYY-MM-DD. ${PERIODS} ` +
							'An aggregate is { count: true, sum: [field], by: field or { month: dateField } }. ' +
							'Name only these fields. If the data cannot answer the question, say so.'
					}
				});
			})
		);
	});
	return !(can.reads.length > 0 || (agent && can.queries.size > 0))
		? undefined
		: tool(
				'query',
				`Read records you may see. Collections: ${can.reads.join(', ')}. Give an id to read one record, where { id: { in: [...] } } for several, or where/orderBy/limit (default 50, at most 200) to read a list. Use an exact where filter for a known key. Batch up to 8 independent reads with { reads: [{ collection, where, select, limit }, ...] }; results follow input order. ` +
					'To count, total, average or compare over time, use aggregate: ONE read answers it, grouped in the database; never page through rows to count them. ' +
					'Example, leavers per month in 2026: { collection, where: { ended_on: { gte: "2026-01-01", lt: "2027-01-01" } }, aggregate: { count: true, by: { month: "ended_on" } } }. ' +
					`Text matches with like: "%Nihon%". ${PERIODS} ` +
					"search takes text, { index: input } for a collection's declared search index (its input as the outline names it), or { semantic: text | { record: id } } where the collection declares semantic search. Long values are clipped unless you name the field in select. " +
					'A select names fields with true. A forward relation takes { select: { field: true } }; an inverse many-relation also needs limit, for example { children: { select: { field: true }, limit: 5 } }. Relation keys are the exact names in the outline (often project_id, not project), not aliases or nested write names by assumption; reading children from their own collection by parent id is often simpler.' +
					(agent && can.queries.size > 0
						? ` A collection query runs as { query, input }: ${[...can.queries].map(([k, q]) => `${k}${q.description ? ` (${q.description})` : ''}`).join('; ')}.`
						: ''),
				Schema.Struct({
					...ReadInput.fields,
					reads: Schema.optionalKey(
						Schema.Array(ReadInput).check(Schema.isMaxLength(8)).annotate({
							description:
								'several reads in one call, each with these same keys; results follow input order'
						})
					)
				}),
				(i, id) =>
					Effect.gen(function* () {
						if (EffectArray.isArray<typeof i.reads>(i.reads)) {
							if (i.reads.length === 0 || i.reads.length > 8)
								return err('reads takes 1 to 8 reads.');
							// each read is bounded on its own; the list is clipped as a whole (read_output reads the rest)
							return ok(
								yield* Effect.all(
									i.reads.map((r, n) =>
										readOne(r, `${id}#${n}`).pipe(Effect.map((got) => got.result))
									),
									{ concurrency: 'unbounded' }
								)
							);
						}
						if (i.query !== undefined) return yield* runQuery(i, id);
						if (i.collection === undefined) return err('Give collection, query, or reads.');
						return yield* readOne(i, id);
					})
			);
}
/** The catalogue for this step (the actor may change at a steer, rule 60). */
export function catalogue(x: ToolContext): Tool[] {
	const e = x.engine,
		a = x.authority,
		can = callablesFor(e, a),
		agent = x.mode === 'agent';
	const tools: Tool[] = [];
	const add = <S extends Schema.Top & { readonly DecodingServices: never }>(
		name: string,
		description: string,
		input: S,
		run: (input: S['Type'], callId: string) => Effect.Effect<ToolAnswer, EngineError | PortFailure>,
		pure = false
	) => {
		const made = tool(name, description, input, run);
		tools.push(pure ? { ...made, pure: true } : made);
	};
	const read = readTool({
		engine: e,
		authority: a,
		bindings: x.bindings,
		turn: x.turn,
		queries: agent,
		inApp: x.inApp
	});
	if (read !== undefined) tools.push(read);
	// each with its input, so the first start is the right one (an omitted input runs the automation over everything)
	const signature = (name: string) => {
		const input =
			(
				e.manifest.automations[name] as
					| {
							input?: {
								[k: string]: {
									kind: string;
									of?: unknown;
									optional?: boolean;
								};
							};
					  }
					| undefined
			)?.input ?? {};
		const kind = (v: { kind: string; of?: unknown }) =>
			v.of === undefined
				? v.kind
				: `${v.kind}<${
						typeof v.of === 'string'
							? v.of
							: ((
									v.of as {
										kind: string;
										of?: unknown;
									}
								).of ??
								(
									v.of as {
										kind: string;
									}
								).kind)
					}>`;
		return `${name}(${Object.entries(input)
			.map(([k, v]) => `${k}${v.optional ? '?' : ''}: ${kind(v)}`)
			.join(', ')})`;
	};
	// a sync starts as its caller: a file sync's import gated by their create or update grants on the collection, its
	// export by their reads (the engine judges both); a remote sync's read is granted by name among the policy's automations
	const allSyncs = syncsOf(e.manifest);
	const files = new Map(
		[...allSyncs].flatMap(([n, x]) => {
			if (!x.file) return [];
			const ca = a.collections[x.collection];
			const modes = [
				...(a.admin || (ca?.create.length ?? 0) + (ca?.update.length ?? 0) > 0 ? ['import'] : []),
				...(a.admin || can.reads.includes(x.collection) ? ['export'] : [])
			];
			return modes.length === 0 ? [] : [[n, modes.join(' | ')] as const];
		})
	);
	/** An `inputFile`: a JSON file of this member's (a `sys_file` they created), at most 8 MiB. */
	const inputOfFile = Effect.fn('AgentTool.work6')(function* (fileId: string) {
		const member = a.actor.kind === 'member' ? a.actor.id : null;
		if (e.files === undefined || member === null)
			return { error: 'This host stores no files; give input.' };
		const [rows] = yield* e.db.read([
			{
				text: 'SELECT key, size FROM sys_file WHERE id = $1 AND created_by = $2',
				params: [fileId, member]
			}
		]);
		const f = rows?.rows[0];
		if (f === undefined)
			return {
				error: `No file ${fileId} of yours; give the id of a file you uploaded or a tool stored for you.`
			};
		if (Number(f['size']) > 8 * 1024 * 1024)
			return { error: 'That file is over 8 MiB; split the input.' };
		return yield* Effect.gen(function* () {
			const text = new TextDecoder().decode(
				yield* e.files!.get(String(f['key']), 8 * 1024 * 1024).pipe(Port.call('files', 30000))
			);
			return {
				input: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
					Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
				)
			};
		}).pipe(
			Effect.catch((error) => Effect.succeed({ error: `That file is not JSON: ${error.message}` }))
		);
	});
	const syncs = [...allSyncs]
		.filter(([n, x]) => !x.file && (a.admin || a.automations.includes(n)))
		.map(([n]) => n);
	const automations = a.automations.filter(
		(n) =>
			!allSyncs.has(n) &&
			e.manifest.automations[n] !== undefined &&
			e.manifest.automations[n]?.agent !== 'never'
	);
	const mayStart = (c: string) =>
		files.has(c) ||
		syncs.includes(c) ||
		(c.startsWith(`${AUTOMATION}.`) && automations.includes(c.slice(AUTOMATION.length + 1)));
	if (agent && (can.acts.size > 0 || automations.length > 0 || files.size > 0 || syncs.length > 0))
		add(
			'act',
			`Write: create, update, delete or upsert records, run a generated collection write, decide an approval, or start an automation or a sync. Callables: ${[...can.acts.keys()].join(', ')}. ` +
				(automations.length > 0
					? `Automations start as automation.<name> with their declared input: ${automations.map(signature).join('; ')}. A committed start admits a run to the queue; its business result is available only after the run finishes. `
					: '') +
				(syncs.length > 0
					? `A remote sync reads its source now as <collection>.sync.<sync> with {}: ${syncs.join(', ')}. `
					: '') +
				(files.size > 0
					? `A file sync runs as <collection>.sync.<sync> with { mode: 'import', file } (a stored file id) or { mode: 'export', to } (a format; the run's output is its file): ${[...files].map(([n, modes]) => `${n}(mode: ${modes})`).join('; ')}. `
					: '') +
				'Inputs: create takes the row ({ column, rel: { create: [rows] } }); update takes { target: id, set: { column, rel: { create: [rows] } } }; delete takes { target: id }; ' +
				'upsert takes the row with the id of the record it updates, or no id to create one ({ id?, column, rel: {…} }): look the record up, then one upsert either way. ' +
				"The workspace outline names each collection's writable columns and nested relation writes. A file field takes a file reference { id, name, mime } as a message or tool lists it. " +
				'create, update and upsert take one row or an array of rows: many rows (an import from a sheet) are one call and one statement. ' +
				`Several different writes: actions [{ callable, input }] (at most ${BATCH}) run in order, stopping at the first that does not commit. ` +
				(e.files !== undefined
					? "An input too large to write out that is already a JSON file of yours: give that file's id as inputFile instead of input. "
					: '') +
				(can.acts.has(APPROVE)
					? `${APPROVE} decides a pending approval request you are an approver of. `
					: '') +
				'A committed write answers the stored rows, and as `runs` any automation runs it started (they run in the background; wait on a run id only when its result is needed now).',
			WriteInput,
			(i, id) =>
				Effect.gen(function* () {
					if (typeof i.inputFile === 'string') {
						const read = yield* inputOfFile(i.inputFile);
						if ('error' in read) return err(read.error);
						i = { ...i, input: read.input };
					}
					const writes = writesOf(i);
					if (writes.length === 0 || writes.length > BATCH)
						return err(`Give callable, or actions: 1 to ${BATCH} { callable, input }.`);
					const denied = writes.find((w) => !can.acts.has(w.callable) && !mayStart(w.callable));
					if (denied !== undefined) return err(`You may not run '${denied.callable}'.`);
					if (
						x.inApp &&
						writes.some(
							(w) =>
								can.acts.get(w.callable)?.agent === 'confirm' ||
								(w.callable.startsWith(`${AUTOMATION}.`) &&
									e.manifest.automations[w.callable.slice(AUTOMATION.length + 1)]?.agent ===
										'confirm')
						)
					)
						return { confirm: true } as const;
					return ok(yield* performAll(x, writes, id));
				})
		);
	if (x.mode === 'plan' && !x.child)
		add(
			'update_plan',
			'Write the draft plan: give body to replace it whole, or patch { old, new } to change one exact passage. expectedRevision is the revision you last saw.',
			Schema.Struct({
				body: Schema.optionalKey(Schema.String.annotate({ description: 'the whole plan' })),
				patch: Schema.optionalKey(
					Schema.Struct({
						old: Schema.String.annotate({ description: 'an exact passage, once in the plan' }),
						new: Schema.String.annotate({ description: 'its replacement' })
					})
				),
				expectedRevision: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({
						description: 'the plan revision you edit'
					})
				)
			}),
			(i) =>
				Effect.gen(function* () {
					const plan = x.conv.plan,
						rev = plan?.revision ?? 0;
					if (i.expectedRevision !== undefined && i.expectedRevision !== rev)
						return err(`The plan is at revision ${rev}; read it again before editing.`);
					if (typeof i.body === 'string') {
						yield* x.setPlan(i.body);
						return ok({ saved: true, revision: rev + 1 });
					}
					const p = i.patch;
					if (p?.old === undefined || plan === null)
						return err('Give body, or a patch against an existing plan.');
					const count = plan.body.split(p.old).length - 1;
					if (count !== 1)
						return err(
							count === 0
								? 'That passage is not in the plan.'
								: 'That passage occurs more than once; quote more of it.'
						);
					yield* x.setPlan(plan.body.replace(p.old, p.new ?? ''));
					return ok({ saved: true, revision: rev + 1 });
				})
		);
	add(
		'goals',
		"Set this conversation's checklist: the whole ordered list, each { id, text, status: pending | doing | done }. Ids are unique, at most one is doing, and a done goal stays done with its text unchanged.",
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({
					id: Schema.String.annotate({ description: 'stable id' }),
					text: Schema.String,
					status: Schema.Literals(['pending', 'doing', 'done'])
				})
			)
		}),
		(i) =>
			Effect.gen(function* () {
				const items = i.items.map((g) => ({ ...g }));
				if (items.length > 100) return err('At most 100 goals.');
				if (new Set(items.map((g) => g.id)).size !== items.length)
					return err('Goal ids must be unique.');
				if (items.filter((g) => g.status === 'doing').length > 1)
					return err('At most one goal is doing.');
				for (const old of x.conv.goals ?? [])
					if (old.status === 'done') {
						const now = items.find((g) => g.id === old.id);
						if (now === undefined || now.status !== 'done' || now.text !== old.text)
							return err(`Goal '${old.id}' is done; it stays done with its text.`);
					}
				yield* x.setGoals(items);
				return ok({ saved: true });
			})
	);
	if (agent)
		add(
			'compact',
			'Checkpoint the conversation before your next step: a summary replaces the history (at most 3 per turn). Use it when the context is long and the work goes on.',
			Schema.Struct({
				reason: Schema.String.annotate({ description: 'why now' })
			}),
			(i) =>
				Effect.gen(function* () {
					return x.compact(i.reason)
						? ok({ scheduled: true })
						: err('No more checkpoints this turn.');
				})
		);
	const skills = Object.entries(x.skills).filter(
		([n]) => a.admin || a.capabilities.skills.includes(n) || !(n in e.manifest.agent.skills)
	);
	if (skills.length > 0)
		add(
			'skill',
			`Read a skill: ${skills.map(([n, t]) => `${n} (${skillOf(t.text).description})`).join('; ')}. Give a section to read one part. Its scripts run as written with run_js { file: '<skill>/<path>' }.`,
			Schema.Struct({
				name: Schema.String.annotate({ description: 'skill' }),
				section: Schema.optionalKey(Schema.String.annotate({ description: 'a ## section' }))
			}),
			(i) =>
				Effect.gen(function* () {
					const t = skills.find(([n]) => n === i.name)?.[1];
					if (t === undefined) return err(`No skill '${i.name}' is available.`);
					const s = skillOf(t.text);
					// its own files, never the packages it vendors
					const own = t.files.filter(
						(f) => f !== SKILL_FILE && !f.split('/').includes('node_modules')
					);
					const files = own.length === 0 ? {} : { files: own.slice(0, 50) };
					if (i.section === undefined) {
						// whole sections that fit the result bound, then the names of the rest: a section is read by name,
						// never through a clipped body
						const parts = s.body.split(/^(?=##\s)/m);
						let body = '',
							shown = 0;
						for (const part of parts) {
							if (shown > 0 && size(body + part) > BOUNDS.resultBytes - 2000) break;
							body += part;
							shown++;
						}
						const rest = parts
							.slice(shown)
							.map((p) => /^##\s+(.+)$/m.exec(p)?.[1]?.trim())
							.filter((name): name is string => name !== undefined);
						return ok({
							description: s.description,
							sections: s.sections,
							body: shown === 1 && parts.length === 1 ? bound(body) : body,
							...files,
							...(rest.length === 0 ? {} : { more: `read each with section: ${rest.join(', ')}` })
						});
					}
					return ok(
						section(s.body, i.section) ?? {
							error: `No section '${i.section}'.`,
							sections: s.sections
						}
					);
				})
		);
	add(
		'history',
		'Search earlier messages: in this conversation, or in all of the conversations of the person this turn serves (scope mine). Answers at most 50 hits naming their conversation.',
		Schema.Struct({
			query: Schema.String.annotate({ description: 'words to find' }),
			scope: Schema.optionalKey(Schema.Literals(['this', 'mine'])),
			limit: Schema.optionalKey(
				Schema.Number.check(Schema.isInt()).annotate({ description: 'at most 50' })
			)
		}),
		(i) =>
			Effect.gen(function* () {
				return ok(
					yield* x.history(
						i.query,
						i.scope === 'mine' ? 'mine' : 'this',
						Math.max(1, Math.min(i.limit ?? 20, 50))
					)
				);
			})
	);
	add(
		'read_output',
		'Read more of a tool result that was clipped: the call id its clip note names (none for the latest clipped result) and the character offset to read from.',
		Schema.Struct({
			call: Schema.optionalKey(
				Schema.String.annotate({
					description: 'the tool call id; omit for the latest clipped result'
				})
			),
			offset: Schema.optionalKey(
				Schema.Number.check(Schema.isInt()).annotate({ description: 'character offset, default 0' })
			)
		}),
		(i) =>
			Effect.gen(function* () {
				const full = yield* x.output(i.call ?? null);
				if (full === undefined)
					return err(
						i.call === undefined
							? 'No result was clipped in this conversation.'
							: 'No saved output for that call; omit call to read the latest clipped result.'
					);
				const text = outputText(full),
					from = Math.max(0, i.offset ?? 0),
					parts: string[] = [];
				// pieces measured as the model receives them (escaping grows code), so the answer stays within the result bound unclipped
				let at = from;
				for (let used = 0; at < text.length;) {
					const part = text.slice(at, at + 1000);
					if ((used += size(part)) > 14000 && parts.length > 0) break;
					parts.push(part);
					at += part.length;
				}
				return {
					result: {
						offset: from,
						total: text.length,
						parts,
						...(at < text.length ? { next: at } : {})
					},
					bounded: true
				};
			})
	);
	if (x.conv.integration !== null)
		add(
			'read_messages',
			"Read this chat's messages not addressed to you that you have not read yet, oldest first (they are then marked read). " +
				'Give all: true to page back through the whole history, newest first, before a seq.',
			Schema.Struct({
				all: Schema.optionalKey(Schema.Boolean),
				limit: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'at most 50' })
				),
				before: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({
						description: 'seq to page before (with all)'
					})
				)
			}),
			(i, id) =>
				Effect.gen(function* () {
					const rows = yield* x.messages({
						unread: i.all !== true,
						limit: Math.max(1, Math.min(i.limit ?? 50, 50)),
						...(i.before === undefined ? {} : { before: i.before }),
						key: `${x.turn}:${id}`
					});
					return ok({
						messages: rows.map((r) => ({
							seq: r.seq,
							from: r.role === 'assistant' ? 'you' : authorOf(r),
							sender: r.sender ?? null,
							message: r.provider_id ?? null,
							sent: r.sent_at ?? r.created_at ?? null,
							text: r.text,
							files: [...filesOf(r)],
							addressed: !ambient(r)
						})) as Json,
						note: 'Only messages since this account was connected are here; senders may have edited or deleted some since.'
					});
				})
		);
	/** A stored file as text, an image, a sheet or a PDF document; an image or document rides into the next step. */
	const readStored = Effect.fn('AgentTool.work15')(function* (
		port: NonNullable<typeof x.attachments>,
		file: Json,
		i: { as?: 'text' | 'image' | 'sheet' | 'document'; sheet?: number }
	) {
		const mime = Predicate.isObject(file) && typeof file['mime'] === 'string' ? file['mime'] : '',
			as = mime.startsWith('image/')
				? 'image'
				: mime === 'application/pdf'
					? 'document'
					: (i.as ?? 'text');
		const got = yield* port.read(file, as, i.sheet).pipe(Port.call('files', 30000));
		if (
			got !== null &&
			typeof got === 'object' &&
			'bytes' in got &&
			got.bytes instanceof Uint8Array &&
			'mime' in got &&
			typeof got.mime === 'string'
		) {
			const dropped = attach(x.files, { mime: got.mime, bytes: got.bytes });
			return ok({
				attached: 'the file is attached to your next step',
				...(dropped > 0
					? { dropped: `${dropped} older file(s) dropped to stay within 8 files / 20 MiB` }
					: {})
			});
		}
		return ok(
			yield* Schema.decodeUnknownEffect(Schema.Json)(got).pipe(
				Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
			)
		);
	});
	const readAs = {
		as: Schema.optionalKey(
			Schema.Literals(['text', 'image', 'sheet', 'document']).annotate({
				description:
					'Optional format preference. Images and PDFs always use their native model format.'
			})
		),
		sheet: Schema.optionalKey(
			Schema.Number.check(Schema.isInt()).annotate({
				description: '0-based XLSX worksheet number, default 0'
			})
		)
	};
	if (x.attachments !== undefined)
		add(
			'read_attachment',
			'Read a file attached to a message (its seq and file index as the message lists them). The file type selects its format: screenshots and images, and PDF documents, are attached to your next step for you to inspect. Text is returned directly. For XLSX, choose a 0-based worksheet number; the response lists sheet names.',
			Schema.Struct({
				seq: Schema.Number.check(Schema.isInt()),
				file: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'index, default 0' })
				),
				...readAs
			}),
			(i) =>
				Effect.gen(function* () {
					const row = yield* x.row(i.seq);
					const file = row === undefined ? undefined : filesOf(row)[i.file ?? 0];
					if (file === undefined) return err('That message has no such file.');
					return yield* readStored(x.attachments!, file, i);
				})
		);
	// a file already filed on a record (a scan on a job, a photo on a report): read only when the person reads that record
	if (x.attachments !== undefined)
		add(
			'read_file',
			"Read a file stored in a record's file field or this conversation's outputs, by its file reference ({ id }). Its type selects image, PDF document, text or XLSX sheet. For a message attachment, use read_attachment with its seq and file index instead. Use it to compare values with the original evidence.",
			Schema.Struct({
				id: Schema.String.annotate({ description: 'the file id from the record' }),
				...readAs
			}),
			(i) =>
				Effect.gen(function* () {
					const id = i.id ?? '';
					const [r] = yield* x.engine.db.read([
						{
							text: `SELECT f.field, EXISTS (
								SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.outputs) o
								WHERE c.id = $2 AND o->>'id' = f.id
							) AS own FROM sys_file f WHERE f.id = $1`,
							params: [id, x.conv.id]
						}
					]);
					const field = r?.rows[0]?.['field'],
						// an output of this conversation is the person's own file, including one just downloaded
						own = field === 'sys_conversation.outputs' && r?.rows[0]?.['own'] === true;
					if (
						typeof field !== 'string' ||
						!field.includes('.') ||
						(field.startsWith('sys_conversation.') && !own) ||
						(!own &&
							!(yield* readableFile(
								{
									manifest: x.engine.manifest,
									db: x.engine.db,
									read: x.engine.read,
									authority: x.authority,
									bindings: x.bindings
								},
								id,
								field
							)))
					)
						return err('No file you can read has this id.');
					return yield* readStored(x.attachments!, { id }, i);
				})
		);
	if (x.geocoder !== undefined)
		add(
			'geocode',
			'Places for an address or place name ({ query }), or the place at a point ({ reverse: { lat, lng } }): at most 8, each with the point a geolocation field takes.',
			Schema.Struct({
				query: Schema.optionalKey(Schema.String.annotate({ description: 'an address or place' })),
				reverse: Schema.optionalKey(
					Schema.Struct({ lat: Schema.Number, lng: Schema.Number }).annotate({
						description: 'a { lat, lng } point'
					})
				)
			}),
			(i) =>
				Effect.gen(function* () {
					const geo = x.geocoder;
					if (geo === undefined) return err('The geocoder is not available here.');
					const r =
						i.reverse === undefined
							? yield* geo.search(i.query ?? '')
							: yield* geo
									.reverse(i.reverse)
									.pipe(Effect.map((hit) => (hit === null ? [] : [hit])));
					return ok(
						r
							.slice(0, 8)
							.map((hit) => ({ label: hit.label, address: hit.address, location: hit.point }))
					);
				})
		);
	const staff = a.actor.kind === 'member' && !a.actor.external;
	// one tool over the source: a text, a path to read, or nothing (the file list); the released source or the author's draft
	if (x.inApp && staff && (x.workspace !== undefined || x.draft !== undefined))
		add(
			'workspace_search',
			'Search or read the workspace source (src/: models, collections, ' +
				'policies, automations, apps, components, lib), as released or, with draft: true, your Studio draft. ' +
				'text finds lines containing it (case-insensitive) in any file (.md, .json too). path reads one file as numbered lines, from and to a range. ' +
				'Nothing lists the files. paths narrows to path prefixes.',
			Schema.Struct({
				text: Schema.optionalKey(Schema.String.annotate({ description: 'text a line contains' })),
				path: Schema.optionalKey(Schema.String.annotate({ description: 'a file to read' })),
				from: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'first line, default 1' })
				),
				to: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'last line' })
				),
				paths: Schema.optionalKey(
					Schema.Array(Schema.String).annotate({ description: 'path prefixes, e.g. src/lib/' })
				),
				draft: Schema.optionalKey(
					Schema.Boolean.annotate({ description: 'your Studio draft instead of the release' })
				),
				limit: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({
						description: 'at most 100 matches, default 30'
					})
				)
			}),
			(i) =>
				Effect.gen(function* () {
					const ws = i.draft === true ? x.draft : x.workspace;
					if (ws === undefined)
						return err(
							i.draft === true
								? 'You have no Studio draft in this workspace.'
								: 'This workspace was built without its source; search your draft.'
						);
					const prefixes = i.paths ?? [];
					const files = (yield* Port.attempt('workspace.files', () => ws.files())).filter(
						(f) => prefixes.length === 0 || prefixes.some((p) => f.startsWith(p))
					);
					const limit = Math.max(1, Math.min(i.limit ?? 30, 100));
					const path = i.path;
					if (typeof path === 'string') {
						const text = yield* Port.attempt('workspace.read', () => ws.read(path));
						if (text === null) {
							const base = path.split('/').pop()!;
							return err(
								`No file '${path}'.${((near) => (near.length > 0 ? ` Did you mean ${near.join(', ')}?` : ''))(files.filter((f) => f.endsWith(base)).slice(0, 5))}`
							);
						}
						return ok({
							path,
							...page(text, i.from ?? 1, i.to ?? Number.MAX_SAFE_INTEGER)
						});
					}
					if (typeof i.text === 'string' && i.text !== '') {
						const want = i.text.toLowerCase(),
							hits: Json[] = [];
						let total = 0;
						for (const path of files)
							for (const [n, line] of (
								(yield* Port.attempt('workspace.read', () => ws.read(path))) ?? ''
							)
								.split('\n')
								.entries())
								if (line.toLowerCase().includes(want) && ++total <= limit)
									hits.push({ path, line: n + 1, text: line.trim().slice(0, 200) });
						return ok({ total, hits });
					}
					return ok({
						files,
						read: 'pass path (with draft: true for your draft) to read one of these'
					});
				}),
			true
		);
	// the platform's API reference (`@norbital-ai/bolt/docs`), narrowed to what a workspace imports; authoring is the staff's
	const reference = x.docs;
	if (staff && reference !== undefined)
		add(
			'docs',
			'The API reference of what a workspace can import: bolt (the declaration functions and their types), bolt/page ($bolt in pages), ' +
				'bolt/test (the test kit), ui and ui/layout (views, field kinds, inputs, Form, primitives, layout), ui/capture and the std value libraries (std/date, std/decimal, …). ' +
				'Nothing given lists the namespaces; query searches names, summaries and signatures; namespace lists one; symbols (up to 8, with or without namespace) ' +
				'reads each: its signature, parameters or props, docs, examples and source. Read what you need in one call.',
			Schema.Struct({
				query: Schema.optionalKey(Schema.String.annotate({ description: 'words to find' })),
				namespace: Schema.optionalKey(
					Schema.String.annotate({ description: 'a namespace, e.g. bolt, ui/layout, std/date' })
				),
				symbol: Schema.optionalKey(Schema.String.annotate({ description: 'an exported name' })),
				symbols: Schema.optionalKey(
					Schema.Array(Schema.String)
						.check(Schema.isMaxLength(8))
						.annotate({ description: 'exported names to read together' })
				)
			}),
			(i) =>
				Effect.gen(function* () {
					const docs = yield* reference.corpus;
					const all = docs.index().namespaces.filter((n) => n.reference),
						names = all.map((n) => n.namespace);
					const ns = i.namespace === undefined ? undefined : i.namespace;
					if (ns !== undefined && !names.includes(ns))
						return err(`No namespace '${ns}'. Namespaces: ${names.join(', ')}.`);
					const within = ns === undefined ? names : [ns];
					if (i.query !== undefined)
						return ok(encodeWire(docs.search(i.query, { namespaces: within, limit: 20 })));
					const wanted = [
						...(i.symbols?.slice(0, 8) ?? []),
						...(i.symbol === undefined ? [] : [i.symbol])
					];
					if (wanted.length > 0) {
						const read = (name: string) =>
							within.flatMap((n) => {
								const s = docs.symbol(n, name);
								return s === null
									? []
									: [{ namespace: n, import: all.find((x) => x.namespace === n)!.module, ...s }];
							});
						const found = wanted.map((name) => ({ name, found: read(name) }));
						if (found.every((f) => f.found.length === 0))
							return err(
								`No symbol ${wanted.map((w) => `'${w}'`).join(', ')}${ns === undefined ? '' : ` in ${ns}`}; search with query.`
							);
						return ok(
							encodeWire(
								wanted.length === 1
									? (found[0]?.found ?? [])
									: found.map((f) =>
											f.found.length > 0
												? f.found
												: { name: f.name, error: 'not found; search with query' }
										)
							)
						);
					}
					if (ns !== undefined) {
						const n = docs.namespace(ns)!;
						return ok({
							namespace: ns,
							import: n.module,
							summary: n.summary,
							symbols: n.symbols.map((s) => ({ name: s.name, kind: s.kind, summary: s.summary }))
						});
					}
					return ok(
						all.map((n) => ({
							namespace: n.namespace,
							import: n.module,
							summary: n.summary,
							symbols: n.symbols
						}))
					);
				})
		);
	if (agent && x.delegation) {
		add(
			'subagent',
			`Delegate to sub-agents working with your authority, in the background: spawn { task, agent? } (agents: ${x.agents.join(', ')}) answers its conversation at once and it works on its own, several at once. ` +
				'Its report (its answer, a question for you, a failure) arrives as a message in this conversation: carry on with other work or end your reply, and you are prompted again when it arrives; wait pauses this turn for one instead. ' +
				'list shows your sub-agents and their status; read { conversation } shows one in detail: its checklist, last messages, the tool calls it made and what it changed or produced. ' +
				'message { conversation, text } answers or steers it (it carries on), stop { conversation } ends it. When it asks you something, answer with message, or ask the person if only they know.',
			Schema.Struct({
				action: Schema.Literals(['spawn', 'list', 'read', 'message', 'stop']),
				task: Schema.optionalKey(
					Schema.String.annotate({
						description: 'spawn: the task, with everything the sub-agent needs'
					})
				),
				agent: Schema.optionalKey(Schema.String.annotate({ description: 'spawn: which agent' })),
				conversation: Schema.optionalKey(
					Schema.String.annotate({ description: 'a sub-agent conversation' })
				),
				text: Schema.optionalKey(
					Schema.String.annotate({ description: 'message: what to tell it' })
				)
			}),
			(i) =>
				Effect.gen(function* () {
					const conv = i.conversation ?? '';
					switch (i.action) {
						case 'spawn': {
							const which = i.agent ?? null;
							if (which !== null && !x.agents.includes(which)) return err(`No agent '${which}'.`);
							return ok(yield* x.subagent.spawn(i.task ?? '', which));
						}
						case 'list':
							return ok(yield* x.subagent.list());
						case 'read':
							return ok(yield* x.subagent.read(conv));
						case 'message':
							return ok(yield* x.subagent.message(conv, i.text ?? ''));
						case 'stop':
							return ok(yield* x.subagent.stop(conv));
						default:
							return err('Unknown action.');
					}
				})
		);
	}
	const convert = e.convert,
		store = e.files;
	if (agent && convert !== undefined && store !== undefined && convert.targets.length > 0)
		add(
			'document',
			`Make a document for the person with the document converter: to (${convert.targets.join(', ')}), name (the file name, with its extension) and markdown, the whole document's content (tables and inline HTML allowed); a pdf also takes page (A4, A3, Letter) and landscape. ` +
				'For a deck (pptx), each slide starts at a level-2 heading. The file is offered to the person under your reply, and its reference is what a file field takes.',
			Schema.Struct({
				to: Schema.Literals(convert.targets),
				name: Schema.String.annotate({ description: 'the file name, e.g. "Q3 report.pdf"' }),
				markdown: Schema.String.annotate({
					description: 'the whole content of the document, written out in Markdown'
				}),
				page: Schema.optionalKey(Schema.Literals(['A4', 'A3', 'Letter'])),
				landscape: Schema.optionalKey(Schema.Boolean)
			}),
			(i) =>
				Effect.gen(function* () {
					if (i.markdown.trim() === '') return err('Write the document out in markdown.');
					const bytes = yield* convert.convert({ markdown: i.markdown }, i.to, {
						...(i.page === undefined ? {} : { page: i.page }),
						...(i.landscape === undefined ? {} : { landscape: i.landscape })
					});
					return ok({
						files: [yield* storeFile(x, store, { name: i.name, mime: CONVERT_MIME[i.to], bytes })]
					});
				})
		);
	// the person's own media from the web: the host fetches and stores it, so no bytes enter the engine
	if (agent && x.inApp && staff && store !== undefined)
		add(
			'download',
			"Save a media file (an image, audio, video, a PDF or an HTML page) at a public http(s) URL as the person's file: the host fetches it and keeps it only if its bytes are media, at most 100 MiB. Source code and archives are read with the browser, not downloaded.",
			Schema.Struct({
				url: Schema.String.annotate({ description: "the media file's public http(s) URL" })
			}),
			(i) =>
				Effect.gen(function* () {
					const file = yield* store.download(i.url);
					return ok({
						saved: file.name,
						mime: file.mime,
						bytes: file.bytes,
						file: yield* recordFile(x, file)
					});
				})
		);
	// JavaScript in a fresh guest isolate, never the cell: inline code, or a skill's script run as written where the host
	// bundles files; its HTTP is granted as a host tool is
	const guest = e.guest,
		bundler = e.bundler,
		http =
			x.inApp && staff && (a.admin || a.capabilities.tools.includes('http')) ? e.http : undefined;
	if (agent && guest !== undefined)
		add(
			'run_js',
			'Run JavaScript in a fresh isolate to parse, transform, aggregate or compute. code is the body of an async function of input (return the answer; await works): ' +
				'plain JavaScript, no require, process, fetch, timers or files; console lines come back with the answer. ' +
				'With http: true (when your policies grant it), await http({ method?, url, headers?, body? }) answers { status, headers, text }: public https only, no redirects, at most 4 MiB. ' +
				'Return { files: [{ name, text } | { name, base64 }] } to give the person files (text, CSV, JSON, Markdown, media, PDF, office documents, archives; never programs): each is kept as their file and its reference replaces it. ' +
				(bundler === undefined
					? ''
					: "Or file: a skill's script, run as written ('<skill>/<path>'; args are its process.argv): require and import resolve inside the skill's folder (read-only at /app, the working directory) and its own node_modules; " +
						"fs reads /app and the conversation files you name in files (read-only at /in/<name>) and writes /out, whose files become the person's; path, buffer, process, util are there, every other Node built-in fails by name; with http: true it has fetch. It answers { exitCode, files }. " +
						"One call holds the whole run, e.g. { file: 'sales/scripts/report.js', args: ['/in/q3.csv', '/out/summary.json'], files: [{ seq: 4, file: 0 }] }: file is required for every run of a script. " +
						"A repository reference's file runs the same way ('<reference>/<path>', as reference named it), as pure computation: never with fetch. ") +
				'Walls: 2 s of CPU, 256 MiB, 60 s, a 4 MiB answer, 64 MiB written, 1 MiB printed.',
			Schema.Struct({
				code: Schema.optionalKey(
					Schema.String.annotate({
						description: 'the body of an async function of input; return the answer'
					})
				),
				input: Schema.optionalKey(ToolJson),
				file: Schema.optionalKey(
					Schema.String.annotate({
						description: "a skill's script '<skill>/<path>', or a reference's '<reference>/<path>'"
					})
				),
				args: Schema.optionalKey(
					Schema.Array(Schema.String).annotate({ description: "the file's process.argv after it" })
				),
				files: Schema.optionalKey(
					Schema.Array(
						Schema.Union([
							Schema.Struct({ id: Schema.String }),
							Schema.Struct({
								seq: Schema.Number.check(Schema.isInt()),
								file: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
							})
						])
					).annotate({
						description:
							"the conversation files the file reads at /in/<name>: an attachment as read_attachment names it ({ seq, file }), or a file reference's { id }"
					})
				),
				http: Schema.optionalKey(
					Schema.Boolean.annotate({ description: 'give the code http(request), the file fetch' })
				)
			}),
			(i, callId) =>
				Effect.gen(function* () {
					if (i.http === true && http === undefined)
						return err('Your policies do not grant scripts HTTP: run it without http.');
					const keep =
						store === undefined
							? undefined
							: (file: { name: string; mime: string; bytes: Uint8Array }) =>
									storeFile(x, store, file);
					const granted = i.http === true ? http : undefined;
					if (i.file === undefined)
						return i.code === undefined
							? err('Give code, or a file to run.')
							: ok(
									yield* runJs({
										code: i.code,
										input: i.input ?? null,
										guest,
										http: granted,
										invocation: callId,
										keep
									})
								);
					if (i.code !== undefined) return err('Give code or file, not both.');
					if (bundler === undefined) return err('This workspace runs no files: give code.');
					const slash = i.file.indexOf('/'),
						name = i.file.slice(0, Math.max(slash, 0)),
						entry = i.file.slice(slash + 1);
					// a reference's name holds its commit (`<repository>@<commit>`); a skill's never has an @
					const reference = name.includes('@');
					if (reference && granted !== undefined)
						return err("A repository reference's file runs without fetch: run it without http.");
					const skill = reference ? undefined : skills.find(([n]) => n === name)?.[1];
					if (!reference && skill === undefined)
						return err(`No skill '${name}' is available: file is '<skill>/<path>'.`);
					if (skill !== undefined && !skill.files.includes(entry))
						return err(`The skill ${name} has no file '${entry}'.`);
					const inputs = yield* conversationFiles(x, i.files ?? []);
					if (typeof inputs === 'string') return err(inputs);
					const source =
						skill === undefined
							? yield* referenceTree(x, name, entry)
							: {
									digest: skill.digest,
									tree: yield* Effect.forEach(
										skill.files,
										(path) =>
											Effect.map(skill.read(path), (bytes): readonly [string, Uint8Array] => [
												path,
												bytes
											]),
										{ concurrency: 8 }
									)
								};
					if (typeof source === 'string') return err(source);
					return ok(
						yield* runFile({
							entry,
							digest: source.digest,
							tree: source.tree,
							args: i.args ?? [],
							inputs,
							guest,
							bundler,
							http: granted,
							invocation: callId,
							keep
						})
					);
				})
		);
	if (x.child)
		add(
			'ask_parent',
			'Ask the agent that delegated this task a question you cannot answer yourself (a choice, a missing fact, a confirmation). Your turn ends on it; its answer arrives as your next message and you carry on from there. Finish what you can first.',
			Schema.Struct({
				question: Schema.String.annotate({
					description: 'one clear question, with what you need to know'
				})
			}),
			(i) =>
				Effect.gen(function* () {
					if (i.question.trim() === '') return err('Ask a question.');
					x.ask(i.question.trim());
					return ok({
						asked: true,
						note: 'Stop here: your question goes to the delegating agent.'
					});
				})
		);
	add(
		'wait',
		"Wait for background work to finish: a sub-agent's report, jobs (long host calls) or automation runs (the run id act answered): the first of the given ones (every job when none) to settle, or nothing at the bound (at most 600 s). A settled run's file (an export, a template) is offered to the person under your reply.",
		Schema.Struct({
			jobs: Schema.optionalKey(Schema.Array(Schema.String)),
			seconds: Schema.optionalKey(
				Schema.Number.check(Schema.isInt()).annotate({ description: 'at most 600, default 120' })
			)
		}),
		(i) =>
			Effect.gen(function* () {
				const ids = i.jobs ?? [];
				const ms = Math.min(Math.max(1, i.seconds ?? 120), 600) * 1000;
				// automation runs are sys_run rows, not this turn's jobs: follow them until one ends (a probe waited on a
				// statutory research run for ten minutes and never heard it finish)
				if (ids.length > 0 && ids.every((id) => !x.jobs.has(id))) {
					let running: Json = [];
					const poll = Effect.gen(function* () {
						const rows = yield* x.engine.db.rows(RunViewRow, {
							text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`,
							params: [JSON.stringify(ids)]
						});
						const views = rows.map((row) => runView(a, row)).filter((view) => view !== null);
						if (views.length === 0) return err(`No job or automation run ${ids.join(', ')}.`);
						running = encodeWire(views);
						const ended = views.find(
							(view) => view.status !== 'queued' && view.status !== 'running'
						);
						return ended === undefined ? null : ok({ settled: encodeWire(ended) });
					});
					const result = yield* poll.pipe(
						Effect.repeat({
							schedule: Schedule.spaced('3 seconds'),
							until: (result) => result !== null
						}),
						Effect.timeoutOption(ms)
					);
					return Option.isSome(result) && result.value !== null
						? result.value
						: ok({ settled: null, running });
				}
				// with no ids and nothing of this turn running there is nothing to wait for: say so, never answer as if time passed
				// (a probe's agent read `{ settled: null }` as thirty seconds and polled a background run in a loop)
				// sub-agents run detached: with nothing of this turn running, wait for one's report instead
				if (ids.length === 0 && x.jobs.pending().length === 0 && (yield* x.subagent.running()) > 0)
					return ok(
						(yield* x.subagent.report(ms))
							? { report: 'arrived', note: 'A sub-agent report arrived: it is your next message.' }
							: { report: null, running: yield* x.subagent.running() }
					);
				if (ids.length === 0 && x.jobs.pending().length === 0)
					return ok({
						settled: null,
						pending: [],
						waited: 0,
						note: 'Nothing of this turn is running. To wait for an automation, pass its run id (a write answers the runs it started).'
					});
				const got = yield* x.jobs.wait(ids, ms);
				return ok(
					got === null
						? { settled: null, pending: encodeWire(x.jobs.pending()) }
						: { settled: got, pending: encodeWire(x.jobs.pending()) }
				);
			})
	);
	if (a.actor.kind === 'member') {
		const member = a.actor;
		// built here, not at module load: runs/index.ts reaches this module through the agent before RunViewRow exists
		const RunList = Schema.Struct({
			...RunViewRow.fields,
			finished: Schema.NullOr(Schema.String)
		});
		add(
			'runs',
			'Automation runs, newest first: filter by automation (an exact name, or a prefix ending in *), status, cause and a due-time window; page with the cursor a page answers as next. ' +
				'Give id for one run in detail: its input, result, error, every attempt and its log lines. You see the runs of automations you hold and the runs you started (only their status, for runs you merely caused).',
			Schema.Struct({
				id: Schema.optionalKey(Schema.String.annotate({ description: 'one run, in detail' })),
				automation: Schema.optionalKey(
					Schema.String.annotate({
						description: 'an exact automation name, or a prefix ending in *'
					})
				),
				status: Schema.optionalKey(
					Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'])
				),
				cause: Schema.optionalKey(Schema.String),
				since: Schema.optionalKey(
					Schema.String.annotate({ description: 'an instant: runs due at or after it' })
				),
				until: Schema.optionalKey(
					Schema.String.annotate({ description: 'an instant: runs due before it' })
				),
				limit: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'default 20, at most 100' })
				),
				cursor: Schema.optionalKey(Schema.String)
			}),
			(i) =>
				Effect.gen(function* () {
					const bad = [i.since, i.until].find(
						(v) => v !== undefined && Number.isNaN(Date.parse(v))
					);
					if (bad !== undefined) return err(`'${bad}' is not an instant.`);
					const after = Option.getOrNull(
						Schema.decodeUnknownOption(
							Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))
						)(i.cursor ?? '')
					);
					if (i.cursor !== undefined && after === null)
						return err('That cursor is not one a page answered.');
					const limit = Math.min(Math.max(1, i.limit ?? 20), 100),
						detail = i.id !== undefined;
					const name = i.automation;
					// the visible runs (rule 56); one run in detail also reads its log lines from the host's log store
					const rows = yield* e.db.rows(RunList, {
						text: `SELECT ${RUN_VIEW_COLUMNS}, finished_at::text AS finished
			FROM sys_run
			WHERE ($1 OR actor = $2 OR automation IN (SELECT jsonb_array_elements_text($3::jsonb)))
				AND ($4::text IS NULL OR id = $4)
				AND ($5::text IS NULL OR automation = $5) AND ($6::text IS NULL OR starts_with(automation, $6))
				AND ($7::text IS NULL OR state = $7) AND ($8::text IS NULL OR cause = $8)
				AND ($9::timestamptz IS NULL OR due_at >= $9::timestamptz) AND ($10::timestamptz IS NULL OR due_at < $10::timestamptz)
				AND ($11::timestamptz IS NULL OR (due_at, id) < ($11::timestamptz, $12::text))
			ORDER BY due_at DESC, id DESC LIMIT ${limit + 1}`,
						params: [
							a.admin,
							actorRef(member),
							JSON.stringify(a.automations),
							i.id ?? null,
							name === undefined || name.endsWith('*') ? null : name,
							name !== undefined && name.endsWith('*') ? name.slice(0, -1) : null,
							i.status === 'cancelled' ? 'stopped' : (i.status ?? null),
							i.cause ?? null,
							i.since ?? null,
							i.until ?? null,
							after?.[0] ?? null,
							after?.[1] ?? null
						]
					});
					const shown = rows.slice(0, limit).flatMap((row) => {
						const view = runView(a, row);
						return view === null ? [] : [{ row, view }];
					});
					if (detail) {
						const one = shown[0];
						if (one === undefined) return err(`No automation run ${i.id} you may read.`);
						const { row, view } = one;
						// a store that cannot answer says so in place of the lines, never as an empty log
						const logs =
							view.input === undefined
								? []
								: yield* readLog(x.logs, { run: view.id, limit: RUN_LOG_LINES }).pipe(
										Effect.map((lines) =>
											lines
												.toReversed()
												.map(({ id, at, severity, event, attributes }) =>
													clipJson({ id, at, severity, event, attributes }, 1024)
												)
										),
										Effect.catch((error) => Effect.succeed(error.message))
									);
						return ok(
							encodeWire({
								id: view.id,
								automation: view.automation,
								status: view.status === 'stopped' ? 'cancelled' : view.status,
								cause: view.cause,
								due: view.due_at,
								started: view.started,
								finished: row.finished,
								attempt_count: view.attempt_count,
								progress: clipJson(view.progress, 2048),
								error: clipJson(encodeWire(view.error), 4096),
								...(view.input === undefined
									? {}
									: {
											input: clipJson(view.input, 4096),
											result: clipJson(view.result ?? null, 4096),
											attempts: EffectArray.isArray<typeof view.attempts>(view.attempts)
												? view.attempts.map((attempt) => clipJson(attempt, 1024))
												: clipJson(view.attempts ?? null, 4096),
											logs
										})
							})
						);
					}
					const last = rows.length > limit ? rows[limit - 1] : undefined;
					return ok(
						encodeWire({
							runs: shown.map(({ row, view }) => ({
								id: view.id,
								automation: view.automation,
								status: view.status === 'stopped' ? 'cancelled' : view.status,
								cause: view.cause,
								due: view.due_at,
								started: view.started,
								finished: row.finished,
								attempt_count: view.attempt_count,
								error:
									view.error === null
										? null
										: {
												code: view.error.code,
												...(view.error.message === undefined
													? {}
													: { message: view.error.message.slice(0, 200) })
											},
								progress: clipJson(view.progress, 512)
							})),
							...(last === undefined ? {} : { next: JSON.stringify([last.due_at, last.id]) })
						})
					);
				})
		);
	}
	if (a.admin && a.actor.kind === 'member')
		add(
			'logs',
			"The workspace's runtime log (an administrator's), newest first: engine events and tenant code's console lines (event 'console'). " +
				'Filter by minimum level, text (in the event or its attributes), run id, automation, conversation and an at window; page with the cursor a page answers as next.',
			Schema.Struct({
				level: Schema.optionalKey(
					Schema.Literals(['info', 'warn', 'error']).annotate({
						description: 'this level or worse'
					})
				),
				text: Schema.optionalKey(Schema.String),
				run: Schema.optionalKey(Schema.String),
				automation: Schema.optionalKey(Schema.String),
				conversation: Schema.optionalKey(Schema.String),
				since: Schema.optionalKey(Schema.String.annotate({ description: 'an instant, inclusive' })),
				until: Schema.optionalKey(Schema.String.annotate({ description: 'an instant, exclusive' })),
				limit: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'default 50, at most 200' })
				),
				cursor: Schema.optionalKey(Schema.String)
			}),
			(i) =>
				Effect.gen(function* () {
					const limit = Math.min(Math.max(1, i.limit ?? 50), 200);
					const { level, cursor, limit: _limit, ...rest } = i;
					const rows = yield* readLog(x.logs, {
						...rest,
						...(level === undefined ? {} : { min: level }),
						...(cursor === undefined ? {} : { before: cursor }),
						limit
					});
					const last = rows.length === limit ? rows.at(-1) : undefined;
					return ok({
						lines: rows.map((row) => ({
							id: row.id,
							at: row.at,
							level: row.severity,
							event: row.event,
							invocation: row.invocation,
							run: row.run,
							conversation: row.conversation,
							attributes: clipJson(row.attributes, 1024)
						})),
						...(last === undefined ? {} : { next: last.id })
					});
				})
		);
	if (agent)
		for (const t of x.mcpTools)
			add(
				`mcp__${t.server}__${t.name}`,
				`${t.description} (MCP server ${t.server})`,
				runtimeInput(t.input),
				(i) =>
					Effect.gen(function* () {
						const r = yield* x.mcp.call(t.server, t.name, i);
						return ok(r);
					})
			);
	const hosts: InternalHostTool[] = x.hostTools.map((host) => ({
		...host,
		input: runtimeInput(host.input),
		call: (input, context) => Port.attempt(host.name, (signal) => host.call(input, context, signal))
	}));
	// the workspace's own search wins: an MCP tool named like a host search tool hides the host's
	const own = new Set(x.mcpTools.map((t) => t.name));
	if (x.inApp && staff)
		for (const host of hosts)
			if (
				!(WORKSPACE_OVERRIDES.has(host.name) && own.has(host.name)) &&
				(agent || host.readOnly === true) &&
				(a.admin || a.capabilities.tools.includes(host.name))
			)
				tools.push({
					...tool(host.name, host.description, host.input, (input, id) =>
						Effect.gen(function* () {
							const context: HostToolContext = {
								actor: a.actor,
								conversation: x.conv.id,
								turn: x.turn,
								callId: id,
								...(x.question === undefined ? {} : { question: x.question }),
								attach: (file) => {
									attach(x.files, file);
									if (host.studio === 'view')
										shown.push({
											name: `${host.name}-${shown.length + 1}.${file.mime.split('/')[1] ?? 'png'}`,
											...file
										});
								},
								keep: (file) => kept.push(file)
							};
							const shown: { name: string; mime: string; bytes: Uint8Array }[] = [],
								kept: Downloaded[] = [];
							const job = yield* x.jobs.add(
								host.name,
								host.call(input, context).pipe(Port.call(host.name, JOBS.hostMs))
							);
							const inline = yield* x.jobs.wait([job], x.inlineMs ?? JOBS.inlineMs);
							if (inline === null) return ok({ job, note: 'still running; collect it with wait' });
							const result = inline.result;
							// a screenshot the person sees too (stored now), or a download (stored by the host): their file, offered on the step
							if (
								!Predicate.isObject(result) ||
								(kept.length === 0 && (shown.length === 0 || e.files === undefined))
							)
								return ok(result);
							const files: Json[] = [];
							if (e.files !== undefined)
								for (const f of shown) files.push(yield* storeFile(x, e.files, f));
							for (const f of kept) files.push(yield* recordFile(x, f));
							return ok({ ...result, files });
						})
					),
					...(host.studio === undefined ? {} : { studio: host.studio })
				});
	// the panel's previewer shows the latest `preview` a result names: this is how the agent picks one explicitly
	const builds = tools.find((t) => t.studio === 'preview')?.name;
	if (builds !== undefined)
		add(
			'preview_show',
			`Show a preview in the person's previewer beside the chat: url is a preview URL a ${builds} result gave. It only shows the page; it does not open or check it.`,
			Schema.Struct({ url: Schema.String.annotate({ description: 'the preview URL' }) }),
			(i) =>
				Effect.succeed(
					/^https?:\/\//.test(i.url) && URL.canParse(i.url)
						? ok({ preview: i.url })
						: err('url is a preview URL (https://…)')
				)
		);
	return tools;
}
/** A file a tool made, stored as the member's (`sys_conversation.outputs`): the reference a file field takes and the panel offers. */
const storeFile = Effect.fn('Agents.storeFile')(function* (
	x: ToolContext,
	files: NonNullable<Engine['files']>,
	f: { name: string; mime: string; bytes: Uint8Array }
) {
	const blob = yield* files.put(f.bytes, { name: f.name, mime: f.mime });
	return yield* recordFile(x, { ...blob, name: f.name, mime: f.mime });
});
const InputFile = systemRow('sys_file', ['id', 'name', 'key', 'size']);
/**
 * The conversation files a file run names, as `/in/<name>`: the member's own uploads and outputs here, at most
 * `RUN_JS.inBytes` in all, one name each. A string is why not.
 */
const conversationFiles = Effect.fn('Agents.runFileInputs')(function* (
	x: ToolContext,
	given: readonly ({ readonly id: string } | { readonly seq: number; readonly file?: number })[]
) {
	if (given.length === 0) return [];
	// an attachment is addressed as the transcript lists it: its message's seq and its index there
	const refs: { readonly id: string }[] = [];
	for (const ref of given) {
		if ('id' in ref) {
			refs.push(ref);
			continue;
		}
		const row = yield* x.row(ref.seq);
		const id = row === undefined ? undefined : filesOf(row)[ref.file ?? 0]?.id;
		if (id === undefined) return `Message ${ref.seq} has no stored file ${ref.file ?? 0}.`;
		refs.push({ id });
	}
	const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null,
		files = x.engine.files;
	if (member === null || files === undefined) return 'This run can be handed no files.';
	const rows = yield* x.engine.db.rows(InputFile, {
		text: `SELECT id, name, key, size FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND field IN ('sys_conversation.inputs', 'sys_conversation.outputs') AND created_by = $2`,
		params: [JSON.stringify(refs.map((ref) => ref.id)), member]
	});
	const byId = new Map(rows.map((file) => [file.id, file]));
	const named: (readonly [string, Uint8Array])[] = [];
	let bytes = 0;
	for (const ref of refs) {
		const file = byId.get(ref.id);
		if (file === undefined) return `File ${ref.id} is not one of your files in this conversation.`;
		const name = file.name.replaceAll('/', '_');
		if (named.some(([taken]) => taken === name)) return `Two files are named ${name}.`;
		bytes += file.size;
		if (bytes > RUN_JS.inBytes) return `The files are over ${RUN_JS.inBytes / 1024 / 1024} MiB.`;
		named.push([name, yield* files.get(file.key, file.size)]);
	}
	return named;
});
const ReferenceFile = systemRow('sys_file', ['key', 'size']);
const ReferenceJson = Schema.fromJsonString(ReferenceIndex);
/**
 * A repository reference's tree for a file run: the person's own latest reference by that name, its index decoded
 * once, at most `REFERENCE.treeBytes`, every file by its content address. A string is why not.
 */
const referenceTree = Effect.fn('Agents.referenceTree')(function* (
	x: ToolContext,
	name: string,
	entry: string
) {
	const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null,
		files = x.engine.files;
	if (member === null || files === undefined) return 'This run reads no repository references.';
	const [row] = yield* x.engine.db.rows(ReferenceFile, {
		text: `SELECT key, size FROM sys_file WHERE name = $1 AND mime = $2 AND field = 'sys_conversation.outputs' AND created_by = $3 ORDER BY created_at DESC LIMIT 1`,
		params: [name, REFERENCE.mime, member]
	});
	if (row === undefined)
		return `No repository reference '${name}' is yours: bring it in with reference first.`;
	const index = Schema.decodeUnknownOption(ReferenceJson)(
		new TextDecoder().decode(yield* files.get(row.key, row.size))
	);
	if (Option.isNone(index)) return `The reference ${name} cannot be read.`;
	const { digest, files: listed } = index.value;
	if (!listed.some((file) => file.path === entry))
		return `The reference ${name} has no text file '${entry}'.`;
	if (listed.reduce((sum, file) => sum + file.bytes, 0) > REFERENCE.treeBytes)
		return `The reference ${name} is over ${REFERENCE.treeBytes / 1024 / 1024} MiB of text: too large to run a file from.`;
	const tree = yield* Effect.forEach(
		listed,
		(file) =>
			Effect.map(files.get(file.key, file.bytes), (bytes): readonly [string, Uint8Array] => [
				file.path,
				bytes
			]),
		{ concurrency: 8 }
	);
	return { digest, tree };
});
/** A file already in the store (the host's `download`) recorded as `storeFile` records one: no bytes enter the engine. */
const recordFile = Effect.fn('Agents.recordFile')(function* (x: ToolContext, file: Downloaded) {
	const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null;
	const id = globalThis.crypto.randomUUID();
	const ref = { id, name: file.name, mime: file.mime, size: file.bytes };
	// one statement: the file and its place among the conversation's outputs
	yield* x.engine.db.write({
		text: `WITH f AS (INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, 'sys_conversation.outputs', $7::timestamptz, $8))
		UPDATE sys_conversation SET outputs = outputs || $9::jsonb WHERE id = $10`,
		params: [
			id,
			file.name,
			file.mime,
			file.bytes,
			file.key,
			file.sha256,
			x.bindings.now,
			member,
			JSON.stringify([ref]),
			x.conv.id
		]
	});
	return ref;
});
/** The host tool a workspace may replace with its own same-named MCP tool; every other host name stays the host's. */
const WORKSPACE_OVERRIDES: ReadonlySet<string> = new Set(['web_search']);
type InternalHostTool = Omit<HostTool, 'call' | 'input'> & {
	input: Schema.Codec<Json>;
	call(input: Json, context: HostToolContext): Effect.Effect<Json, EngineError | PortFailure>;
};
