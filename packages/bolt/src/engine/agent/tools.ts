// The fixed tool set (rule 58): `read` (a layer map over the models and layers the actor may read: records, aggregates,
// search indexes), `act` (guarded writes, approval decisions, automation and sync starts), the plan, goal and compaction
// tools, skills, `history`, `runs` (members), `logs` (administrators), `geocode`, `read_messages` on envoy turns,
// `read_attachment`, `read_output`, `docs` and `workspace_search` for staff, `document` when it binds a converter,
// `download` for staff in the app when files are stored, `run_js` (HTTP when a policy names `http`), `subagent` and `wait`
// under delegation, MCP tools a held policy's capabilities name (a sub-agent has no plan or sub-agents, and asks its
// delegating agent with `ask_parent`), and host tools (Workspace Studio, browser, personal skills) only on in-app turns of
// staff members. Built-in tools are `Tool.make` definitions, MCP and host tools `Tool.dynamic` ones over their raw JSON
// Schema, all in one per-turn `Toolkit` (P7). The agent has no authority of its own (decision 10): the catalogue lists
// only what the actor may invoke and every call runs as the actor, so a refusal is the engine's answer, never the agent's.
import { Validator } from '@cfworker/json-schema';
import {
	Context,
	Deferred,
	Effect,
	FiberMap,
	Option,
	Predicate,
	Schedule,
	Schema,
	Stream,
	type SchemaAST
} from 'effect';
import { Tool, Toolkit } from 'effect/ai';
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
import { exposed } from '../access/authority.ts';
import {
	LayerRequestSchema,
	type LayerRequestJson,
	type ReadRequestJson
} from '../../protocol/read-request.ts';
import type { AgentEngine as Engine } from './index.ts';
import { lowerRead } from '../query/engine.ts';
import { BOUNDS, bound, bounded, filesOf, localTime, outputText, page, size } from './context.ts';
import { MODEL_FILES, ToolAnswer, toolSchema, type AnyTool, type InferTool } from './ai.ts';
export { ToolAnswer, type AnyTool } from './ai.ts';
import { REFERENCE, ReferenceIndex, RUN_JS, runFile, runJs } from './run-js.ts';
import { layered, layers, SKILL_FILE, type EngineManifest, type SkillSpec } from '../manifest.ts';
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
/** One catalogue tool as the loop treats it: its Studio role, and whether its answer depends only on its arguments within a turn (the same call again straight after is not run). */
export type AgentTool = {
	readonly name: string;
	readonly studio?: StudioRole;
	readonly pure?: true;
};
/** Any tool's handler context (`Tool.Any` names no tool in particular), merged into the step's toolkit. */
type Handlers = Tool.HandlersFor<Record<string, Tool.Any>>;
/** This step's tools: what the loop and the prompt name, the toolkit the model is offered, and one call run as the actor. */
export type Catalogue = {
	readonly tools: readonly AgentTool[];
	readonly toolkit: Toolkit.WithHandler<Record<string, AnyTool>>;
	/** A refused input (closed: an unknown key is a wrong call) or a failure is the model's answer, never the turn's. */
	readonly run: (name: string, input: unknown, callId: string) => Effect.Effect<ToolAnswer>;
};
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
/** Decoding that refuses an unknown key anywhere in the input: a misplaced key is a wrong call, not one to drop. */
export const CLOSED: SchemaAST.ParseOptions = { onExcessProperty: 'error' };
/** One write `{ callable, input }`: a generated verb's input is its array of rows. */
export const WriteInput = Schema.Struct({
	callable: Schema.String.annotate({
		description: 'model.verb, approvals.decide, automation.<name> or model.sync.<sync>'
	}),
	input: Schema.optionalKey(ToolJson.annotate({ description: 'the input the callable accepts' })),
	inputFile: Schema.optionalKey(
		Schema.String.annotate({
			description: 'instead of input: the id of a JSON file of yours; its contents are the input'
		})
	)
});
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
/** `act { callable: 'automation.<name>' }` starts an automation now; `<model>.sync.<sync>` runs a sync now. */
const AUTOMATION = 'automation';
/**
 * Every sync a run starts, by its startable name (`<model>.sync.<sync>`): a remote sync's read (`{}`), or a file
 * sync's import or export.
 */
const syncsOf = (m: Engine['manifest']) =>
	new Map<string, { readonly model: string; readonly file: boolean }>(
		Object.entries(m.exposures).flatMap(([c, spec]) =>
			Object.entries(spec.syncs ?? {}).flatMap(([s, x]) =>
				x.with === 'file' || x.read === true
					? [[`${c}.sync.${s}`, { model: c, file: x.with === 'file' }] as const]
					: []
			)
		)
	);
