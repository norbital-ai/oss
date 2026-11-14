import { actor_ref } from '../access/actor.ts';
import { EFFECT_VERBS } from '../../decl/model.ts';
import { decode_acts } from '../callables/parse.ts';
// The agent catalogue: `read` (a layer map over what the actor may read, with runs, approvals, logs and the audit trail as
// ledger roots), `act` (guarded writes, approval decisions, automation starts), `sync` (native refresh and file transfer),
// `describe_workspace`, `page` (the person's open tab), `read_file`, `view_image` and `read_output` (files, ingests and
// clipped results), `run_js`, the plan tool, skills, `history`, `geocode`, `read_messages` on channel turns, the
// workspace source tools for staff, `document`, `download`, the sub-agent tools and `wait` under delegation, MCP tools a
// held policy names, and host tools (Studio, browser, personal skills) on in-app staff turns. A conversation's tool list is
// fixed by its audience (`fixedTools`); each definition owns its schema and decoder, and the step binds its handler under
// the current actor.
// A tool's text is static across workspaces and turns so providers cache the shared prefix: it says what the tool does, in a
// line or two, and names no model, path or sample; what an actor holds is `describe_workspace`'s, and a wrong name's error
// lists the right ones. The agent has no authority of its own: every call runs as the actor, so a refusal is
// the engine's answer, never the agent's.
import { describe_kind, kind_label, kind_signature } from '@norbital-ai/store/kind';
import { Validator } from '@cfworker/json-schema';
import {
	Clock,
	Deferred,
	Effect,
	FiberMap,
	FiberSet,
	Option,
	Predicate,
	PubSub,
	Result,
	Schema,
	type SchemaAST
} from 'effect';
import * as EffectArray from 'effect/Array';
import { Images, type Geo, type LogsShape } from '../ports.ts';
import { imageCrop, image_jpeg } from '../files/image.ts';
import {
	AuditQuery,
	CONVERT_MIME,
	CONVERT_TARGETS,
	type Downloaded,
	type HostTool,
	type HostToolContext,
	type ImageCrop,
	type Ingested,
	model_schema,
	PAPER_SIZES,
	Port,
	type PortFailure,
	REFERENCE,
	ReferenceIndex,
	type SearchAnswer,
	SKILL_FILE,
	type SearchRequest,
	type StudioRole,
	type ToolBehavior,
	type WorkspacePort
} from '@norbital-ai/host-api';
import { confirmed_send } from '../conversations/status.ts';
import type { EngineError } from '../errors.ts';
import { RUN_VIEW_COLUMNS, RunViewRow, run_view, visible_run_names } from '../runs/rows.ts';

import { readLog, runLog } from '../guest/telemetry.ts';
import { readableFile } from '../decision.ts';
import { toBase64 } from '../crypto.ts';
import { sha256_hex } from '@norbital-ai/store';
import { FOLDER_NOTES, role_at } from '../../decl/layout.ts';
import type { Json } from '../../decl/values.ts';
import { type Authority, type Bindings, type Outcome } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import { SYSTEM_UI, SystemUiRequest, systemUiPath } from '../../protocol/system-ui.ts';
import type { AgentQuestion } from '../../protocol/schema.ts';
import { exposed, outputsOf, readsAny, actorVarsOf, writable_columns } from '../access/authority.ts';
import {
	LayerRequestSchema,
	type ReadRequestJson
} from '../../protocol/read-request.ts';
import type { AgentEngine as Engine } from './index.ts';
import { lower_read, readableBy } from '../query/engine.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import { materializeEach } from '../runs/time.ts';
import {
	BOUNDS,
	bound,
	bounded,
	filesOf,
	localTime,
	outputText,
	size,
	shortId
} from './context.ts';
import { MODEL_FILES, ToolAnswer, type InferTool } from './ai.ts';
import {
	cached,
	dataLine,
	dataSummary,
	entryFiles,
	grep,
	imageIngest,
	imagesIn,
	INGEST_BYTES,
	outlineMap,
	route,
	stash,
	summary,
	textIngest,
	transcriptOf,
	unparsed,
	window,
	WINDOW_IMAGES,
	type Stash,
	StoredFile
} from './ingest.ts';
import { can_open, nav, navigation_paths } from '../../shell/nav.ts';
import { InvitationInput, inviteMany } from '../identity/members.ts';
export { ToolAnswer } from './ai.ts';
import { RUN_JS, runFile, runJs } from './run-js.ts';
import { layered, layers, type EngineManifest, type SkillSpec } from '../manifest.ts';
import { row as systemRow } from '../system/rows.ts';
import { SYSTEM } from '../../system/index.ts';
import { isList, isObj } from './draft.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { Chain } from '../write/sql.ts';
import type { McpSessions, McpTool } from './mcp.ts';
import {
	ambient,
	authorOf,
	type ConversationRow,
	type MessageRow,
	type Receipt
} from './schema.ts';
import { routesApproval } from '../approvals/lock.ts';
/** A skill the agent may read and whose scripts it may run: its tree's listing, and each file's bytes by its path. */
export type Skill = SkillSpec & {
	readonly read: (path: string) => Effect.Effect<Uint8Array, EngineError | PortFailure>;
};
/** Reads a message's file through the host: an image's bytes go to the model; text answers as text; anything else is ingested. */
export type AttachmentPort = {
	read(file: Json): Effect.Effect<
		| Json
		| {
				mime: string;
				bytes: Uint8Array;
		  },
		EngineError | PortFailure
	>;
};
export type SourceSearch = (request: SearchRequest) => Promise<SearchAnswer | undefined>;
/** A file past this is read for its text alone: a long tender's scans would not fit one answer. */
export const TEXT_FIRST_BYTES = 16 * 1024 * 1024;
/** Long work: a host call past 30 s (at most 10 minutes), an ingest. */
export const JOBS = { inlineMs: 30000, hostMs: 60000, waitMs: 120000, ingestMs: 600000 } as const;
type Jobs = Effect.Success<ReturnType<typeof jobs>>;
const jobFailed = (result: Json): string | undefined =>
	isObj(result) && typeof result['error'] === 'string' ? result['error'] : undefined;
/**
 * A turn's jobs. Each finished job leaves one steering line, taken once at the start of the turn's next step (`take`)
 * unless `wait` collected it first. A turn job is a child of the turn scope; a `detach`ed one (an ingest) runs on
 * `detached` and outlives the turn: what finishes after the turn closed, and what the turn left untaken, goes to `late`
 * (the agent queues it in the conversation and wakes it).
 */
