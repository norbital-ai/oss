// The fixed tool set (rule 58): `read` (a layer map over what the actor may read), `act` (guarded writes, approval decisions,
// automation and sync starts), `describe_workspace`, `page` (the person's open tab), `read_file` (files, ingests and clipped
// results), `run_js`, the plan and checklist tools, skills, `history`, `runs`, `logs`, `geocode`, `read_messages` on envoy
// turns, the workspace source tools for staff, `document`, `download`, `subagent` and `wait` under delegation, MCP tools a held
// policy names, and host tools (Studio, browser, personal skills) on in-app staff turns. Built-in tools are `Tool.make`
// definitions, MCP and host tools `Tool.dynamic` ones over their raw JSON Schema, all in one per-turn `Toolkit` (P7).
// A tool's text is static across workspaces and turns so providers cache the shared prefix: it says what the tool does, in a
// line or two, and names no model, path or sample; what an actor holds is `describe_workspace`'s, and a wrong name's error
// lists the right ones. The agent has no authority of its own (decision 10): every call runs as the actor, so a refusal is
// the engine's answer, never the agent's.
import { item_kind } from '@norbital-ai/std/kind';
import { Validator } from '@cfworker/json-schema';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	FiberMap,
	FiberSet,
	Option,
	Predicate,
	PubSub,
	Result,
	Schedule,
	Schema,
	Stream,
	type SchemaAST
} from 'effect';
import { Tool, Toolkit } from 'effect/ai';
import * as EffectArray from 'effect/Array';
import { Images, type Geo, type LogsShape } from '../ports.ts';
import { imageCrop, imageJpeg } from '../files/image.ts';
import { Port, type PortFailure } from '../port.ts';
import type { EngineError } from '../errors.ts';
import { RUN_VIEW_COLUMNS, RunViewRow, runView } from '../runs/index.ts';
import { actorRef } from '../write/commit.ts';
import { readLog, runLog } from '../guest/telemetry.ts';
import { readableFile } from '../decisions/index.ts';
import { toBase64 } from '../crypto.ts';
import { sha256Hex } from '@norbital-ai/store';
import { FOLDER_NOTES, roleAt } from '../../decl/layout.ts';
import type { Json } from '../../decl/values.ts';
import { encodeWire } from '@norbital-ai/std/wire';
import {
	CONVERT_MIME,
	type Authority,
	type Bindings,
	type Downloaded,
	type Ingested,
	type ImageCrop,
	type Outcome
} from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import { SYSTEM_UI, SystemUiRequest, systemUiPath } from '../../protocol/system-ui.ts';
import { exposed, outputsOf, readsAny, requestorOf, writableColumns } from '../access/authority.ts';
import {
	LayerRequestSchema,
	READ_LIMIT,
	type LayerRequestJson,
	type ReadRequestJson
} from '../../protocol/read-request.ts';
import type { AgentEngine as Engine } from './index.ts';
import { lowerRead } from '../query/engine.ts';
import { materializeEach } from '../runs/time.ts';
import {
	BOUNDS,
	bound,
	bounded,
	filesOf,
	localTime,
	outputText,
	page,
	size,
	shortId
} from './context.ts';
import { MODEL_FILES, ToolAnswer, toolSchema, type AnyTool, type InferTool } from './ai.ts';
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
	type StoredFile
} from './ingest.ts';
import { canOpen, nav, navigationPaths } from '../../shell/nav.ts';
import { InvitationInput, inviteMany } from '../identity/members.ts';
export { ToolAnswer, type AnyTool } from './ai.ts';
import { REFERENCE, ReferenceIndex, RUN_JS, runFile, runJs } from './run-js.ts';
import { layered, layers, SKILL_FILE, type EngineManifest, type SkillSpec } from '../manifest.ts';
import type { InputKind } from '../../decl/fields.ts';
import { row as systemRow } from '../system/rows.ts';
import { SYSTEM } from '../../system/index.ts';
import { isObj } from './draft.ts';
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
	/** The agent's mark when this turn runs as one (`Authority.agent`): a browser page opened for it is the agent's. */
	agent?: Authority['agent'];
	turn: string;
	callId: string;
	/** The person's latest message, when the turn has one (a search host ranks by it). */
	question?: string;
	/** An image the model sees on its next step (a screenshot). */
	attach(file: { mime: string; bytes: Uint8Array }): void;
	/** A file the host stored (a download), recorded as the person's and offered on the step; the model sees only its reference. */
	keep?(file: Downloaded): void;
	/** The conversation files the call named in `files`, by name, for a `files` tool. */
	files?: readonly (readonly [name: string, bytes: Uint8Array])[];
};

/**
 * A host capability (`capabilities.tools`): offered to staff members in the app only; `readOnly` ones also while planning.
 * An administrator holds every one, another member those their policies grant, and every staff member a read-only
 * `source` tool (it reads the workspace's own source, never a secret or a host file).
 */
export type HostTool = {
	name: string;
	description: string;
	input: Json;
	readOnly?: boolean;
	source?: true;
	studio?: StudioRole;
	/** A call's wall when it is past the usual host call's. */
	wallMs?: number;
	/** The call's `files: [{ id }]` are read for it, as `run_js`'s are. */
	files?: true;

	call(input: Json, ctx: HostToolContext, signal: AbortSignal): Promise<Json>;
};
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
/** A `workspace_search` as the host's ripgrep answers it, its hits in path order. */
export type SearchRequest = {
	readonly pattern: string;
	readonly path?: string;
	readonly include?: string;
	/** Only the files holding a match, one hit each. */
	readonly files?: boolean;
	readonly literal?: boolean;
	readonly caseSensitive?: boolean;
	readonly limit?: number;
};
export type SearchAnswer =
	| {
			readonly hits: readonly {
				readonly path: string;
				readonly line: number;
				readonly text: string;
			}[];
			readonly truncated: boolean;
	  }
	| { readonly error: string };