type Spec = {
	confirm?: true;
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
/**
 * What the actor may read: each read root (a model with `read`, never the run ledger) whose root access point admits it,
 * with every layer path it declares (a layer its policy does not name is read in full). An administrator reads every
 * workspace model; a built-in model only through a grant.
 */
export function readPaths(m: EngineManifest, a: Authority): string[] {
	return Object.entries(layered(m).exposures).flatMap(([root, spec]) =>
		root !== 'sys_run' &&
		((a.admin && root in m.exposures) || (a.models[root]?.read[root]?.length ?? 0) > 0)
			? Object.keys(spec.read)
			: []
	);
}
/** What the actor may write, by model: the generated verbs its write arms admit (rules 33a, 58), and approval decisions. */
function callablesFor(m: EngineManifest, a: Authority): Map<string, Spec> {
	const acts = new Map<string, Spec>();
	for (const [c, spec] of Object.entries(m.exposures)) {
		const ca = a.models[c];
		for (const v of VERBS) {
			const arms =
				v === 'upsert'
					? (ca?.create.length ?? 0) && (ca?.update.length ?? 0)
					: (ca?.[v].length ?? 0);
			const declared =
				v === 'upsert'
					? spec.create !== undefined && spec.update !== undefined
					: spec[v] !== undefined;
			if (declared && (a.admin || arms > 0)) acts.set(`${c}.${v}`, {});
		}
	}
	// a decision on a pending approval: the approvals engine admits only the step's approvers; the person confirms in the app
	if (mayDecide(m, a))
		acts.set(APPROVE, {
			confirm: true,
			description:
				'decide a pending approval: { requestId, decision: approve | reject | requestChanges, reason? } (a reason for reject and requestChanges)'
		});
	return acts;
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
/** The step's facts, in the closing note (the system prompt names the identity): the time, and an envoy's sender. */
export function turnFacts(e: Engine, a: Authority, b: Bindings, tz?: string): string {
	const x = a.actor,
		wtz = e.manifest.workspace.tz;
	return (
		`Now: ${localTime(b.now, wtz)} (${wtz}, ${b.now})${tz === undefined || tz === wtz ? '' : `; theirs ${localTime(b.now, tz)} (${tz})`}.` +
		(x.kind === 'envoy'
			? ` The newest message is from ${x.sender}${x.linked === undefined ? '' : `, linked to ${x.linked.email ?? x.linked.id} (member id ${x.linked.id})`}.`
			: '')
	);
}
function receipt(callable: string, o: Outcome): Receipt | null {
	if (o.kind === 'committed')
		return {
			outcome: 'committed',
			callable,
			records: o.records.map(({ model, id }) => ({ model, id }))
		};
	if (o.kind === 'pendingApproval')
		return {
			outcome: 'pendingApproval',
			callable,
			requestId: o.requestId,
			records: o.records.map(({ model, id }) => ({ model, id }))
		};
	return null;
}
/** Runs one `act` write under the call's key and answers its outcome. */
export const perform = Effect.fn('AgentTool.perform')(function* (
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
	// a sync is its model's (`<c>.sync.<s>`), run as the platform run of that name
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
	const [model, name] = [callable.slice(0, dot), callable.slice(dot + 1)];
	const common = {
		authority: x.authority,
		bindings: x.bindings,
		invocationId: `${x.turn}:${callId}`,
		key: `agent:${x.turn}:${callId}`,
		issuedAt: x.bindings.now
	};
	if (!Schema.is(Schema.Literals(VERBS))(name))
		return {
			error: `There is no generated write '${callable}'. Start a declared automation for a workflow.`
		};
	const r = yield* x.engine.act({
		...common,
		mode: { _tag: 'Direct' },
		model,
		verb: name,
		input,
		// an upsert updates the record each row's id names (rule 28)
		...(name === 'upsert' ? { onConflict: 'update' as const } : {})
	});
	const rc = receipt(callable, r.outcome);
	if (rc !== null) x.receipts.push(rc);
	if (r.outcome.kind !== 'committed' || name === 'delete') return encodeWire(r.outcome);
	// the stored rows, as the actor reads them: one read request, a root per written model
	const reads = Object.entries(
		Object.groupBy(
			r.outcome.records.filter((c) => c.model in x.engine.manifest.exposures).slice(0, 20),
			(c) => c.model
		)
	);
	const stored =
		reads.length === 0
			? {}
			: yield* Effect.try({
					try: () =>
						lowerRead(x.engine.manifest, 'query', [
							Object.fromEntries(
								reads.map(([c, rows]) => [
									c,
									{ where: { id: { in: (rows ?? []).map((row) => row.id) } } }
								])
							)
						]),
					catch: (cause) =>
						BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
				}).pipe(
					Effect.flatMap((ir) =>
						x.engine.read([ir], { as: 'caller', authority: x.authority }, x.bindings)
					),
					Effect.map(([got]) => got ?? {}),
					Effect.tapCause(Effect.logWarning),
					Effect.catch(() => Effect.succeed({}))
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
/** Effect has no importer for active JSON Schema conditionals: the ABI validator decodes a raw schema's input in its handler. */
const validatorOf = (json: { readonly [k: string]: Json }) => {
	const validator = new Validator(json, '2020-12', false);
	return (value: unknown): Json | string => {
		const checked = validator.validate(value);
		if (!checked.valid)
			return `Invalid input: ${checked.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join('; ')}`;
		return Option.getOrElse(
			Schema.decodeUnknownOption(Schema.Json)(value),
			() => 'Invalid input: not JSON'
		);
	};
};
/** What `read` needs: the engine's reads, as `authority` at `bindings`. */
export type ReadToolContext = {
	engine: Pick<Engine, 'manifest' | 'read'>;
	authority: Authority;
	bindings: Bindings;
};
/** A root read without its own `limit` reads this many rows, a page the model takes in at once (a request's own default is 10,000). */
const READ_PAGE = 50;
/** Whether `search` works on one read key for `a`: every field the search covers exposed there and unmasked (rule 14). */
function searchable(m: EngineManifest, a: Authority, path: string): boolean {
	const root = path.split('.')[0]!;
	const model = layers(m)[root]?.[path] ?? root;
	const here = exposed(m, root, path, model),
		masked = a.models[root]?.masks[path] ?? {};
	const text = layered(m).models[model]?.search?.text ?? [];
	return text.length > 0 && text.every((f) => here.includes(f) && !(f in masked));
}
/** A layer named without its parent key: the two calls that read it, in this workspace's own keys. */
function orphaned(m: EngineManifest, path: string): string {
	const dot = path.lastIndexOf('.'),
		parent = path.slice(0, dot),
		relation = path.slice(dot + 1),
		root = path.split('.')[0]!;
	const parentModel = layers(m)[root]?.[parent] ?? root,
		model = layers(m)[root]?.[path];
	// a many-layer is its model's rows whose link names the parent row
	const link = Object.entries(layered(m).relationships).find(
		([key, r]) => key.startsWith(`${model}.`) && r.to === parentModel && r.inverse === relation
	)?.[0];
	const own =
		model === undefined || link === undefined
			? ''
			: `, or read ${model} as its own root: { "${model}": { "where": { "${link.slice(model.length + 1)}": { "eq": "<the ${parentModel} id>" } } } }`;
	return `"${path}" nests in each "${parent}" row, so name both in one call: { "${parent}": { "where": … }, "${path}": { … } }${own}`;
}
/**
 * This turn's `read` input: one optional property per root and layer the caller may read, each naming exactly the fields
 * this caller reads there, `search` only where it works and `after` only on a root (no `asOf`: past states are the history tool's) — so the schema is what the engine
 * accepts (a bare enum of property names is lost in some providers' schema conversion). A layer needs its parent key.
 */
const readInput = (m: EngineManifest, a: Authority, paths: readonly string[]) =>
	Schema.Struct(
		Object.fromEntries(
			paths.map((path) => {
				const dot = path.lastIndexOf('.');
				const search = searchable(m, a, path);
				// the model's declared read is the shape; a request only filters, orders and pages it. Past states are the
				// history tool's, so the agent's read is current data only
				const {
					search: text,
					after,
					asOf: _asOf,
					fields: _fields,
					...base
				} = LayerRequestSchema.fields;
				// search is words, unless the model declares indexes or semantic search for its object form
				const declared = layered(m).models[layers(m)[path.split('.')[0]!]?.[path] ?? path]?.search;
				const words =
					declared?.semantic !== undefined || Object.keys(declared?.indexes ?? {}).length > 0
						? text
						: Schema.optionalKey(Schema.String.annotate({ description: 'words to find' }));
				const description =
					(dot < 0 ? 'a root' : `a layer of "${path.slice(0, dot)}"`) +
					(search ? '' : '; no search');
				const layer =
					dot < 0
						? search
							? Schema.Struct({ ...base, search: words, after }).annotate({ description })
							: Schema.Struct({ ...base, after }).annotate({ description })
						: search
							? Schema.Struct({ ...base, search: words }).annotate({ description })
							: Schema.Struct(base).annotate({ description });
				return [path, Schema.optionalKey(layer)];
			})
		)
	).check(
		Schema.makeFilter((request: object) => {
			const keys = Object.keys(request);
			if (keys.length === 0)
				return 'name at least one root: ' + paths.filter((p) => !p.includes('.')).join(', ');
			const orphan = keys.find(
				(k) => k.includes('.') && !keys.includes(k.slice(0, k.lastIndexOf('.')))
			);
			return orphan === undefined ? undefined : orphaned(m, orphan);
		})
	);
/**
 * `read` (rule 58, P3): one read request, a layer map over the models and declared layers the actor may read, answered in
 * one engine read as the actor and bounded by rule 62; `undefined` when nothing is readable. A lone root re-reads exactly
 * the rows the bound kept, so its cursor pages on from the last row shown.
 */
export function readTool(x: ReadToolContext) {
	const e = x.engine,
		a = x.authority,
		paths = readPaths(e.manifest, a);
	if (paths.length === 0) return undefined;
	const answer = (request: ReadRequestJson) =>
		Effect.try({
			try: () => lowerRead(e.manifest, 'query', [request]),
			catch: (cause) =>
				cause instanceof BoltError
					? cause
					: BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
		}).pipe(
			Effect.flatMap((ir) => e.read([ir], { as: 'caller', authority: a }, x.bindings)),
			Effect.map(([got]) => got ?? null)
		);
	const run = Effect.fn('AgentTool.read')(function* (given: ReadRequestJson) {
		// a root page the model can take in, unless it asked for one; an empty cursor or search is the model's "none"
		const request: { [path: string]: ReadRequestJson[string] } = Object.fromEntries(
			Object.entries(given).map(([path, asked]) => {
				const { after, search, ...rest } = asked;
				const layer = {
					...rest,
					...(after === undefined || after === '' ? {} : { after }),
					...(search === undefined || search === '' ? {} : { search })
				};
				return [
					path,
					path.includes('.') || layer.limit !== undefined || layer.aggregate !== undefined
						? layer
						: { ...layer, limit: READ_PAGE }
				];
			})
		);
		const keep = [...new Set(Object.values(given).flatMap((layer) => layer.fields ?? []))];
		const named = Object.keys(request).filter((path) => !path.includes('.'));
		const lone = named.length === 1 ? named[0] : undefined;
		const pageOf = (v: Json): Json =>
			lone !== undefined && Predicate.isObject(v) && !EffectArray.isArray<typeof v>(v)
				? (v[lone] ?? null)
				: v;
		const wrap = (v: Json): Json => (lone === undefined ? v : { [lone]: v });
		return yield* Effect.gen(function* () {
			let out = bounded(pageOf(yield* answer(request)), keep);
			const clipped = Predicate.isObject(out.value) ? out.value['clipped'] : undefined;
			// rows dropped for size: re-read exactly the rows shown, so the cursor pages on from the last of them
			const root = lone === undefined ? undefined : request[lone];
			let limit = root?.limit ?? 0;
			while (
				lone !== undefined &&
				root?.aggregate === undefined &&
				out.kept !== null &&
				out.kept > 0 &&
				out.kept < limit
			) {
				limit = out.kept;
				out = bounded(pageOf(yield* answer({ ...request, [lone]: { ...root, limit } })), keep);
			}
			return {
				result: wrap(
					clipped === undefined ||
						!Predicate.isObject(out.value) ||
						EffectArray.isArray<typeof out.value>(out.value)
						? out.value
						: { ...out.value, clipped }
				),
				bounded: true
			} as const;
		}).pipe(
			Effect.catch((failure) => {
				if (!(failure instanceof BoltError) || failure.code !== 'invalid')
					return Effect.fail(failure);
				// one next step, not the whole contract again: the model's source holds its fields and types
				return Effect.succeed({
					result: {
						error: failure.message,
						hint:
							(failure.message.includes("unknown operator 'contains'")
								? 'Text takes like: "%value%"; contains is only for a period or a JSON field. '
								: 'Change what the error names. ') +
							"The model's source (src/data/model/<model>/+model.ts) holds its fields and types. If the data cannot answer the question, say so."
					}
				});
			})
		);
	});
	return {
		tool: Tool.make('read', {
			description: `Read records. The input is an object: each key names what to read, its value holds that key's options. Several keys go in one call.

Keys
- "<model>" (a root): rows of that model.
- "<root>.<relation>" (a layer): for each root row, its related rows, nested inside that row (one related row as an object in place of its link, many as a list). Send it together with its root key.
Each key returns the fields its model's read declares.

Options (all optional)
- where: { "<field>": { "<operator>": value } }; several fields must all hold; combine with { "and": [...] }, { "or": [...] }, { "not": {...} }. On a root it chooses which rows return; on a layer it only narrows that layer's rows inside each root row, using the layer's own fields, never its link to the root.
  Operators by field kind:
  text: eq, ne, in, nin, isNull, like ("%word%"; % matches any characters)
  number, decimal, date (YYYY-MM-DD), instant: eq, ne, lt, lte, gt, gte, in, nin, isNull; an instant also olderThan ("7d")
  enum, bool, link (a row id): eq, ne, in, nin, isNull
  point: near ([point, metres]), within ({ bbox } or { polygon }); period: contains, overlaps, within; json: contains, isEmpty
- search: words found across the model's searchable text (where the schema offers it on that key).
- orderBy: "<field>", { "<field>": "asc" | "desc" }, or a list of these.
- limit: how many rows. A root returns ${READ_PAGE} unless you set it (at most 10,000); a many-layer returns up to 10,000 per root row, so set one.
- aggregate: { "count": true, "sum" | "avg" | "min" | "max": ["<field>"], "by": "<field>" | { "month": "<date field>" } }: totals instead of rows.
- after (root only): the "next" cursor a previous page of this same request returned.

Long values are clipped; read_output reads the rest.

Examples
- Rows by a filter: { "<model>": { "where": { "<date field>": { "eq": "2026-01-31" } }, "limit": 20 } }
- Rows with related rows: { "<model>": { "where": { "<text field>": { "like": "%word%" } } }, "<model>.<relation>": { "limit": 20 } }
- A count per value: { "<model>": { "aggregate": { "count": true, "by": "<field>" } } }`,
			parameters: readInput(e.manifest, a, paths),
			success: ToolAnswer
		}),
		run: (request: {
			readonly [path: string]: LayerRequestJson | undefined;
		}): Effect.Effect<ToolAnswer> =>
			guard(
				run(
					Object.fromEntries(
						Object.entries(request).flatMap(([path, layer]) =>
							layer === undefined ? [] : [[path, layer] as const]
						)
					)
				)
			)
	};
}
/** `read` as a tool an inference is lent (`ai.sys_2.infer` naming `read`, rule 58): the same tool, as the actor. */
export function readInferTool(x: ReadToolContext): InferTool | undefined {
	const read = readTool(x);
	if (read === undefined) return undefined;
	const decode = Schema.decodeUnknownEffect(read.tool.parametersSchema, CLOSED);
	return {
		name: read.tool.name,
		description: read.tool.description ?? '',
		input: toolSchema(read.tool),
		call: (input) =>
			decode(input).pipe(
				Effect.matchEffect({
					onFailure: (error) => Effect.succeed<Json>({ error: error.message }),
					onSuccess: (request) =>
						read
							.run(request)
							.pipe(
								Effect.map((answer) =>
									'result' in answer ? answer.result : { error: 'confirmation needed' }
								)
							)
				})
			)
	};
}
/** The catalogue for this step (the actor may change at a steer, rule 60): one toolkit, every handler run as the actor. */
export const catalogue = Effect.fn('AgentTool.catalogue')(function* (x: ToolContext) {
	const e = x.engine,
		a = x.authority,
		acts = callablesFor(e.manifest, a),
		paths = readPaths(e.manifest, a),
		agent = x.mode === 'agent';
	const entries: (AgentTool & {
		readonly tool: AnyTool;
		readonly handlers: Context.Context<Handlers>;
	})[] = [];
	const add = (
		tool: AnyTool,
		handlers: Effect.Effect<Context.Context<Handlers>>,
		meta: Omit<AgentTool, 'name'> = {}
	) =>
		Effect.map(handlers, (built) => {
			entries.push({ name: tool.name, tool, handlers: built, ...meta });
		});
	const read = readTool(x);
	if (read !== undefined)
		yield* add(
			read.tool,
			Toolkit.make(read.tool).toHandlers({ read: (request) => read.run(request) })
		);
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
	// a sync starts as its caller: a file sync's import gated by their create or update grants on the model, its
	// export by their reads (the engine judges both); a remote sync's read is granted by name among the policy's automations
	const allSyncs = syncsOf(e.manifest);
	const files = new Map(
		[...allSyncs].flatMap(([n, x]) => {
			if (!x.file) return [];
			const ca = a.models[x.model];
			const modes = [
				...(a.admin || (ca?.create.length ?? 0) + (ca?.update.length ?? 0) > 0 ? ['import'] : []),
				...(a.admin || paths.includes(x.model) ? ['export'] : [])
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
	if (agent && (acts.size > 0 || automations.length > 0 || files.size > 0 || syncs.length > 0)) {
		const actTool = Tool.make('act', {
			description:
				`Write records, decide an approval, or start an automation or a sync. The input is { "callable": "<name>", "input": <its input> }; one call per write.

Model writes: the callable is "<model>.<verb>" and its input is always an array of rows, committed together as one batch.
- create: [{ "<column>": value, "<relation>": [<row> or "<existing id>"] }]
- update: [{ "target": "<id>", "set": { "<column>": value, "<relation>": { "create": [<row>], "update": [{ "target": "<id>", "set": {...} }], "delete": ["<id>"], "link": ["<id>"], "unlink": ["<id>"] } } }]
- delete: [{ "target": "<id>" }]
- upsert: [{ "id"?: "<id>", "<column>": value }]: with an id it updates that row, without one it creates.
Related rows go inside their root row in the same call, never in a separate write. A link column takes the linked row's id; a file column takes the file reference { "id", "name", "mime" } a message or tool gave. The model's +model.ts names each write's columns and their kinds.
` +
				`Callables: ${[...acts.keys()].join(', ')}. ` +
				(automations.length > 0
					? `Automations start as automation.<name> with their declared input: ${automations.map(signature).join('; ')}. A committed start admits a run to the queue; its business result is available only after the run finishes. `
					: '') +
				(syncs.length > 0
					? `A remote sync reads its source now as <model>.sync.<sync> with {}: ${syncs.join(', ')}. `
					: '') +
				(files.size > 0
					? `A file sync runs as <model>.sync.<sync> with { mode: 'import', file } (a stored file id) or { mode: 'export', to } (a format; the run's output is its file): ${[...files].map(([n, modes]) => `${n}(mode: ${modes})`).join('; ')}. `
					: '') +
				(e.files !== undefined
					? "An input too large to write out that is already a JSON file of yours: give that file's id as inputFile instead of input. "
					: '') +
				(acts.has(APPROVE)
					? `${APPROVE} decides a pending approval request you are an approver of. `
					: '') +
				'Your policies decide these callables and check each batch when it commits: a denial names its reason (do not retry it); a write routed to approval waits for its approvers (say so, not that it is done). ' +
				'A committed write answers the stored rows, and as `runs` any automation runs it started (they run in the background; wait on a run id only when its result is needed now).',
			parameters: WriteInput,
			success: ToolAnswer
		});
		yield* add(
			actTool,
			Toolkit.make(actTool).toHandlers({
				act: (i, { toolCallId: id = '' }) =>
					guard(
						Effect.gen(function* () {
							if (typeof i.inputFile === 'string') {
								const read = yield* inputOfFile(i.inputFile);
								if ('error' in read) return err(read.error);
								i = { ...i, input: read.input };
							}
							if (!acts.has(i.callable) && !mayStart(i.callable))
								return err(`You may not run '${i.callable}'.`);
							if (
								x.inApp &&
								(acts.get(i.callable)?.confirm === true ||
									(i.callable.startsWith(`${AUTOMATION}.`) &&
										e.manifest.automations[i.callable.slice(AUTOMATION.length + 1)]?.agent ===
											'confirm'))
							)
								return { confirm: true } as const;
							return ok(yield* perform(x, i.callable, i.input ?? null, id));
						})
					)
			})
		);
	}
	if (x.mode === 'plan' && !x.child) {
		const updatePlanTool = Tool.make('update_plan', {
			description:
				'Write the draft plan: give body to replace it whole, or patch { old, new } to change one exact passage. expectedRevision is the revision you last saw.',
			parameters: Schema.Struct({
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
			success: ToolAnswer
		});
		yield* add(
			updatePlanTool,
			Toolkit.make(updatePlanTool).toHandlers({
				update_plan: (i) =>
					guard(
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
					)
			})
		);
	}
	{
		const goalsTool = Tool.make('goals', {
			description:
				"Set this conversation's checklist: the whole ordered list, each { id, text, status: pending | doing | done }. Ids are unique, at most one is doing, and a done goal stays done with its text unchanged.",
			parameters: Schema.Struct({
				items: Schema.Array(
					Schema.Struct({
						id: Schema.String.annotate({ description: 'stable id' }),
						text: Schema.String,
						status: Schema.Literals(['pending', 'doing', 'done'])
					})
				)
			}),
			success: ToolAnswer
		});
		yield* add(
			goalsTool,
			Toolkit.make(goalsTool).toHandlers({
				goals: (i) =>
					guard(
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
					)
			})
		);
	}
	if (agent) {
		const compactTool = Tool.make('compact', {
			description:
				'Checkpoint the conversation before your next step: a summary replaces the history (at most 3 per turn). Use it when the context is long and the work goes on.',
			parameters: Schema.Struct({
				reason: Schema.String.annotate({ description: 'why now' })
			}),
			success: ToolAnswer
		});
		yield* add(
			compactTool,
			Toolkit.make(compactTool).toHandlers({
				compact: (i) =>
					guard(
						Effect.gen(function* () {
							return x.compact(i.reason)
								? ok({ scheduled: true })
								: err('No more checkpoints this turn.');
						})
					)
			})
		);
	}
	const skills = Object.entries(x.skills).filter(
		([n]) => a.admin || a.capabilities.skills.includes(n) || !(n in e.manifest.agent.skills)
	);
	if (skills.length > 0) {
		const skillTool = Tool.make('skill', {
			description: `Read a skill: ${skills.map(([n, t]) => `${n} (${skillOf(t.text).description})`).join('; ')}. Give a section to read one part. Its scripts run as written with run_js { file: '<skill>/<path>' }.`,
			parameters: Schema.Struct({
				name: Schema.String.annotate({ description: 'skill' }),
				section: Schema.optionalKey(Schema.String.annotate({ description: 'a ## section' }))
			}),
			success: ToolAnswer
		});
		yield* add(
			skillTool,
			Toolkit.make(skillTool).toHandlers({
				skill: (i) =>
					guard(
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
									...(rest.length === 0
										? {}
										: { more: `read each with section: ${rest.join(', ')}` })
								});
							}
							return ok(
								section(s.body, i.section) ?? {
									error: `No section '${i.section}'.`,
									sections: s.sections
								}
							);
						})
					)
			})
		);
	}
	{
		const historyTool = Tool.make('history', {
			description:
				'Search earlier messages: in this conversation, or in all of the conversations of the person this turn serves (scope mine). Answers at most 50 hits naming their conversation.',
			parameters: Schema.Struct({
				query: Schema.String.annotate({ description: 'words to find' }),
				scope: Schema.optionalKey(Schema.Literals(['this', 'mine'])),
				limit: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'at most 50' })
				)
			}),
			success: ToolAnswer
		});
		yield* add(
			historyTool,
			Toolkit.make(historyTool).toHandlers({
				history: (i) =>
					guard(
						Effect.gen(function* () {
							return ok(
								yield* x.history(
									i.query,
									i.scope === 'mine' ? 'mine' : 'this',
									Math.max(1, Math.min(i.limit ?? 20, 50))
								)
							);
						})
					)
			})
		);
	}
	{
		const readOutputTool = Tool.make('read_output', {
			description:
				'Read more of a tool result that was clipped: the call id its clip note names (none for the latest clipped result) and the character offset to read from.',
			parameters: Schema.Struct({
				call: Schema.optionalKey(
					Schema.String.annotate({
						description: 'the tool call id; omit for the latest clipped result'
					})
				),
				offset: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({
						description: 'character offset, default 0'
					})
				)
			}),
			success: ToolAnswer
		});
		yield* add(
			readOutputTool,
			Toolkit.make(readOutputTool).toHandlers({
				read_output: (i) =>
					guard(
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
					)
			})
		);
	}
	if (x.conv.integration !== null) {
		const readMessagesTool = Tool.make('read_messages', {
			description:
				"Read this chat's messages not addressed to you that you have not read yet, oldest first (they are then marked read). " +
				'Give before: seq (or all: true) to read back through the whole history, newest first, from that message; each file lists the id read_file opens.',
			parameters: Schema.Struct({
				all: Schema.optionalKey(Schema.Boolean),
				limit: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'at most 50' })
				),
				before: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({
						description: 'read the history before this seq, newest first'
					})
				)
			}),
			success: ToolAnswer
		});
		yield* add(
			readMessagesTool,
			Toolkit.make(readMessagesTool).toHandlers({
				read_messages: (i, { toolCallId: id = '' }) =>
					guard(
						Effect.gen(function* () {
							const rows = yield* x.messages({
								unread: i.all !== true && i.before === undefined,
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
								note: 'Only messages since this account was connected are here; senders may have edited or deleted some since. Open a file with read_file { id }; read further back with before: the oldest seq here.'
							});
						})
					)
			})
		);
	}
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
	if (x.attachments !== undefined) {
		const readAttachmentTool = Tool.make('read_attachment', {
			description:
				'Read a file attached to a message (its seq and file index as the message lists them). The same file is a stored document with an id, so read_file can read it by that id too. The file type selects its format: screenshots and images, and PDF documents, are attached to your next step for you to inspect. Text is returned directly. For XLSX, choose a 0-based worksheet number; the response lists sheet names.',
			parameters: Schema.Struct({
				seq: Schema.Number.check(Schema.isInt()),
				file: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'index, default 0' })
				),
				...readAs
			}),
			success: ToolAnswer
		});
		yield* add(
			readAttachmentTool,
			Toolkit.make(readAttachmentTool).toHandlers({
				read_attachment: (i) =>
					guard(
						Effect.gen(function* () {
							const row = yield* x.row(i.seq);
							const file = row === undefined ? undefined : filesOf(row)[i.file ?? 0];
							if (file === undefined) return err('That message has no such file.');
							return yield* readStored(x.attachments!, file, i);
						})
					)
			})
		);
	}
	// a file already filed on a record (a scan on a job, a photo on a report): read only when the person reads that record
	if (x.attachments !== undefined) {
		const readFileTool = Tool.make('read_file', {
			description:
				"Read any stored file by its file reference ({ id }): a record's file field, any of this conversation's inputs (every [file: … id:…] line, filtered messages' files included) or outputs, or the same id a message attachment lists. Video and audio cannot be viewed: the answer says so. Its type selects image, PDF document, text or XLSX sheet. read_attachment is a shortcut for a message attachment by seq and file index; the id is the same document. Use it to compare values with the original evidence.",
			parameters: Schema.Struct({
				id: Schema.String.annotate({ description: 'the file id' }),
				...readAs
			}),
			success: ToolAnswer
		});
		yield* add(
			readFileTool,
			Toolkit.make(readFileTool).toHandlers({
				read_file: (i) =>
					guard(
						Effect.gen(function* () {
							const id = i.id ?? '';
							const [r] = yield* x.engine.db.read([
								{
									text: `SELECT f.field, f.created_by, EXISTS (
								SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.outputs) o
								WHERE c.id = $2 AND o->>'id' = f.id
							) AS own, EXISTS (
								SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.inputs) i
								WHERE c.id = $2 AND i->>'id' = f.id
							) AS here FROM sys_file f WHERE f.id = $1`,
									params: [id, x.conv.id]
								}
							]);
							const field = r?.rows[0]?.['field'],
								// an output of this conversation is the person's own file, including one just downloaded
								own = field === 'sys_conversation.outputs' && r?.rows[0]?.['own'] === true,
								member = x.authority.actor.kind === 'member' ? x.authority.actor.id : undefined,
								// an input of this conversation (a channel's received file has no uploader), or the member's own upload
								ownInput =
									field === 'sys_conversation.inputs' &&
									(r?.rows[0]?.['here'] === true ||
										x.authority.admin ||
										(member !== undefined && r?.rows[0]?.['created_by'] === member));
							if (!own && !ownInput) {
								if (
									typeof field !== 'string' ||
									!field.includes('.') ||
									field.startsWith('sys_conversation.')
								)
									return err('No file you can read has this id.');
								const readable = yield* readableFile(
									{
										manifest: x.engine.manifest,
										db: x.engine.db,
										read: x.engine.read,
										authority: x.authority,
										bindings: x.bindings
									},
									id,
									field
								);
								if (!readable) return err('No file you can read has this id.');
							}
							return yield* readStored(x.attachments!, { id }, i);
						})
					)
			})
		);
	}
	if (x.geocoder !== undefined) {
		const geocodeTool = Tool.make('geocode', {
			description:
				'Places for an address or place name ({ query }), or the place at a point ({ reverse: { lat, lng } }): at most 8, each with the point a geolocation field takes.',
			parameters: Schema.Struct({
				query: Schema.optionalKey(Schema.String.annotate({ description: 'an address or place' })),
				reverse: Schema.optionalKey(
					Schema.Struct({ lat: Schema.Number, lng: Schema.Number }).annotate({
						description: 'a { lat, lng } point'
					})
				)
			}),
			success: ToolAnswer
		});
		yield* add(
			geocodeTool,
			Toolkit.make(geocodeTool).toHandlers({
				geocode: (i) =>
					guard(
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
					)
			})
		);
	}
	const staff = a.actor.kind === 'member' && !a.actor.external;
	// one tool over the source: a text, a path to read, or nothing (the file list); the released source or the author's draft
	if (x.workspace !== undefined || x.draft !== undefined) {
		const workspaceSearchTool = Tool.make('workspace_search', {
			description:
				'Read or search the workspace source (src/: models, policies, teams, automations, apps, lib), as released or, with draft: true, your Studio draft. ' +
				'path reads one file as numbered lines (from and to a range); text finds the lines containing it (case-insensitive) in any file, paths narrowing it to path prefixes. ' +
				'workspace_list shows what a folder holds.',
			parameters: Schema.Struct({
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
			success: ToolAnswer
		});
		yield* add(
			workspaceSearchTool,
			Toolkit.make(workspaceSearchTool).toHandlers({
				workspace_search: (i) =>
					guard(
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
							return err(
								'Give path to read a file or text to search; workspace_list shows a folder.'
							);
						})
					)
			}),
			{ pure: true }
		);
		const workspaceListTool = Tool.make('workspace_list', {
			description:
				'List a folder of the workspace source: its subfolders (ending in /) and files, as released or, with draft: true, your Studio draft. ' +
				'Start at src/ and go down; read a file with workspace_search { path }.',
			parameters: Schema.Struct({
				path: Schema.optionalKey(
					Schema.String.annotate({ description: 'a folder, e.g. src/data/model/; default src/' })
				),
				draft: Schema.optionalKey(
					Schema.Boolean.annotate({ description: 'your Studio draft instead of the release' })
				)
			}),
			success: ToolAnswer
		});
		yield* add(
			workspaceListTool,
			Toolkit.make(workspaceListTool).toHandlers({
				workspace_list: (i) =>
					guard(
						Effect.gen(function* () {
							const ws = i.draft === true ? x.draft : x.workspace;
							if (ws === undefined)
								return err(
									i.draft === true
										? 'You have no Studio draft in this workspace.'
										: 'This workspace was built without its source.'
								);
							const dir = (i.path ?? 'src/').replace(/\/?$/, '/');
							const entries = new Set<string>();
							for (const f of yield* Port.attempt('workspace.files', () => ws.files()))
								if (f.startsWith(dir)) {
									const rest = f.slice(dir.length),
										cut = rest.indexOf('/');
									entries.add(cut < 0 ? rest : rest.slice(0, cut + 1));
								}
							return entries.size === 0
								? err(`Nothing is under '${dir}'.`)
								: ok({ path: dir, entries: [...entries].sort() });
						})
					)
			}),
			{ pure: true }
		);
	}
	// the platform's API reference (`@norbital-ai/bolt/docs`), narrowed to what a workspace imports; authoring is the staff's
	const reference = x.docs;
	if (staff && reference !== undefined) {
		const docsTool = Tool.make('docs', {
			description:
				'The API reference of what a workspace can import: bolt (the declaration functions and their types), bolt/page ($bolt in pages), ' +
				'bolt/test (the test kit), ui and ui/layout (views, field kinds, inputs, Form, primitives, layout), ui/capture and the std value libraries (std/date, std/decimal, …). ' +
				'Nothing given lists the namespaces; query searches names, summaries and signatures; namespace lists one; symbols (up to 8, with or without namespace) ' +
				'reads each: its signature, parameters or props, docs, examples and source. Read what you need in one call.',
			parameters: Schema.Struct({
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
			success: ToolAnswer
		});
		yield* add(
			docsTool,
			Toolkit.make(docsTool).toHandlers({
				docs: (i) =>
					guard(
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
											: [
													{ namespace: n, import: all.find((x) => x.namespace === n)!.module, ...s }
												];
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
									symbols: n.symbols.map((s) => ({
										name: s.name,
										kind: s.kind,
										summary: s.summary
									}))
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
					)
			})
		);
	}
	if (agent && x.delegation) {
		{
			const subagentTool = Tool.make('subagent', {
				description:
					`Delegate to sub-agents working with your authority, in the background: spawn { task, agent? } (agents: ${x.agents.join(', ')}) answers its conversation at once and it works on its own, several at once. ` +
					'Its report (its answer, a question for you, a failure) arrives as a message in this conversation: carry on with other work or end your reply, and you are prompted again when it arrives; wait pauses this turn for one instead. ' +
					'list shows your sub-agents and their status; read { conversation } shows one in detail: its checklist, last messages, the tool calls it made and what it changed or produced. ' +
					'message { conversation, text } answers or steers it (it carries on), stop { conversation } ends it. When it asks you something, answer with message, or ask the person if only they know.',
				parameters: Schema.Struct({
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
				success: ToolAnswer
			});
			yield* add(
				subagentTool,
				Toolkit.make(subagentTool).toHandlers({
					subagent: (i) =>
						guard(
							Effect.gen(function* () {
								const conv = i.conversation ?? '';
								switch (i.action) {
									case 'spawn': {
										const which = i.agent ?? null;
										if (which !== null && !x.agents.includes(which))
											return err(`No agent '${which}'.`);
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
						)
				})
			);
		}
	}
	const convert = e.convert,
		store = e.files;
	if (agent && convert !== undefined && store !== undefined && convert.targets.length > 0) {
		const documentTool = Tool.make('document', {
			description:
				`Make a document for the person with the document converter: to (${convert.targets.join(', ')}), name (the file name, with its extension) and markdown, the whole document's content (tables and inline HTML allowed); a pdf also takes page (A4, A3, Letter) and landscape. ` +
				'For a deck (pptx), each slide starts at a level-2 heading. The file is offered to the person under your reply, and its reference is what a file field takes.',
			parameters: Schema.Struct({
				to: Schema.Literals(convert.targets),
				name: Schema.String.annotate({ description: 'the file name, e.g. "Q3 report.pdf"' }),
				markdown: Schema.String.annotate({
					description: 'the whole content of the document, written out in Markdown'
				}),
				page: Schema.optionalKey(Schema.Literals(['A4', 'A3', 'Letter'])),
				landscape: Schema.optionalKey(Schema.Boolean)
			}),
			success: ToolAnswer
		});
		yield* add(
			documentTool,
			Toolkit.make(documentTool).toHandlers({
				document: (i) =>
					guard(
						Effect.gen(function* () {
							if (i.markdown.trim() === '') return err('Write the document out in markdown.');
							const bytes = yield* convert.convert({ markdown: i.markdown }, i.to, {
								...(i.page === undefined ? {} : { page: i.page }),
								...(i.landscape === undefined ? {} : { landscape: i.landscape })
							});
							return ok({
								files: [
									yield* storeFile(x, store, { name: i.name, mime: CONVERT_MIME[i.to], bytes })
								]
							});
						})
					)
			})
		);
	}
	// the person's own media from the web: the host fetches and stores it, so no bytes enter the engine
	if (agent && x.inApp && staff && store !== undefined) {
		const downloadTool = Tool.make('download', {
			description:
				"Save a media file (an image, audio, video, a PDF or an HTML page) at a public http(s) URL as the person's file: the host fetches it and keeps it only if its bytes are media, at most 100 MiB. Source code and archives are read with the browser, not downloaded.",
			parameters: Schema.Struct({
				url: Schema.String.annotate({ description: "the media file's public http(s) URL" })
			}),
			success: ToolAnswer
		});
		yield* add(
			downloadTool,
			Toolkit.make(downloadTool).toHandlers({
				download: (i) =>
					guard(
						Effect.gen(function* () {
							const file = yield* store.download(i.url);
							return ok({
								saved: file.name,
								mime: file.mime,
								bytes: file.bytes,
								file: yield* recordFile(x, file)
							});
						})
					)
			})
		);
	}
	// JavaScript in a fresh guest isolate, never the cell: inline code, or a skill's script run as written where the host
	// bundles files; its HTTP is granted as a host tool is
	const guest = e.guest,
		bundler = e.bundler,
		http =
			x.inApp && staff && (a.admin || a.capabilities.tools.includes('http')) ? e.http : undefined;
	if (agent && guest !== undefined) {
		const runJsTool = Tool.make('run_js', {
			description:
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
			parameters: Schema.Struct({
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
			success: ToolAnswer
		});
		yield* add(
			runJsTool,
			Toolkit.make(runJsTool).toHandlers({
				run_js: (i, { toolCallId: callId = '' }) =>
					guard(
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
								return err(
									"A repository reference's file runs without fetch: run it without http."
								);
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
					)
			})
		);
	}
	if (x.child) {
		const askParentTool = Tool.make('ask_parent', {
			description:
				'Ask the agent that delegated this task a question you cannot answer yourself (a choice, a missing fact, a confirmation). Your turn ends on it; its answer arrives as your next message and you carry on from there. Finish what you can first.',
			parameters: Schema.Struct({
				question: Schema.String.annotate({
					description: 'one clear question, with what you need to know'
				})
			}),
			success: ToolAnswer
		});
		yield* add(
			askParentTool,
			Toolkit.make(askParentTool).toHandlers({
				ask_parent: (i) =>
					guard(
						Effect.gen(function* () {
							if (i.question.trim() === '') return err('Ask a question.');
							x.ask(i.question.trim());
							return ok({
								asked: true,
								note: 'Stop here: your question goes to the delegating agent.'
							});
						})
					)
			})
		);
	}
	{
		const waitTool = Tool.make('wait', {
			description:
				"Wait for background work to finish: a sub-agent's report, jobs (long host calls) or automation runs (the run id act answered): the first of the given ones (every job when none) to settle, or nothing at the bound (at most 600 s). A settled run's file (an export, a template) is offered to the person under your reply.",
			parameters: Schema.Struct({
				jobs: Schema.optionalKey(Schema.Array(Schema.String)),
				seconds: Schema.optionalKey(
					Schema.Number.check(Schema.isInt()).annotate({ description: 'at most 600, default 120' })
				)
			}),
			success: ToolAnswer
		});
		yield* add(
			waitTool,
			Toolkit.make(waitTool).toHandlers({
				wait: (i) =>
					guard(
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
							if (
								ids.length === 0 &&
								x.jobs.pending().length === 0 &&
								(yield* x.subagent.running()) > 0
							)
								return ok(
									(yield* x.subagent.report(ms))
										? {
												report: 'arrived',
												note: 'A sub-agent report arrived: it is your next message.'
											}
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
					)
			})
		);
	}
	if (a.actor.kind === 'member') {
		const member = a.actor;
		// built here, not at module load: runs/index.ts reaches this module through the agent before RunViewRow exists
		const RunList = Schema.Struct({
			...RunViewRow.fields,
			finished: Schema.NullOr(Schema.String)
		});
		{
			const runsTool = Tool.make('runs', {
				description:
					'Automation runs, newest first: filter by automation (an exact name, or a prefix ending in *), status, cause and a due-time window; page with the cursor a page answers as next. ' +
					'Give id for one run in detail: its input, result, error, every attempt and its log lines. You see the runs of automations you hold and the runs you started (only their status, for runs you merely caused).',
				parameters: Schema.Struct({
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
				success: ToolAnswer
			});
			yield* add(
				runsTool,
				Toolkit.make(runsTool).toHandlers({
					runs: (i) =>
						guard(
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
						)
				})
			);
		}
	}
	if (a.admin && a.actor.kind === 'member') {
		const logsTool = Tool.make('logs', {
			description:
				"The workspace's runtime log (an administrator's), newest first: engine events and tenant code's console lines (event 'console'). " +
				'Filter by minimum level, text (in the event or its attributes), run id, automation, conversation and an at window; page with the cursor a page answers as next.',
			parameters: Schema.Struct({
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
			success: ToolAnswer
		});
		yield* add(
			logsTool,
			Toolkit.make(logsTool).toHandlers({
				logs: (i) =>
					guard(
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
					)
			})
		);
	}
	// MCP and host tools keep their raw JSON Schema: the model is shown it, and the handler validates the input against it
	const dynamic = (
		name: string,
		description: string,
		input: Json,
		call: (input: Json, callId: string) => Effect.Effect<ToolAnswer, EngineError | PortFailure>,
		meta: Omit<AgentTool, 'name'> = {}
	) =>
		Effect.gen(function* () {
			if (!Predicate.isObject(input)) return;
			const valid = validatorOf(input);
			const made = Tool.dynamic(name, { description, parameters: input, success: ToolAnswer });
			yield* add(
				made,
				Toolkit.make(made).toHandlers({
					[name]: (given: unknown, c: { readonly toolCallId?: string | undefined }) => {
						const checked = valid(given);
						return typeof checked === 'string'
							? Effect.succeed(err(checked))
							: guard(call(checked, c.toolCallId ?? ''));
					}
				}),
				meta
			);
		});
	if (agent)
		for (const t of x.mcpTools)
			yield* dynamic(
				`mcp__${t.server}__${t.name}`,
				`${t.description} (MCP server ${t.server})`,
				t.input,
				(i) => x.mcp.call(t.server, t.name, i).pipe(Effect.map(ok))
			);
	// the workspace's own search wins: an MCP tool named like a host search tool hides the host's
	const own = new Set(x.mcpTools.map((t) => t.name));
	if (x.inApp && staff)
		for (const host of x.hostTools)
			if (
				!(WORKSPACE_OVERRIDES.has(host.name) && own.has(host.name)) &&
				(agent || host.readOnly === true) &&
				(a.admin || a.capabilities.tools.includes(host.name))
			)
				yield* dynamic(
					host.name,
					host.description,
					host.input,
					(input, id) =>
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
								Port.attempt(host.name, (signal) => host.call(input, context, signal)).pipe(
									Port.call(host.name, JOBS.hostMs)
								)
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
						}),
					host.studio === undefined ? {} : { studio: host.studio }
				);
	// the panel's previewer shows the latest `preview` a result names: this is how the agent picks one explicitly
	const builds = entries.find((t) => t.studio === 'preview')?.name;
	if (builds !== undefined) {
		const previewShowTool = Tool.make('preview_show', {
			description: `Show a preview in the person's previewer beside the chat: url is a preview URL a ${builds} result gave. It only shows the page; it does not open or check it.`,
			parameters: Schema.Struct({
				url: Schema.String.annotate({ description: 'the preview URL' })
			}),
			success: ToolAnswer
		});
		yield* add(
			previewShowTool,
			Toolkit.make(previewShowTool).toHandlers({
				preview_show: (i) =>
					guard(
						Effect.succeed(
							/^https?:\/\//.test(i.url) && URL.canParse(i.url)
								? ok({ preview: i.url })
								: err('url is a preview URL (https://…)')
						)
					)
			})
		);
	}
	const toolkit = yield* Toolkit.make(...entries.map((entry) => entry.tool)).pipe(
		Effect.provideContext(Context.mergeAll(...entries.map((entry) => entry.handlers)))
	);
	return {
		tools: entries.map(({ name, studio, pure }) => ({
			name,
			...(studio === undefined ? {} : { studio }),
			...(pure === undefined ? {} : { pure })
		})),
		toolkit,
		// the input is decoded against the tool's own schema here, closed: the toolkit skips decoding a schema it does not
		// recognise as one, and an unchecked input would reach the handler with keys the schema never offered
		run: (name: string, input: unknown, callId: string) =>
			Schema.decodeUnknownEffect(
				entries.find((entry) => entry.name === name)?.tool.parametersSchema ?? Schema.Unknown,
				CLOSED
			)(input).pipe(
				Effect.flatMap((decoded) => toolkit.handle(name, decoded, callId, CLOSED)),
				Effect.flatMap(Stream.runLast),
				Effect.map((last) =>
					Option.getOrElse(
						Option.filter(
							Option.map(last, (handled) => handled.result),
							Schema.is(ToolAnswer)
						),
						() => err(`${name} answered nothing.`)
					)
				),
				// an unknown tool or a refused input (`Invalid parameters for tool …`): the model's answer
				Effect.catch((error) =>
					Effect.succeed(
						err(
							error.message.replace(
								/^Toolkit\.\w+\.handle: Invalid parameters for tool '\w+': /,
								''
							)
						)
					)
				)
			)
	} satisfies Catalogue;
});
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