export const jobs = Effect.fn('AgentTool.jobs')(function* (
	options: {
		readonly detached?: FiberSet.FiberSet<unknown, never>;
		readonly late?: (lines: readonly string[]) => Effect.Effect<void>;
		/** A job ended with its owner's declared behavior. */
		readonly ended?: (answer: Json, behavior: ToolBehavior) => void;
	} = {}
) {
	const fibers = yield* FiberMap.make<string, Json>();
	const late = options.late ?? (() => Effect.void);
	const all = new Map<
		string,
		{
			label: string;
			result: Deferred.Deferred<Json>;
			done: boolean;
			detached: boolean;
			alias: string | undefined;
			studio: StudioRole | undefined;
		}
	>();
	/** Finished jobs' steering lines, by job, not yet taken. */
	const lines = new Map<string, string>();
	let closed = false;
	yield* Effect.addFinalizer(() =>
		Effect.suspend(() => {
			closed = true;
			const left = [...lines.values()];
			lines.clear();
			return left.length === 0 ? Effect.void : late(left);
		})
	);
	return {
		add: Effect.fn('AgentTool.jobAdd')(function* (
			label: string,
			work: Effect.Effect<Json, EngineError | PortFailure>,
			o: {
				readonly detach?: boolean;
				readonly done?: (job: string, result: Json) => string;
				/** The whole line to the agent whichever way the job ended (a failure is the result, not something to report). */
				readonly alert?: (job: string, result: Json) => string;
				/** Another id `wait` and `has` know the job by (a run's id). */
				readonly alias?: string;
				readonly studio?: StudioRole;
				readonly behavior?: ToolBehavior;
			} = {}
		) {
			const id = globalThis.crypto.randomUUID().slice(0, 8),
				result = yield* Deferred.make<Json>();
			const detached = o.detach === true && options.detached !== undefined;
			const item = { label, result, done: false, detached, alias: o.alias, studio: o.studio };
			all.set(id, item);
			const run = work.pipe(
				Effect.catch((error) => Effect.succeed<Json>({ error: error.message })),
				Effect.tap((value) =>
					Effect.suspend(() => {
						item.done = true;
						const failed = jobFailed(value);
						options.ended?.(value, o.behavior ?? {});
						const line =
							o.alert?.(id, value) ??
							(failed !== undefined
								? `[job ${id} failed] ${label}: ${failed}`
								: (o.done?.(id, value) ??
									`[job ${id} done] ${label}: ${JSON.stringify(bounded(value).value)}`));
						if (!closed) {
							lines.set(id, line);
							return Effect.void;
						}
						return late([line]);
					})
				),
				Effect.tap((value) => Deferred.succeed(result, value))
			);
			if (detached && options.detached !== undefined)
				yield* FiberSet.run(options.detached, Effect.asVoid(run).pipe(Effect.ignore));
			else yield* FiberMap.run(fibers, id, run);
			return id;
		}),
		/** The first of `ids` (every job when none) to settle, collected: its steering line is not sent. */
		wait: Effect.fn('AgentTool.jobWait')(function* (ids: readonly string[], ms: number) {
			const open = [...all].filter(
				([id, item]) =>
					ids.length === 0 ||
					ids.includes(id) ||
					(item.alias !== undefined && ids.includes(item.alias))
			);
			if (open.length === 0) return null;
			const got = yield* Effect.raceAll(
				open.map(([id, item]) => Deferred.await(item.result).pipe(Effect.as(id)))
			).pipe(Effect.timeoutOption(ms));
			if (Option.isNone(got)) return null;
			const item = all.get(got.value);
			if (item === undefined) return null;
			const result = yield* Deferred.await(item.result);
			all.delete(got.value);
			lines.delete(got.value);
			return {
				job: got.value,
				label: item.label,
				result,
				...(item.studio === undefined ? {} : { studio: item.studio })
			};
		}),
		/** The finished jobs' steering lines, each once: the next step's input. */
		take: () => {
			const taken = [...lines];
			lines.clear();
			for (const [id] of taken) all.delete(id);
			return taken.map(([, line]) => line);
		},
		/** Whether every job of the turn (not a detached one) has finished, waiting at most `ms`. */
		settled: Effect.fn('AgentTool.jobsSettled')(function* (ms: number) {
			const open = [...all.values()].filter((item) => !item.detached && !item.done);
			if (open.length === 0) return true;
			return Option.isSome(
				yield* Effect.all(open.map((item) => Deferred.await(item.result))).pipe(
					Effect.timeoutOption(ms)
				)
			);
		}),
		pending: () => [...all].map(([id, item]) => ({ job: id, label: item.label, done: item.done })),
		/** Steering lines waiting for the next step. */
		ready: () => lines.size,
		/** Turn jobs still running: a reply meanwhile is interim. */
		running: () => [...all.values()].filter((item) => !item.detached && !item.done).length,
		has: (id: string) => all.has(id) || [...all.values()].some((item) => item.alias === id)
	};
});
export type ToolContext = {
	engine: Engine;
	conv: ConversationRow;
	authority: Authority;
	bindings: Bindings;
	turn: string;
	mode: 'agent' | 'plan';
	/** The person's own IANA zone when their client sent one (their clock). */
	tz?: string | undefined;
	/** The person's latest message (`HostToolContext.question`). */
	question?: string | undefined;
	/** Envoy turns have no confirmation card: `confirm` executes directly there. */
	inApp: boolean;
	delegation: boolean;
	/** A sub-agent's turn: no plan of its own and no sub-agents (one level deep). */
	child: boolean;
	mcp: McpSessions;
	/** The host's runtime log (`logs`, `automation_runs { id }`). */
	logs: LogsShape;
	mcpTools: readonly McpTool[];
	host_tools: readonly HostTool[];
	browser_tools: readonly HostTool[];
	attachments?: AttachmentPort | undefined;
	workspace?: WorkspacePort | undefined;
	/** The author's current working source; absent when this person authors nothing here. */
	draft?: WorkspacePort | undefined;
	/** The host's search over the caller's working tree; nothing back, the engine scans it itself. */
	search?: SourceSearch | undefined;
	geocoder?: Geo['Service'] | undefined;
	skills: { readonly [name: string]: Skill };
	agents: readonly string[];
	receipts: Receipt[];
	/** Whom the conversation serves: its fixed tool list. */
	audience: Audience;
	/** `view_image` crops this turn, by document. */
	zooms: Map<string, number>;
	/** The ingests this engine is running: a restart leaves none, so one marked running elsewhere was cut short. */
	reading: Set<string>;
	validators: Validators;
	/** The host's ingest port (plan 12, Norbital Convert): a file as HTML and its images. Absent: no document ingests. */
	ingest?:
		| ((
				file: { sha256: string; name: string; mime: string; key: string; size: number },
				read?: { readonly page?: number; readonly password?: string }
		  ) => Effect.Effect<Ingested | { readonly unsupported: string }, PortFailure>)
		| undefined;
	/** What the last step's calls opened, for the next request alone, each after the call that opened it. */
	files: {
		mime: string;
		bytes: Uint8Array;
		call?: string;
		id?: string;
	}[];
	jobs: Jobs;
	inlineMs?: number | undefined;
	setPlan(body: string): Effect.Effect<void, EngineError>;
	/** A sub-agent's question for its delegating agent: its turn ends on it, and the delegating agent's `message` resumes it. */
	ask(question: AgentQuestion): boolean;
	/** An instance's history, newest first before `before`. */
	messages(o: { limit: number; before?: number }): Effect.Effect<readonly MessageRow[], EngineError>;
	/** The whole output of a clipped call; `null` names the latest clipped call. */
	output(callId: string | null): Effect.Effect<Json | undefined, EngineError>;
	history(query: string, scope: 'this' | 'mine', limit: number): Effect.Effect<Json, EngineError>;
	/** Ends once input waits for this conversation: a `wait` gives way to it, so the step ends and the next takes it. */
	heard: Effect.Effect<void, EngineError>;
	subagent: {
		spawn(
			task: string,
			agent: string | null,
			done?: string,
			format?: string
		): Effect.Effect<Json, EngineError>;
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
	readonly description: string;
	readonly input: Json;
	readonly studio?: StudioRole;
	readonly behavior: ToolBehavior;
};
type ToolPresentation = Pick<AgentTool, 'name' | 'studio' | 'behavior'> & { readonly input: Json };
type BoundTool = {
	readonly tool: AgentTool;
	readonly run: (input: unknown, callId: string) => Effect.Effect<ToolAnswer, Error>;
};
/** This step's offered tools and their decoded calls, run as the current actor. */
export type Catalogue = {
	/** The audience's fixed tools, the host's, and the workspace's MCP tools as they are now. */
	readonly fixed: readonly AgentTool[];
	readonly host: readonly AgentTool[];
	readonly mcp: readonly AgentTool[];
	/** What this step may call. */
	readonly available: readonly AgentTool[];
	/** The catalogue note's lines by key (`catalogueNote`): skills, models, automations, syncs and MCP tools. */
	readonly index: CatalogueIndex;
	readonly presentation: (name: string, input: Json) => ToolPresentation;
	/** A refused input (closed: an unknown key is a wrong call) or a failure is the model's answer, never the turn's. */
	readonly run: (name: string, input: unknown, callId: string) => Effect.Effect<ToolAnswer>;
};
/** JSON tool parameters spell every value kind so model routers retain arrays and records. */
export const ToolJson: Schema.Codec<Json> = Schema.suspend(() =>
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
type ToolDefinition<A> = Pick<AgentTool, 'name' | 'description' | 'input' | 'behavior'> & {
	readonly decode: (input: unknown, options?: SchemaAST.ParseOptions) => Effect.Effect<A, Schema.SchemaError>;
};
/** Static definitions compile once; registering a step only binds the actor's handler. */
const defineTool = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(
	name: string,
	spec: { readonly description: string; readonly parameters: S; readonly behavior?: ToolBehavior }
): ToolDefinition<S['Type']> => ({
	name,
	description: spec.description,
	behavior: spec.behavior ?? {},
	input: model_schema(spec.parameters),
	decode: Schema.decodeUnknownEffect(spec.parameters, CLOSED)
});
/** One write `{ callable, input }`: a generated verb's input is its array of rows. */
export const WriteInput = Schema.Struct({
	callable: Schema.String,
	input: Schema.optionalKey(ToolJson),
	input_file: Schema.optionalKey(
		Schema.String.annotate({ description: 'a JSON file id, instead of input' })
	)
});
const ok = (result: Json): ToolAnswer => ({ result });
/**
 * A document's text as one answer, whole up to the result bound (never clipped cell-wise like a row's field): past it,
 * the start and a pointer, the whole kept for `read_output`.
 */
/** A page as a model reads it: whole it arrives too small for digits, so its four overlapping quarters come with it. */
const TILES = [
	{ left: 0, top: 0, right: 0.55, bottom: 0.55 },
	{ left: 0.45, top: 0, right: 1, bottom: 0.55 },
	{ left: 0, top: 0.45, right: 0.55, bottom: 1 },
	{ left: 0.45, top: 0.45, right: 1, bottom: 1 }
] as const;
/** At most this many pages in a read come with their quarters. */
const TILED_PAGES = 3;
/** `read_file` zooms into one document in a turn: past this a model is re-reading strokes, not finding anything. */
const ZOOMS = 3;
/** A write of at most this many rows answers them whole; a larger batch answers the columns it wrote. */
const WHOLE_ROWS = 5;
/** What `bolt build` proves its history with: large, and nothing in them is the author's to read. */
const GENERATED = /^migrations\/(?:snapshot|migrations\.lock|physical)\.json$/;
/** A search hit's line: enough to place it; workspace_read shows the rest. */
const HIT_CHARS = 240;
const PACKAGES = ': installed packages are outside the workspace: workspace_lang reads their types.';
/** What a source tool answers for a path outside the source: installed packages, or what the build writes from it. */
const outsideSource = (asked: string, path: string): string | undefined =>
	path === 'node_modules' || path.startsWith('node_modules/')
		? `${asked}${PACKAGES}`
		: path === '.norbital' || path.startsWith('.norbital/')
			? `${asked}: the build writes .norbital from your source (a model's binding from its +model.ts) and it is never read: workspace_lang reads its types.`
			: undefined;
const GENERATED_NOTE =
	'The build writes this. Never read or edit it: the schema is in each +model.ts and every step in migrations/*.sql.';
const documentAnswer = (answer: { readonly [key: string]: Json }, key: string): ToolAnswer => {
	const value = answer[key],
		text = typeof value === 'string' ? value : '',
		room = BOUNDS.resultBytes - 2_000;
	if (size(text) <= room) return { result: answer, bounded: true };
	return {
		result: { ...answer, [key]: text.slice(0, room) },
		full: answer,
		bounded: true
	};
};
/** Clips one value of a view to `bytes`; the whole view uses the value itself. */
type Clip = (v: Json, bytes: number) => Json;
/** A JSON value within `bytes` as the model reads it, or its leading text with a note naming where the rest is. */
const clipJson =
	(call: string): Clip =>
	(v, bytes) =>
		size(v) <= bytes
			? v
			: `${JSON.stringify(v).slice(0, bytes)}... [clipped, ${size(v)} bytes; read_output { call: '${call}' } reads it whole]`;
/** A view with its values clipped (bounded as any answer), the whole view kept for `read_output`. */
const clippedView = (view: (clip: Clip) => Json, call: string): ToolAnswer => ({
	result: bound(view(clipJson(call))),
	full: view((v) => v),
	bounded: true
});
/** Text as one answer, whole up to the result bound. */
const textAnswer = (text: string): ToolAnswer => {
	const room = BOUNDS.resultBytes - 2_000;
	return size(text) <= room
		? { result: text, bounded: true }
		: { result: text.slice(0, room), full: text, bounded: true };
};
/** OpenCode's `read`, `grep` and `glob` over the workspace's source: the same pages, in the same words. */
const READ_LINES = 2000;
/** A path as OpenCode resolves one, from the workspace root: `./a`, `/a` and `b/../a` are all `a`. */
const sourcePath = (path: string) => {
	const parts: string[] = [];
	for (const part of path.split('/'))
		if (part === '..') parts.pop();
		else if (part !== '' && part !== '.') parts.push(part);
	return parts.join('/');
};
const truncatedNote = (shown: number) =>
	`(Results are truncated: showing first ${shown} results. Consider using a more specific path or pattern.)`;
const filePage = (path: string, text: string, offset: number, limit: number) => {
	const { total, from, to, lines } = window(text, offset, offset + limit - 1, undefined, 'text');
	return offset > total
		? { error: `Offset ${offset} is out of range for ${path} (${total} lines)` }
		: {
				text: [
					`Read file ${path}, lines ${from}-${to}`,
					...lines,
					...(to < total ? [`[Output truncated. Continue reading with offset: ${to + 1}]`] : [])
				].join('\n')
			};
};
const grepAnswer = (
	hits: readonly { readonly path: string; readonly line: number; readonly text: string }[],
	truncated: boolean,
	files = false
) => {
	if (files)
		return [
			...(hits.length === 0
				? ['No files found']
				: [`Found ${hits.length} files`, ...hits.map((hit) => hit.path)]),
			...(truncated ? ['', truncatedNote(hits.length)] : [])
		].join('\n');
	const lines = [hits.length === 0 ? 'No matches found' : `Found ${hits.length} matches`];
	let current = '';
	for (const hit of hits) {
		if (current !== hit.path) {
			if (current !== '') lines.push('');
			current = hit.path;
			lines.push(`${hit.path}:`);
		}
		lines.push(`  Line ${hit.line}: ${hit.text}`);
	}
	return [...lines, ...(truncated ? ['', truncatedNote(hits.length)] : [])].join('\n');
};
/** A glob as ripgrep's `--glob` reads it: `**`, `*`, `?` and `{a,b}`; with no `/` it matches at any depth. */
export const globRegExp = (glob: string) => {
	const rooted = glob.includes('/') ? glob.replace(/^\.?\//, '') : `**/${glob}`;
	let regex = '',
		braces = 0;
	for (let at = 0; at < rooted.length; at++) {
		const char = rooted[at] ?? '';
		if (char === '*' && rooted[at + 1] === '*') {
			at++;
			if (rooted[at + 1] === '/') {
				at++;
				regex += '(?:.*/)?';
			} else regex += '.*';
		} else if (char === '*') regex += '[^/]*';
		else if (char === '?') regex += '[^/]';
		else if (char === '{') {
			braces++;
			regex += '(?:';
		} else if (char === '}' && braces > 0) {
			braces--;
			regex += ')';
		} else if (char === ',' && braces > 0) regex += '|';
		else regex += char.replace(/[.+^$()|\\[\]{}]/g, '\\$&');
	}
	return new RegExp(`^${regex}$`);
};
/** The source as an ASCII tree from the workspace root: a folder's note on the folder, a role's on its first file. */
const sourceTree = (files: readonly string[]): string => {
	type Folder = Map<string, Folder | null>;
	const root: Folder = new Map(),
		noted = new Set<string>(),
		lines = ['/  <- cwd'];
	for (const file of files) {
		const folders = file.split('/'),
			name = folders.pop() ?? '';
		let at = root;
		for (const folder of folders) {
			const next: Folder = at.get(folder) ?? new Map();
			at.set(folder, next);
			at = next;
		}
		at.set(name, null);
	}
	const walk = (folder: Folder, path: string, indent: string) => {
		const names = [...folder.keys()].sort();
		for (const [i, name] of names.entries()) {
			const last = i === names.length - 1,
				inner = folder.get(name),
				shown = inner == null ? name : `${name}/`,
				role = inner == null ? role_at(`${path}${name}`) : undefined,
				note =
					role === undefined || noted.has(role.role) ? FOLDER_NOTES[`${path}${shown}`] : role.note;
			if (role !== undefined) noted.add(role.role);
			lines.push(`${indent}${last ? '└── ' : '├── '}${shown}${note ? `  ${note}` : ''}`);
			if (inner != null) walk(inner, `${path}${name}/`, `${indent}${last ? '    ' : '│   '}`);
		}
	};
	walk(root, '', '');
	return lines.join('\n');
};
const err = (
	message: string
): {
	result: Json;
} => ({ result: { error: message } });
const VERBS = ['create', 'update', 'delete', 'import'] as const;
/** `act`'s callable for a decision on an approval request (`bolt.approvals.decide`). */
const APPROVE = 'approvals.decide';
const Decide = Schema.Struct({
	request_id: Schema.String,
	decision: Schema.Literals(['approve', 'reject', 'request_changes', 'withdraw']),
	reason: Schema.optionalKey(Schema.String)
});
/** `act { callable: 'automation.<name>' }` starts a declared automation now. */
const AUTOMATION = 'automation';
type Spec = { confirm?: true };
const before = (text: string, separator: string) => {
	const at = text.indexOf(separator);
	return at < 0 ? text : text.slice(0, at);
};
/** `---\ndescription: …\n---` then `##` sections. */
function skillOf(text: string): {
	description: string;
	body: string;
	sections: string[];
} {
	const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const description = fm?.[1] === undefined ? '' : (/^description:\s*(.*)$/m.exec(fm[1])?.[1] ?? '').trim();
	const body = fm === null ? text : text.slice(fm[0].length);
	return {
		description,
		body,
		sections: [...body.matchAll(/^##\s+(.+)$/gm)].flatMap((x) => x[1] === undefined ? [] : [x[1].trim()])
	};
}
function section(body: string, title: string): string | undefined {
	const parts = body.split(/^(?=##\s)/m);
	return parts.find(
		(p) => before(p.replace(/^##\s+/, ''), '\n').trim().toLowerCase() === title.toLowerCase()
	);
}
/**
 * The read outputs of `root` the actor may read (`default` first, then the named ones in declaration order). An
 * administrator reads every workspace model and the member directory; another built-in model only through a grant.
 */
export function readOutputs(m: EngineManifest, a: Authority, root: string): readonly string[] {
	if (root === 'sys_run') return [];
	return outputsOf(m, root).filter((output) => {
		const arms = a.models[root]?.read[output]?.[root] ?? [];
		return Object.hasOwn(SYSTEM.models, root)
			? // a built-in model only through a policy that names it, never the administrator's blanket arm; the member
				// directory is the exception: an administrator resolves the people a document names (a sales owner) by it
				arms.some((arm) => arm.policy !== '$admin' || root === 'sys_user')
			: arms.length > 0;
	});
}
/** The layer map of output `output` of `root`. */
const outputLayers = (m: EngineManifest, root: string, output: string) => {
	const spec = layered(m).exposures[root];
	return spec?.outputs[output] ?? {};
};
/**
 * What the actor may read: each read root (a model with `read`, never the run ledger) with an output it may read, with
 * every layer path those outputs declare.
 */
export function readPaths(m: EngineManifest, a: Authority): string[] {
	return Object.keys(layered(m).exposures).flatMap((root) => [
		...new Set(
			readOutputs(m, a, root).flatMap((output) => Object.keys(outputLayers(m, root, output)))
		)
	]);
}
/** What the actor may write, by model: the generated verbs its write arms admit, and approval decisions. */
function callablesFor(m: EngineManifest, a: Authority, identity = false): Map<string, Spec> {
	const acts = new Map<string, Spec>();
	for (const [c, spec] of Object.entries(m.exposures)) {
		const ca = a.models[c];
		for (const v of VERBS) {
			const arms =
				v === 'import'
					? Math.max(ca?.create.length ?? 0, ca?.update.length ?? 0)
					: (ca?.[v].length ?? 0);
			const declared =
				v === 'import'
					? spec.create !== undefined && (m.models[c]?.key?.length ?? 0) > 0
					: spec[v] !== undefined;
			if (declared && (a.admin || arms > 0))
				acts.set(`${c}.${v}`, Object.hasOwn(SYSTEM.models, c) ? { confirm: true } : {});
		}
	}
	if (identity && a.admin && a.actor.kind === 'member' && !a.actor.external)
		acts.set('sys_invitation.create', { confirm: true });
	// a decision on a pending approval: the approvals engine admits only the step's approvers; the person confirms in the app
	if (mayDecide(m, a)) acts.set(APPROVE, { confirm: true });
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
/** A committed or held write joins the turn's receipts. */
function receipt(receipts: Receipt[], callable: string, o: Outcome): void {
	if (o.kind !== 'committed' && o.kind !== 'pending_approval') return;
	const records = o.records.map(({ model, id }) => ({ model, id }));
	receipts.push(
		o.kind === 'committed'
			? { outcome: 'committed', callable, records }
			: { outcome: 'pending_approval', callable, request_id: o.request_id, records }
	);
}
/** The queued or running run of `automation` over `input` (and by `actor`, when named), oldest first. */
const activeRun = (e: Engine, automation: string, input: Json, actor?: string) =>
	e.db
		.read([
			{
				text: `SELECT id FROM sys_run WHERE automation = $1 AND input = $2::jsonb AND state IN ('queued', 'running')
					AND ($3::text IS NULL OR actor = $3) ORDER BY due_at LIMIT 1`,
				params: [automation, JSON.stringify(input), actor ?? null]
			}
		])
		.pipe(Effect.map(([active]) => {
			const id = active?.rows[0]?.['id'];
			return typeof id === 'string' ? id : undefined;
		}));
/** A run's end, read once the ledger says it ended (`RunEnds`, never a poll): its result, or why it did not succeed. */
const runEnd = (e: Engine, a: Authority, run: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const ends = e.runEnds;
			if (ends === undefined)
				return yield* BoltError.make('unavailable', 'facility', 'this host does not follow runs');
			const subscription = yield* PubSub.subscribe(ends);
			for (;;) {
				const row = yield* e.db.one(RunViewRow, {
					text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`,
					params: [run]
				});
				if (Option.isNone(row))
					return yield* BoltError.make('invalid_input', 'admission', `run ${run} is gone`);
				const state = row.value.state;
				if (state === 'succeeded' || state === 'skipped') {
					const view = run_view(a, row.value);
					return {
						status: state,
						...(view?.result === undefined ? {} : { result: view.result })
					};
				}
				if (state !== 'queued' && state !== 'running')
					return yield* Effect.fail(
						BoltError.make(
							'guest_error',
							'guest',
							state === 'stopped'
								? 'the run was stopped'
								: (row.value.error?.message ?? `the run ${state}`)
						)
					);
				while (!(yield* PubSub.take(subscription)).includes(run));
			}
		})
	);
/**
 * A run the agent started is always a job (like an ingest): `act` answers at once with `{ job, run }`, and the run's end
 * (succeeded, failed, stopped, or the start held for approval) steers the next step once, or wakes the conversation.
 */
export const runJob = Effect.fn('AgentTool.runJob')(function* (
	jobs: Jobs,
	e: Engine,
	a: Authority,
	callable: string,
	answer: Json
) {
	if (!isObj(answer) || typeof answer['run'] !== 'string') return answer;
	const run = answer['run'],
		outcome = answer['outcome'],
		kind = isObj(outcome) ? outcome['kind'] : undefined;
	if (kind !== undefined && kind !== 'committed' && kind !== 'pending_approval') return answer;
	const name = callable.startsWith(`${AUTOMATION}.`) ? callable.slice(AUTOMATION.length + 1) : callable;
	const sync_at = name.indexOf('.sync.');
	const label = sync_at < 0 ? `automation ${name}` : `sync ${name.slice(0, sync_at)}.${name.slice(sync_at + 6)}`;
	const held = kind === 'pending_approval' && isObj(outcome) ? String(outcome['request_id'] ?? '') : undefined;
	const job = yield* jobs.add(
		label,
		held === undefined ? runEnd(e, a, run) : Effect.succeed<Json>({ status: 'held', request: held }),
		{
			detach: true,
			alias: run,
			done: (id, result) => {
				const r = isObj(result) ? result : {};
				const said =
					r['status'] === 'held'
						? `held for approval (request ${String(r['request'])})`
						: `${String(r['status'] ?? 'succeeded')}${r['result'] === undefined ? '' : `: ${JSON.stringify(bounded(r['result'] ?? null).value).slice(0, 600)}`}`;
				return `[job ${id} done] ${label} run ${run} → ${said}`;
			}
		}
	);
	return {
		job,
		...answer,
		note: 'Its end arrives by itself, or wakes this conversation.'
	};
});
/** Runs one `act` write under the call's key and answers its outcome. */
export const perform = Effect.fn('AgentTool.perform')(function* (
	x: Pick<ToolContext, 'engine' | 'authority' | 'bindings' | 'turn' | 'receipts'> & {
		/** The in-app agent's conversation: a start it makes for its member records it on the run's trigger. */
		readonly agent?: { readonly conversation: string };
	},
	callable: string,
	input: Json,
	callId: string
) {
	if (callable === 'sys_invitation.create') {
		if (
			x.engine.identity === undefined ||
			!x.authority.admin ||
			x.authority.actor.kind !== 'member' ||
			x.authority.actor.external
		)
			return { error: 'Only an active workspace administrator may invite members.' };
		const decoded = Schema.decodeUnknownResult(
			Schema.Array(InvitationInput).check(Schema.isMinLength(1), Schema.isMaxLength(1000))
		)(input);
		if (Result.isFailure(decoded)) return { error: decoded.failure.message };
		const result = yield* inviteMany(
			x.engine.identity,
			x.engine.manifest,
			x.authority,
			decoded.success
		);
		const records = result.ids.map((id) => ({ model: 'sys_invitation', id }));
		x.receipts.push({ outcome: 'committed', callable, records });
		return { kind: 'committed', records, output: result };
	}
	if (callable === APPROVE) {
		const d = Option.getOrUndefined(Schema.decodeUnknownOption(Decide)(input));
		if (d === undefined)
			return {
				error: `${APPROVE} takes { request_id, decision: approve | reject | request_changes | withdraw, reason? }`
			};
		return yield* x.engine.approvals.decide({
			...d,
			authority: x.authority,
			now: x.bindings.now
		});
	}
	if (callable.startsWith(`${AUTOMATION}.`)) {
		const automation = callable.slice(AUTOMATION.length + 1),
			args = input ?? {},
			agent = x.agent === undefined ? {} : { agent: x.agent };
		if (x.engine.manifest.automations[automation]?.agent === 'never')
			return { error: `You may not run '${callable}'.` };
		if (x.engine.manifest.automations[automation]?.mode === 'call')
			return yield* x.engine.automations.call({ automation, input: args, authority: x.authority, bindings: x.bindings, ...agent });
		// the same automation over the same input, queued or running, is that run: a model asking again must not queue a
		// second one (a local probe started one review three times while the first placed 426 photos)
		const existing = yield* activeRun(x.engine, automation, args);
		if (existing !== undefined) return { run: existing, already_active: true };
		const run = globalThis.crypto.randomUUID();
		const outcome = yield* x.engine.calls.start({
			automation,
			runs: [{ id: run, input: args }],
			authority: x.authority,
			bindings: x.bindings,
			...agent
		});
		// This receipt commits the queue admission; the run records its business result after execution.
		receipt(x.receipts, callable, outcome);
		return { run, outcome };
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
	const decoded = yield* decode_acts(x.engine.manifest, { [callable]: input });
	const r = yield* x.engine.calls.acts({
		...common,
		name: 'act',
		from: 'Client',
		acts: decoded.acts,
		outputs: decoded.outputs
	});
	receipt(x.receipts, callable, r.outcome);
	if (r.outcome.kind !== 'committed' || name === 'delete') return r.outcome;
	// the stored rows, as the actor reads them: one read request, a root per written model (at most 20 rows each) with its
	// first-level layers (child lines, linked records), so the answer is the read-back
	const reads = Object.entries(
		Object.groupBy(
			r.outcome.records.filter((c) => c.model in x.engine.manifest.exposures),
			(c) => c.model
		)
	);
	// what the write supplied, per root: its own columns and the child lists it wrote, each with their columns
	const supplied = name === 'import' && Predicate.isObject(input) ? input['rows'] : input;
	const rowsIn = isList(supplied) ? supplied : [];
	const written = (rows: readonly Json[]) => {
		const own = new Set<string>(),
			lists = new Map<string, Set<string>>();
		for (const row of rows) {
			const fields = isObj(row) ? (isObj(row['set']) ? row['set'] : row) : {};
			for (const [key, value] of Object.entries(fields)) {
				if (isList(value) && value.every(isObj)) {
					const cols = lists.get(key) ?? new Set<string>();
					for (const v of value) if (isObj(v)) for (const k of Object.keys(v)) cols.add(k);
					lists.set(key, cols);
				} else if (key !== 'target') own.add(key);
			}
		}
		return { own: [...own], lists };
	};
	const wrote = written(rowsIn);
	const references = (model: string) =>
		Object.entries(x.engine.manifest.relationships)
			.filter(([key]) => key.startsWith(`${model}.`))
			.map(([key, relation]) => ({ field: key.slice(model.length + 1), to: relation.to }));
	const layersOf = (root: string, output: string) =>
		Object.keys(outputLayers(x.engine.manifest, root, output)).filter(
			(path) =>
				path.startsWith(`${root}.`) &&
				!path.slice(root.length + 1).includes('.') &&
				wrote.lists.has(path.slice(root.length + 1))
		);
	const readBack =
		reads.length === 0
			? Result.succeed<typeof StoredReadBack.Type>({})
			: yield* lower_read(x.engine.manifest, 'query', [
							Object.fromEntries(
								reads.map(([c, rows]) => {
									const output = readOutputs(x.engine.manifest, x.authority, c)[0] ?? 'default';
									return [
										c,
										{
											where: { id: { in: (rows ?? []).slice(0, 20).map((row) => row.id) } },
											...(output === 'default' ? {} : { output }),
											// a batch's read-back is what was written; a small write's is the whole row, generated values with it
											...(c === model && wrote.own.length > 0 && rowsIn.length > WHOLE_ROWS
												? {
														fields: [
															...new Set([...wrote.own, ...references(c).map((r) => r.field)])
														].filter((f) =>
															exposed(x.engine.manifest, c, c, c, output).includes(f)
														)
													}
												: {}),
											// each written list as its nested relation
											...Object.fromEntries(
												layersOf(c, output).map((path) => [
													path.slice(c.length + 1),
													{
														fields: [
															...new Set([
																...(wrote.lists.get(path.slice(c.length + 1)) ?? []),
																...references(layers(x.engine.manifest)[c]?.[path] ?? c).map(
																	(r) => r.field
																)
															])
														].filter((f) =>
															exposed(
																x.engine.manifest,
																c,
																path,
																layers(x.engine.manifest)[c]?.[path] ?? c,
																output
															).includes(f)
														)
													}
												])
											)
										}
									];
								})
							)
						]).pipe(
					Effect.mapError((cause) =>
						BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
					),
					Effect.flatMap(readAs(x)),
					Effect.flatMap(Schema.decodeUnknownEffect(StoredReadBack)),
					Effect.tapCause(Effect.logWarning),
					Effect.result
				);
	const stored: typeof StoredReadBack.Type = Result.isSuccess(readBack) ? readBack.success : {};
	const writtenById = new Map(r.outcome.records.map((row) => [`${row.model}:${row.id}`, row]));
	const fieldMap = new Map<string, Json>();
	for (const [path, layer] of Object.entries(stored)) {
		const root = path.split('.')[0] ?? path;
		const model = layers(x.engine.manifest)[root]?.[path] ?? root;
		for (const row of layer.rows)
			for (const reference of references(model)) {
				const value = row[reference.field];
				if (typeof value !== 'string') continue;
				const target = writtenById.get(`${reference.to}:${value}`);
				const field = `${model}.${reference.field}`;
				fieldMap.set(`${row.id}:${field}`, {
					model,
					row: row.id,
					field,
					targetModel: reference.to,
					value,
					decision: target === undefined ? 'LINK' : target.revision === 1 ? 'CREATE' : 'UPDATE'
				});
			}
	}
	// the effect runs this write queued carry its record ids (`queue_effects`): answer them, so the model can `wait` on one
	const ids = r.outcome.records.map((c) => c.id);
	const queued =
		ids.length === 0
			? Result.succeed([])
			: yield* x.engine.db
					.rows(Schema.Struct({ id: Schema.String, automation: Schema.String }), {
						text: `SELECT id, automation FROM sys_run
		WHERE state IN ('queued', 'running') AND cause = 'effect'
		AND input -> 'ids' ?| ARRAY(SELECT jsonb_array_elements_text($1::jsonb))`,
						params: [JSON.stringify(ids)]
					})
					.pipe(Effect.tapCause(Effect.logWarning), Effect.result);
	const runs = Result.isFailure(queued)
		? []
		: queued.success.map(({ id, automation }) => ({ run: id, automation }));
	return {
		...r.outcome,
		...(fieldMap.size === 0 ? {} : { fieldMap: [...fieldMap.values()] }),
		...(Result.isFailure(readBack)
			? {
					read_back_error: `The write committed. Stored rows could not be read: ${readBack.failure.message}`
				}
			: { stored }),
		...(Result.isFailure(queued)
			? {
					runs_lookup_error: `The write committed. Queued runs could not be read: ${queued.failure.message}`
				}
			: {}),
		...(runs.length === 0 ? {} : { runs }),
		...(r.outcome.unchanged === undefined
			? {}
			: {
					note: r.outcome.unchanged
						.map(
							({ model, id }) =>
								`no change: ${model} ${id} already holds these values (a write callback may derive them)`
						)
						.join('; ')
				})
	};
});
type OpenedFile = { mime: string; bytes: Uint8Array; id?: string };
/**
 * A file into the next request, at its end: what a request carries there no later request's prefix holds, so a sent
 * message never changes, however many files a conversation opens, and no step sends a file twice.
 */
const attach = (files: OpenedFile[], file: OpenedFile): 'shown' | 'none' => {
	if (file.id !== undefined && files.some((f) => f.id === file.id)) return 'shown';
	const bytes = files.reduce((sum, f) => sum + f.bytes.byteLength, 0) + file.bytes.byteLength;
	if (files.length >= MODEL_FILES.count || bytes > MODEL_FILES.bytes) return 'none';
	files.push(file);
	return 'shown';
};
/** What the model is told of a file it opened. */
const ATTACHED = {
	shown: 'shown on your next step only',
	none: 'not shown: too many images at once'
} as const;
const guard = (
	work: Effect.Effect<ToolAnswer, EngineError | PortFailure>
): Effect.Effect<ToolAnswer> =>
	work.pipe(Effect.catch((error) => Effect.succeed(err(error.message))));
/** Effect has no importer for active JSON Schema conditionals: the ABI validator decodes a raw schema's input in its handler. */
const validatorOf = (json: { readonly [k: string]: Json }) => {
	const validator = new Validator(json, '2020-12', false);
	return (value: unknown): Json | string => {
		// a schema it cannot follow (an MCP server's dangling `$ref`) checks nothing: the tool still judges its own input
		const checked = Result.try(() => validator.validate(value));
		if (Result.isSuccess(checked) && !checked.success.valid)
			return `Invalid input: ${checked.success.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join('; ')}`;
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
/** `read`'s request path once lowered: one engine read as the actor. A write's read-back reads through it too. */
const readAs = (x: ReadToolContext) => (ir: ReadIR) =>
	x.engine.read([ir], { as: 'caller', authority: x.authority }, x.bindings).pipe(Effect.map(([got]) => got ?? null));
/** The stored rows a committed write returns. Omit the pages' cursors. */
const StoredReadBack = Schema.Record(
	Schema.String,
	Schema.Struct({
		rows: Schema.Array(
			Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
				Schema.Record(Schema.String, Schema.Json)
			])
		)
	})
);
/** A read answer without their pages' `next` cursor: the answer is those rows, not a read to page. */
const uncursored = (v: Json): Json =>
	!Predicate.isObject(v) || EffectArray.isArray<typeof v>(v)
		? v
		: 'rows' in v
			? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'next'))
			: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, uncursored(x)]));

/**
 * How a root may be searched, from its declaration: the words of `search` over its text fields (those this output reads,
 * and the records they link to), each named index with the input it takes, and semantic search. `null`: it has none,
 * and only `where` narrows it.
 */
function searchOf(m: EngineManifest, model: string, readable: readonly string[]): Json {
	const spec = m.models[model]?.search;
	const text = (spec?.text ?? []).filter((f) => readable.includes(f));
	const indexes = Object.entries(spec?.indexes ?? {});
	if (text.length === 0 && indexes.length === 0 && spec?.semantic === undefined) return null;
	return {
		...(text.length === 0
			? {}
			: {
					text: {
						fields: text,
						use: 'search: "<words>" ranks, not proof; where: { "$search": "<words>" } requires each'
					}
				}),
		...Object.fromEntries(
			indexes.map(([name, index]) => [
				name,
				{
					about: index.description,
					input: Object.fromEntries(
						Object.entries(index.input).map(([f, k]) => [f, describe_kind(k, (name) => m.custom_fields[name]?.shape)])
					),
					use: `search: { "${name}": <input> }`
				}
			])
		),
		...(spec?.semantic === undefined
			? {}
			: {
					semantic: { fields: spec.semantic.fields, use: 'search: { "semantic": "<text>" }' }
				})
	};
}
/**
 * `describe`: a read key's declared shape in one output — each field and its kind (a link names its model, an enum or
 * state its values), the layers declared below it, and on a root how it may be searched, the outputs the caller may read
 * and the writes it may call with the columns each takes (a create's required ones named). The model API in one small answer, instead of its source.
 */
/** A read key's fields in one output, each with its kind: a link names its model. */
function fieldKinds(m: EngineManifest, path: string, output: string): Record<string, string> {
	const root = before(path, '.'),
		model = layers(m)[root]?.[path] ?? root,
		all = layered(m);
	const kind = (f: string): string => {
		const link = all.relationships[`${model}.${f}`];
		if (link !== undefined) return `link to ${[link.to].flat().join(' | ')}`;
		const d = all.models[model]?.fields[f];
		if (d === undefined) return 'system';
		return kind_label(d);
	};
	return Object.fromEntries(exposed(m, root, path, model, output).map((f) => [f, kind(f)]));
}
function shapeOf(m: EngineManifest, a: Authority, path: string, output = 'default'): Json {
	const root = before(path, '.'),
		model = layers(m)[root]?.[path] ?? root,
		all = layered(m);
	const kinds = fieldKinds(m, path, output),
		fields = Object.keys(kinds);
	const below = Object.keys(outputLayers(m, root, output)).filter(
		(p) => p.startsWith(`${path}.`) && !p.slice(path.length + 1).includes('.')
	);
	const writes = path.includes('.')
		? []
		: [...callablesFor(m, a).keys()].filter((c) => c.startsWith(`${root}.`));
	const columns = (verb: 'create' | 'update') => all.exposures[root]?.[verb]?.columns;
	const requiredOf = (owner: string) => (f: string) => {
		const link = all.relationships[`${owner}.${f}`];
		if (link !== undefined) return link.optional !== true && link.default === undefined;
		const d = all.models[owner]?.fields[f];
		return (
			d !== undefined &&
			d.optional !== true &&
			d.default === undefined &&
			!['seq', 'sum', 'count', 'state'].includes(d.kind)
		);
	};
	const outputs = path.includes('.') ? [] : readOutputs(m, a, root);
	return {
		model,
		...(output === 'default' ? {} : { output }),
		...(outputs.length > 1 || outputs[0] !== output ? { outputs } : {}),
		fields: kinds,
		...(path.includes('.') ? {} : { search: searchOf(m, model, fields) }),
		...(below.length === 0
			? {}
			: { layers: Object.fromEntries(below.map((p) => [p, layers(m)[root]?.[p] ?? ''])) }),
		...(writes.length === 0
			? {}
			: {
					writes: Object.fromEntries(
						writes.map((c) => {
							const verb = c.slice(root.length + 1);
							// the held policies whose check judges this write (it may allow, refuse or hold it for approval); an
							// arm without a check allows, so with one held (an administrator's) no check holds a batch
							const arms = (
								verb === 'import'
									? (['create', 'update'] as const)
									: verb === 'create' || verb === 'update' || verb === 'delete'
										? ([verb] as const)
										: []
							).flatMap((v) => a.models[root]?.[v] ?? []);
							const judges =
								arms.length > 0 && arms.every((arm) => arm.check)
									? [...new Set(arms.map((arm) => arm.policy))]
									: [];
							const checks = judges.length === 0 ? {} : { checks: judges };
							const cols = verb === 'create' || verb === 'update' ? columns(verb) : undefined;
							if (cols === undefined) return [c, judges.length === 0 ? true : checks];
							// the caller's own columns: the model's, narrowed to what its policies let it write
							const allowed = writable_columns(a, root, verb === 'create' ? 'create' : 'update');
							const own =
								allowed === 'all'
									? cols
									: { ...cols, [root]: (cols[root] ?? []).filter((f) => allowed.has(f)) };
							// a create's columns that have no default and are not optional: leaving one out is refused
							const required = verb === 'create' ? (cols[root] ?? []).filter(requiredOf(root)) : [];
							return [
								c,
								{ columns: own, ...(required.length === 0 ? {} : { required }), ...checks }
							];
						})
					)
				})
	};
}
/** An automation with its input, so the first start is the right one (an omitted input runs it over everything). */
const automationSignature = (m: EngineManifest, name: string) =>
	`${name}(${Object.entries(m.automations[name]?.input ?? {})
		.map(([field, kind]) => `${field}${kind.optional ? '?' : ''}: ${kind.kind === 'rows' ? `rows<${kind.of}>` : kind_signature(kind)}`)
		.join(', ')})`;
/** `describe_workspace`'s whole map is at most this many bytes; past it, items are named for a call with `names`. */
export const OVERVIEW_BYTES = 12_000;
/** The base message catalogue's `'key': 'text'` pairs, read from its source. */
// ponytail: a regex over the source, not a TS parse; a key or text with a quote inside is skipped
export const messageCatalogue = (source: string | null): ReadonlyMap<string, string> =>
	new Map(
		[...(source ?? '').matchAll(/'([^'\n]+)':\s*'((?:[^'\\\n]|\\.)*)'/g)].flatMap(
			([, key, value]) => key === undefined || value === undefined ? [] : [[key, value] as const]
		)
	);
/**
 * The workspace as a map, scoped to the caller: its basics, the apps they open (group ▸ app ▸ pages), the models they
 * read or write (description, outputs, writes, links, states, effects, syncs, search, notices) and the automations they
 * start (signature, description, trigger, agent use). `names` answers each named item in full: a model or layer with its
 * fields and your writes, an app, or an automation.
 */
export function describeWorkspace(
	m: EngineManifest,
	a: Authority,
	messages: ReadonlyMap<string, string>,
	names: readonly string[] = [],
	totals: ReadonlyMap<string, number> = new Map()
): string {
	const all = layered(m),
		t = (key: string) => messages.get(key) ?? key,
		acts = [...callablesFor(m, a).keys()];
	const roots = new Set(readPaths(m, a).filter((path) => !path.includes('.')));
	const apps = [...new Set([...(m.workspace.apps ?? []), ...Object.keys(m.apps)])].filter(
		(name) => m.apps[name] !== undefined && can_open(m, a, name)
	);
	const models = Object.keys(all.models).filter(
		(name) => roots.has(name) || acts.some((c) => c.startsWith(`${name}.`))
	);
	const automations = a.automations.filter((name) => m.automations[name] !== undefined);
	const app = (name: string) => {
		const spec = m.apps[name];
		if (spec === undefined) return name;
		const group = name.includes('/') ? name.slice(0, name.indexOf('/')) : undefined,
			label = group === undefined ? undefined : m.groups?.[group]?.title;
		return [
			`${group === undefined ? '' : `${group}${label === undefined ? '' : ` "${t(label)}"`} ▸ `}${name} "${t(spec.title)}": ${t(spec.description)}`,
			...Object.entries(spec.pages).map(
				([page, p]) =>
					`  ├ /app/${name}/${page} "${t(p.title)}"${p.section === undefined ? '' : ` section "${t(p.section)}"`}${p.portal === true ? ' portal' : ''}`
			)
		].join('\n');
	};
	const model = (name: string) => {
		const spec = all.models[name], ex = all.exposures[name];
		if (spec === undefined) return name;
		const links = Object.entries(all.relationships).flatMap(([key, r]) => [
			...(key.startsWith(`${name}.`)
				? [`${key.slice(name.length + 1)} → ${[r.to].flat().join(' | ')}`]
				: []),
			...([r.to].flat().includes(name) && r.inverse !== undefined
				? [`${r.inverse} (many ${key.slice(0, key.indexOf('.'))})`]
				: [])
		]);
		const states = Object.entries(spec.fields).flatMap(([f, d]) =>
			d.kind === 'state' ? [`${f}: ${Object.keys(d.states).join(' | ')}`] : []
		);
		const writes = acts
			.filter((c) => c.startsWith(`${name}.`))
			.map((c) => c.slice(name.length + 1));
		const line = (label: string, items: readonly string[]) =>
			items.length === 0 ? [] : [`  ${label} ${items.join(' · ')}`];
		const outputs = roots.has(name) ? readOutputs(m, a, name) : [],
			total = totals.get(name);
		return [
			`${name} "${before(spec.description, '\n').trim()}"${total === undefined ? '' : ` · ${total} ${total === 1 ? 'row' : 'rows'}`}`,
			...line('reads', outputs),
			// a named model answers its fields in its shape below instead
			...line(
				'fields',
				outputs[0] === undefined || names.length > 0
					? []
					: Object.entries(fieldKinds(m, name, outputs[0])).map(([field, kind]) => `${field} ${kind}`)
			),
			...line('writes', writes),
			...line('links', links),
			...line('state', states),
			...line('effects', EFFECT_VERBS.filter((verb) => ex?.[verb]?.effect === true)),
			...line(
				'syncs',
				Object.entries(ex?.syncs ?? {}).map(([sync, x]) => `${sync} (${x.with})`)
			),
			...line('search', Object.keys(spec.search?.indexes ?? {})),
			...line('notices', EFFECT_VERBS.some((verb) => ex?.[verb]?.effect === true) ? ['on its write and approval events'] : [])
		].join('\n');
	};
	const automation = (name: string) => {
		const spec = m.automations[name];
		if (spec === undefined) return name;
		const on = (spec.on ?? []).map((x) => ('cron' in x ? `cron ${x.cron}` : `on ${x.model} ${x.verbs.join('|')}`));
		return `${automationSignature(m, name)} "${spec.description}"${on.length === 0 ? '' : ` · ${on.join(', ')}`}${spec.agent === undefined ? '' : ` · agent ${spec.agent}`}`;
	};
	const sections = {
		app: { title: '# Apps (group ▸ app ▸ pages)', names: apps, render: app },
		model: { title: '# Models', names: models, render: model },
		automation: {
			title: '# Automations (start as automation.<name>)',
			names: automations,
			render: automation
		}
	};
	if (names.length > 0) {
		const paths = readPaths(m, a);
		return names
			.map((name) => {
				// the fields of what the caller reads, or may write as an administrator; native settings keep their rows private
				const shape =
					paths.includes(name) || (a.admin && all.models[name] !== undefined)
						? `\n${JSON.stringify(shapeOf(m, a, name, readOutputs(m, a, before(name, '.'))[0]))}`
						: '';
				const section = Object.values(sections).find((one) => one.names.includes(name));
				return section !== undefined
					? `${section.render(name)}${shape}`
					: shape !== ''
						? `${name}${shape}`
						: `Nothing named ${name} that you can reach.`;
			})
			.join('\n\n');
	}
	const header = `# Workspace tz ${m.workspace.tz} · locale ${m.workspace.locale}${m.workspace.currency === undefined ? '' : ` · currency ${m.workspace.currency}`}`;
	const out = [header];
	let used = size(header);
	for (const section of Object.values(sections)) {
		if (section.names.length === 0) continue;
		out.push('', section.title);
		const rest: string[] = [];
		for (const name of section.names) {
			const text = rest.length > 0 ? undefined : section.render(name);
			if (text !== undefined && used + size(text) <= OVERVIEW_BYTES - 1_000) {
				out.push(text);
				used += size(text);
			} else rest.push(name);
		}
		if (rest.length === 0) continue;
		// the names past the cap, as many as still fit
		let also = `Also (describe_workspace { names }):`,
			named = 0;
		for (const name of rest) {
			if (used + size(also) + size(name) + 200 > OVERVIEW_BYTES) break;
			also += `${named === 0 ? ' ' : ', '}${name}`;
			named++;
		}
		if (named < rest.length) also += ` … and ${rest.length - named} more`;
		out.push(also);
		used += size(also);
	}
	return out.join('\n');
}
/** An order as models write it: `-field`, `{ field, direction }` or a list of them, as the read takes it. */
/** `read`'s input: the one read request a page's `bolt.query` and `/__bolt/q` send, one key per root and layer. */
const ReadOptions = (() => {
	// the contract's free JSON options as the same any-JSON, spelled out: an untyped parameter reaches a routed model
	// wrapped as { item: … }
	const { order_by: _orderBy, aggregate, ...fields } = LayerRequestSchema.fields;
	return Schema.Struct({
		...fields,
		order_by: Schema.optionalKey(ToolJson),
		aggregate: Schema.optionalKey(
			Schema.Struct({ ...aggregate.schema.fields, by: Schema.optionalKey(ToolJson) })
		)
	});
})();
// the free map sits under a key: at a tool's root a routed model wraps it in one of its own
const ReadNode = Schema.StructWithRest(ReadOptions, [Schema.Record(
	Schema.String.check(Schema.makeFilter((name) => !Object.hasOwn(ReadOptions.fields, name))), ToolJson
)]);
const ReadInput = Schema.Struct({ request: Schema.Record(Schema.String, ReadNode) });
/**
 * `read`: one read request, a layer map over the models and declared layers the actor may read, answered in
 * one engine read as the actor and bounded by the tool-result budget (a lone root's page keeps whole rows); `undefined` when nothing is
 * readable. What the bound cut stays readable with `read_output`.
 */
export function readTool(x: ReadToolContext) {
	const e = x.engine,
		a = x.authority,
		paths = readPaths(e.manifest, a);
	if (paths.length === 0) return undefined;
	const materialize = (node: Json): Json => {
		if (!isObj(node)) return node;
		return Object.fromEntries(Object.entries<Json>(node).map(([key, value]) => [key,
			key === 'where' && isObj(value) ? materializeEach(value, { ...x.bindings, actor: actorVarsOf(a) })
				: Object.hasOwn(ReadOptions.fields, key) ? value : materialize(value)
		]));
	};
	const answer = (request: ReadRequestJson) =>
		// time variables are this turn's literals before decode; a faulty one is the read's own refusal
		Effect.try({
			try: () => Object.fromEntries(Object.entries(request).map(([root, node]) => [root, materialize(node)])),
			catch: (cause) =>
				cause instanceof BoltError
					? cause
					: BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
		}).pipe(
			Effect.flatMap((materialized) => lower_read(e.manifest, 'query', [materialized])),
			Effect.flatMap(readAs(x))
		);
	const run = Effect.fn('AgentTool.read')(function* (
		request: ReadRequestJson,
		enrich: (full: Json) => Effect.Effect<Json, EngineError> = Effect.succeed
	) {
		const named = Object.keys(request).filter((path) => !path.includes('.'));
		const single = named.length === 1 ? named[0] : undefined;
		const pageOf = (v: Json): Json => (single !== undefined && isObj(v) ? (v[single] ?? null) : v);
		const wrap = (v: Json): Json => (single === undefined ? v : { [single]: v });
		return yield* Effect.gen(function* () {
			const full = yield* Effect.flatMap(answer(request), enrich),
				shown = bounded(pageOf(full));
			// rows the bound cut lie before the page's cursor: what it left out is read_file's, not the next page's
			return {
				result: wrap(shown.kept === null ? shown.value : uncursored(shown.value)),
				full,
				bounded: true
			} as const;
		}).pipe(
			Effect.catch((failure) =>
				Effect.gen(function* () {
					if (!(failure instanceof BoltError) || failure.code !== 'invalid')
						return yield* Effect.fail(failure);
					// a read stops at its first refusal: each root alone names its own, so one correction fixes them all
					const roots = [
						...new Set(Object.keys(request).map((path) => path.split('.')[0] ?? path))
					];
					const refusals =
						roots.length < 2
							? [failure.message]
							: yield* Effect.forEach(roots, (root) =>
									answer(
										Object.fromEntries(
											Object.entries(request).filter(
												([path]) => path === root || path.startsWith(`${root}.`)
											)
										)
									).pipe(
										Effect.match({
											onSuccess: () => [],
											onFailure: (cause) => (cause instanceof BoltError ? [cause.message] : [])
										})
									)
								).pipe(Effect.map((each) => each.flat()));
					return { result: { error: refusals.join('\n') } };
				})
			)
		);
	});
	return {
		tool: recordsTool,
		run: (
			{ request }: typeof ReadInput.Type,
			enrich?: (full: Json) => Effect.Effect<Json, EngineError>
		): Effect.Effect<ToolAnswer> => {
			const unknown = Object.keys(request).find((path) => !paths.includes(path));
			return unknown === undefined
				? guard(run(request, enrich))
				: Effect.succeed(
						err(
							`You read no '${unknown}'. ${unknown.includes('.') ? 'describe_workspace { names } lists its layers.' : `Models: ${paths.filter((p) => !p.includes('.')).join(', ')}`}`
						)
					);
		}
	};
}
/** `read` as a tool an inference is lent (`ai.sys_2.infer` naming `read`): the same tool, as the actor. */
export function readInferTool(x: ReadToolContext): InferTool | undefined {
	const read = readTool(x);
	if (read === undefined) return undefined;
	return {
		name: read.tool.name,
		description: read.tool.description,
		input: read.tool.input,
		behavior: read.tool.behavior,
		call: (input) =>
			read.tool.decode(input).pipe(
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
const Instant = Schema.String.check(Schema.makeFilter((v) => !Number.isNaN(Date.parse(v)) || 'an ISO instant'));
const Limit = Schema.Number.check(Schema.isInt());
const RunsNode = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	automation: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.Literals(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'skipped'])),
	cause: Schema.optionalKey(Schema.String),
	since: Schema.optionalKey(Instant),
	until: Schema.optionalKey(Instant),
	limit: Schema.optionalKey(Limit),
	after: Schema.optionalKey(Schema.String)
});
const LogsNode = Schema.Struct({
	level: Schema.optionalKey(Schema.Literals(['info', 'warn', 'error'])),
	text: Schema.optionalKey(Schema.String),
	run: Schema.optionalKey(Schema.String),
	automation: Schema.optionalKey(Schema.String),
	conversation: Schema.optionalKey(Schema.String),
	since: Schema.optionalKey(Schema.String),
	until: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Limit),
	after: Schema.optionalKey(Schema.String)
});
const { actor_kind: _kind, invocation: _invocation, order: _order, after: _after, ...AUDIT_FILTERS } = AuditQuery.fields;
const AuditNode = Schema.Struct({ id: Schema.optionalKey(Schema.String), after: Schema.optionalKey(Schema.NonEmptyString), ...AUDIT_FILTERS });
const ApprovalsNode = Schema.Struct({
	model: Schema.optionalKey(Schema.String),
	ids: Schema.optionalKey(Schema.Array(Schema.String)),
	all: Schema.optionalKey(Schema.Boolean)
});
const RunList = Schema.Struct({ ...RunViewRow.fields, finished: Schema.NullOr(Schema.String) });
/** A ledger root's options decoded closed: a misplaced key is a wrong call. */
const ledgerNode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, root: string, node: unknown) =>
	Schema.decodeUnknownEffect(schema, CLOSED)(node).pipe(
		Effect.mapError((error) => BoltError.make('invalid_input', 'decode', `${root}: ${error.message}`, error))
	);
/**
 * The workspace's ledgers as `read` roots, each `{ rows, next }` newest first, held as the tools that read them were:
 * runs and approvals by members, the runtime log by administrators, the audit trail by staff administrators.
 */
function ledgerRoots(
	x: ToolContext
): { readonly [root: string]: (node: unknown, call: string) => Effect.Effect<ToolAnswer> } {
	const e = x.engine,
		a = x.authority;
	if (a.actor.kind !== 'member') return {};
	const member = a.actor;
	const readable = readableBy(e.read, e.manifest, a, x.bindings);
	const head = (row: typeof RunList.Type, view: NonNullable<ReturnType<typeof run_view>>) => ({
		id: view.id,
		automation: view.automation,
		status: view.status === 'stopped' ? 'cancelled' : view.status,
		cause: view.cause,
		due: view.due_at,
		started: view.started,
		finished: row.finished,
		attempt_count: view.attempt_count
	});
	const runs = Effect.fn('AgentTool.runs')(function* (node: unknown, call: string) {
		const i = yield* ledgerNode(RunsNode, '$runs', node);
		const after = Option.getOrNull(
			Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])))(i.after ?? '')
		);
		if (i.after !== undefined && after === null) return err('$runs: after is a next a page answered.');
		const limit = Math.min(Math.max(1, i.limit ?? 20), 100),
			name = i.automation;
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
				actor_ref(member),
				JSON.stringify(visible_run_names(a)),
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
			const view = run_view(a, row);
			return view === null ? [] : [{ row, view }];
		});
		if (i.id !== undefined) {
			const one = shown[0];
			if (one === undefined) return err(`$runs: no automation run ${i.id} you may read.`);
			const { row, view } = one;
			// a store that cannot answer says so in place of the lines, never as an empty log
			const lines =
				view.input === undefined
					? []
					: yield* runLog(x.logs, view.id).pipe(
							Effect.map((lines) =>
								typeof lines === 'string'
									? lines
									: lines.map(({ id, at, severity, event, attributes }): Json => ({ id, at, severity, event, attributes }))
							)
						);
			return clippedView(
				(clip) => ({
					rows: [
						{
							...head(row, view),
							progress: clip(view.progress, 2048),
							error: clip(view.error, 4096),
							...(view.input === undefined
								? {}
								: {
										input: clip(view.input, 4096),
										result: clip(view.result ?? null, 4096),
										attempts: EffectArray.isArray<typeof view.attempts>(view.attempts)
											? view.attempts.map((attempt) => clip(attempt, 1024))
											: clip(view.attempts ?? null, 4096),
										logs: typeof lines === 'string' ? lines : lines.map((line) => clip(line, 1024))
									})
						}
					],
					next: null
				}),
				call
			);
		}
		const last = rows.length > limit ? rows[limit - 1] : undefined;
		return clippedView(
			(clip) => ({
				rows: shown.map(({ row, view }) => ({
					...head(row, view),
					error:
						view.error === null
							? null
							: {
									code: view.error.code,
									...(view.error.message === undefined ? {} : { message: clip(view.error.message, 200) })
								},
					progress: clip(view.progress, 512)
				})),
				next: last === undefined ? null : JSON.stringify([last.due_at, last.id])
			}),
			call
		);
	});
	const approvals = Effect.fn('AgentTool.approvals')(function* (node: unknown) {
		const i = yield* ledgerNode(ApprovalsNode, '$approvals', node);
		return ok({ rows: yield* e.approvals.list({ model: i.model, ids: i.ids, all: i.all }, a, readable), next: null });
	});
	const logs = Effect.fn('AgentTool.logs')(function* (node: unknown, call: string) {
		const { level, after, limit: asked, ...rest } = yield* ledgerNode(LogsNode, '$logs', node);
		const limit = Math.min(Math.max(1, asked ?? 50), 200);
		const rows = yield* readLog(x.logs, {
			...rest,
			...(level === undefined ? {} : { min: level }),
			...(after === undefined ? {} : { before: after }),
			limit
		});
		const last = rows.length === limit ? rows.at(-1) : undefined;
		return clippedView(
			(clip) => ({
				rows: rows.map((row) => ({
					id: row.id,
					at: row.at,
					level: row.severity,
					event: row.event,
					invocation: row.invocation,
					run: row.run,
					conversation: row.conversation,
					attributes: clip(row.attributes, 1024)
				})),
				next: last === undefined ? null : last.id
			}),
			call
		);
	});
	const audit = e.audit;
	const trail =
		audit === undefined || !a.admin || member.external
			? undefined
			: Effect.fn('AgentTool.audit')(function* (node: unknown) {
					const { id, ...query } = yield* ledgerNode(AuditNode, '$audit', node);
					if (id === undefined) return ok(yield* audit.query({ order: 'newest', ...query }));
					const event = yield* audit.detail(id);
					return event === null ? err(`$audit: no event ${id}.`) : ok({ rows: [event], next: null });
				});
	const guarded =
		(work: (node: unknown, call: string) => Effect.Effect<ToolAnswer, EngineError | PortFailure>) =>
		(node: unknown, call: string) =>
			guard(work(node, call));
	return {
		$runs: guarded(runs),
		$approvals: guarded(approvals),
		...(a.admin ? { $logs: guarded(logs) } : {}),
		...(trail === undefined ? {} : { $audit: guarded(trail) })
	};
}
/**
 * A read's per-root extras on its whole answer: each root row's revisions (`$history`, through the record history read
 * its output's history grant admits) and approval requests (`$approvals`, those its reader may see).
 */
const withExtras = Effect.fn('AgentTool.readExtras')(function* (
	x: ToolContext,
	full: Json,
	extras: {
		readonly [root: string]: { readonly history: boolean; readonly approvals: boolean; readonly output: string | undefined };
	}
) {
	if (Object.keys(extras).length === 0) return full;
	const e = x.engine,
		a = x.authority,
		readable = readableBy(e.read, e.manifest, a, x.bindings);
	// the answer holds each root's page under its name
	const pages: { readonly [root: string]: Json } = isObj(full) ? full : {};
	const out: { [root: string]: Json } = {};
	for (const [root, page] of Object.entries(pages)) {
		const want = extras[root],
			rows = isObj(page) && isList(page['rows']) ? page['rows'] : undefined;
		if (want === undefined || rows === undefined || !isObj(page)) {
			out[root] = page;
			continue;
		}
		if (want.history && rows.length > HISTORY_ROWS)
			return yield* BoltError.make('invalid_input', 'decode', `${root}: history reads at most ${HISTORY_ROWS} rows; set limit.`);
		const ids = rows.flatMap((row) => (isObj(row) && typeof row['id'] === 'string' ? [row['id']] : []));
		const requests = want.approvals ? yield* e.approvals.list({ model: root, records: ids, all: true }, a, readable) : [];
		const histories = want.history
			? yield* Effect.forEach(ids, (id) => recordHistory(x, root, id, want.output), { concurrency: 4 })
			: [];
		out[root] = {
			...page,
			rows: rows.map((row) => {
				if (!isObj(row) || typeof row['id'] !== 'string') return row;
				const id = row['id'];
				return {
					...row,
					...(want.history ? { $history: histories[ids.indexOf(id)] ?? [] } : {}),
					...(want.approvals
						? { $approvals: requests.filter((request) => request.records.some((r) => r.model === root && r.id === id)) }
						: {})
				};
			})
		};
	}
	return out;
});
/** At most this many rows a read answers with their history: each row is one history read. */
const HISTORY_ROWS = 20;
/** One record's revisions, oldest first, each writer named as the person (name, else handle), never an account id. */
const recordHistory = Effect.fn('AgentTool.recordHistory')(function* (
	x: ToolContext,
	model: string,
	id: string,
	output: string | undefined
) {
	const e = x.engine;
	const ir = yield* lower_read(e.manifest, 'history', [model, id, output === undefined ? {} : { output }]);
	const revisions = yield* Schema.decodeUnknownEffect(HistoryRevisions)(yield* readAs(x)(ir)).pipe(
		Effect.mapError((error) => BoltError.make('internal', 'decode', error.message, error))
	);
	const people = [...new Set(revisions.flatMap((r) => (r.actor?.kind === 'member' ? [r.actor.id] : [])))];
	const named =
		people.length === 0
			? []
			: yield* e.db.rows(Schema.Struct({ id: Schema.String, label: Schema.NullOr(Schema.String) }), {
					text: 'SELECT id::text AS id, coalesce(name, email, phone) AS label FROM sys_user WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb))',
					params: [JSON.stringify(people)]
				});
	const label = new Map(named.map((p) => [p.id, p.label]));
	return revisions.map(({ actor, ...revision }): Json => ({
		...revision,
		by: actor === null ? null : actor.kind === 'member' ? (label.get(actor.id) ?? 'a member') : actor.kind
	}));
});
/** The catalogue note's lines by key: `skill:`, `model:`, `automation:`, `sync:`, `act:` and `tool:` (an MCP tool). */
export type CatalogueIndex = { readonly [key: string]: string };
/** A model's fields in the note: past this many, the rest are describe_workspace's. */
const NOTE_FIELDS = 30;
/** What the actor holds that a merge can change, one line each: the catalogue note's index. */
function catalogueIndex(
	m: EngineManifest,
	a: Authority,
	skills: { readonly [name: string]: Skill },
	mcp: readonly AgentTool[],
	acts: ReadonlyMap<string, Spec>,
	automations: readonly string[],
	syncs: readonly { readonly model: string; readonly sync: string; readonly kind: string; readonly modes: readonly string[] }[]
): CatalogueIndex {
	const index: { [key: string]: string } = {};
	for (const [name, skill] of Object.entries(skills)) index[`skill:${name}`] = `${name} — ${skillOf(skill.text).description}`;
	const roots = readPaths(m, a).filter((path) => !path.includes('.'));
	const writes = new Map<string, string[]>();
	for (const callable of acts.keys()) {
		const dot = callable.lastIndexOf('.'),
			model = callable.slice(0, dot);
		if (m.models[model] === undefined) index[`act:${callable}`] = callable;
		else writes.set(model, [...(writes.get(model) ?? []), callable.slice(dot + 1)]);
	}
	for (const model of new Set([...roots, ...writes.keys()])) {
		const outputs = roots.includes(model) ? readOutputs(m, a, model) : [],
			fields = outputs[0] === undefined ? [] : Object.entries(fieldKinds(m, model, outputs[0]));
		const shown = fields.slice(0, NOTE_FIELDS).map(([field, kind]) => `${field}: ${kind}`);
		index[`model:${model}`] = [
			`${model}(${shown.join(', ')}${fields.length > shown.length ? `, … ${fields.length - shown.length} more` : ''})`,
			outputs.length > 1 ? ` reads ${outputs.join(', ')}` : '',
			writes.has(model) ? ` writes ${writes.get(model)?.join(', ')}` : ''
		].join('');
	}
	for (const name of automations) {
		const spec = m.automations[name];
		if (spec !== undefined) index[`automation:${name}`] = `automation.${automationSignature(m, name)} — ${before(spec.description, '\n').trim()}`;
	}
	for (const sync of syncs) index[`sync:${sync.model}.${sync.sync}`] = `${sync.model}.${sync.sync} (${sync.kind}: ${sync.modes.join(', ')})`;
	for (const tool of mcp) index[`tool:${tool.name}`] = toolLine(tool);
	return index;
}
/** A tool in one line: `name(arg: type, …) — what it does`. */
const toolLine = (tool: Pick<AgentTool, 'name' | 'description' | 'input'>) => {
	const properties = isObj(tool.input) && isObj(tool.input['properties']) ? tool.input['properties'] : {};
	const required = isObj(tool.input) && isList(tool.input['required']) ? tool.input['required'] : [];
	const args = Object.entries(properties).map(([arg, schema]) => {
		const type = isObj(schema) && typeof schema['type'] === 'string' ? schema['type'] : 'json';
		return `${arg}${required.includes(arg) ? '' : '?'}: ${type}`;
	});
	return `${tool.name}(${args.join(', ')}) — ${before(tool.description, '\n').trim()}`;
};
const SECTIONS = [
	['skill:', 'Skills (skill reads one)'],
	['model:', 'Models (fields; reads and writes beyond the default)'],
	['act:', 'Also act'],
	['automation:', 'Automations (act automation.<name>)'],
	['sync:', 'Syncs (sync)'],
	['tool:', 'Tools (run_tool { name, input })']
] as const;
/** Past this many changed lines a merge's note gives counts, and describe_workspace and skill the rest. */
const NOTE_CHANGES = 10;
/**
 * The catalogue note: at a conversation's start (or after a compaction), every line but the MCP tools, which are native;
 * after a merge, only what changed since the last note: added or changed lines, removed names, or counts past
 * `NOTE_CHANGES`; `undefined` when nothing changed since. A tool added after the start is reached through run_tool.
 */
export function catalogueNote(index: CatalogueIndex, previous: CatalogueIndex | undefined): string | undefined {
	const section = (keys: readonly string[]) =>
		SECTIONS.flatMap(([prefix, title]) => {
			const lines = keys.filter((key) => key.startsWith(prefix)).map((key) => index[key] ?? '');
			return lines.length === 0 ? [] : [`${title}:`, ...lines.map((line) => `- ${line}`)];
		});
	// the first note is written even when empty: it is where the conversation's native tools are kept
	if (previous === undefined)
		return ['[Catalogue]', ...section(Object.keys(index).filter((key) => !key.startsWith('tool:')))].join('\n');
	const changed = Object.keys(index).filter((key) => previous[key] !== index[key]);
	const removed = Object.keys(previous).filter((key) => index[key] === undefined);
	if (changed.length === 0 && removed.length === 0) return undefined;
	const name = (key: string) => key.slice(key.indexOf(':') + 1);
	if (changed.length + removed.length > NOTE_CHANGES) {
		const added = changed.filter((key) => previous[key] === undefined).length;
		return `[Catalogue changed by a merge] ${added} added, ${changed.length - added} changed, ${removed.length} removed: describe_workspace and skill read them.`;
	}
	return [
		'[Catalogue changed by a merge]',
		...section(changed),
		...(removed.length === 0 ? [] : [`Removed: ${removed.map(name).join(', ')}`])
	].join('\n');
}
/** The actor may change at a steer, so a step binds every handler under its admitted authority. */
export const catalogue = Effect.fn('AgentTool.catalogue')(function* (x: ToolContext) {
	const e = x.engine,
		a = x.authority,
		acts = callablesFor(e.manifest, a, x.inApp && !x.child && e.identity !== undefined),
		agent = x.mode === 'agent',
		hosted = x.host_tools;
	const entries = new Map<string, BoundTool>(), mcpEntries = new Map<string, BoundTool>();
	/** The host tools this role holds, offered in the tool list whatever the mode: a role's list never changes mid-conversation. */
	const hostOffered: AgentTool[] = [];
	/** Binds a definition's handler under this step's actor: a refused input or a failure is the model's answer. */
	const add = <A>(
		definition: ToolDefinition<A>,
		handler: (input: A, callId: string) => Effect.gen.Return<ToolAnswer, EngineError | PortFailure>,
		meta: Pick<AgentTool, 'studio'> = {},
		destination = entries
	) => {
		const { name, description, input, behavior } = definition;
		destination.set(name, {
			tool: { name, description, input, behavior, ...meta },
			run: (input, callId) => definition.decode(input, { ...CLOSED, errors: 'all' }).pipe(
				Effect.mapError((error) => new Error(`Invalid parameters for tool '${name}': ${error.message}`)),
				Effect.tap((decoded) => Effect.annotateCurrentSpan({ tool: name, parameters: decoded })),
				Effect.flatMap((decoded) => guard(Effect.gen(() => handler(decoded, callId))))
			)
		});
	};
	const read = readTool(x);
	const ledgers = ledgerRoots(x);
	if (read !== undefined || Object.keys(ledgers).length > 0)
		add(agentReadTool, function* ({ request }, call) {
			const roots = Object.entries(request);
			const ledger = roots.filter(([root]) => root.startsWith('$'));
			const asked = Object.fromEntries(
				roots
					.filter(([root]) => !root.startsWith('$'))
					.map(([root, node]) => {
						const { history: _history, approvals: _approvals, ...rest } = node;
						return [root, rest];
					})
			);
			const extras = Object.fromEntries(
				roots.flatMap(([root, node]) =>
					!root.startsWith('$') && !root.includes('.') && (node['history'] === true || node['approvals'] === true)
						? [[root, {
								history: node['history'] === true,
								approvals: node['approvals'] === true,
								output: typeof node['output'] === 'string' ? node['output'] : undefined
							}] as const]
						: []
				)
			);
			const unknown = ledger.find(([root]) => ledgers[root] === undefined);
			if (unknown !== undefined)
				return err(`No '${unknown[0]}' you may read. Ledgers: ${Object.keys(ledgers).join(', ') || 'none'}`);
			const records =
				Object.keys(asked).length === 0
					? undefined
					: read === undefined
						? err('You read no models.')
						: yield* read.run({ request: asked }, (full) => withExtras(x, full, extras));
			const answers = yield* Effect.forEach(ledger, ([root, node]) =>
				Effect.map(ledgers[root]?.(node, call) ?? Effect.succeed<ToolAnswer>(err(`No '${root}'.`)), (answer) => [root, answer] as const)
			);
			// a lone root answers as itself; several merge, each under its own name
			if (records === undefined && answers.length === 1 && answers[0] !== undefined)
				return answers[0][1];
			const failed = [records, ...answers.map(([, answer]) => answer)].find(
				(answer) => answer !== undefined && 'result' in answer && jobFailed(answer.result) !== undefined
			);
			if (failed !== undefined) return failed;
			const part = (answer: ToolAnswer | undefined, key: 'result' | 'full'): Json =>
				answer === undefined || !('result' in answer)
					? null
					: key === 'full' && answer.full !== undefined
						? answer.full
						: answer.result;
			const merge = (key: 'result' | 'full'): Json => {
				const base = part(records, key);
				return {
					...(isObj(base) ? base : {}),
					...Object.fromEntries(answers.map(([root, answer]) => [root, part(answer, key)]))
				};
			};
			return { result: merge('result'), full: merge('full'), bounded: true };
		});
	add(describeTool, function* (i) {
		const names = i.names ?? [];
		// the native setup: capabilities a page opens, the connections, secret names and MCP servers, administrators only
		const setup =
			!names.includes('system')
				? undefined
				: !x.inApp || x.child || !a.admin || a.actor.kind !== 'member' || a.actor.external
					? 'system: nothing you may set up.'
					: yield* Effect.map(
							x.engine.db.read([
								{ text: 'SELECT id, name, integration, envoy FROM sys_integration ORDER BY name', params: [] }
							]),
							([connected]) =>
								[
									'# System',
									`capabilities (page { path, configure }): ${Object.entries(SYSTEM_UI).map(([capability, ui]) => `${capability} ${JSON.stringify(ui)}`).join('; ')}`,
									`connections: ${JSON.stringify(connected?.rows ?? [])}`,
									`secrets: ${Object.keys(e.manifest.workspace.secrets ?? {}).join(', ') || 'none'}`,
									`mcp: ${Object.keys(e.manifest.mcp).join(', ') || 'none'}`
								].join('\n')
						);
		if (setup !== undefined && names.length === 1) return ok(setup);
		const workspace = x.workspace;
		const source =
			workspace === undefined
				? null
				: yield* Port.attempt('workspace', () => workspace.read('src/i18n/+messages.ts')).pipe(
						Effect.orElseSucceed(() => null)
					);
		// the plain map counts each readable model's rows in one read, so an empty table needs no read of its own
		const roots = names.length > 0 ? [] : readPaths(e.manifest, a).filter((path) => !path.includes('.'));
		const counted = roots.length === 0 || read === undefined
			? undefined
			: yield* read.run({ request: Object.fromEntries(roots.map((root) => [root, { limit: 1 }])) });
		const whole = counted === undefined || !('result' in counted) ? undefined : 'full' in counted ? counted.full : counted.result;
		const totals = new Map(
			roots.flatMap((root) => {
				const total = isObj(whole) && isObj(whole[root]) ? whole[root]['total'] : undefined;
				return typeof total === 'number' ? [[root, total] as const] : [];
			})
		);
		const described = describeWorkspace(e.manifest, a, messageCatalogue(source), names.filter((name) => name !== 'system'), totals);
		return ok(setup === undefined ? described : `${described}\n\n${setup}`);
	});
	if (agent && x.inApp && !x.child && x.conv.owner !== null && x.conv.integration === null && x.conv.envoy === null && x.conv.run == null && a.actor.kind === 'member' && !a.actor.external) {
		const allowed = navigation_paths(nav(e.manifest, a), a.admin);
		add(pageTool, function* ({ path, configure: asked, click, type, scroll, go, highlight, preview }) {
			if (preview !== undefined)
				return /^https?:\/\//.test(preview) && URL.canParse(preview)
					? ok({ preview })
					: err('preview is a preview URL (https://…)');
			if (path !== undefined) {
				if (!allowed.includes(path)) return err(`No page ${path}. Pages: ${allowed.join(', ')}`);
				const setup = Schema.decodeUnknownOption(SystemUiRequest)(asked);
				if (asked !== undefined && Option.isNone(setup))
					return err("configure is a capability from describe_workspace { names: ['system'] }");
				const configure = Option.getOrUndefined(setup);
				if (configure?.capability === 'secret.set' && e.manifest.workspace.secrets?.[configure.record] === undefined)
					return err('That secret is not declared in this workspace.');
				if (configure?.capability === 'mcp.configure' && e.manifest.mcp[configure.record] === undefined)
					return err('That MCP server is not declared in this workspace.');
				const target = configure === undefined ? path : a.admin ? systemUiPath(path, configure) : null;
				return target === null
					? err('This configuration does not belong to that page or your authority.')
					: ok({ navigation: target, requested: true });
			}
			if ([click, scroll, go, type, highlight].every((v) => v === undefined))
				return err('give path, click, type, scroll, go, highlight or preview');
			return ok({
				page: {
					...(click === undefined ? {} : { click }),
					...(scroll === undefined ? {} : { scroll }),
					...(go === undefined ? {} : { go }),
					...(type === undefined ? {} : { type }),
					...(highlight === undefined ? {} : { highlight })
				},
				requested: true
			});
		});
	}
	// Manual sync is its own native operation, with file grants or an explicit remote refresh capability.
	const sync_controls = a.actor.kind !== 'member' ? [] : Object.entries(e.manifest.exposures).flatMap(([model, spec]) =>
		Object.entries(spec.syncs ?? {}).flatMap(([sync, entry]) => {
			if (entry.with === 'file') {
				const grants = a.models[model];
				const modes = [
					...(a.admin || (grants?.create.length ?? 0) + (grants?.update.length ?? 0) > 0 ? ['import'] : []),
					...(readsAny(a, model) ? ['template', 'export'] : [])
				];
				return modes.length === 0 ? [] : [{ model, sync, kind: 'file', modes }];
			}
			return entry.read === true && readsAny(a, model) && (a.admin || a.capabilities.syncs.includes(`${model}.${sync}`))
				? [{ model, sync, kind: 'remote', modes: ['read'] }] : [];
		})
	);
	/** An `input_file`: a JSON file of this member's (a `sys_file` they created), at most `MODEL_FILES.fileBytes`. */
	const inputOfFile = Effect.fn('AgentTool.inputOfFile')(function* (fileId: string) {
		const member = a.actor.kind === 'member' ? a.actor.id : null, files = e.files;
		if (files === undefined || member === null) return { error: 'This host stores no files; give input.' };
		const [f] = yield* e.db.rows(ReferenceFile, {
			text: 'SELECT key, size FROM sys_file WHERE id = $1 AND created_by = $2',
			params: [fileId, member]
		});
		if (f === undefined)
			return { error: `No file ${fileId} of yours; give the id of a file you uploaded or a tool stored for you.` };
		if (f.size > MODEL_FILES.fileBytes)
			return { error: `That file is over ${MODEL_FILES.fileBytes / 1024 / 1024} MiB; split the input.` };
		return yield* files.get(f.key, MODEL_FILES.fileBytes).pipe(
			Port.call('files', 30000),
			Effect.flatMap((bytes) =>
				Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(new TextDecoder().decode(bytes))
			),
			Effect.map((input) => ({ input })),
			Effect.catch((error) => Effect.succeed({ error: `That file is not JSON: ${error.message}` }))
		);
	});
	/** A file field's value given as a file id (whole or short): the stored file's reference, when the actor may read it. */
	const withFileRefs = Effect.fn('AgentTool.fileRefs')(function* (callable: string, input: Json) {
		const dot = callable.lastIndexOf('.'),
			model = callable.slice(0, dot),
			verb = callable.slice(dot + 1),
			fields = e.manifest.models[model]?.fields ?? {};
		const files = Object.keys(fields).filter((f) => fields[f]?.kind === 'file');
		if (files.length === 0 || !['create', 'update', 'import'].includes(verb)) return input;
		const ref = Effect.fn('AgentTool.fileRef')(function* (given: Json) {
			if (typeof given !== 'string') return given;
			const id = yield* wholeId(x, given);
			const [file] = yield* sourceFile(id);
			if (file === undefined || !(yield* canRead(file.id))) return `No file ${given} you can read.`;
			return { id: file.id, name: file.name, mime: file.mime, size: file.size };
		});
		const row: (r: Json) => Effect.Effect<Json, EngineError | PortFailure> = Effect.fn('AgentTool.fileRow')(function* (r: Json) {
			if (!isObj(r)) return r;
			const out: { [key: string]: Json } = { ...r };
			for (const f of files) {
				const v = r[f];
				if (v === undefined) continue;
				const refs = yield* Effect.forEach(isList(v) ? v : [v], ref);
				const missing = refs.find((one) => typeof one === 'string');
				if (missing !== undefined) return missing;
				out[f] = isList(v) ? refs : (refs[0] ?? null);
			}
			if (verb === 'update' && isObj(r['set'])) {
				const set = yield* row(r['set']);
				if (typeof set === 'string') return set;
				out['set'] = set;
			}
			return out;
		});
		const rows = verb === 'import' && isObj(input) && isList(input['rows']) ? input['rows'] : isList(input) ? input : [];
		const done = yield* Effect.forEach(rows, row);
		const missing = done.find((one) => typeof one === 'string');
		if (missing !== undefined) return missing;
		return verb === 'import' && isObj(input) ? { ...input, rows: done } : done;
	});
	const automations = a.automations.filter(
		(n) => e.manifest.automations[n] !== undefined && e.manifest.automations[n]?.agent !== 'never'
	);
	const mayStart = (c: string) => c.startsWith(`${AUTOMATION}.`) && automations.includes(c.slice(AUTOMATION.length + 1));
	if (agent && (acts.size > 0 || automations.length > 0))
		add(actTool, function* (i, id) {
			if (typeof i.input_file === 'string') {
				const read = yield* inputOfFile(i.input_file);
				if ('error' in read) return err(read.error);
				i = { ...i, input: read.input };
			}
			if (!acts.has(i.callable) && !mayStart(i.callable))
				return err(
					`You may not run '${i.callable}'. Yours: ${[...acts.keys(), ...automations.map((n) => `${AUTOMATION}.${n}`)].slice(0, 60).join(', ')}`
				);
			if (Array.isArray(i.input) && i.input.length === 0)
				return err(`'${i.callable}' was given no rows: there is nothing to write.`);
			const filed = yield* withFileRefs(i.callable, i.input ?? null);
			if (typeof filed === 'string') return err(filed);
			i = { ...i, input: filed };
			if (
				x.inApp &&
				(acts.get(i.callable)?.confirm === true ||
					(i.callable.startsWith(`${AUTOMATION}.`) &&
						e.manifest.automations[i.callable.slice(AUTOMATION.length + 1)]?.agent === 'confirm'))
			)
				return { confirm: true } as const;
			const answer = yield* perform(
				// the in-app agent starts for its member; an envoy's turn is the envoy's own start
				x.inApp ? { ...x, agent: { conversation: x.conv.id } } : x,
				i.callable,
				i.input ?? null,
				id
			);
			return ok(yield* runJob(x.jobs, e, a, i.callable, answer));
		});
	if (agent && sync_controls.length > 0)
		add(syncTool, function* (i) {
			if (!sync_controls.some((entry) => entry.model === i.model && entry.sync === i.sync))
				return err('You may not use this sync. Read describe_workspace for your native sync controls.');
			const automation = `${i.model}.sync.${i.sync}`, input = i.input ?? {};
			const existing = yield* activeRun(e, automation, input, actor_ref(a.actor));
			if (existing !== undefined) return ok(yield* runJob(x.jobs, e, a, automation, { run: existing, already_active: true }));
			const run = globalThis.crypto.randomUUID();
			const outcome = yield* e.calls.sync_control({
				model: i.model, sync: i.sync, id: run, input, authority: a, bindings: x.bindings,
				...(x.inApp ? { agent: { conversation: x.conv.id } } : {})
			});
			receipt(x.receipts, automation, outcome);
			return ok(yield* runJob(x.jobs, e, a, automation, { run, outcome }));
		});

	if (x.mode === 'plan' && !x.child) {
		add(updatePlanTool, function* (i) {
			const plan = x.conv.plan,
				rev = plan?.revision ?? 0;
			if (i.expected_revision !== undefined && i.expected_revision !== rev)
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
		});
	}
	// every skill is readable by every actor: a skill is procedure, never authority
	const skills = Object.entries(x.skills);
	if (skills.length > 0) {
		add(skillTool, function* (i) {
			const t = skills.find(([n]) => n === i.name)?.[1];
			if (t === undefined)
				return err(`No skill '${i.name}'. Skills: ${skills.map(([n]) => n).join(', ')}`);
			if (i.file !== undefined && i.section !== undefined)
				return err('Read a section or a file, not both.');
			const s = skillOf(t.text);
			if (i.file !== undefined && i.file !== SKILL_FILE) {
				if (!t.files.includes(i.file))
					return err(
						`No file '${i.file}' in ${i.name}. Files: ${t.files
							.filter((f) => f !== SKILL_FILE)
							.slice(0, 50)
							.join(', ')}`
					);
				const bytes = yield* t.read(i.file);
				return documentAnswer(
					{ file: i.file, text: new TextDecoder().decode(bytes) },
					'text'
				);
			}
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
				return documentAnswer(
					{
						description: s.description,
						sections: s.sections,
						body,
						...files,
						...(rest.length === 0
							? {}
							: { more: `read each with section: ${rest.join(', ')}` })
					},
					'body'
				);
			}
			const part = section(s.body, i.section);
			return part === undefined
				? ok({ error: `No section '${i.section}'.`, sections: s.sections })
				: textAnswer(part);
		});
	}
	add(historyTool, function* (i) {
		return ok(yield* x.history(i.query, i.scope === 'mine' ? 'mine' : 'this', Math.max(1, Math.min(i.limit ?? 20, 50))));
	});
	/** More of a clipped result: the call its clip note names (none for the latest) from a character offset. */
	const readOutput = Effect.fn('AgentTool.readOutput')(function* (call: string, offset: number) {
		const named = yield* x.output(call === '' ? null : call),
			latest = named === undefined && call !== '' ? yield* x.output(null) : undefined,
			full = named ?? latest;
		if (full === undefined) return err('No result was clipped in this conversation.');
		const text = outputText(full),
			from = Math.max(0, offset),
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
				...(latest === undefined
					? {}
					: { note: `No saved output for call '${call}'; this is the latest clipped result.` }),
				...(at < text.length ? { next: at } : {})
			},
			bounded: true as const
		};
	});
	if (x.conv.integration !== null) {
		add(readMessagesTool, function* (i) {
			const rows = yield* x.messages({
				limit: Math.max(1, Math.min(i.limit ?? 50, 50)),
				...(i.before === undefined ? {} : { before: i.before })
			});
			return ok({
				messages: rows.map((r) => ({
					seq: r.seq,
					from: r.role === 'assistant' ? 'you' : authorOf(r),
					sender: r.sender ?? null,
					message: r.provider_id ?? null,
					status: r.status ?? null,
					sent: r.direction === 'outbound' && !confirmed_send(r.status) ? null : r.sent_at ?? null,
					created: r.created_at ?? null,
					text: r.text,
					files: filesOf(r),
					addressed: !ambient(r)
				}))
			});
		});
	}
	/** A page's four quarters, shown beside it. */
	const tiled = Effect.fn('AgentTool.tiled')(function* (bytes: Uint8Array, id: string) {
		const images = x.engine.images;
		if (images === undefined) return;
		const tiles = yield* Effect.forEach(
			TILES,
			(tile) =>
				imageCrop(bytes, tile).pipe(
					Effect.flatMap((crop) => image_jpeg(crop, 2048)),
					Effect.provideService(Images, images)
				),
			{ concurrency: TILES.length }
		);
		for (const [n, tile] of tiles.entries())
			attach(x.files, { mime: 'image/jpeg', bytes: tile, id: `${id}#tile:${n}` });
	});
	/** A stored file as an image (shown from the next step) or its text; every other file is parsed first. */
	const readStored = Effect.fn('AgentTool.readStored')(function* (
		port: NonNullable<typeof x.attachments>,
		file: Json
	) {
		const fileId = isObj(file) && typeof file['id'] === 'string' ? file['id'] : undefined;
		const got = yield* port.read(file).pipe(Port.call('files', 30000));
		if (Predicate.isObject(got) && 'bytes' in got && got.bytes instanceof Uint8Array && 'mime' in got && typeof got.mime === 'string') {
			const seen = attach(x.files, { mime: got.mime, bytes: got.bytes, ...(fileId === undefined ? {} : { id: fileId }) });
			if (seen === 'shown') yield* tiled(got.bytes, fileId ?? got.mime);
			return ok({ attached: ATTACHED[seen] });
		}
		const answer = yield* Schema.decodeUnknownEffect(Schema.Json)(got).pipe(
			Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message, error))
		);
		// a text file is one long value: whole up to the bound
		return isObj(answer) && typeof answer['text'] === 'string' ? documentAnswer(answer, 'text') : ok(answer);
	});
	const sourceFile = (id: string) =>
		x.engine.db.rows(SourceFile, { text: 'SELECT id, name, mime, size, key, sha256 FROM sys_file WHERE id = $1', params: [id] });
	/** Whether the actor may read stored file `id`: this conversation's input or output, their own upload, or a record's file they read. */
	const canRead = Effect.fn('AgentTool.canRead')(function* (id: string) {
		const [r] = yield* x.engine.db.read([
			{
				text: `SELECT f.field, f.created_by, EXISTS (
					SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.outputs) o
					WHERE c.id = $2 AND (o->>'id' = f.id OR o->'files' @> jsonb_build_array(jsonb_build_object('id', f.id)))
				) AS own, EXISTS (
					SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.inputs) i
					WHERE c.id = $2 AND i->>'id' = f.id
				) AS here FROM sys_file f WHERE f.id = $1`,
				params: [id, x.conv.id]
			}
		]);
		const row = r?.rows[0],
			field = row?.['field'],
			member = x.authority.actor.kind === 'member' ? x.authority.actor.id : undefined;
		// an output of this conversation is the person's own file, including one just downloaded
		if (row?.['own'] === true || row?.['here'] === true) return true;
		if (field === 'sys_conversation.inputs' && (x.authority.admin || (member !== undefined && row?.['created_by'] === member)))
			return true;
		if (typeof field !== 'string' || !field.includes('.') || field.startsWith('sys_conversation.'))
			return false;
		const { manifest, db, read } = x.engine;
		return yield* readableFile({ manifest, db, read, authority: x.authority, bindings: x.bindings }, id, field);
	});
	/** This conversation's ingests (plan 12): one output entry per source file, oldest first. */
	const readingKey = (output: string) => `${x.conv.id}/${output}`;
	const ingests = Effect.fn('AgentTool.ingests')(function* () {
		const [r] = yield* x.engine.db.read([
			{ text: 'SELECT outputs FROM sys_conversation WHERE id = $1', params: [x.conv.id] }
		]);
		const outputs = r?.rows[0]?.['outputs'];
		return (Array.isArray(outputs) ? outputs : []).flatMap((o) =>
			Option.toArray(Schema.decodeUnknownOption(IngestEntry)(o))
		);
	});
	/** Merges `patch` into an ingest's entry and `state` into its `ingest`, in one statement. */
	const patchEntry = (output: string, patch: Json, state: Json) => {
		const chain = new Chain();
		capturePiece(chain, 'patched', 'sys_conversation', `UPDATE sys_conversation SET outputs = (SELECT jsonb_agg(CASE WHEN e->'ingest'->>'output' = ${chain.p(output)}
			THEN (e || ${chain.p(JSON.stringify(patch))}::jsonb) || jsonb_build_object('ingest', (e->'ingest') || ${chain.p(JSON.stringify(state))}::jsonb) ELSE e END ORDER BY n)
			FROM jsonb_array_elements(outputs) WITH ORDINALITY AS t(e, n)) WHERE id = ${chain.p(x.conv.id)}`);
		return nativeCommit(x.engine.db.write, x.engine.live.publish, chain, CapturedResult).pipe(Effect.asVoid);
	};
	/** `read_file` over an ingest: a window of its lines with the images they reference, the lines holding a text, or one image. */
	const readIngest = Effect.fn('AgentTool.readIngest')(function* (
		entry: typeof IngestEntry.Type,
		i: {
			from?: number | undefined;
			to?: number | undefined;
			text?: string | undefined;
			image?: number | undefined;
			page?: number | undefined;
			crops?: readonly (readonly [number, number, number, number])[] | undefined;
			password?: string | undefined;
		}
	) {
		const o = entry.ingest.output,
			files = e.files;
		if (entry.ingest.status === 'ingesting')
			return ok({
				note: `Still being read: wait { jobs: ['${entry.ingest.job ?? o}'] } returns when it ends.`
			});
		if (entry.ingest.status === 'failed' || entry.id === undefined || files === undefined)
			return err(
				`The ingest of ${entry.name} failed: ${entry.ingest.error ?? 'its files are not stored'}.`
			);
		const ids = (entry.files ?? []).map((f) => f.id);
		const stored = yield* x.engine.db.rows(StoredFile, {
			text: `SELECT id, name, mime, size, key FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(ids)]
		});
		const byId = new Map(stored.map((f) => [f.id, f]));
		const html = byId.get(entry.id);
		if (html === undefined)
			return err(`The ingest ${o} is no longer stored: ingest the file again.`);
		const images = new Map(
			ids.flatMap((id) => {
				const f = byId.get(id),
					name = f?.name.split('/images/')[1];
				return f === undefined || name === undefined || !f.name.includes('/images/')
					? []
					: [[name, f] as const];
			})
		);
		const show = Effect.fn('AgentTool.showImages')(function* (names: readonly string[]) {
			for (const name of names) {
				const f = images.get(name);
				if (f === undefined) continue;
				const bytes = yield* files.get(f.key, f.size);
				const seen = attach(x.files, { mime: f.mime, bytes, id: `${entry.id}#${name}` });
				if (names.length <= TILED_PAGES && seen === 'shown')
					yield* tiled(bytes, `${entry.id}#${name}`);
			}
		});
		if (i.page !== undefined) {
			const [source] = yield* sourceFile(entry.ingest.source);
			if (source === undefined || x.ingest === undefined)
				return err('The file is no longer stored.');
			const got = yield* x.ingest(source, {
				page: i.page,
				...(i.password === undefined ? {} : { password: i.password })
			});
			const picture = 'unsupported' in got ? undefined : got.images[0];
			if (picture === undefined) return err(`${entry.name} has no page ${i.page} to show.`);
			const id = `${entry.id}#page-${i.page}`;
			const seen = attach(x.files, { mime: picture.mime, bytes: picture.bytes, id });
			if (seen === 'shown') yield* tiled(picture.bytes, id);
			return ok({ page: i.page, attached: ATTACHED[seen] });
		}
		const crops = i.crops ?? [],
			imageNumber = i.image ?? (crops.length > 0 && images.size === 1 ? 1 : undefined);
		const taken = x.zooms.get(o) ?? 0;
		if (crops.length > 0) {
			if (taken >= ZOOMS) return err(`${o} has had its ${ZOOMS} zooms this turn.`);
			x.zooms.set(o, taken + 1);
		}
		if (crops.length > 0 && imageNumber === undefined)
			return err(`${o} has ${images.size} images: give image, the 1-based one to crop.`);
		const text = new TextDecoder().decode(yield* files.get(html.key, html.size));
		if (imageNumber !== undefined) {
			const name = [...images.keys()][imageNumber - 1];
			if (name === undefined) return err(`${o} has ${images.size} images; image is 1-based.`);
			if (crops.length === 0) yield* show([name]);
			else {
				const image = images.get(name);
				if (image === undefined) return err('The image is no longer stored.');
				if (x.engine.images === undefined) return err('The host provides no image cropping.');
				const source = yield* files.get(image.key, image.size);
				for (const [left, top, right, bottom] of crops) {
					const crop: ImageCrop = { left, top, right, bottom, min_edge: 1024 };
					attach(x.files, {
						mime: 'image/png',
						bytes: yield* imageCrop(source, crop).pipe(
							Effect.provideService(Images, x.engine.images)
						),
						id: `${entry.id}#${name}#crop:${left},${top},${right},${bottom}`
					});
				}
			}
			return ok({
				image: name,
				...(crops.length === 0
					? {}
					: {
							crops: crops.length,
							zoomsLeft: ZOOMS - (x.zooms.get(o) ?? 0)
						}),
				attached: ATTACHED.shown
			});
		}
		// a data ingest has no lines: its summary, and run_js computes over its data.json
		if (html.mime === 'application/json') {
			const run = `run_js { files: [{ id: '${html.id}' }] }`;
			if (i.text !== undefined && i.text !== '')
				return err(`${o} is data, not lines: find it with ${run}.`);
			const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text);
			if (Option.isNone(json))
				return err(`The ingest ${o} is no longer readable: ingest the file again.`);
			return ok({
				output: o,
				file: entry.name,
				data: dataSummary(json.value),
				note: `its data: ${run}${images.size === 0 ? '' : `; its images: view_image { id: ${o}, image: n }`}`
			});
		}
		if (i.text !== undefined && i.text !== '') {
			const found = grep(text, i.text, 50);
			return {
				result: {
					output: o,
					...found,
					...(found.total === 0
						? { note: `No line of ${o} holds '${i.text}'.` }
						: found.total > found.hits.length
							? { note: `${found.total - found.hits.length} more hits` }
							: {})
				},
				bounded: true as const
			};
		}
		const w = window(text, i.from, i.to);
		const refs = imagesIn(w.lines, [...images.keys()]),
			shown = refs.slice(0, WINDOW_IMAGES);
		yield* show(shown);
		const count = (v: number) => v.toLocaleString('en-US');
		return {
			result: {
				id: o,
				file: entry.name,
				lines: w.lines,
				...(shown.length === 0
					? {}
					: {
							images: shown,
							note: `each <img> named in images is shown on your next step only${shown.length > TILED_PAGES ? '; whole pages without their quarters: view_image { id, image: n } adds them' : ''}`
						}),
				...(refs.length > shown.length
					? {
							more: `${refs.length - shown.length} more images: view_image { id: ${o}, image: n }`
						}
					: {}),
				at: `lines ${count(w.from)}–${count(w.to)} of ${count(w.total)}${w.next === undefined ? '' : ` · read_file { id: ${o}, from: ${w.next} }`}`
			},
			bounded: true as const
		};
	});
	/** Starts parsing a stored file; its entry joins this conversation's outputs. Answers the job and the output. */
	const ingestFile = Effect.fn('AgentTool.ingestFile')(function* (
		fileStore: NonNullable<Engine['files']>,
		file: typeof SourceFile.Type,
		how: Exclude<ReturnType<typeof route>, 'unsupported'>,
		password?: string
	) {
		const port = x.ingest;
		// a locked file's parse is kept under its password too: only a reader who holds that password reuses it
		const cacheKey =
			password === undefined ? file.sha256 : sha256_hex(`${file.sha256}\0${password}`);
		const chain = new Chain();
		const entry = JSON.stringify({ name: `${file.name} (${how === 'audio' ? 'transcript' : 'ingested'})`, mime: 'text/html' }),
			state = JSON.stringify({ source: file.id, sha256: file.sha256, status: 'ingesting' });
		capturePiece(chain, 'added', 'sys_conversation', `UPDATE sys_conversation SET outputs = outputs || jsonb_build_array(${chain.p(entry)}::jsonb || jsonb_build_object('ingest',
			${chain.p(state)}::jsonb || jsonb_build_object('output', 'o' || (1 + (SELECT count(*) FROM jsonb_array_elements(outputs) e WHERE e ? 'ingest')))))
			WHERE id = ${chain.p(x.conv.id)}`, { returning: (_before, after) => `${after}.outputs->-1->'ingest'->>'output' AS output` });
		const { output } = yield* nativeCommit(x.engine.db.write, x.engine.live.publish, chain,
			Schema.Struct({ ...CapturedResult.fields, output: Schema.NullOr(Schema.String) }),
			'(SELECT output FROM added) AS output');
		if (output === null)
			return yield* BoltError.make('invalid_input', 'admission', 'This conversation is gone.');
		const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null,
			base = file.name.replace(/\.[^./]*$/, '').replaceAll('/', '_') || 'file';
		const record = (event: string, attributes: { readonly [key: string]: Json }) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				x.logs.write({
					at: new Date(now).toISOString(),
					severity: 'info',
					event,
					invocation: x.turn,
					run: null,
					conversation: x.conv.id,
					turn: x.turn,
					attributes
				})
			);
		const work = Effect.gen(function* () {
			const hit = yield* cached(x.engine.db, fileStore, cacheKey);
			let stored: Stash;
			// plan 12 billing: a conversion's compute is `ingest.convert`; a cache hit records the hit and no compute
			if (hit !== undefined) {
				stored = hit;
				yield* record('ingest.convert', {
					sha256: file.sha256,
					mime: file.mime,
					kind: hit.kind,
					cached: true,
					bytes: file.size
				});
			} else {
				const got: Ingested | { readonly unsupported: string } =
					how === 'image'
						? imageIngest({
								name: file.name,
								mime: file.mime,
								bytes: yield* fileStore.get(file.key, INGEST_BYTES)
							})
						: how === 'text'
							? textIngest(yield* fileStore.get(file.key, INGEST_BYTES))
							: port !== undefined
								? yield* port(
										{
											sha256: file.sha256,
											name: file.name,
											mime: file.mime,
											key: file.key,
											size: file.size
										},
										password === undefined ? {} : { password }
									)
								: { unsupported: 'This host cannot ingest files.' };
				if ('unsupported' in got)
					return yield* BoltError.make('invalid_input', 'decode', unparsed(file.name, file.mime));
				// the model calls Convert made (a transcription), attributed here; the host bills each call id
				const usage = got.meta.usage;
				if (usage !== undefined)
					yield* record('ai.call', {
						calls: usage.calls,
						model: usage.model,
						input: usage.input,
						output: usage.output,
						cost: usage.cost,
						facility: 'convert.ingest',
						settlement: usage.calls.length === 0 ? 'attention' : 'pending'
					});
				stored = yield* stash(
					x.engine.db,
					x.engine.live.publish,
					fileStore,
					{ sha256: cacheKey, base, member, now: x.bindings.now },
					got
				);
				yield* record('ingest.convert', {
					sha256: file.sha256,
					mime: file.mime,
					kind: got.kind,
					cached: false,
					...got.meta.stats
				});
			}
			const main = new TextDecoder().decode(
				stored.kind === 'data' || how === 'audio'
					? yield* fileStore.get(stored.main.key, stored.main.size)
					: new Uint8Array()
			);
			const title = `${file.name} (${stored.kind === 'data' ? 'data' : how === 'audio' ? 'transcript' : 'ingested'})`;
			yield* patchEntry(
				output,
				{
					id: stored.main.id,
					name: title,
					mime: stored.main.mime,
					size: stored.main.size,
					files: entryFiles(stored.files)
				},
				{
					status: 'ready',
					...(stored.kind === 'document' ? { lines: stored.index.lines } : {})
				}
			);
			const run = (f: StoredFile | undefined) =>
				f === undefined ? '' : `${f.name.split('/').pop()} ${f.id} — run_js { files: [{ id }] }`;
			if (stored.kind === 'data') {
				const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(main);
				return {
					title,
					lines: [
						`  ${Option.isNone(json) ? 'unreadable data' : dataLine(json.value)}`,
						`  Compute from it with run_js, never retype: ${run(stored.main)}`
					]
				};
			}
			const json = run(stored.files.find((f) => f.name.endsWith('/transcript.json')));
			return {
				title,
				lines: [
					`  ${summary(stored.index, how === 'audio' ? transcriptOf(main) : undefined)}`,
					`  Map: ${outlineMap(stored.index)}`,
					...(json === ''
						? []
						: [`  Typed JSON for run_js (compute from it, never retype): ${json}`])
				]
			};
		}).pipe(
			Effect.tapError((error) =>
				patchEntry(output, {}, { status: 'failed', error: error.message }).pipe(Effect.ignore)
			)
		);
		x.reading.add(readingKey(output));
		const job = yield* x.jobs.add(
			`reading ${file.name}`,
			Effect.ensuring(
				work,
				Effect.sync(() => x.reading.delete(readingKey(output)))
			),
			{
				detach: true,
				done: (id, result) => {
					const said = isObj(result) ? result : {};
					const title = typeof said['title'] === 'string' ? said['title'] : file.name;
					const lines = Array.isArray(said['lines'])
						? said['lines'].filter((l) => typeof l === 'string')
						: [];
					return [
						`[job ${id} done] ingest of ${file.name}: read_file { id: ${output} } "${title}"`,
						...lines
					].join('\n');
				}
			}
		);
		yield* patchEntry(output, {}, { job });
		return { job, output };
	});
	/** A file by id: its lines (`read_file`) or its images (`view_image`), parsed first where it needs it. */
	const readFile = Effect.fn('AgentTool.readFile')(function* (i: {
		readonly id: string;
		readonly from?: number | undefined;
		readonly to?: number | undefined;
		readonly text?: string | undefined;
		readonly image?: number | undefined;
		readonly page?: number | undefined;
		readonly crops?: readonly (readonly [number, number, number, number])[] | undefined;
		readonly password?: string | undefined;
	}) {
		if (i.id.includes('@')) return yield* readReference(x, i.id, i);
		const id = yield* wholeId(x, i.id);
		let found = (yield* ingests()).findLast(
			(o) => o.ingest.output === id || o.ingest.source === id || o.id === id
		);
		// a job dies with its generation: a read it left unfinished starts over, never waits for good
		if (
			found?.ingest.status === 'ingesting' &&
			!x.reading.has(readingKey(found.ingest.output))
		) {
			yield* patchEntry(
				found.ingest.output,
				{},
				{ status: 'failed', error: 'a restart cut it short' }
			);
			found = undefined;
		}
		// a failed parse is retried by its file's id and explained by its output's
		if (
			found !== undefined &&
			(found.ingest.status !== 'failed' || found.ingest.output === id)
		)
			return yield* readIngest(found, i);
		// a repository reference's own file is its index: read by id as by its name, the person's own
		const [indexed] = yield* sourceFile(id);
		if (indexed?.mime === REFERENCE.mime) return yield* readReference(x, indexed.name, i);
		const attachments = x.attachments;
		if (attachments === undefined) return err('This host reads no files.');
		// a file attached to this conversation's messages is this conversation's to read, by its own type
		const [attached] = yield* x.engine.db.read([
			{
				text: `SELECT i - 'message' AS file FROM sys_conversation c, jsonb_array_elements(c.inputs) i WHERE c.id = $1 AND i->>'id' = $2 LIMIT 1`,
				params: [x.conv.id, id]
			}
		]);
		const input = attached?.rows[0]?.['file'];
		if (input === undefined && !(yield* canRead(id))) {
			// a wrong id's answer names the right ones, so the next call needs no look around
			const [held] = yield* x.engine.db.read([
				{
					text: `SELECT i->>'id' AS id, i->>'name' AS name FROM sys_conversation c, jsonb_array_elements(c.inputs) i WHERE c.id = $1`,
					params: [x.conv.id]
				}
			]);
			const files = (held?.rows ?? [])
				.slice(-20)
				.map((row) => `${String(row['name'])} ${shortId(String(row['id']))}`);
			return err(
				`No file you can read has this id; a clipped result is read_output's.${files.length === 0 ? '' : ` This conversation's files: ${files.join(', ')}`}`
			);
		}
		const file = indexed;
		if (file === undefined) return yield* readStored(attachments, input ?? { id });
		const how = route(file.mime, file.name);
		if (how === 'unsupported') return err(unparsed(file.name, file.mime));
		const detail =
			i.from !== undefined ||
			i.to !== undefined ||
			i.text !== undefined ||
			i.image !== undefined ||
			i.page !== undefined ||
			i.crops !== undefined;
		if (how !== 'convert' && how !== 'audio' && !detail)
			return yield* readStored(attachments, input ?? { id });
		if (e.files === undefined) return err('This host cannot parse files.');
		if ((how === 'convert' || how === 'audio') && x.ingest === undefined)
			return err('This host cannot parse files.');
		const started = yield* ingestFile(e.files, file, how, i.password);
		const settled = yield* x.jobs.wait([started.job], x.inlineMs ?? JOBS.inlineMs);
		if (settled === null)
			return ok({
				reading: file.name,
				job: started.job,
				note: `Still being read. wait { jobs: ['${started.job}'] } returns when it ends.`
			});
		const failed = jobFailed(settled.result);
		if (failed !== undefined) return err(failed);
		const ready = (yield* ingests()).findLast((o) => o.ingest.output === started.output);
		if (ready === undefined) return err('This conversation is gone.');
		const answer = yield* readIngest(ready, i),
			said = Schema.decodeUnknownOption(Schema.Array(Schema.Json))(
				Predicate.isObject(settled.result) ? settled.result['lines'] : undefined
			);
		return 'result' in answer && Predicate.isObject(answer.result) && Option.isSome(said)
			? { ...answer, result: { ...answer.result, about: said.value } }
			: answer;
	});
	add(readFileTool, function* (i) {
		return yield* readFile(i);
	});
	add(viewImageTool, function* (i) {
		if (i.image === undefined && i.page === undefined && i.crops === undefined)
			return err('give image, page or crops');
		return yield* readFile(i);
	});
	add(readOutputTool, function* (i) {
		return yield* readOutput(i.call, i.offset ?? 0);
	});
	if (x.geocoder !== undefined) {
		add(geocodeTool, function* (i) {
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
		});
	}
	const staff = a.actor.kind === 'member' && !a.actor.external;
	// a member reads the source of the models they may read, and every file that is no model's: an administrator all of it
	const unseen = (path: string) => {
		const model = /^src\/data\/model\/([^/]+)\//.exec(path)?.[1];
		return model !== undefined && !readsAny(a, model);
	};
	const visible = (ws: WorkspacePort | undefined): WorkspacePort | undefined =>
		ws === undefined
			? undefined
			: {
					files: () => ws.files().then((files) => files.filter((f) => !unseen(f))),
					read: (path) => (unseen(path) ? Promise.resolve(null) : ws.read(path))
				};
	// An author's current Studio tree; without authoring, the workspace's released source.
	const source = visible(x.draft ?? x.workspace);
	if (source !== undefined && !(a.actor.kind === 'member' && a.actor.external)) {
		add(readSource, function* (i) {
			const files = yield* Port.attempt('workspace.files', () => source.files());
			const offset = Math.max(1, i.offset ?? 1),
				limit = Math.min(Math.max(1, i.limit ?? READ_LINES), READ_LINES);
			const one = Effect.fn('AgentTool.readSource')(function* (asked: string) {
				// the same normalisation workspace_search uses: `./src/a.ts` is `src/a.ts`
				const path = sourcePath(asked),
					outside = outsideSource(asked, path);
				if (outside !== undefined) return { error: outside };
				if (!files.includes(path))
					return {
						error: files.some((file) => file.startsWith(`${path}/`))
							? `${asked} is a directory: workspace_list_dir lists it.`
							: `${asked}: no such file: workspace_list_dir shows the source.`
					};
				const text = yield* Port.attempt('workspace.read', () => source.read(path));
				if (text === null)
					return { error: `${asked}: no such file: workspace_list_dir shows the source.` };
				if (GENERATED.test(path) && !text.includes('<<<<<<<'))
					return { text: `Read file ${path}: ${GENERATED_NOTE}` };
				return filePage(path, text, offset, limit);
			});
			if (i.paths !== undefined && i.paths.length > 0)
				return textAnswer(
					(yield* Effect.forEach(i.paths.slice(0, 20), one))
						.map((answer) => ('error' in answer ? answer.error : answer.text))
						.join('\n\n')
				);
			if (i.path === undefined) return err('give path or paths');
			const answer = yield* one(i.path);
			return 'error' in answer ? err(answer.error) : textAnswer(answer.text);
		});
		add(searchSource, function* (i) {
			const within = sourcePath(i.path ?? ''),
				outside = outsideSource(i.path ?? '', within);
			if (outside !== undefined) return err(outside);
			// ripgrep over an administrator's checkout; a member reads only what `visible` lets through
			const search = x.search?.bind(x);
			const found =
				a.admin && search !== undefined
					? yield* Port.attempt('workspace.search', () => search(i))
					: undefined;
			if (found !== undefined)
				return 'error' in found
					? err(found.error)
					: textAnswer(
							grepAnswer(
								found.hits.filter((hit) => !GENERATED.test(hit.path)),
								found.truncated,
								i.files === true
							)
						);
			const regex =
				i.literal === true
					? null
					: yield* Effect.try({
							try: () => new RegExp(i.pattern, i.case_sensitive === false ? 'i' : ''),
							catch: () =>
								BoltError.make(
									'invalid_input',
									'decode',
									'Invalid regular expression; fix pattern or use literal:true.'
								)
						});
			const wanted = i.case_sensitive === false ? i.pattern.toLowerCase() : i.pattern;
			const included = i.include === undefined ? undefined : globRegExp(i.include);
			const files = (yield* Port.attempt('workspace.files', () => source.files())).filter(
				(file) =>
					(within === '' || file === within || file.startsWith(`${within}/`)) &&
					(included === undefined || included.test(file)) &&
					!GENERATED.test(file) &&
					file !== 'bun.lock'
			);
			const limit = i.limit ?? 100,
				hits: { path: string; line: number; text: string }[] = [];
			for (const path of files) {
				const text = (yield* Port.attempt('workspace.read', () => source.read(path))) ?? '';
				for (const [line, value] of text.split('\n').entries()) {
					if (
						regex === null
							? (i.case_sensitive === false ? value.toLowerCase() : value).includes(wanted)
							: regex.test(value)
					) {
						if (hits.length === limit)
							return textAnswer(grepAnswer(hits, true, i.files === true));
						hits.push({ path, line: line + 1, text: value.slice(0, HIT_CHARS) });
						if (i.files === true) break;
					}
				}
			}
			return textAnswer(grepAnswer(hits, false, i.files === true));
		});
		add(listSource, function* (i) {
			const under = sourcePath(i.path ?? ''),
				outside = outsideSource(i.path ?? '', under);
			if (outside !== undefined) return err(outside);
			const shown = (yield* Port.attempt('workspace.files', () => source.files())).filter(
				(file) => under === '' || file.startsWith(`${under}/`)
			);
			return shown.length === 0
				? err(`${i.path}: no such directory: workspace_list_dir with no path shows the source.`)
				: textAnswer(sourceTree(shown));
		});
	}
	if (agent && x.delegation) {
		add(subagentTool, function* (i) {
			const which = i.agent ?? null;
			if (which !== null && !x.agents.includes(which))
				return err(`No agent '${which}'. Agents: ${x.agents.join(', ')}`);
			return ok(yield* x.subagent.spawn(i.task, which, i.done, i.format));
		});
		add(subagentReadTool, function* (i) {
			return ok(yield* x.subagent.read(i.conversation));
		});
		add(subagentMessageTool, function* (i) {
			return ok(yield* x.subagent.message(i.conversation, i.text));
		});
		add(subagentStopTool, function* (i) {
			return ok(yield* x.subagent.stop(i.conversation));
		});
	}
	const convert = e.convert,
		store = e.files;
	if (agent && convert !== undefined && store !== undefined && convert.targets.length > 0) {
		add(documentTool, function* (i) {
			if (!convert.targets.includes(i.to))
				return err(`This host converts to ${convert.targets.join(', ')}; choose one of those targets.`);
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
		});
	}
	// the person's own media from the web: the host fetches and stores it, so no bytes enter the engine (the browser's
	// download does the same with its sign-ins, so a turn with a browser has that one)
	if (
		agent &&
		x.inApp &&
		staff &&
		store !== undefined &&
		!x.host_tools.some((tool) => tool.behavior.downloads === true)
	) {
		add(downloadTool, function* (i) {
			const file = yield* store.download(i.url);
			return ok({
				saved: file.name,
				mime: file.mime,
				bytes: file.bytes,
				file: yield* recordFile(x, file)
			});
		});
	}
	// JavaScript in a fresh guest isolate, never the cell: inline code, or a skill's script run as written where the host
	// bundles files; its HTTP is granted as a host tool is
	const guest = e.guest,
		bundler = e.bundler,
		http =
			x.inApp && staff && (a.admin || a.capabilities.tools.includes('http')) ? e.http : undefined;
	/** The catalogue's own tools a script calls, as the actor; its `run` exists once the catalogue is built. */
	let self: Catalogue['run'] | undefined;
	const inner = (call: string) => {
		let used = 0;
		return (name: string, input: unknown): Effect.Effect<ToolAnswer> =>
			self === undefined || UNSCRIPTED.has(name) || (!entries.has(name) && !mcpEntries.has(name))
				? Effect.succeed(err(`A script cannot call '${name}': it calls your other tools by name.`))
				: ++used > RUN_JS.toolCalls
					? Effect.succeed(err(`A run makes at most ${RUN_JS.toolCalls} tool calls.`))
					: self(name, input, `${call}:${used}`);
	};
	if (agent && guest !== undefined) {
		add(runJsTool, function* (i, callId) {
			if (i.http === true && http === undefined)
				return err('Your policies do not grant scripts HTTP: run it without http.');
			const keep =
				store === undefined
					? undefined
					: (file: { name: string; mime: string; bytes: Uint8Array }) =>
							storeFile(x, store, file);
			const granted = i.http === true ? http : undefined;
			if (i.file === undefined) {
				if (i.code === undefined) return err('Give code, or a file to run.');
				const named = yield* conversationFiles(x, i.files ?? []);
				if (typeof named === 'string') return err(named);
				const given = i.input ?? null;
				if (named.length > 0 && given !== null && !Predicate.isObject(given))
					return err('With files, input is an object: the files join it as input.files.');
				return ok(
					yield* runJs({
						code: i.code,
						input:
							named.length === 0
								? given
								: {
										...(Predicate.isObject(given) ? given : {}),
										files: Object.fromEntries(
											named.map(([name, bytes]) => [name, fileContent(bytes)])
										)
									},
						guest,
						http: granted,
						tool: inner(callId),
						invocation: callId,
						keep
					})
				);
			}
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
		});
	}
	add(askTool, function* (i) {
		const question = i.question.trim();
		if (question === '') return err('Ask a question.');
		const options = (i.options ?? []).map((option) => option.trim()).filter((option) => option !== '');
		if (!x.ask({ question, options: [...new Set(options)] })) return err('One question is already waiting in this step.');
		return ok({ asked: true, to: x.child ? 'the delegating agent' : 'the person' });
	});
	add(waitTool, function* (i) {
		const heard = x.heard.pipe(
			Effect.map(() =>
				ok({
					settled: null,
					pending: x.jobs.pending(),
					note: 'New input arrived: it is your next message. What you waited for keeps running.'
				})
			)
		);
		return yield* Effect.raceFirst(heard, Effect.gen(function* () {
			const ids = i.jobs ?? [];
			const ms = Math.min(Math.max(1000, (i.seconds ?? Infinity) * 1000), JOBS.waitMs);
			// automation runs are sys_run rows, not this turn's jobs: follow them until one ends (a probe waited on a
			// statutory research run for ten minutes and never heard it finish)
			if (ids.length > 0 && ids.every((id) => !x.jobs.has(id))) {
				const read = x.engine.db
					.rows(RunViewRow, {
						text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`,
						params: [JSON.stringify(ids)]
					})
					.pipe(
						Effect.map((rows) =>
							rows.flatMap((row) => {
								const view = run_view(a, row);
								return view === null ? [] : [view];
							})
						)
					);
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const { runEnds } = x.engine;
						const subscription =
							runEnds === undefined ? null : yield* PubSub.subscribe(runEnds);
						const views = yield* read;
						if (views.length === 0)
							return err(`No job or automation run ${ids.join(', ')}.`);
						const isSettled = (view: (typeof views)[number]) =>
							view.status !== 'queued' && view.status !== 'running';
						const settled = views.find(isSettled);
						if (settled !== undefined) return ok({ settled });
						const visible = new Set(views.map((view) => view.id));
						const heard =
							subscription === null
								? Effect.never
								: PubSub.take(subscription).pipe(
										Effect.repeat({
											until: (ended) => ended.some((id) => visible.has(id))
										})
									);
						const ended = yield* heard.pipe(Effect.timeoutOption(ms));
						if (Option.isNone(ended))
							return ok({ settled: null, running: views });
						const current = yield* read;
						const answer = current.find(isSettled);
						return answer === undefined
							? ok({ settled: null, running: current })
							: ok({ settled: answer });
					})
				);
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
			return ok({ settled: got, pending: x.jobs.pending() });
		}));
	});
	// an MCP tool changes with the workspace: native in the list a conversation froze at its start, through run_tool when a
	// merge added it later; callable only while acting
	const mcpTools: AgentTool[] = [];
	for (const tool of x.mcpTools) {
		if (!Predicate.isObject(tool.input)) continue;
		const definition = { name: mcpName(tool.server, tool.name), description: tool.description, input: tool.input, behavior: {} };
		mcpTools.push(definition);
		if (!agent) continue;
		const valid = validatorFor(x.validators, tool.input);
		add(
			{ ...definition, decode: Effect.succeed },
			function* (given) {
				const input = valid(given);
				return typeof input === 'string' ? err(input) : ok(yield* x.mcp.call(tool.server, tool.name, input));
			},
			{},
			mcpEntries
		);
	}
	add(runToolTool, function* (i, callId) {
		if (FIXED_NAMES.has(i.name) || hostOffered.some((tool) => tool.name === i.name))
			return err(`'${i.name}' is in your tool list: call it by its own name.`);
		return yield* runMcp(i.name, i.input === undefined ? {} : i.input, callId);
	});
	// Host tools are fixed per host and role, so they sit in the tool list by their own names; each keeps its raw JSON
	// Schema, checked by its validator. A planning turn binds only the read-only ones
	for (const host of [...x.browser_tools, ...(x.inApp && staff ? hosted : [])]) {
		const { name, description, input: schema, behavior } = host;
		if (
			!Predicate.isObject(schema) ||
			!(a.admin || a.capabilities.tools.includes(name) || (host.source === true && host.read_only === true))
		)
			continue;
		hostOffered.push({ name, description, input: schema, behavior });
		if (!(agent || host.read_only === true)) continue;
		const valid = validatorFor(x.validators, schema);
		add({ name, description, input: schema, behavior, decode: Effect.succeed }, function* (given, id) {
			const input = valid(given);
			if (typeof input === 'string') return err(input);
			const files = host.files === true ? yield* conversationFiles(x, namedFiles(input)) : [];
			if (typeof files === 'string') return err(files);
			const shown: { name: string; mime: string; bytes: Uint8Array }[] = [],
				kept: Downloaded[] = [];
			const context: HostToolContext = {
				actor: a.actor,
				conversation: x.conv.id,
				...(a.agent === undefined ? {} : { agent: a.agent }),
				turn: x.turn,
				call_id: id,
				...(x.question === undefined ? {} : { question: x.question }),
				attach: (file) => {
					attach(x.files, file);
					if (host.studio === 'view')
						shown.push({ name: `${name}-${shown.length + 1}.${file.mime.split('/')[1] ?? 'png'}`, ...file });
				},
				keep: (file) => kept.push(file),
				files
			};
			// a screenshot the person sees too (stored now), or a download (stored by the host): their file, offered on
			// the step. Inside the job, so a tool past the inline wall still records what it kept
			const offered = Effect.fnUntraced(function* (result: Json) {
				if (!Predicate.isObject(result) || (kept.length === 0 && (shown.length === 0 || e.files === undefined)))
					return result;
				const files: Json[] = [];
				if (e.files !== undefined) for (const f of shown) files.push(yield* storeFile(x, e.files, f));
				for (const f of kept) files.push(yield* recordFile(x, f));
				return { ...result, files };
			});
			const job = yield* x.jobs.add(
				name,
				Port.attempt(name, (signal) => host.call(input, context, signal)).pipe(
					Port.call(name, host.wall_ms ?? JOBS.hostMs),
					Effect.flatMap(offered)
				),
				{
					behavior,
					...(host.studio === undefined ? {} : { studio: host.studio }),
					alert: (id: string, result: Json) => `[job ${id} finished] ${name}: ${JSON.stringify(bounded(result).value)}`
				}
			);
			const inline = yield* x.jobs.wait([job], x.inlineMs ?? JOBS.inlineMs);
			return ok(
				inline?.result ?? { job, note: 'Still running; keep working. Its result arrives by itself, or wait returns it.' }
			);
		}, host.studio === undefined ? {} : { studio: host.studio });
	}
	const encodeAnswer = Schema.encodeUnknownEffect(ToolAnswer);
	const execute = (registry: ReadonlyMap<string, BoundTool>, name: string, input: unknown, callId: string) => {
		const entry = registry.get(name);
		if (entry === undefined)
			return Effect.succeed(err(`Tool '${name}' is not available in this step. Available tools: ${[...registry.keys()].join(', ') || 'none'}`));
		return entry.run(input, callId).pipe(
			// Retain result validation at the boundary without a second input decode or an intermediate tool stream.
			Effect.flatMap((answer) => encodeAnswer(answer).pipe(
				Effect.mapError((error) => new Error(`Failed to encode result for tool '${name}': ${error.message}`)),
				Effect.as(answer)
			)),
			Effect.catch((error) => Effect.succeed(err(error.message)))
		);
	};
	const runMcp: Catalogue['run'] = (name, input, callId) => execute(mcpEntries, name, input, callId);
	// a native MCP tool is called by its own name, a later one through run_tool; a script reaches both by name
	const run: Catalogue['run'] = (name, input, callId) =>
		entries.has(name) || !mcpEntries.has(name) ? execute(entries, name, input, callId) : runMcp(name, input, callId);
	self = run;
	return {
		fixed: fixedTools(x.audience, x.child),
		host: hostOffered,
		mcp: mcpTools,
		available: [...entries.values(), ...mcpEntries.values()].map((entry) => entry.tool),
		index: catalogueIndex(e.manifest, a, x.skills, mcpTools, acts, automations, sync_controls),
		presentation: (name, input) => {
			const host = name === runToolTool.name && isObj(input) && typeof input['name'] === 'string'
				? mcpEntries.get(input['name']) : undefined;
			const definition = host?.tool ?? entries.get(name)?.tool;
			const given = host !== undefined && isObj(input) ? input['input'] : input;
			return {
				name: host?.tool.name ?? name,
				input: given === undefined ? {} : given,
				...(definition?.studio === undefined ? {} : { studio: definition.studio }),
				behavior: definition?.behavior ?? {}
			};
		},
		run
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
const SourceFile = systemRow('sys_file', ['id', 'name', 'mime', 'size', 'key', 'sha256']);
/** An ingest's output entry (plan 12): the source file's group, its HTML the entry's own file once ready. */
const IngestEntry = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	name: Schema.String,
	files: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				mime: Schema.String,
				size: Schema.Number
			})
		)
	),
	ingest: Schema.Struct({
		output: Schema.String,
		source: Schema.String,
		sha256: Schema.String,
		status: Schema.Literals(['ingesting', 'ready', 'failed']),
		job: Schema.optionalKey(Schema.String),
		error: Schema.optionalKey(Schema.String)
	})
});
const SHORT_ID = /^[0-9a-f]{8}$/;
/** A file's short id in full, when one file of this conversation has it; anything else stays as given. */
const wholeId = Effect.fn('Agents.wholeId')(function* (x: ToolContext, id: string) {
	if (!SHORT_ID.test(id)) return id;
	const [read] = yield* x.engine.db.read([
		{
			text: `SELECT i->>'id' AS id FROM sys_conversation c, jsonb_array_elements(c.inputs || c.outputs) i
				WHERE c.id = $1 AND i->>'id' LIKE $2`,
			params: [x.conv.id, `${id}%`]
		}
	]);
	const [only, other] = read?.rows ?? [];
	return only !== undefined && other === undefined ? String(only['id']) : id;
});
/**
 * The conversation files a file run names, as `/in/<name>`: the member's own uploads and outputs here, at most
 * `RUN_JS.inBytes` in all, one name each. A string is why not.
 */
const FileRefs = Schema.Struct({ files: Schema.Array(Schema.Struct({ id: Schema.String })) });
/** The `files: [{ id }]` of a call, which the tool's own schema has checked. */
const namedFiles = (input: Json) =>
	Option.match(Schema.decodeUnknownOption(FileRefs)(input), {
		onNone: () => [],
		onSome: ({ files }) => files
	});
const conversationFiles = Effect.fn('Agents.runFileInputs')(function* (
	x: ToolContext,
	refs: readonly { readonly id: string }[]
) {
	if (refs.length === 0) return [];
	const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null,
		files = x.engine.files,
		ids = yield* Effect.forEach(refs, (ref) => wholeId(x, ref.id));
	if (member === null || files === undefined) return 'This run can be handed no files.';
	const rows = yield* x.engine.db.rows(InputFile, {
		// the member's own, or an ingest filed in this conversation's outputs (a cached ingest may be another member's)
		text: `SELECT id, name, key, size FROM sys_file f WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))
			AND field IN ('sys_conversation.inputs', 'sys_conversation.outputs') AND (created_by = $2 OR EXISTS (
				SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.outputs) o
				WHERE c.id = $3 AND (o->>'id' = f.id OR o->'files' @> jsonb_build_array(jsonb_build_object('id', f.id)))
			))`,
		params: [JSON.stringify(ids), member, x.conv.id]
	});
	const byId = new Map(rows.map((file) => [file.id, file]));
	const named: (readonly [string, Uint8Array])[] = [];
	let bytes = 0;
	for (const id of ids) {
		const file = byId.get(id);
		if (file === undefined) return `File ${id} is not one of your files in this conversation.`;
		const name = file.name.replaceAll('/', '_');
		if (named.some(([taken]) => taken === name)) return `Two files are named ${name}.`;
		bytes += file.size;
		if (bytes > RUN_JS.inBytes) return `The files are over ${RUN_JS.inBytes / 1024 / 1024} MiB.`;
		named.push([name, yield* files.get(file.key, file.size)]);
	}
	return named;
});
/** A conversation file as inline code reads it: text as text, other bytes as base64. */
const fileContent = (bytes: Uint8Array): Json => {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return { base64: toBase64(bytes) };
	}
};
const ReferenceFile = systemRow('sys_file', ['key', 'size']);
const ReferenceJson = Schema.fromJsonString(ReferenceIndex);
/** The person's own latest reference by that name, its index decoded. A string is why not. */
const referenceIndex = Effect.fn('Agents.referenceIndex')(function* (x: ToolContext, name: string) {
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
	return Option.isNone(index) ? `The reference ${name} cannot be read.` : index.value;
});
/** `read_file` on a reference: `<name>` or a folder lists its files, with `text` greps them, `<name>/<path>` reads one. */
const readReference = Effect.fn('Agents.readReference')(function* (
	x: ToolContext,
	id: string,
	i: { readonly from?: number | undefined; readonly to?: number | undefined; readonly text?: string | undefined }
) {
	const slash = id.indexOf('/'),
		name = slash < 0 ? id : id.slice(0, slash),
		path = slash < 0 ? '' : id.slice(slash + 1),
		index = yield* referenceIndex(x, name),
		files = x.engine.files;
	if (typeof index === 'string') return err(index);
	if (files === undefined) return err('This host stores no files.');
	const read = (file: (typeof index.files)[number]) =>
		Effect.map(files.get(file.key, file.bytes), (bytes) => new TextDecoder().decode(bytes));
	const file = index.files.find((one) => one.path === path);
	if (file !== undefined) {
		const text = yield* read(file);
		return ok({ path, ...window(text, i.from, i.to, undefined, 'text') });
	}
	const folder = path === '' ? '' : `${path.replace(/\/$/, '')}/`,
		under = index.files.filter((one) => one.path.startsWith(folder));
	if (under.length === 0) return err(`${name} has no file '${path}'.`);
	if (i.text === undefined || i.text === '')
		return textAnswer(under.map((one) => `${one.path}  ${one.bytes}`).join('\n'));
	const hits: string[] = [];
	const found = yield* Effect.forEach(under, (one) => read(one), { concurrency: 8 });
	for (const [n, text] of found.entries())
		for (const hit of grep(text, i.text, 200 - hits.length, 'text').hits)
			hits.push(`${under[n]?.path}:${hit.from}: ${hit.text}`);
	return textAnswer(hits.length === 0 ? `Nothing in ${name} holds '${i.text}'.` : hits.join('\n'));
});
/**
 * A repository reference's tree for a file run: the person's own latest reference by that name, its index decoded
 * once, at most `REFERENCE.treeBytes`, every file by its content address. A string is why not.
 */
const referenceTree = Effect.fn('Agents.referenceTree')(function* (
	x: ToolContext,
	name: string,
	entry: string
) {
	const index = yield* referenceIndex(x, name),
		files = x.engine.files;
	if (typeof index === 'string') return index;
	if (files === undefined) return 'This run reads no repository references.';
	const { digest, files: listed } = index;
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
	// one native statement: the file and its place among the conversation's outputs, published to live readers
	const chain = new Chain();
	capturePiece(chain, 'filed', 'sys_file', `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
		VALUES (${chain.p(id)}, ${chain.p(file.name)}, ${chain.p(file.mime)}, ${chain.p(file.bytes)}, ${chain.p(file.key)}, ${chain.p(file.sha256)},
			'sys_conversation.outputs', ${chain.p(x.bindings.now)}::timestamptz, ${chain.p(member)})`);
	capturePiece(chain, 'listed', 'sys_conversation',
		`UPDATE sys_conversation SET outputs = outputs || ${chain.p(JSON.stringify([ref]))}::jsonb WHERE id = ${chain.p(x.conv.id)}`);
	yield* nativeCommit(x.engine.db.write, x.engine.live.publish, chain, CapturedResult);
	return ref;
});
/** Raw-schema validators by schema object, held by the engine that compiled them. */
export type Validators = WeakMap<object, ReturnType<typeof validatorOf>>;
const validatorFor = (validators: Validators, input: { readonly [key: string]: Json }) => {
	const valid = validators.get(input) ?? validatorOf(input);
	validators.set(input, valid);
	return valid;
};
/** An MCP tool's name in a tool list: providers take [A-Za-z0-9_-], and no fixed tool holds a double underscore. */
const mcpName = (server: string, tool: string) => `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
/** The tools a script's `tool()` never reaches: they steer the turn or the person's tab. */
const UNSCRIPTED: ReadonlySet<string> = new Set(['ask', 'wait', 'run_js', 'subagent', 'subagent_message', 'subagent_stop', 'update_plan', 'page']);

// Tool text and model schemas are shared; handlers bind only when a step is admitted.
const READ_TEXT = `Read records. request: { "<model>": { where, fields, order_by, limit, after, search, aggregate, as_of, output, "<relation>": { where, fields, order_by, limit, search, aggregate, "<relation>": { ... } } } }, each model and relation once. output: omit it for "default", else one of the model's reads. order_by: "<field>", { <field>: "desc" } or a list of those.
where: { <field>: { eq|ne|lt|lte|gt|gte|in|is_null: value, like: "%text%" (ignores case), contains: value (a period or a JSON field) } }, { "$search": "<words>" } (each word required), and/or/not; on a relation { is|some|none|every: where } or { count|sum|avg|min|max: … }; a value may be { var: CEL over requestor, today, now }.
search: words (ranked, not required), { <index>: input } or { semantic: text }. aggregate: { count, sum|avg|min|max: [field], by: field | { day|week|month|quarter|year: field } or a list of those }; a field there may be "<link>.<field>" through links to one record.
Answers each model's { rows, next, total } (total counts every match), or with aggregate its measures. Long values are clipped.`;
const recordsTool = defineTool('read', {
	behavior: { data: true, resume: { argument: 'after', roots: true } },
	description: READ_TEXT,
	parameters: ReadInput
});
/** The agent's `read`: the same request, with its per-root options and the workspace's ledgers as roots. */
const agentReadTool = defineTool('read', {
	behavior: recordsTool.behavior,
	description: `${READ_TEXT}
On a root, history: true adds each row's revisions as $history (who, when, cause, changed fields; at most 20 rows), approvals: true each row's approval requests as $approvals (steps, deciders, log, moves you may make).
Ledger roots, each answering { rows, next } newest first: "$runs": { id, automation (a name or prefix*), status, cause, since, until, limit, after } automation runs, id one in full with input, result, attempts and log; "$approvals": { model, ids, all } approval requests you may see, open ones unless all; "$logs": { level, text, run, automation, conversation, since, until, limit, after } live's runtime log; "$audit": { id, text, actor_id, category, action, status, model, record, run, since, until, limit, after } the audit trail.`,
	parameters: ReadInput
});
const describeTool = defineTool('describe_workspace', {
	behavior: { data: true },
	description: "The workspace as you may use it: apps, pages, models with their fields and row counts, automations. names answers each in full; 'system' names the native setup capabilities, connections, secrets and MCP servers.",
	parameters: Schema.Struct({ names: Schema.optionalKey(Schema.Array(Schema.String)) }),
});
const pageTool = defineTool('page', {
	behavior: { page: true },
	description: "Drive the person's visible tab: open path (configure: a native setup form), click or highlight visible text, type into a labelled field, scroll, go back|forward, preview a URL beside the chat. Buttons, external links and typed values await their confirmation; approvals, passwords and files are theirs alone. The resulting page arrives at your next step.",
	parameters: Schema.Struct({
		path: Schema.optionalKey(Schema.String),
		configure: Schema.optionalKey(
			Schema.Struct({ capability: Schema.String, record: Schema.optionalKey(Schema.String) })
		),
		click: Schema.optionalKey(Schema.NonEmptyString),
		type: Schema.optionalKey(
			Schema.Struct({
				label: Schema.NonEmptyString,
				text: Schema.String,
				submit: Schema.optionalKey(Schema.Boolean)
			})
		),
		scroll: Schema.optionalKey(Schema.Finite),
		go: Schema.optionalKey(Schema.Literals(['back', 'forward'])),
		highlight: Schema.optionalKey(Schema.NonEmptyString),
		preview: Schema.optionalKey(Schema.String)
	})
});
const actTool = defineTool('act', {
	behavior: { data: true },
	description: `Write records, decide an approval or start an automation: { callable, input }.
"<model>.create": [{ column: value, relation: [new row | existing { id, revision }] }]. "<model>.update": [{ target, set: { column, relation: { create, update, delete, link, unlink } } }]. "<model>.delete": [{ target }]. "<model>.import": { rows, on_conflict: "update"|"keep"|"refuse", on_missing?: "create"|"skip", prune?, dry_run? }. A target, link or existing child is { id, revision } with the revision you read; an audited model refuses one without it. A batch commits together, related rows with their root. A file field takes a file's id.
"automation.<name>": its input; a call answers its output, a job ends at your next step. "approvals.decide": { request_id, decision, reason? }. "sys_invitation.create": [{ email | phone, team? }].
Answers the stored rows, or holds for approval.`,
	parameters: WriteInput,
});
const syncTool = defineTool('sync', {
	behavior: { data: true },
	description: 'Run a native sync (model, sync from describe_workspace). Remote read input: { instance?, partition? } or {}. File transfer: { mode: "import", file, context? } or { mode: "template"|"export", format?, to?, where?, context? }, reading and writing as you. Your permissions admit it; it ends at your next step. Never schedulable as an automation.',
	parameters: Schema.Struct({ model: Schema.String, sync: Schema.String, input: Schema.optionalKey(ToolJson) })
});
const updatePlanTool = defineTool('update_plan', {
	description: 'Write the draft plan: body replaces it, patch { old, new } changes one exact passage.',
	parameters: Schema.Struct({
		body: Schema.optionalKey(Schema.String),
		patch: Schema.optionalKey(Schema.Struct({ old: Schema.String, new: Schema.String })),
		expected_revision: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});
const skillTool = defineTool('skill', {
	behavior: { data: true },
	description: "Read one of your skills whole, one ## section, or one of its files.",
	parameters: Schema.Struct({
		name: Schema.String,
		section: Schema.optionalKey(Schema.String),
		file: Schema.optionalKey(Schema.String)
	})
});
const historyTool = defineTool('history', {
	description: "Search earlier messages in this conversation, or scope mine for all of this person's.",
	parameters: Schema.Struct({
		query: Schema.String,
		scope: Schema.optionalKey(Schema.Literals(['this', 'mine'])),
		limit: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});
const readMessagesTool = defineTool('read_messages', {
	description: "This chat's messages, newest first, before a message seq (default: the newest), at most limit (≤ 50).",
	parameters: Schema.Struct({
		before: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		limit: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});
const readFileTool = defineTool('read_file', {
	behavior: { data: true },
	description: "Read a file by id (conversation, record or tool output); documents, scans, sheets and recordings are parsed. A reference lists its paths; read '<reference>/<path>'. A document answers numbered lines with the page images they show (from, to: lines), a sheet its columns and first rows. text answers the lines holding it (a|b for either). password opens a locked PDF or Office file.",
	parameters: Schema.Struct({
		id: Schema.String,
		from: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		to: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		text: Schema.optionalKey(Schema.String),
		password: Schema.optionalKey(Schema.String).annotate({
			description: 'the password the person gave for this file'
		})
	})
});
const viewImageTool = defineTool('view_image', {
	behavior: { data: true },
	description: "Show an image of a read file on your next step: image n (1-based) of a document, or page n of a PDF as a picture; crops shows up to 8 regions of it instead, at most 3 zooms a document a turn.",
	parameters: Schema.Struct({
		id: Schema.String,
		image: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		page: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		crops: Schema.optionalKey(
			Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]))
				.check(Schema.isMaxLength(8))
				.annotate({ description: '[left, top, right, bottom], fractions 0 to 1' })
		),
		password: Schema.optionalKey(Schema.String)
	})
});
const readOutputTool = defineTool('read_output', {
	behavior: { data: true, resume: { argument: 'offset' } },
	description: 'The rest of a clipped tool result, by its call id, from a character offset.',
	parameters: Schema.Struct({
		call: Schema.String,
		offset: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});
const geocodeTool = defineTool('geocode', {
	description: 'Places for an address or name (query), or at a point (reverse), each with the point a geolocation field takes.',
	parameters: Schema.Struct({
		query: Schema.optionalKey(Schema.String),
		reverse: Schema.optionalKey(Schema.Struct({ lat: Schema.Number, lng: Schema.Number }))
	})
});
const readSource = defineTool('workspace_read', {
	behavior: { pure: true, data: true },
	description: 'Read source files (path, or paths) as numbered <line>: <content> lines. offset: 1-based start line; limit ≤ 2000.',
	parameters: Schema.Struct({
		path: Schema.optionalKey(Schema.NonEmptyString),
		paths: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
		offset: Schema.optionalKey(Schema.Int),
		limit: Schema.optionalKey(Schema.Int)
	})
});
const searchSource = defineTool('workspace_search', {
	behavior: { pure: true, data: true },
	description: 'ripgrep the source: pattern is a regex, or exact text with literal. Answers matching lines, or with files the files only. path: a file or directory; include: a file glob (*.{ts,svelte}). Case-sensitive by default.',
	parameters: Schema.Struct({
		pattern: Schema.NonEmptyString,
		path: Schema.optionalKey(Schema.String),
		include: Schema.optionalKey(Schema.NonEmptyString),
		files: Schema.optionalKey(Schema.Boolean),
		literal: Schema.optionalKey(Schema.Boolean),
		case_sensitive: Schema.optionalKey(Schema.Boolean),
		limit: Schema.optionalKey(
			Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
		)
	})
});
const listSource = defineTool('workspace_list_dir', {
	behavior: { pure: true, data: true },
	description: 'The source tree under path, the whole workspace by default, with what each folder and role is for.',
	parameters: Schema.Struct({ path: Schema.optionalKey(Schema.String) }),
});
const subagentTool = defineTool('subagent', {
	description: 'Start a background sub-agent with your authority on task (≤ 4 at once): done says when it is finished, format what it returns, agent which agent it is. Answers its conversation; its report arrives as a message and wakes you.',
	parameters: Schema.Struct({
		task: Schema.String,
		done: Schema.optionalKey(Schema.String),
		format: Schema.optionalKey(Schema.String),
		agent: Schema.optionalKey(Schema.String)
	})
});
const subagentReadTool = defineTool('subagent_read', {
	behavior: { data: true },
	description: "One of your sub-agents: its status, last messages, tool calls and the records it changed.",
	parameters: Schema.Struct({ conversation: Schema.String })
});
const subagentMessageTool = defineTool('subagent_message', {
	description: 'Send one of your sub-agents a message; it carries on and reports here.',
	parameters: Schema.Struct({ conversation: Schema.String, text: Schema.String })
});
const subagentStopTool = defineTool('subagent_stop', {
	description: 'Stop one of your sub-agents.',
	parameters: Schema.Struct({ conversation: Schema.String })
});
const downloadTool = defineTool('download', {
	description: "Save a public http(s) file as the person's: media, a PDF, HTML or CAD, at most 100 MiB.",
	parameters: Schema.Struct({ url: Schema.String }),
});
const runJsTool = defineTool('run_js', {
	behavior: { data: true },
	description: "Run JavaScript in a fresh billed isolate; only its return value and prints come back. code: an async function body of input, without require, process, fetch or timers. await tool(name, input) calls your other tools by name, as you, ≤ 200 calls; a failed call throws its error. files: [{ id }] arrive as input.files { name: text | { base64 } }. http: true adds await http({ method?, url, headers?, body? }) answering { status, headers, text }, public https only. Return { files: [{ name, text | base64 }] } to give the person files. file runs '<skill>/<path>' or '<reference>/<path>' with args, /in and /out instead of code. Walls: 3 s CPU, 256 MiB, 60 s, 4 MiB answer.",
	parameters: Schema.Struct({
		code: Schema.optionalKey(Schema.String),
		input: Schema.optionalKey(ToolJson),
		file: Schema.optionalKey(Schema.String),
		args: Schema.optionalKey(Schema.Array(Schema.String)),
		files: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
		http: Schema.optionalKey(Schema.Boolean)
	})
});
const askTool = defineTool('ask', {
	description: 'Sends one question with optional answer choices to the person, or in a sub-agent to the agent that delegated the task, then ends the turn.',
	parameters: Schema.Struct({
		question: Schema.String,
		options: Schema.optionalKey(Schema.Array(Schema.String))
	})
});
const waitTool = defineTool('wait', {
	description: `Wait up to ${JOBS.waitMs / 1000} s for the first of jobs (default: any of this turn) to end. A finished job also arrives at your next step.`,
	parameters: Schema.Struct({
		jobs: Schema.optionalKey(Schema.Array(Schema.String)),
		seconds: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});
const runToolTool = defineTool('run_tool', {
	description: 'Run a tool a catalogue note added after this conversation began: run_tool { name, input }.',
	parameters: Schema.Struct({ name: Schema.String, input: Schema.optionalKey(ToolJson) })
});
const documentTool = defineTool('document', {
	description: 'Make a file from markdown (tables and inline HTML allowed) and offer it to the person; a file field takes its id. In pptx each ## starts a slide.',
	parameters: Schema.Struct({
		to: Schema.Literals(CONVERT_TARGETS),
		name: Schema.String,
		markdown: Schema.String,
		page: Schema.optionalKey(Schema.Literals(PAPER_SIZES)),
		landscape: Schema.optionalKey(Schema.Boolean)
	})
});
const HistoryRevisions = Schema.Array(
	Schema.StructWithRest(Schema.Struct({ actor: Schema.NullOr(Schema.Struct({ kind: Schema.String, id: Schema.String })) }), [
		Schema.Record(Schema.String, Schema.Json)
	])
);
/**
 * Whom a conversation serves, fixed for its life: an in-app staff member, an in-app external member, or a messaging
 * channel's sender. Each has one tool list, so a conversation's `tools[]` never changes; a tool its step cannot use
 * answers why.
 */
export type Audience = 'staff' | 'member' | 'channel';
const ALL_TOOLS = [
	agentReadTool, describeTool, pageTool, actTool, syncTool, updatePlanTool, skillTool, historyTool, readMessagesTool,
	readFileTool, viewImageTool, readOutputTool, geocodeTool, readSource, searchSource, listSource, subagentTool,
	subagentReadTool, subagentMessageTool, subagentStopTool, documentTool, downloadTool, runJsTool, askTool, waitTool,
	runToolTool
];
const AUDIENCE: { readonly [A in Audience]: ReadonlySet<string> } = {
	staff: new Set(ALL_TOOLS.map((tool) => tool.name).filter((name) => name !== 'read_messages')),
	member: new Set(ALL_TOOLS.map((tool) => tool.name).filter((name) => !['read_messages', 'download', 'workspace_read', 'workspace_search', 'workspace_list_dir'].includes(name))),
	channel: new Set(ALL_TOOLS.map((tool) => tool.name).filter((name) => !['page', 'update_plan', 'download', 'workspace_read', 'workspace_search', 'workspace_list_dir'].includes(name)))
};
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_read', 'subagent_message', 'subagent_stop', 'update_plan']);
/** The fixed tool list of an audience; a sub-agent's leaves out delegation and planning. */
export const fixedTools = (audience: Audience, child: boolean): readonly AgentTool[] =>
	ALL_TOOLS.filter((tool) => AUDIENCE[audience].has(tool.name) && !(child && SUBAGENT_TOOLS.has(tool.name)))
		.map(({ name, description, input, behavior }) => ({ name, description, input, behavior }));
const FIXED_NAMES: ReadonlySet<string> = new Set(ALL_TOOLS.map((tool) => tool.name));