export type SourceSearch = (request: SearchRequest) => Promise<SearchAnswer | undefined>;
/** The released workspace as built (`artifact/workspace/`): its source files. Every host binds it. */
export type WorkspacePort = {
	files(): Promise<readonly string[]>;
	read(path: string): Promise<string | null>;
};
/** A file past this is read for its text alone: a long tender's scans would not fit one answer. */
export const TEXT_FIRST_BYTES = 16 * 1024 * 1024;
/** Long work: a host call past 30 s (at most 10 minutes), an ingest. */
export const JOBS = { inlineMs: 30000, hostMs: 60000, waitMs: 120000, ingestMs: 600000 } as const;
type Jobs = Effect.Success<ReturnType<typeof jobs>>;
const jobFailed = (result: Json): string | undefined =>
	Predicate.isObject(result) && !Array.isArray(result) && typeof result['error'] === 'string'
		? result['error']
		: undefined;
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
		/** A job ended, by its label, with its answer. */
		readonly ended?: (label: string, answer: Json) => void;
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
						options.ended?.(label, value);
						const line =
							o.alert?.(id, value) ??
							(failed !== undefined
								? `[job ${id} failed] ${label}: ${failed}; tell the person`
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
	/** The author's current working source; absent when this person authors nothing here. */
	draft?: WorkspacePort | undefined;
	/** The host's search over the caller's working tree; nothing back, the engine scans it itself. */
	search?: SourceSearch | undefined;
	geocoder?: Geo['Service'] | undefined;
	skills: { readonly [name: string]: Skill };
	agents: readonly string[];
	receipts: Receipt[];
	/** What this turn has read (skills, sections, files), each with how the closing note names it: already above. */
	read: Map<string, string>;
	/** The host's ingest port (plan 12, Norbital Convert): a file as HTML and its images. Absent: no document ingests. */
	ingest?:
		| ((
				file: { sha256: string; name: string; mime: string; key: string; size: number },
				read?: { readonly page?: number; readonly password?: string }
		  ) => Effect.Effect<Ingested | { readonly unsupported: string }, PortFailure>)
		| undefined;
	/** What the last step's calls opened, for the next request alone (rule 62's budget), each after the call that opened it. */
	files: {
		mime: string;
		bytes: Uint8Array;
		call?: string;
		id?: string;
	}[];
	jobs: Jobs;
	inlineMs?: number | undefined;
	setPlan(body: string): Effect.Effect<void, EngineError>;
	setGoals(goals: Goal[]): Effect.Effect<void, EngineError>;
	/** A sub-agent's question for its delegating agent: its turn ends on it, and the delegating agent's `message` resumes it. */
	ask(question: string): void;
	/** An instance's history: `unread` = ambient rows not yet read, oldest first, marked read by `key`; else newest first before `before`. */
	messages(o: {
		unread: boolean;
		limit: number;
		before?: number;
		key: string;
	}): Effect.Effect<readonly MessageRow[], EngineError>;
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
	readonly description: string;
	readonly input: Json;
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
/**
 * A tool whose text and schema are the same for every conversation: one definition per cell, so what a step offers
 * allocates nothing per session and its JSON Schema is derived once (`toolSchema`).
 */
const definitions = new Map<string, AnyTool>();
const shared = <T extends AnyTool>(name: string, make: () => T): T => {
	const held = definitions.get(name);
	if (held !== undefined) return held as T;
	const tool = make();
	definitions.set(name, tool);
	return tool;
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
/** One write `{ callable, input }`: a generated verb's input is its array of rows. */
export const WriteInput = Schema.Struct({
	callable: Schema.String,
	input: Schema.optionalKey(ToolJson),
	inputFile: Schema.optionalKey(
		Schema.String.annotate({ description: 'a JSON file id, instead of input' })
	)
});
const ok = (result: Json): ToolAnswer => ({ result });
/**
 * A document's text as one answer, whole up to the result bound (never clipped cell-wise like a row's field): past it,
 * the start and a pointer, the whole kept for `read_file { call }`.
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
/** The reads this generation is running: an engine holds them, so a restart leaves none and tells what it cut short. */
const READING = new Set<string>();
/** A scan is read by eye: the guard against values made up or slipped between columns. */
const SCAN_NOTE =
	'read each value in an image from the image itself, column by column. Ask the person about any value you cannot read for certain.';
/** A script's own call: what it reads reaches its code, not the conversation, so "already above" would be false. */
const Scripted = Context.Reference<boolean>('bolt/Scripted', { defaultValue: () => false });
/** What `bolt build` proves its history with: large, and nothing in them is the author's to read. */
const GENERATED = /^migrations\/(?:snapshot|migrations\.lock|physical)\.json$/;
/** A search hit's line: enough to place it; workspace_read shows the rest. */
const HIT_CHARS = 240;
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
			: `${JSON.stringify(v).slice(0, bytes)}... [clipped, ${size(v)} bytes; read_file { call: '${call}' } reads it whole]`;
/** A view with its values clipped (bounded as any answer), the whole view kept for `read_file { call }`. */
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
	const { total, from, to, lines } = page(text, offset, offset + limit - 1);
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
				role = inner == null ? roleAt(`${path}${name}`) : undefined,
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
const VERBS = ['create', 'update', 'delete', 'upsert'] as const;
/** `act`'s callable for a decision on an approval request (`bolt.approvals.decide`). */
const APPROVE = 'approvals.decide';
const Decide = Schema.Struct({
	requestId: Schema.String,
	decision: Schema.Literals(['approve', 'reject', 'request_changes']),
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
type Spec = { confirm?: true };
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
/** What the actor may write, by model: the generated verbs its write arms admit (rules 33a, 58), and approval decisions. */
function callablesFor(m: EngineManifest, a: Authority, identity = false): Map<string, Spec> {
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
function receipt(callable: string, o: Outcome): Receipt | null {
	if (o.kind === 'committed')
		return {
			outcome: 'committed',
			callable,
			records: o.records.map(({ model, id }) => ({ model, id }))
		};
	if (o.kind === 'pending_approval')
		return {
			outcome: 'pending_approval',
			callable,
			requestId: o.requestId,
			records: o.records.map(({ model, id }) => ({ model, id }))
		};
	return null;
}
/** A run's end, read once the ledger says it ended (`RunEnds`, never a poll): its result, or why it did not succeed. */
const runEnd = (e: Engine, a: Authority, run: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const ends = e.runEnds;
			if (ends === undefined)
				return yield* Effect.fail(
					BoltError.make('unavailable', 'facility', 'this host does not follow runs')
				);
			const subscription = yield* PubSub.subscribe(ends);
			for (;;) {
				const row = yield* e.db.one(RunViewRow, {
					text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`,
					params: [run]
				});
				if (Option.isNone(row))
					return yield* Effect.fail(
						BoltError.make('invalidInput', 'admission', `run ${run} is gone`)
					);
				const state = row.value.state;
				if (state === 'succeeded' || state === 'skipped') {
					const view = runView(a, row.value);
					return encodeWire({
						status: state,
						...(view?.result === undefined ? {} : { result: view.result })
					});
				}
				if (state !== 'queued' && state !== 'running')
					return yield* Effect.fail(
						BoltError.make(
							'guestError',
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
	if (!Predicate.isObject(answer) || Array.isArray(answer) || typeof answer['run'] !== 'string')
		return answer;
	const run = answer['run'],
		outcome = answer['outcome'],
		kind = Predicate.isObject(outcome) && !Array.isArray(outcome) ? outcome['kind'] : undefined;
	if (kind !== undefined && kind !== 'committed' && kind !== 'pending_approval') return answer;
	const name = callable.startsWith(`${AUTOMATION}.`)
		? callable.slice(AUTOMATION.length + 1)
		: callable;
	const held =
		kind === 'pending_approval' && Predicate.isObject(outcome) && !Array.isArray(outcome)
			? String(outcome['requestId'] ?? '')
			: undefined;
	const job = yield* jobs.add(
		`automation ${name}`,
		held === undefined
			? runEnd(e, a, run)
			: Effect.succeed<Json>({ status: 'held', request: held }),
		{
			detach: true,
			alias: run,
			done: (id, result) => {
				const r = Predicate.isObject(result) && !Array.isArray(result) ? result : {};
				const said =
					r['status'] === 'held'
						? `held for approval (request ${String(r['request'])})`
						: `${String(r['status'] ?? 'succeeded')}${r['result'] === undefined ? '' : `: ${JSON.stringify(bounded(r['result'] ?? null).value).slice(0, 600)}`}`;
				return `[job ${id} done] automation ${name} run ${run} → ${said}`;
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
				error: `${APPROVE} takes { requestId, decision: approve | reject | request_changes, reason? }`
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
			bindings: x.bindings,
			...(x.agent === undefined ? {} : { agent: x.agent })
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
		...(name === 'upsert' ? { on_conflict: 'update' as const } : {})
	});
	const rc = receipt(callable, r.outcome);
	if (rc !== null) x.receipts.push(rc);
	if (r.outcome.kind !== 'committed' || name === 'delete') return encodeWire(r.outcome);
	// the stored rows, as the actor reads them: one read request, a root per written model (at most 20 rows each) with its
	// first-level layers (child lines, linked records), so the answer is the read-back
	const reads = Object.entries(
		Object.groupBy(
			r.outcome.records.filter((c) => c.model in x.engine.manifest.exposures),
			(c) => c.model
		)
	);
	// what the write supplied, per root: its own columns and the child lists it wrote, each with their columns
	const rowsIn = Array.isArray(input) ? input : [];
	const written = (rows: readonly Json[]) => {
		const own = new Set<string>(),
			lists = new Map<string, Set<string>>();
		for (const row of rows) {
			const fields =
				Predicate.isObject(row) && !Array.isArray(row)
					? Predicate.isObject(row['set']) && !Array.isArray(row['set'])
						? row['set']
						: row
					: {};
			for (const [key, value] of Object.entries(fields)) {
				if (
					Array.isArray(value) &&
					value.every((v) => Predicate.isObject(v) && !Array.isArray(v))
				) {
					const cols = lists.get(key) ?? new Set<string>();
					for (const v of value)
						if (Predicate.isObject(v) && !Array.isArray(v))
							for (const k of Object.keys(v)) cols.add(k);
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
			: yield* Effect.try({
					try: () =>
						lowerRead(x.engine.manifest, 'query', [
							Object.fromEntries(
								reads.flatMap(([c, rows]) => {
									const output = readOutputs(x.engine.manifest, x.authority, c)[0] ?? 'default';
									return [
										[
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
													: {})
											}
										],
										...layersOf(c, output).map((path) => [
											path,
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
									];
								})
							)
						]),
					catch: (cause) =>
						BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
				}).pipe(
					Effect.flatMap((ir) =>
						x.engine.read([ir], { as: 'caller', authority: x.authority }, x.bindings)
					),
					Effect.flatMap(([got]) => Schema.decodeUnknownEffect(StoredReadBack)(got)),
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
	// the effect runs this write queued carry its record ids (`queueEffects`): answer them, so the model can `wait` on one
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
			: { stored: encodeWire(stored) }),
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
	shown: 'shown on your next step only: take what you need from it there',
	none: 'not shown, too many images at once: read it again on your next step'
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
/** An input field as describe shows it: its kind, an enum's values, a range, an object's or custom value's fields. */
const formatOf = (m: EngineManifest, k: import('@norbital-ai/std/kind').Kind): Json => {
	const optional = k.optional === true ? ' (optional)' : '';

	if (k.many === true) {
		const size = k.min_items !== undefined && k.min_items === k.max_items ? `${k.min_items} ` : '';
		const item = formatOf(m, item_kind(k));
		return typeof item === 'string'
			? `list of ${size}${item}${optional}`
			: { [`list of ${size}`]: item };
	}
	switch (k.kind) {
		case 'enum':
			return `enum ${k.values.join(' | ')}${optional}`;
		case 'ref':
			return `id of ${typeof k.to === 'string' ? k.to : k.to.join(' | ')}${optional}`;
		case 'number':
			return `number${k.min === undefined && k.max === undefined ? '' : ` ${k.min ?? ''}..${k.max ?? ''}`}${optional}`;
		case 'object':
			return Object.fromEntries(Object.entries(k.fields).map(([f, v]) => [f, formatOf(m, v)]));
		case 'custom': {
			const shape = m.customFields[k.of]?.shape;
			return shape === undefined ? `${k.of}${optional}` : formatOf(m, shape);
		}
		default:
			return `${k.kind}${optional}`;
	}
};
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
						Object.entries(index.input).map(([f, k]) => [f, formatOf(m, k)])
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
function shapeOf(m: EngineManifest, a: Authority, path: string, output = 'default'): Json {
	const root = path.split('.')[0]!,
		model = layers(m)[root]?.[path] ?? root,
		all = layered(m);
	const kind = (f: string): string => {
		const link = all.relationships[`${model}.${f}`];
		if (link !== undefined) return `link to ${[link.to].flat().join(' | ')}`;
		const d = all.models[model]?.fields[f];
		if (d === undefined) return 'system';
		const many = d.many === true ? ' (list)' : '';
		return d.kind === 'enum'
			? `enum ${d.values.join(' | ')}${many}`
			: d.kind === 'state'
				? `state ${Object.keys(d.states).join(' | ')}`
				: `${d.kind === 'file' ? 'file reference, as a message lists it' : d.kind}${many}`;
	};
	const fields = exposed(m, root, path, model, output);
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
		fields: Object.fromEntries(fields.map((f) => [f, kind(f)])),
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
								verb === 'upsert'
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
							const allowed = writableColumns(a, root, verb === 'create' ? 'create' : 'update');
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
/** Every root the actor reads, by name: the prompt's map. `undefined` when nothing is readable. */
export function workspaceSchema(m: EngineManifest, a: Authority): string | undefined {
	const roots = readPaths(m, a).filter((path) => !path.includes('.'));
	return roots.length === 0 ? undefined : `# Models you read\n${roots.join(', ')}`;
}
/** An automation with its input, so the first start is the right one (an omitted input runs it over everything). */
type SignedInput =
	{ readonly [k: string]: { kind: string; of?: unknown; optional?: boolean } } | undefined;
const automationSignature = (m: EngineManifest, name: string) =>
	signature(name, (m.automations[name] as { input?: SignedInput } | undefined)?.input);
/**
 * The workspace's tools as a person's turn reads them, below what it already holds: `run_tool` stays one fixed entry, so
 * a merge that declares a tool moves no byte of the cached tools, system prompt or transcript.
 */
export const toolsListing = (tools: NonNullable<EngineManifest['agent']['tools']>) => {
	const lines = Object.entries(tools).map(
		([name, spec]) => `- ${signature(name, spec.input as SignedInput)}: ${spec.description}`
	);
	return lines.length === 0
		? 'The workspace declares no tools now.'
		: `The workspace's tools, each called with run_tool { name, input, files }:\n${lines.join('\n')}`;
};
const signature = (name: string, input: SignedInput = {}) => {
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
/** `describe_workspace`'s whole map is at most this many bytes; past it, items are named for a call with `names`. */
export const OVERVIEW_BYTES = 12_000;
/** The base message catalogue's `'key': 'text'` pairs, read from its source. */
// ponytail: a regex over the source, not a TS parse; a key or text with a quote inside is skipped
export const messageCatalogue = (source: string | null): ReadonlyMap<string, string> =>
	new Map(
		[...(source ?? '').matchAll(/'([^'\n]+)':\s*'((?:[^'\\\n]|\\.)*)'/g)].map(
			(match) => [match[1]!, match[2]!] as const
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
	names: readonly string[] = []
): string {
	const all = layered(m),
		t = (key: string) => messages.get(key) ?? key,
		acts = [...callablesFor(m, a).keys()];
	const roots = new Set(readPaths(m, a).filter((path) => !path.includes('.')));
	const apps = [...new Set([...(m.workspace.apps ?? []), ...Object.keys(m.apps)])].filter(
		(name) => m.apps[name] !== undefined && canOpen(m, a, name)
	);
	const models = Object.keys(all.models).filter(
		(name) => roots.has(name) || acts.some((c) => c.startsWith(`${name}.`))
	);
	const automations = a.automations.filter((name) => m.automations[name] !== undefined);
	const app = (name: string) => {
		const spec = m.apps[name]!,
			group = name.includes('/') ? name.slice(0, name.indexOf('/')) : undefined,
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
		const spec = all.models[name]!,
			ex = all.exposures[name];
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
		return [
			`${name} "${spec.description.split('\n')[0]!.trim()}"`,
			...line('reads', roots.has(name) ? readOutputs(m, a, name) : []),
			...line('writes', writes),
			...line('links', links),
			...line('state', states),
			...line('effects', Object.keys(ex?.effect ?? {})),
			...line(
				'syncs',
				Object.entries(ex?.syncs ?? {}).map(([sync, x]) => `${sync} (${x.with})`)
			),
			...line('search', Object.keys(spec.search?.indexes ?? {})),
			...line('notices', ex?.notify === true ? ['on its write and approval events'] : [])
		].join('\n');
	};
	const automation = (name: string) => {
		const spec = m.automations[name]!,
			on = (spec.on ?? []).map((x) => ('cron' in x ? `cron ${x.cron}` : `webhook ${x.webhook}`));
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
						? `\n${JSON.stringify(shapeOf(m, a, name, readOutputs(m, a, name.split('.')[0]!)[0]))}`
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
	const out = [
		`# Workspace tz ${m.workspace.tz} · locale ${m.workspace.locale}${m.workspace.currency === undefined ? '' : ` · currency ${m.workspace.currency}`}`
	];
	let used = size(out[0]!);
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
const ReadInput = Schema.Struct({ request: Schema.Record(Schema.String, ReadOptions) });
/**
 * `read` (rule 58, P3): one read request, a layer map over the models and declared layers the actor may read, answered in
 * one engine read as the actor and bounded by rule 62 (a lone root's page keeps whole rows); `undefined` when nothing is
 * readable. What the bound cut stays readable with `read_file { call }`.
 */
export function readTool(x: ReadToolContext) {
	const e = x.engine,
		a = x.authority,
		paths = readPaths(e.manifest, a);
	if (paths.length === 0) return undefined;
	const answer = (request: ReadRequestJson) =>
		Effect.try({
			// time variables are this turn's literals before decode; the requestor variables bind in the read itself
			try: () =>
				lowerRead(e.manifest, 'query', [
					Object.fromEntries(
						Object.entries(request).map(([path, layer]) => [
							path,
							layer.where === undefined
								? layer
								: {
										...layer,
										where: materializeEach(layer.where, {
											...x.bindings,
											requestor: requestorOf(a)
										})
									}
						])
					)
				]),
			catch: (cause) =>
				cause instanceof BoltError
					? cause
					: BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
		}).pipe(
			Effect.flatMap((ir) => e.read([ir], { as: 'caller', authority: a }, x.bindings)),
			Effect.map(([got]) => got ?? null)
		);
	const run = Effect.fn('AgentTool.read')(function* (request: ReadRequestJson) {
		const named = Object.keys(request).filter((path) => !path.includes('.'));
		const single = named.length === 1 ? named[0] : undefined;
		const pageOf = (v: Json): Json =>
			single !== undefined && Predicate.isObject(v) && !EffectArray.isArray<typeof v>(v)
				? (v[single] ?? null)
				: v;
		const wrap = (v: Json): Json => (single === undefined ? v : { [single]: v });
		return yield* Effect.gen(function* () {
			const full = yield* answer(request),
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
					const error = refusals.join('\n');
					return {
						result: {
							error,
							hint: error.includes("unknown operator 'contains'")
								? 'Text takes like: "%value%"; contains is only for a period or a JSON field.'
								: 'describe_workspace { names } gives its fields. If the data cannot answer, say so.'
						}
					};
				})
			)
		);
	});
	return {
		tool: Tool.make('read', {
			description: `Read records. request is one read request, the JSON bolt.query and ctx.query take: { "<model>": { output, where, fields, order_by, limit, after, search, aggregate, as_of }, "<model>.<relation>": { where, fields, order_by, limit, search, aggregate } }, each key once. order_by: "<field>", { <field>: "desc" } or a list of them. limit: at most ${READ_LIMIT}.
where: { <field>: { eq|ne|lt|lte|gt|gte|in|nin|is_null|like: value } }, and/or/not; on a relation { is|some|none|every: where } or { count|sum|avg|min|max: … }; a value may be { var: CEL over requestor, today, now }.
search: words, { <index>: input } or { semantic: text }. aggregate: { count, sum|avg|min|max: [field], by: field | { day|week|month|quarter|year: field } }.
Answers each model's { rows, next, total }, total counting every match, so a count needs no aggregate; with aggregate, its measures instead of rows. Long values are clipped.`,
			parameters: ReadInput,
			success: ToolAnswer
		}),
		run: ({ request }: typeof ReadInput.Type): Effect.Effect<ToolAnswer> => {
			const unknown = Object.keys(request).find((path) => !paths.includes(path));
			return unknown === undefined
				? guard(run(request))
				: Effect.succeed(
						err(
							`You read no '${unknown}'. ${unknown.includes('.') ? 'describe_workspace { names } lists its layers.' : `Models: ${paths.filter((p) => !p.includes('.')).join(', ')}`}`
						)
					);
		}
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
		acts = callablesFor(e.manifest, a, x.inApp && !x.child && e.identity !== undefined),
		paths = readPaths(e.manifest, a),
		agent = x.mode === 'agent',
		hosted = x.hostTools;
	const entries: (Pick<AgentTool, 'name' | 'studio' | 'pure'> & {
		readonly tool: AnyTool;
		readonly handlers: Context.Context<Handlers>;
	})[] = [];
	const add = (
		tool: AnyTool,
		handlers: Effect.Effect<Context.Context<Handlers>>,
		meta: Pick<AgentTool, 'studio' | 'pure'> = {}
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
	const describeTool = shared('describe_workspace', () =>
		Tool.make('describe_workspace', {
			description:
				"The workspace as you may use it: apps and their pages, models, automations. names answers each in full: a model's fields, links, layers, search and your writes with their columns; an app; an automation's input; 'system' for native setup pages, secrets and MCP servers.",
			parameters: Schema.Struct({ names: Schema.optionalKey(Schema.Array(Schema.String)) }),
			success: ToolAnswer
		})
	);
	yield* add(
		describeTool,
		Toolkit.make(describeTool).toHandlers({
			describe_workspace: (i) =>
				guard(
					Effect.gen(function* () {
						const names = i.names ?? [];
						if (names.includes('system')) {
							if (!x.inApp || x.child || !a.admin || a.actor.kind !== 'member' || a.actor.external)
								return ok({ capabilities: [] });
							const [connected] = yield* x.engine.db.read([
								{
									text: 'SELECT id, name, integration, envoy FROM sys_integration ORDER BY name',
									params: []
								}
							]);
							return ok({
								capabilities: Object.entries(SYSTEM_UI).map(([capability, ui]) => ({
									capability,
									...ui
								})),
								connections: connected?.rows ?? [],
								secretNames: Object.keys(e.manifest.workspace.secrets ?? {}),
								mcp: Object.keys(e.manifest.mcp),
								note: "An envoy and a connection of a declared integration are records, with no source change: act sys_envoy.create, then sys_integration.create { integration, name, envoy: <its id> } with no owner. page { path, configure } opens a native form for what stays the person's (pairing, secrets); it never submits. A new integration or MCP server is declared in source first."
							});
						}
						const source =
							x.workspace === undefined
								? null
								: yield* Port.attempt('workspace', () =>
										x.workspace!.read('src/i18n/+messages.ts')
									).pipe(Effect.orElseSucceed(() => null));
						return ok(describeWorkspace(e.manifest, a, messageCatalogue(source), names));
					})
				)
		})
	);
	const signature = (name: string) => automationSignature(e.manifest, name);
	if (agent && x.inApp && !x.child && a.actor.kind === 'member' && !a.actor.external) {
		const allowed = navigationPaths(nav(e.manifest, a), a.admin);
		const pageTool = shared('page', () =>
			Tool.make('page', {
				description:
					'Drive the tab the person is looking at: open path (with configure, a native setup form), click by visible text, type { label, text, submit? } into a field, scroll, go back or forward, highlight: ring something on the page by its visible text, or preview: a preview URL shown beside the chat. A button, an external link or a typed value waits for their confirmation; approvals, passwords and files are theirs alone. It answers a request; what their page then shows closes your next step.',
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
				}),
				success: ToolAnswer
			})
		);
		yield* add(
			pageTool,
			Toolkit.make(pageTool).toHandlers({
				page: ({ path, configure: asked, click, type, scroll, go, highlight, preview }) => {
					if (preview !== undefined)
						return Effect.succeed(
							/^https?:\/\//.test(preview) && URL.canParse(preview)
								? ok({ preview })
								: err('preview is a preview URL (https://…)')
						);
					if (path !== undefined) {
						if (!allowed.includes(path))
							return Effect.succeed(err(`No page ${path}. Pages: ${allowed.join(', ')}`));
						const setup = Schema.decodeUnknownOption(SystemUiRequest)(asked);
						if (asked !== undefined && Option.isNone(setup))
							return Effect.succeed(
								err("configure is a capability from describe_workspace { names: ['system'] }")
							);
						const configure = Option.getOrUndefined(setup);
						if (
							configure?.capability === 'secret.set' &&
							e.manifest.workspace.secrets?.[configure.record] === undefined
						)
							return Effect.succeed(err('That secret is not declared in this workspace.'));
						if (
							configure?.capability === 'mcp.configure' &&
							e.manifest.mcp[configure.record] === undefined
						)
							return Effect.succeed(err('That MCP server is not declared in this workspace.'));
						const target =
							configure === undefined ? path : a.admin ? systemUiPath(path, configure) : null;
						return Effect.succeed(
							target === null
								? err('This configuration does not belong to that page or your authority.')
								: ok({ navigation: target, requested: true })
						);
					}
					if (
						click === undefined &&
						scroll === undefined &&
						go === undefined &&
						type === undefined &&
						highlight === undefined
					)
						return Effect.succeed(err('give path, click, type, scroll, go, highlight or preview'));
					return Effect.succeed(
						ok({
							page: {
								...(click === undefined ? {} : { click }),
								...(scroll === undefined ? {} : { scroll }),
								...(go === undefined ? {} : { go }),
								...(type === undefined ? {} : { type }),
								...(highlight === undefined ? {} : { highlight })
							},
							requested: true
						})
					);
				}
			})
		);
	}
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
		const actTool = shared('act', () =>
			Tool.make('act', {
				description: `Write records, decide an approval, or start an automation or sync: { callable, input }.
"<model>.create": [{ column: value, relation: [row | id] }]. "<model>.update": [{ target, set: { column, relation: { create, update, delete, link, unlink } } }]. "<model>.delete": [{ target }]. "<model>.upsert": [{ id?, column: value }]. Rows commit as one batch, related rows inside their root. A link takes an id, a file field a file reference.
"automation.<name>" takes its input, "<model>.sync.<sync>" {} or { mode, file | to }: each starts a job whose end arrives at your next step. "approvals.decide": { requestId, decision, reason? }. "sys_invitation.create": [{ email | phone, team? }].
A committed write answers the stored rows; a held one waits for approval.`,
				parameters: WriteInput,
				success: ToolAnswer
			})
		);
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
								return err(
									`You may not run '${i.callable}'. Yours: ${[...acts.keys(), ...automations.map((n) => `${AUTOMATION}.${n}`), ...files.keys(), ...syncs].slice(0, 60).join(', ')}`
								);
							if (Array.isArray(i.input) && i.input.length === 0)
								return err(`'${i.callable}' was given no rows: there is nothing to write.`);
							if (
								x.inApp &&
								(acts.get(i.callable)?.confirm === true ||
									(i.callable.startsWith(`${AUTOMATION}.`) &&
										e.manifest.automations[i.callable.slice(AUTOMATION.length + 1)]?.agent ===
											'confirm'))
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
						})
					)
			})
		);
	}
	if (x.mode === 'plan' && !x.child) {
		const updatePlanTool = shared('update_plan', () =>
			Tool.make('update_plan', {
				description:
					'Write the draft plan: body replaces it, patch { old, new } changes one exact passage.',
				parameters: Schema.Struct({
					body: Schema.optionalKey(Schema.String),
					patch: Schema.optionalKey(Schema.Struct({ old: Schema.String, new: Schema.String })),
					expectedRevision: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
				}),
				success: ToolAnswer
			})
		);
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
		const goalsTool = shared('goals', () =>
			Tool.make('goals', {
				description:
					"Set this conversation's checklist, the whole list; at most one doing, done items stay.",
				parameters: Schema.Struct({
					items: Schema.Array(
						Schema.Struct({
							id: Schema.String,
							text: Schema.String,
							status: Schema.Literals(['pending', 'doing', 'done'])
						})
					)
				}),
				success: ToolAnswer
			})
		);
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
							// a done goal is history: resending the live list without it keeps it rather than refusing
							for (const old of x.conv.goals ?? [])
								if (old.status === 'done') {
									const now = items.find((g) => g.id === old.id);
									if (now === undefined) items.push({ ...old });
									else if (now.status !== 'done' || now.text !== old.text) {
										now.status = 'done';
										now.text = old.text;
									}
								}
							yield* x.setGoals(items);
							return ok({ saved: true, goals: items });
						})
					)
			})
		);
	}
	// every skill is readable by every actor: a skill is procedure, never authority
	const skills = Object.entries(x.skills);
	if (skills.length > 0) {
		const skillTool = shared('skill', () =>
			Tool.make('skill', {
				description:
					"Read one of your skills whole, one ## section, or one of its files. Its scripts run with run_js { file: '<skill>/<path>' }.",
				parameters: Schema.Struct({
					name: Schema.String,
					section: Schema.optionalKey(Schema.String),
					file: Schema.optionalKey(Schema.String)
				}),
				success: ToolAnswer
			})
		);
		yield* add(
			skillTool,
			Toolkit.make(skillTool).toHandlers({
				skill: (i) =>
					guard(
						Effect.gen(function* () {
							const t = skills.find(([n]) => n === i.name)?.[1];
							if (t === undefined)
								return err(`No skill '${i.name}'. Skills: ${skills.map(([n]) => n).join(', ')}`);
							if (i.file !== undefined && i.section !== undefined)
								return err('Read a section or a file, not both.');
							const key = `${i.name}#${i.section ?? ''}#${i.file ?? ''}`;
							if (x.read.has(key))
								return ok({ note: `You read ${i.name} earlier in this turn; its text is above.` });
							x.read.set(
								key,
								`skill ${i.name}${i.section === undefined ? '' : ` (${i.section})`}${i.file === undefined ? '' : ` file ${i.file}`}`
							);
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
						})
					)
			})
		);
	}
	{
		const historyTool = shared('history', () =>
			Tool.make('history', {
				description:
					"Search earlier messages in this conversation, or scope mine for all of this person's.",
				parameters: Schema.Struct({
					query: Schema.String,
					scope: Schema.optionalKey(Schema.Literals(['this', 'mine'])),
					limit: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
				}),
				success: ToolAnswer
			})
		);
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
		const readMessagesTool = shared('read_messages', () =>
			Tool.make('read_messages', {
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
			})
		);
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
	/** A page's four quarters, shown beside it. */
	const tiled = Effect.fn('AgentTool.tiled')(function* (bytes: Uint8Array, id: string) {
		const images = x.engine.images;
		if (images === undefined) return;
		const tiles = yield* Effect.forEach(
			TILES,
			(tile) =>
				imageCrop(bytes, tile).pipe(
					Effect.flatMap((crop) => imageJpeg(crop, 2048)),
					Effect.provideService(Images, images)
				),
			{ concurrency: TILES.length }
		);
		for (const [n, tile] of tiles.entries())
			attach(x.files, { mime: 'image/jpeg', bytes: tile, id: `${id}#tile:${n}` });
	});
	/** A stored file as an image (shown from the next step) or its text; every other file is parsed first. */
	const readStored = Effect.fn('AgentTool.work15')(function* (
		port: NonNullable<typeof x.attachments>,
		file: Json
	) {
		const fileId =
				Predicate.isObject(file) && typeof file['id'] === 'string' ? file['id'] : undefined,
			fileName =
				Predicate.isObject(file) && typeof file['name'] === 'string'
					? file['name']
					: (fileId ?? 'the file');
		const seen = (yield* Scripted) || fileId === undefined ? undefined : `file:${fileId}`;
		if (seen !== undefined && x.read.has(seen))
			return ok({ note: `You read ${fileName} earlier in this turn; its answer is above.` });
		const got = yield* port.read(file).pipe(Port.call('files', 30000));
		if (
			Predicate.isObject(got) &&
			'bytes' in got &&
			got.bytes instanceof Uint8Array &&
			'mime' in got &&
			typeof got.mime === 'string'
		) {
			const seen = attach(x.files, {
				mime: got.mime,
				bytes: got.bytes,
				...(fileId === undefined ? {} : { id: fileId })
			});
			if (seen === 'shown') yield* tiled(got.bytes, fileId ?? got.mime);
			return ok({ attached: ATTACHED[seen] });
		}
		const answer = yield* Schema.decodeUnknownEffect(Schema.Json)(got).pipe(
			Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
		);
		if (seen !== undefined) x.read.set(seen, `file ${fileName}`);
		// a text file is one long value: whole up to the bound
		const record = Option.getOrUndefined(
			Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(answer)
		);
		return record !== undefined && typeof record['text'] === 'string'
			? documentAnswer(record, 'text')
			: ok(answer);
	});
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
		const field = r?.rows[0]?.['field'],
			member = x.authority.actor.kind === 'member' ? x.authority.actor.id : undefined;
		// an output of this conversation is the person's own file, including one just downloaded
		if (r?.rows[0]?.['own'] === true || r?.rows[0]?.['here'] === true) return true;
		if (
			field === 'sys_conversation.inputs' &&
			(x.authority.admin || (member !== undefined && r?.rows[0]?.['created_by'] === member))
		)
			return true;
		if (typeof field !== 'string' || !field.includes('.') || field.startsWith('sys_conversation.'))
			return false;
		return yield* readableFile(
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
	const patchEntry = (output: string, patch: Json, state: Json) =>
		x.engine.db
			.write({
				text: `UPDATE sys_conversation SET outputs = (SELECT jsonb_agg(CASE WHEN e->'ingest'->>'output' = $2
					THEN (e || $3::jsonb) || jsonb_build_object('ingest', (e->'ingest') || $4::jsonb) ELSE e END ORDER BY n)
					FROM jsonb_array_elements(outputs) WITH ORDINALITY AS t(e, n)) WHERE id = $1`,
				params: [x.conv.id, output, JSON.stringify(patch), JSON.stringify(state)]
			})
			.pipe(Effect.asVoid);
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
				note: `Still being read: wait { jobs: ['${entry.ingest.job ?? o}'] } returns when it ends. Reading it again changes nothing.`
			});
		if (entry.ingest.status === 'failed' || entry.id === undefined || files === undefined)
			return err(
				`The ingest of ${entry.name} failed: ${entry.ingest.error ?? 'its files are not stored'}. Tell the person.`
			);
		const ids = (entry.files ?? []).map((f) => f.id);
		const stored = yield* x.engine.db.rows(IngestFile, {
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
			const [source] = yield* x.engine.db.rows(SourceFile, {
				text: 'SELECT id, name, mime, size, key, sha256 FROM sys_file WHERE id = $1',
				params: [entry.ingest.source]
			});
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
			return ok({ page: i.page, attached: ATTACHED[seen], note: SCAN_NOTE });
		}
		const crops = i.crops ?? [],
			imageNumber = i.image ?? (crops.length > 0 && images.size === 1 ? 1 : undefined),
			zoomed = `zoom:${o}`;
		if (crops.length > 0) {
			const taken = [...x.read.keys()].filter((key) => key.startsWith(zoomed)).length;
			if (taken >= ZOOMS)
				return err(
					`${o} has had its ${ZOOMS} zooms this turn: more shows nothing new. Report what stays unclear as your best reading, marked uncertain.`
				);
			x.read.set(`${zoomed}:${taken}`, `zooms of ${o}`);
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
					const crop: ImageCrop = { left, top, right, bottom, minEdge: 1024 };
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
							zoomsLeft: ZOOMS - [...x.read.keys()].filter((key) => key.startsWith(zoomed)).length
						}),
				attached: ATTACHED.shown,
				note: SCAN_NOTE
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
				note: `compute from data.json, never retype: ${run}${images.size === 0 ? '' : `; its images: read_file { id: ${o}, image: n }`}`
			});
		}
		if (i.text !== undefined && i.text !== '') {
			const found = grep(text, i.text, 50);
			return {
				result: {
					output: o,
					...found,
					note:
						found.total === 0
							? `No line of ${o} holds '${i.text}'.`
							: `read a hit with read_file { id: ${o}, from, to }${found.total > found.hits.length ? `; ${found.total - found.hits.length} more hits: narrow the text` : ''}`
				},
				bounded: true as const
			};
		}
		const w = window(text, i.from, i.to),
			seen = `ingest:${o}:${w.from}-${w.to}`;
		const scripted = yield* Scripted;
		if (!scripted && x.read.has(seen))
			return ok({
				note: `lines ${w.from}–${w.to} of ${o} are already above: read on from ${w.to + 1}`
			});
		if (!scripted) x.read.set(seen, `${o} lines ${w.from}–${w.to}`);
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
							note: `each <img> named in images is shown to you: ${SCAN_NOTE}${shown.length > TILED_PAGES ? ` These are whole pages, too small for fine print: read_file { id: ${o}, image: n } adds a page's quarters.` : ''}`
						}),
				...(refs.length > shown.length
					? {
							more: `${refs.length - shown.length} more images: read_file { id: ${o}, image: n }`
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
			password === undefined ? file.sha256 : sha256Hex(`${file.sha256}\0${password}`);
		const [added] = (yield* x.engine.db.write({
			text: `UPDATE sys_conversation SET outputs = outputs || jsonb_build_array($2::jsonb || jsonb_build_object('ingest',
				$3::jsonb || jsonb_build_object('output', 'o' || (1 + (SELECT count(*) FROM jsonb_array_elements(outputs) e WHERE e ? 'ingest')))))
				WHERE id = $1 RETURNING outputs->-1->'ingest'->>'output' AS output`,
			params: [
				x.conv.id,
				JSON.stringify({
					name: `${file.name} (${how === 'audio' ? 'transcript' : 'ingested'})`,
					mime: 'text/html'
				}),
				JSON.stringify({ source: file.id, sha256: file.sha256, status: 'ingesting' })
			]
		})).rows;
		const output = typeof added?.['output'] === 'string' ? added['output'] : undefined;
		if (output === undefined)
			return yield* Effect.fail(
				BoltError.make('invalidInput', 'admission', 'This conversation is gone.')
			);
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
					return yield* Effect.fail(
						BoltError.make('invalidInput', 'decode', unparsed(file.name, file.mime))
					);
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
		READING.add(readingKey(output));
		const job = yield* x.jobs.add(
			`reading ${file.name}`,
			Effect.ensuring(
				work,
				Effect.sync(() => READING.delete(readingKey(output)))
			),
			{
				detach: true,
				done: (id, result) => {
					const said = Predicate.isObject(result) && !Array.isArray(result) ? result : {};
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
	const readFileTool = shared('read_file', () =>
		Tool.make('read_file', {
			description:
				"Read a file by id: a conversation file, a record's file or a tool's output. A document, scan, sheet or recording is parsed first. A reference is listed, '<reference>/<path>' read, and text greps it. Answers text; a document as numbered lines, its page images shown to you (from, to page; text greps, a|b for either, each hit with its page); a sheet as columns and first rows. image: n shows one image; with crops, up to 8 regions of it at once. call reads more of a clipped result. password opens a locked PDF or Office file.",
			parameters: Schema.Struct({
				id: Schema.optionalKey(Schema.String),
				from: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
				to: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
				text: Schema.optionalKey(Schema.String),
				image: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
				page: Schema.optionalKey(Schema.Number.check(Schema.isInt())).annotate({
					description: 'a PDF page, shown as a picture: for a page with no text, or a drawing'
				}),
				crops: Schema.optionalKey(
					Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]))
						.check(Schema.isMaxLength(8))
						.annotate({ description: '[left, top, right, bottom], fractions 0 to 1' })
				),
				call: Schema.optionalKey(Schema.String),
				offset: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
				password: Schema.optionalKey(Schema.String).annotate({
					description: 'the password the person gave for this file'
				})
			}),
			success: ToolAnswer
		})
	);
	yield* add(
		readFileTool,
		Toolkit.make(readFileTool).toHandlers({
			read_file: (i) =>
				guard(
					Effect.gen(function* () {
						if (i.id === undefined && i.call === undefined)
							return err('read_file needs the id of a file, or call for a clipped result.');
						if (i.id === undefined) return yield* readOutput(i.call ?? '', i.offset ?? 0);
						if (i.id.includes('@')) return yield* readReference(x, i.id, i);
						const id = yield* wholeId(x, i.id);
						let found = (yield* ingests()).findLast(
							(o) => o.ingest.output === id || o.ingest.source === id || o.id === id
						);
						// a job dies with its generation: a read it left unfinished starts over, never waits for good
						if (
							found?.ingest.status === 'ingesting' &&
							!READING.has(readingKey(found.ingest.output))
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
								`No file you can read has this id; a truncated result is read with call, not id.${files.length === 0 ? '' : ` This conversation's files: ${files.join(', ')}`}`
							);
						}
						const [file] = yield* x.engine.db.rows(SourceFile, {
							text: 'SELECT id, name, mime, size, key, sha256 FROM sys_file WHERE id = $1',
							params: [id]
						});
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
							said = Predicate.isObject(settled.result) ? settled.result['lines'] : undefined;
						return 'result' in answer && Predicate.isObject(answer.result) && Array.isArray(said)
							? { ...answer, result: { ...answer.result, about: said as Json } }
							: answer;
					})
				)
		})
	);
	if (x.geocoder !== undefined) {
		const geocodeTool = shared('geocode', () =>
			Tool.make('geocode', {
				description:
					'Places for an address or name (query), or at a point (reverse), each with the point a geolocation field takes.',
				parameters: Schema.Struct({
					query: Schema.optionalKey(Schema.String),
					reverse: Schema.optionalKey(Schema.Struct({ lat: Schema.Number, lng: Schema.Number }))
				}),
				success: ToolAnswer
			})
		);
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
		const readSource = shared('workspace_read', () =>
			Tool.make('workspace_read', {
				description:
					'Read source files: path, or paths for several. Each line is prefixed by its number as <line>: <content>. offset is the line to start from (1-based), limit how many, at most 2000.',
				parameters: Schema.Struct({
					path: Schema.optionalKey(Schema.NonEmptyString),
					paths: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
					offset: Schema.optionalKey(Schema.Int),
					limit: Schema.optionalKey(Schema.Int)
				}),
				success: ToolAnswer
			})
		);
		yield* add(
			readSource,
			Toolkit.make(readSource).toHandlers({
				workspace_read: (i) =>
					guard(
						Effect.gen(function* () {
							const files = yield* Port.attempt('workspace.files', () => source.files());
							const offset = Math.max(1, i.offset ?? 1),
								limit = Math.min(Math.max(1, i.limit ?? READ_LINES), READ_LINES);
							const one = Effect.fn('AgentTool.readSource')(function* (asked: string) {
								// the same normalisation workspace_search uses: `./src/a.ts` is `src/a.ts`
								const path = sourcePath(asked);
								if (path.startsWith('node_modules/') || path === 'node_modules')
									return {
										error: `${asked}: installed packages are outside the workspace: workspace_lang reads their types.`
									};
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
						})
					)
			}),
			{ pure: true }
		);
		const searchSource = shared('workspace_search', () =>
			Tool.make('workspace_search', {
				description:
					'Search the source with ripgrep: pattern is a regular expression, or exact text with literal. Answers matching lines, or with files only the files holding them. path is a file or directory, include a glob filtering files (*.ts, *.{ts,svelte}). Case-sensitive by default. At most 100 results unless limit says fewer. Installed packages are read through workspace_lang.',
				parameters: Schema.Struct({
					pattern: Schema.NonEmptyString,
					path: Schema.optionalKey(Schema.String),
					include: Schema.optionalKey(Schema.NonEmptyString),
					files: Schema.optionalKey(Schema.Boolean),
					literal: Schema.optionalKey(Schema.Boolean),
					caseSensitive: Schema.optionalKey(Schema.Boolean),
					limit: Schema.optionalKey(
						Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
					)
				}),
				success: ToolAnswer
			})
		);
		yield* add(
			searchSource,
			Toolkit.make(searchSource).toHandlers({
				workspace_search: (i) =>
					guard(
						Effect.gen(function* () {
							const within = sourcePath(i.path ?? '');
							if (within === 'node_modules' || within.startsWith('node_modules/'))
								return err(
									`${i.path}: installed packages are outside the workspace: workspace_lang reads their types.`
								);
							// ripgrep over an administrator's checkout; a member reads only what `visible` lets through
							const found =
								a.admin && x.search !== undefined
									? yield* Port.attempt('workspace.search', () => x.search!(i))
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
											try: () => new RegExp(i.pattern, i.caseSensitive === false ? 'i' : ''),
											catch: () =>
												BoltError.make(
													'invalidInput',
													'decode',
													'Invalid regular expression; fix pattern or use literal:true.'
												)
										});
							const wanted = i.caseSensitive === false ? i.pattern.toLowerCase() : i.pattern;
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
											? (i.caseSensitive === false ? value.toLowerCase() : value).includes(wanted)
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
						})
					)
			}),
			{ pure: true }
		);
		const listSource = shared('workspace_list_dir', () =>
			Tool.make('workspace_list_dir', {
				description:
					'The source tree under path, the whole workspace by default, with what each folder and role is for.',
				parameters: Schema.Struct({ path: Schema.optionalKey(Schema.String) }),
				success: ToolAnswer
			})
		);
		yield* add(
			listSource,
			Toolkit.make(listSource).toHandlers({
				workspace_list_dir: (i) =>
					guard(
						Port.attempt('workspace.files', () => source.files()).pipe(
							Effect.map((files) => {
								const under = sourcePath(i.path ?? '');
								const shown = files.filter((file) => under === '' || file.startsWith(`${under}/`));
								return shown.length === 0
									? err(
											`${i.path}: no such directory: workspace_list_dir with no path shows the source.`
										)
									: textAnswer(sourceTree(shown));
							})
						)
					)
			}),
			{ pure: true }
		);
	}
	if (agent && x.delegation) {
		{
			const subagentTool = shared('subagent', () =>
				Tool.make('subagent', {
					description:
						'Delegate to background sub-agents with your authority, at most 4: spawn { task, done?, format?, agent? }, list, read { conversation }, message { conversation, text }, stop { conversation }. A report arrives as a message and wakes you.',
					parameters: Schema.Struct({
						action: Schema.Literals(['spawn', 'list', 'read', 'message', 'stop']),
						task: Schema.optionalKey(Schema.String),
						done: Schema.optionalKey(Schema.String),
						format: Schema.optionalKey(Schema.String),
						agent: Schema.optionalKey(Schema.String),
						conversation: Schema.optionalKey(Schema.String),
						text: Schema.optionalKey(Schema.String)
					}),
					success: ToolAnswer
				})
			);
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
											return err(`No agent '${which}'. Agents: ${x.agents.join(', ')}`);
										return ok(yield* x.subagent.spawn(i.task ?? '', which, i.done, i.format));
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
				'Make a file from markdown (tables and inline HTML allowed), offered to the person; a file field takes its reference. In a pptx each ## starts a slide.',
			parameters: Schema.Struct({
				to: Schema.Literals(convert.targets),
				name: Schema.String,
				markdown: Schema.String,
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
	// the person's own media from the web: the host fetches and stores it, so no bytes enter the engine (the browser's
	// download does the same with its sign-ins, so a turn with a browser has that one)
	if (
		agent &&
		x.inApp &&
		staff &&
		store !== undefined &&
		!x.hostTools.some((t) => t.name === 'browser')
	) {
		const downloadTool = shared('download', () =>
			Tool.make('download', {
				description:
					"Save a public http(s) file as the person's: media, a PDF, HTML or CAD, at most 100 MiB.",
				parameters: Schema.Struct({ url: Schema.String }),
				success: ToolAnswer
			})
		);
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
	/** The catalogue's own tools a script calls, as the actor; its `run` exists once the catalogue is built. */
	let self: Catalogue['run'] | undefined;
	const inner = (call: string) => {
		let used = 0;
		return (name: string, input: unknown): Effect.Effect<ToolAnswer> =>
			self === undefined || !SCRIPTED.has(name) || !entries.some((t) => t.name === name)
				? Effect.succeed(err(`A script cannot call '${name}': ${RUN_JS.tools.join(', ')} only.`))
				: ++used > RUN_JS.toolCalls
					? Effect.succeed(err(`A run makes at most ${RUN_JS.toolCalls} tool calls.`))
					: self(name, input, `${call}:${used}`).pipe(Effect.provideService(Scripted, true));
	};
	if (agent && guest !== undefined) {
		const runJsTool = shared('run_js', () =>
			Tool.make('run_js', {
				description:
					"Run JavaScript in a fresh billed isolate, for computing, looping and bulk work; only what it returns or prints comes back. code is an async function body of input: no require, process, fetch or timers. await tool(name, input) calls read, act, browser, web_search, describe_workspace, read_file or workspace_read, at most 200 calls, each as you. files: [{ id }] arrive as input.files, an object of name to content: text as a string, else { base64 }. http: true gives await http({ method?, url, headers?, body? }), answering { status, headers, text }, over public https. Return { files: [{ name, text | base64 }] } to give the person files. file runs '<skill>/<path>' or '<reference>/<path>' with args, /in and /out instead. Walls: 3 s CPU, 256 MiB, 60 s, 4 MiB answer.",
				parameters: Schema.Struct({
					code: Schema.optionalKey(Schema.String),
					input: Schema.optionalKey(ToolJson),
					file: Schema.optionalKey(Schema.String),
					args: Schema.optionalKey(Schema.Array(Schema.String)),
					files: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
					http: Schema.optionalKey(Schema.Boolean)
				}),
				success: ToolAnswer
			})
		);
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
						})
					)
			})
		);
	}
	if (x.child) {
		const askParentTool = shared('ask_parent', () =>
			Tool.make('ask_parent', {
				description:
					'Ask the agent that delegated this task. Your turn ends; its answer is your next message.',
				parameters: Schema.Struct({ question: Schema.String }),
				success: ToolAnswer
			})
		);
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
	if (!x.child) {
		const askTool = shared('ask', () =>
			Tool.make('ask', {
				description:
					'Sends the person one question with optional answer choices, then ends the turn.',
				parameters: Schema.Struct({
					question: Schema.String,
					options: Schema.optionalKey(Schema.Array(Schema.String))
				}),
				success: ToolAnswer
			})
		);
		yield* add(
			askTool,
			Toolkit.make(askTool).toHandlers({
				ask: (i) =>
					guard(
						Effect.sync(() => {
							const question = i.question.trim();
							if (question === '') return err('Ask a question.');
							const options = (i.options ?? [])
								.map((option) => option.trim())
								.filter((option) => option !== '');
							x.ask(
								options.length === 0
									? question
									: `${question}\n\n${options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
							);
							return ok({
								asked: true,
								note: 'Stop here: your question goes to the person.'
							});
						})
					)
			})
		);
	}
	{
		const waitTool = shared('wait', () =>
			Tool.make('wait', {
				description:
					'Wait up to 120 s for the first of the given jobs or runs to end (any of this turn when none). A finished job also announces itself at your next step.',
				parameters: Schema.Struct({
					jobs: Schema.optionalKey(Schema.Array(Schema.String)),
					seconds: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
				}),
				success: ToolAnswer
			})
		);
		yield* add(
			waitTool,
			Toolkit.make(waitTool).toHandlers({
				wait: (i) =>
					guard(
						Effect.raceFirst(
							x.heard.pipe(
								Effect.map(() =>
									ok({
										settled: null,
										pending: encodeWire(x.jobs.pending()),
										note: 'New input arrived: it is your next message. What you waited for keeps running.'
									})
								)
							),
							Effect.gen(function* () {
								const ids = i.jobs ?? [];
								const ms = Math.min(Math.max(1, i.seconds ?? 120), 120) * 1000;
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
													const view = runView(a, row);
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
											if (settled !== undefined) return ok({ settled: encodeWire(settled) });
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
												return ok({ settled: null, running: encodeWire(views) });
											const current = yield* read;
											const answer = current.find(isSettled);
											return answer === undefined
												? ok({ settled: null, running: encodeWire(current) })
												: ok({ settled: encodeWire(answer) });
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
								return ok(
									got === null
										? { settled: null, pending: encodeWire(x.jobs.pending()) }
										: { settled: got, pending: encodeWire(x.jobs.pending()) }
								);
							})
						)
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
			const runsTool = shared('runs', () =>
				Tool.make('runs', {
					description:
						'Automation runs, newest first, filtered by automation (a name or prefix*), status, cause, since, until; id answers one with its input, result, error, attempts and log.',
					parameters: Schema.Struct({
						id: Schema.optionalKey(Schema.String),
						automation: Schema.optionalKey(Schema.String),
						status: Schema.optionalKey(
							Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'])
						),
						cause: Schema.optionalKey(Schema.String),
						since: Schema.optionalKey(Schema.String),
						until: Schema.optionalKey(Schema.String),
						limit: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
						cursor: Schema.optionalKey(Schema.String)
					}),
					success: ToolAnswer
				})
			);
			yield* add(
				runsTool,
				Toolkit.make(runsTool).toHandlers({
					runs: (i, { toolCallId: call = '' }) =>
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
									const lines =
										view.input === undefined
											? []
											: yield* runLog(x.logs, view.id).pipe(
													Effect.map((lines) =>
														typeof lines === 'string'
															? lines
															: lines.map(({ id, at, severity, event, attributes }): Json => ({
																	id,
																	at,
																	severity,
																	event,
																	attributes
																}))
													)
												);
									return clippedView((clip) => {
										const logs =
											typeof lines === 'string' ? lines : lines.map((line) => clip(line, 1024));
										return encodeWire({
											id: view.id,
											automation: view.automation,
											status: view.status === 'stopped' ? 'cancelled' : view.status,
											cause: view.cause,
											due: view.due_at,
											started: view.started,
											finished: row.finished,
											attempt_count: view.attempt_count,
											progress: clip(view.progress, 2048),
											error: clip(encodeWire(view.error), 4096),
											...(view.input === undefined
												? {}
												: {
														input: clip(view.input, 4096),
														result: clip(view.result ?? null, 4096),
														attempts: EffectArray.isArray<typeof view.attempts>(view.attempts)
															? view.attempts.map((attempt) => clip(attempt, 1024))
															: clip(view.attempts ?? null, 4096),
														logs
													})
										});
									}, call);
								}
								const last = rows.length > limit ? rows[limit - 1] : undefined;
								return clippedView(
									(clip) =>
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
																	: { message: clip(view.error.message, 200) })
															},
												progress: clip(view.progress, 512)
											})),
											...(last === undefined
												? {}
												: { next: JSON.stringify([last.due_at, last.id]) })
										}),
									call
								);
							})
						)
				})
			);
		}
	}
	if (a.admin && a.actor.kind === 'member') {
		const logsTool = shared('logs', () =>
			Tool.make('logs', {
				description:
					"Live's runtime log, newest first: engine events and console lines, filtered by level (or worse), text, run, automation, conversation, since, until.",
				parameters: Schema.Struct({
					level: Schema.optionalKey(Schema.Literals(['info', 'warn', 'error'])),
					text: Schema.optionalKey(Schema.String),
					run: Schema.optionalKey(Schema.String),
					automation: Schema.optionalKey(Schema.String),
					conversation: Schema.optionalKey(Schema.String),
					since: Schema.optionalKey(Schema.String),
					until: Schema.optionalKey(Schema.String),
					limit: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
					cursor: Schema.optionalKey(Schema.String)
				}),
				success: ToolAnswer
			})
		);
		yield* add(
			logsTool,
			Toolkit.make(logsTool).toHandlers({
				logs: (i, { toolCallId: call = '' }) =>
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
							return clippedView(
								(clip) => ({
									lines: rows.map((row) => ({
										id: row.id,
										at: row.at,
										level: row.severity,
										event: row.event,
										invocation: row.invocation,
										run: row.run,
										conversation: row.conversation,
										attributes: clip(row.attributes, 1024)
									})),
									...(last === undefined ? {} : { next: last.id })
								}),
								call
							);
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
		meta: Pick<AgentTool, 'studio' | 'pure'> = {}
	) =>
		Effect.gen(function* () {
			if (!Predicate.isObject(input)) return;
			const known = dynamics.get(input) ?? {
				valid: validatorOf(input),
				made: Tool.dynamic(name, { description, parameters: input, success: ToolAnswer })
			};
			dynamics.set(input, known);
			const { valid, made } = known;
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
		for (const host of hosted)
			if (
				!(WORKSPACE_OVERRIDES.has(host.name) && own.has(host.name)) &&
				(agent || host.readOnly === true) &&
				(a.admin ||
					a.capabilities.tools.includes(host.name) ||
					(host.source === true && host.readOnly === true))
			)
				yield* dynamic(
					host.name,
					host.description,
					host.input,
					(input, id) =>
						Effect.gen(function* () {
							const files =
								host.files === true ? yield* conversationFiles(x, namedFiles(input)) : [];
							if (typeof files === 'string') return err(files);
							const context: HostToolContext = {
								actor: a.actor,
								conversation: x.conv.id,
								...(a.agent === undefined ? {} : { agent: a.agent }),
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
								keep: (file) => kept.push(file),
								files
							};
							const shown: { name: string; mime: string; bytes: Uint8Array }[] = [],
								kept: Downloaded[] = [];
							// a screenshot the person sees too (stored now), or a download (stored by the host): their file, offered on
							// the step. Inside the job, so a tool past the inline wall still records what it kept
							const offered = (result: Json) =>
								Effect.gen(function* () {
									if (
										!Predicate.isObject(result) ||
										(kept.length === 0 && (shown.length === 0 || e.files === undefined))
									)
										return result;
									const files: Json[] = [];
									if (e.files !== undefined)
										for (const f of shown) files.push(yield* storeFile(x, e.files, f));
									for (const f of kept) files.push(yield* recordFile(x, f));
									return { ...result, files };
								});
							const job = yield* x.jobs.add(
								host.name,
								Port.attempt(host.name, (signal) => host.call(input, context, signal)).pipe(
									Port.call(host.name, host.wallMs ?? JOBS.hostMs),
									Effect.flatMap(offered)
								),
								{
									...(host.studio === undefined ? {} : { studio: host.studio }),
									alert: (id: string, result: Json) =>
										`[job ${id} finished] ${host.name}: ${JSON.stringify(bounded(result).value)}`
								}
							);
							const inline = yield* x.jobs.wait([job], x.inlineMs ?? JOBS.inlineMs);
							return ok(
								inline?.result ?? {
									job,
									note: 'Still running; keep working. Its result arrives by itself, or wait returns it.'
								}
							);
						}),
					host.studio === undefined ? {} : { studio: host.studio }
				);
	const toolkit = yield* Toolkit.make(...entries.map((entry) => entry.tool)).pipe(
		Effect.provideContext(Context.mergeAll(...entries.map((entry) => entry.handlers)))
	);
	// the input is decoded against the tool's own schema here, closed: the toolkit skips decoding a schema it does not
	// recognise as one, and an unchecked input would reach the handler with keys the schema never offered
	const run: Catalogue['run'] = (name, input, callId) =>
		Schema.decodeUnknownEffect(
			entries.find((entry) => entry.name === name)?.tool.parametersSchema ?? Schema.Unknown,
			// every issue at once, so a wrong call learns all it must change in one answer
			{ ...CLOSED, errors: 'all' }
		)(input).pipe(
			Effect.mapError(
				(error) => new Error(`Invalid parameters for tool '${name}': ${error.message}`)
			),
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
				Effect.succeed(err(error.message.replace(/^Toolkit\.\w+\.handle: /, '')))
			)
		);
	self = run;
	return {
		tools: entries.map(({ name, tool, studio, pure }) => ({
			name,
			description: Tool.getDescription(tool) ?? '',
			input: toolSchema(tool),
			...(studio === undefined ? {} : { studio }),
			...(pure === undefined ? {} : { pure })
		})),
		toolkit,
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
const IngestFile = systemRow('sys_file', ['id', 'name', 'mime', 'size', 'key']);
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
			text: `SELECT i->>'id' AS id FROM sys_conversation c, jsonb_array_elements(c.inputs) i
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
	i: { readonly from?: number; readonly to?: number; readonly text?: string }
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
		return ok({ path, ...page(text, i.from ?? 1, i.to ?? Number.MAX_SAFE_INTEGER) });
	}
	const folder = path === '' ? '' : `${path.replace(/\/$/, '')}/`,
		under = index.files.filter((one) => one.path.startsWith(folder));
	if (under.length === 0) return err(`${name} has no file '${path}'.`);
	if (i.text === undefined || i.text === '')
		return textAnswer(under.map((one) => `${one.path}  ${one.bytes}`).join('\n'));
	const wanted = i.text.toLowerCase(),
		hits: string[] = [];
	const found = yield* Effect.forEach(under, (one) => read(one), { concurrency: 8 });
	for (const [n, text] of found.entries())
		for (const [line, value] of text.split('\n').entries())
			if (hits.length < 200 && value.toLowerCase().includes(wanted))
				hits.push(`${under[n]?.path}:${line + 1}: ${value.trim().slice(0, 200)}`);
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
/** A dynamic tool and its validator, by the JSON Schema object they come from: a turn's later steps offer the same ones. */
const dynamics = new WeakMap<
	object,
	{
		readonly valid: (value: unknown) => Json | string;
		readonly made: AnyTool;
	}
>();
/** What a script's `tool()` reaches. */
const SCRIPTED: ReadonlySet<string> = new Set(RUN_JS.tools);
/** The host tool a workspace may replace with its own same-named MCP tool; every other host name stays the host's. */
const WORKSPACE_OVERRIDES: ReadonlySet<string> = new Set(['web_search']);
