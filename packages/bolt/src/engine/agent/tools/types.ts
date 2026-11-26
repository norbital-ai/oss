import { Effect, Schema, type SchemaAST } from 'effect';
import {
	type HostTool,
	type Ingested,
	type PortFailure,
	type SearchAnswer,
	type SearchRequest,
	type StudioRole,
	type ToolBehavior,
	type ToolView,
	type WorkspacePort
} from '@norbital-ai/host-api';
import type { Json } from '../../../decl/values.ts';
import type { AgentQuestion } from '../../../protocol/schema.ts';
import type { Authority, Bindings } from '../../contracts.ts';
import type { EngineError } from '../../errors.ts';
import { InvitationInput } from '../../identity/members.ts';
import type { SkillSpec } from '../../manifest.ts';
import type { Geo, LogsShape } from '../../ports.ts';
import { LayerRequestSchema } from '../../../protocol/read-request.ts';
import type { ToolAnswer } from '../ai.ts';
import type { AgentEngine as Engine } from '../index.ts';
import type { McpSessions, McpTool } from '../mcp.ts';
import type { ConversationRow, MessageRow, Receipt } from '../schema.ts';
import type { Jobs } from './jobs.ts';

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

/** `describe_workspace`'s whole map is at most this many bytes; past it, items are named for a call with `names`. */
export const OVERVIEW_BYTES = 12_000;

/** The tools one request may carry: OpenAI-compatible APIs (DeepSeek's among them) take at most 128 functions. */
export const TOOLS_PER_REQUEST = 128;

export const VERBS = ['create', 'update', 'delete', 'import'] as const;
export const APPROVE = 'approvals.decide';
export const AUTOMATION = 'automation';
export const READ_LINES = 2000;
export const HISTORY_ROWS = 20;
export const WHOLE_ROWS = 5;
export const TILED_PAGES = 3;
export const ZOOMS = 3;
export const HIT_CHARS = 240;
export const LINE_CHARS = 2000;
export const PAGE_BYTES = 50 * 1024;
export const TAIL_LINES = 100;
export const GENERATED = /^migrations\/(?:snapshot|migrations\.lock|physical)\.json$/;
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export const TILES = [
	{ left: 0, top: 0, right: 0.55, bottom: 0.55 },
	{ left: 0.45, top: 0, right: 1, bottom: 0.55 },
	{ left: 0, top: 0.45, right: 0.55, bottom: 1 },
	{ left: 0.45, top: 0.45, right: 1, bottom: 1 }
] as const;

export const REJECTED = {
	unsupported: 'providers take 1 to 64 of A-Z, a-z, 0-9, _ and -',
	native: 'a native tool holds that name',
	shared: 'another contributed tool takes that name too',
	limit: `a request carries at most ${TOOLS_PER_REQUEST} tools; MCP tools fill what is left in name order`
} as const;

export class ToolRejected extends Schema.TaggedError<ToolRejected>()('ToolRejected', {
	/** The provider-visible name it would have had. */
	tool: Schema.String,
	reason: Schema.Literals(['unsupported', 'native', 'shared', 'limit']),
	message: Schema.String
}) {}

/** Raw-schema validators by schema object, held by the engine that compiled them. */
export type Validators = WeakMap<object, (value: unknown) => Json | string>;

/**
 * Whom a conversation serves, fixed for its life: an in-app staff member, an in-app external member, a messaging
 * channel's sender, or a system agent's task. Each has one tool list, so a conversation's `tools[]` never changes; a
 * tool its step cannot use answers why.
 */
export type Audience = 'staff' | 'member' | 'channel' | 'system';

export type HostGives = { readonly source: boolean; readonly delegation: boolean };

export type Spec = { confirm?: true };

/** The catalogue note's lines by key: `skill:`, `model:`, `automation:`, `sync:`, `act:` and `tool:` (an MCP tool). */
export type CatalogueIndex = { readonly [key: string]: string };

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
	/** Envoy turns have no confirmation card: a call that needs one is refused there. */
	inApp: boolean;
	/** Whether the person approved this exact call on a card it has not run since; a true answer uses the approval up. */
	approved: (name: string, input: Json) => boolean;
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
	/** `read_file` crops this turn, by document. */
	zooms: Map<string, number>;
	/** The ingests this engine is running: a restart leaves none, so one marked running elsewhere was cut short. */
	reading: Set<string>;
	validators: Validators;
	/** The host's ingest port (Norbital Convert): a file as HTML and its images. Absent: no document ingests. */
	ingest?:
		| ((
				file: { sha256: string; name: string; mime: string; key: string; size: number },
				read?: { readonly page?: number; readonly password?: string; readonly entry?: string }
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
	/** A sub-agent's question for its delegating agent: its turn ends on it, and the delegating agent's `task` with its `task_id` resumes it. */
	ask(question: AgentQuestion): boolean;
	/** An instance's history, newest first before `before`. */
	messages(o: { limit: number; before?: number }): Effect.Effect<readonly MessageRow[], EngineError>;
	/** The whole output of a clipped call; `null` names the latest clipped call. */
	output(callId: string | null): Effect.Effect<Json | undefined, EngineError>;
	history(query: string, scope: 'this' | 'mine', limit: number): Effect.Effect<Json, EngineError>;
	/** Ends once input waits for this conversation: a `wait` gives way to it, so the step ends and the next takes it. */
	heard: Effect.Effect<void, EngineError>;
	subagent: {
		/** Starts a sub-agent of `agent` on `prompt`, or with `task` sends that one `prompt`: its id and whether it was already working, or why not. */
		task(o: {
			description: string;
			prompt: string;
			agent: string;
			task?: string | undefined;
		}): Effect.Effect<{ id: string; running: boolean } | { error: string }, EngineError>;
		read(task: string): Effect.Effect<Json, EngineError>;
		stop(task: string): Effect.Effect<Json, EngineError>;
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

export type ToolPresentation = Pick<AgentTool, 'name' | 'studio' | 'behavior'> & {
	readonly input: Json;
	/** How a host tool's call reads in the panel (`HostTool.view`), decoded; none for a native tool. */
	readonly view?: ToolView;
};

export type BoundTool = {
	readonly tool: AgentTool;
	/** A host tool's `view` (`HostTool.view`): its own code, so its answer is decoded. */
	readonly view?: (input: Json) => unknown;
	/** Whether a script's `tool()` reaches it (`ToolPolicy.scripts`). */
	readonly scripts: boolean;
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

export type ToolPolicy = {
	readonly audiences?: readonly Audience[];
	readonly child?: false;
	readonly scripts?: false;
	readonly needs?: 'source' | 'delegation';
};

export type ToolDefinition<A> = Pick<AgentTool, 'name' | 'description' | 'input' | 'behavior'> &
	ToolPolicy & {
		readonly decode: (input: unknown, options?: SchemaAST.ParseOptions) => Effect.Effect<A, Schema.SchemaError>;
	};

export type AddTool = <A>(
	definition: ToolDefinition<A>,
	handler: (input: A, callId: string) => Effect.gen.Return<ToolAnswer, EngineError | PortFailure>,
	meta?: Pick<AgentTool, 'studio'> & Pick<BoundTool, 'view'>,
	destination?: Map<string, BoundTool>
) => void;

export type HoldTool = (name: string, input: Json, what: string) => ToolAnswer | undefined;

/** What `read` needs: the engine's reads, as `authority` at `bindings`. */
export type ReadToolContext = {
	engine: Pick<Engine, 'manifest' | 'read'>;
	authority: Authority;
	bindings: Bindings;
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

/** The same atomic write map a page or server body submits; a file may supply the whole map. */
export const WriteInput = Schema.Struct({
	acts: Schema.optionalKey(Schema.Record(Schema.String, ToolJson)),
	key: Schema.optionalKey(Schema.NonEmptyString),
	input_file: Schema.optionalKey(
		Schema.String.annotate({
			description: 'a JSON file id containing the act map, instead of acts'
		})
	)
});

export const RunInput = Schema.Struct({
	automation: Schema.String,
	input: Schema.optionalKey(ToolJson),
	key: Schema.optionalKey(Schema.NonEmptyString),
	input_file: Schema.optionalKey(
		Schema.String.annotate({ description: 'a JSON file id, instead of input' })
	)
});

export const InviteInput = Schema.Struct({
	members: Schema.Array(InvitationInput).check(Schema.isMinLength(1), Schema.isMaxLength(1000))
});

export const Decide = Schema.Struct({
	request_id: Schema.String,
	decision: Schema.Literals(['approve', 'reject', 'request_changes', 'withdraw']),
	reason: Schema.optionalKey(Schema.String)
});

export const ReadOptions = (() => {
	const { order_by: _orderBy, aggregate, ...fields } = LayerRequestSchema.fields;
	return Schema.Struct({
		...fields,
		order_by: Schema.optionalKey(ToolJson),
		aggregate: Schema.optionalKey(
			Schema.Struct({ ...aggregate.schema.fields, by: Schema.optionalKey(ToolJson) })
		)
	});
})();

const ReadNode = Schema.StructWithRest(ReadOptions, [
	Schema.Record(
		Schema.String.check(Schema.makeFilter((name) => !Object.hasOwn(ReadOptions.fields, name))),
		ToolJson
	)
]);

export const ReadInput = Schema.Struct({ request: Schema.Record(Schema.String, ReadNode) });
