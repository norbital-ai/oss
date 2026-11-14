// The agent engine: a turn is a loop over a conversation's rows. Each step claims the queued inputs
// (a steer joins at the next step and acts as its own sender), builds the context, makes one model request (60 s to its
// first byte, then the 20 s idle wall) and runs the tool calls it asks for as the actor. A turn ends on a reply with no tool calls, a confirmation
// card or a stop, or at the step cap; guards end it earlier when it makes no progress. An executed plan is checked once by a verifier pass on the
// turn's own cached prefix; a sub-agent is a
// child conversation run under the delegating turn's `as`, never wider. Hosts drive `drain`; nothing here names a host.
// A claimed turn holds a three-minute lease its heartbeat renews and queues the platform run `agent.turn`, so a turn
// whose process died is taken over once the lease lapses, and never runs twice at once.
import { sql } from '../db/sql.ts';
import {
	type AgentPorts,
	type AiRequest,
	type AiResponse,
	type FacilityFailure,
	type HostTool,
	type LogEvent,
	Port,
	type SearchRequest,
	type Sql,
	type ToolBehavior,
	Unavailable,
	type WorkspaceNote,
	type WorkspacePort
} from '@norbital-ai/host-api';
import {
	Cause,
	Clock,
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberHandle,
	FiberMap,
	FiberSet,
	Layer,
	Option,
	PubSub,
	Queue,
	Redacted,
	Schedule,
	Schema,
	Scope,
	Stream
} from 'effect';
import { Secrets } from '../secrets.ts';
import {
	Ai,
	Bundler,
	Convert,
	Files,
	GuestIsolates,
	Geo,
	Http,
	Images,
	Logs,
	Mcp,
	RunUnits
} from '../ports.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { makeParking } from '../parking.ts';
import {
	Agents as AgentsTag,
	Callables,
	Automations,
	Links,
	Live,
	Manifest,
	Reads,
	RunEnds,
	RunHandlers,
	Wake,
	Approvals,
	HostIdentity,
	type AgentsShape,
	type CallablesShape,
	type ReadsShape,
	type ApprovalsShape,
	type LiveShape
} from '../services.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { AgentQuestion, PageResult } from '../../protocol/schema.ts';
import { enqueueTurn, TURN_RUN, TurnHandlers } from './turns.ts';
import { LEASE_MS, leaseUntil } from '../queue.ts';
import { MessageQueue, messageQueue, SCHEDULED_RUN } from './queue.ts';
import { attachmentsFor, file_attachments } from './attachments.ts';
import { Chain } from '../write/sql.ts';
import { next_due } from '../runs/queue.ts';
import { runPiece } from '../runs/rows.ts';
import { activeEnvoys, envoySpec } from '../envoys/spec.ts';
import {
	post as postMessage,
	settle as settleMessage,
	stream as streamMessage,
	cancel as cancelMessage,
	claim as claimMessage,
	mark as markMessage,
	msg as messagePiece,
	MSG
} from '../conversations/store.ts';
import { bindingsAt } from '../query/reader.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Json } from '../../decl/values.ts';

import type { Authority, Bindings } from '../contracts.ts';
import { textOf } from './schema.ts';
import { Authorities } from '../identity/actor.ts';
import { model_step, run_calls, type ModelCarry } from './step.ts';
import { isFacilityError, modelCall, overflow, servesModel, type ToolAnswer } from './ai.ts';
import {
	bounded,
	storedToolResult,
	senderAsides,
	COMPACT_FORMAT,
	envoyName,
	projection,
	state,
	system,
	modelTranscript,
	pageNote,
	pageWaiting,
} from './context.ts';
import { mcpServers, mcpSessions, type McpHost } from './mcp.ts';
import { agentSettings, allowedModel, overLimit } from './settings.ts';
import {
	ambient as isAmbient,
	authorOf,
	clip,
	rowsOf,
	storable,
	transcriptRow,
	Message,
	Conversation,
	AgentRefusal,
	type As,
	type ConversationRow,
	type MessageRow,
	type Meta,
	type Plan,
	type Receipt,
	type ToolCall,
	type Usage
} from './schema.ts';
import {
	catalogue,
	catalogueNote,
	JOBS,
	TEXT_FIRST_BYTES,
	jobs,
	perform,
	runJob,
	turnFacts,
	WriteInput,
	CLOSED,
	type AttachmentPort,
	type Audience,
	type ToolContext,
	type Validators
} from './tools.ts';
import { Audit, type AuditShape } from '../audit.ts';
import { AUTHORING_SKILLS, PLATFORM_SKILLS } from './skills.ts';
import { requestEvidence, sequenceRanges } from './request.ts';
import { sha256_hex } from '@norbital-ai/store';
import { isObj } from './draft.ts';
export { infer_facility } from './ai.ts';
export { mcpServers } from './mcp.ts';
export { type As } from './schema.ts';
export type { AttachmentPort } from './tools.ts';
export type AgentEngine = {
	identity?: import('../identity/session.ts').IdentityHost;
	manifest: EngineManifest;
	db: TenantDbShape;
	live: LiveShape;
	calls: CallablesShape;
	automations: import('../services.ts').AutomationsShape;
	read: ReadsShape['run'];
	approvals: ApprovalsShape;
	/** The administrator audit trail, where the host keeps one: the `audit` tool. */
	audit?: AuditShape | undefined;
	files?: Files['Service'] | undefined;
	images?: Images['Service'] | undefined;
	/** The host's document converter: the `document` tool, and its ingest port `read_file`. */
	convert?: Convert['Service'] | undefined;
	/** Run ends as they are written (`RunEnds`): a run the agent started is a job that ends with it. */
	runEnds?: PubSub.PubSub<readonly string[]> | undefined;
	/** Fresh guest isolates for `run_js`, and the outbound HTTP a granted script's `http` makes. */
	guest?: GuestIsolates['Service'] | undefined;
	http?: Http['Service'] | undefined;
	/** The host's confined bundler: `run_js` runs a skill's file only where there is one. */
	bundler?: Bundler['Service'] | undefined;
};
type DrainOptions = {
	force?: boolean | undefined;
	receipts?: readonly Receipt[] | undefined;
	onWrite?: ((row: MessageRow) => Effect.Effect<unknown, EngineError>) | undefined;
};
export class AgentDrains extends Context.Service<
	AgentDrains,
	{
		readonly drain: (
			conversation: string,
			options?: DrainOptions
		) => Effect.Effect<{ ran: boolean; reply: MessageRow | null }, EngineError>;
	}
>()('bolt/AgentDrains') {}
/** The agent's host parts (`AgentPorts`), and what the release binds beside them. */
export type AgentConfig = AgentPorts & {
	engine: AgentEngine;
	ai?: Ai['Service'];
	bindings: Effect.Effect<Bindings>;
	/** A message's authority; default: members from `sys_user`, public senders and policy sets by the manifest. */
	resolve?: (as: As) => Effect.Effect<Authority | null, EngineError>;
	mcp?: McpHost;
	attachments?: AttachmentPort;
	media: { files: Files['Service']; images: Images['Service'] };
	geocoder?: Geo['Service'];
	/** The published source used when there is no authoring tree; a host reads it from the artifact (`workspace_files`). */
	workspace?: WorkspacePort;
	/** The isolated fleet browser, admitted under the actor's tool capabilities independently of web UI authoring. */
	browser_tools?: readonly HostTool[];
	/**
	 * A linked chat shows the assistant typing (`on`) from the turn's first step until its first reply, refreshed every
	 * TYPING_REFRESH_MS; a turn that ends without one stops it. Absent where nothing is linked (an in-app conversation).
	 */
	typing?: (integration: string, thread: string, on: boolean) => Effect.Effect<void>;
	/** The workspace's skill files (the artifact's `skills/<name>/`, `skill_files`): a file run reads its tree here. */
	skill_files?: (skill: string, path: string) => Promise<Uint8Array>;
	/** A host call that has not answered by then becomes a background job (default 30 s). */
	host_inline_ms?: number;
	/** The deadlines port's `announce` for this scope: a recovery run's due time. */
	announce?: (at: string) => Effect.Effect<void>;
	/** Context windows by model class; default 200,000 tokens. */
	windows?: {
		readonly [modelClass: string]: number;
	};
	wall_ms?: number;
};
class Unusable extends Schema.TaggedError<Unusable>()('Unusable', { message: Schema.String }) {}
/** flag costly calls on their observation; the gauge does not stop the turn or change the billed charge. */
const AI_GAUGE_USD = 5;
export const AGENT_LIMITS = {
	/** Checkpoints in a row with no model step between them: compaction that frees nothing stops here. */
	compactions: 3,
	/** Compact at 80% of the window, leaving room for the reply and a compaction that itself fits. */
	compactAt: 0.8,
	window: 200000,
	/** Sub-agents one conversation may have running at once; each is a full agent loop in this host. */
	subagents: 4,
	/** Model steps one turn may take: a turn making distinct successful calls stops here rather than at the spend cap. */
	steps: 150,
	sameFailure: 3,
	failingSteps: 4,
	leaseMs: LEASE_MS.turn,
	heartbeatMs: 60000,
	/** The newest workspace events one step hears; older unheard ones are dropped. */
	eventsHeard: 10
} as const;
const MIB = 1_048_576;
/** This host process's RAM at a step boundary, for the `ai.call` observation; absent off Node. */
const memoryOf = (): {
	rssMiB?: number;
	heapUsedMiB?: number;
	heapTotalMiB?: number;
	externalMiB?: number;
} => {
	const usage = globalThis.process?.memoryUsage?.();
	if (usage === undefined) return {};
	const mib = (bytes: number) => Math.round((bytes / MIB) * 10) / 10;
	return {
		rssMiB: mib(usage.rss),
		heapUsedMiB: mib(usage.heapUsed),
		heapTotalMiB: mib(usage.heapTotal),
		externalMiB: mib(usage.external)
	};
};
/** A tool answer that failed: its `error` is set (a run's `error: null` describes a run that did not fail). */
const failedResult = (result: Json): result is { readonly [key: string]: Json } =>
	isObj(result) && result['error'] !== undefined && result['error'] !== null;
/**
 * A reply being written reaches its row at most this often: one UPDATE of the whole text so far per flush (a write is
 * one statement), each published live like any other write, so the panel's transcript grows patch by patch.
 */
export const STREAM_FLUSH_MS = 150;
/** A chat's typing presence lapses on its own (WhatsApp's after about 10 s): a working turn renews it this often. */
export const TYPING_REFRESH_MS = 10_000;
/** Keeps the newest messages that fit `budget` characters: a compaction never exceeds the window it summarises. */
const fit = <M extends { content: unknown }>(list: readonly M[], budget: number): M[] => {
	let used = 0;
	const kept: M[] = [];
	for (const message of list.toReversed()) {
		const size =
			typeof message.content === 'string'
				? message.content.length
				: JSON.stringify(message.content).length;
		if (kept.length > 0 && used + size > budget) break;
		kept.unshift(message);
		used += size;
	}
	return kept;
};
/** Characters a model can slip into a name unseen: format (zero-width, bidi) and default-ignorable code points. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const plain = (text: string) => text.normalize('NFKC').replace(INVISIBLE, '');
const canonical = (v: Json): Json =>
	typeof v === 'string'
		? plain(v)
		: Array.isArray(v)
			? v.map(canonical)
			: isObj(v)
				? Object.fromEntries(
						Object.entries(v)
							.map(([k, x]): [string, Json] => [plain(k), canonical(x)])
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					)
				: v;
/**
 * What makes two calls the same call: the tool and its input normalised (NFKC, invisible characters dropped, keys in
 * order), so a name dressed in zero-width characters or a reordered object is never a new call to the repeat guards.
 */
export const callKey = (name: string, input: Json): string =>
	`${name}\u0000${JSON.stringify(canonical(input))}`;
/** A call as the transcript records it: its name and clipped arguments, for matching what a resumed step repeats. */
const stepKey = (name: string, args: string | undefined): string => `${name}\u0000${args ?? ''}`;
/**
 * How many failures a check (`workspace_diagnose`, `workspace_test`) reported: its `failing` count, or the count its
 * `error` names (`"7 failing"`, the older answer); 0 when it came back clean; undefined when it could not run at all.
 */
export const checkFailing = (answer: Json): number | undefined => {
	if (!isObj(answer)) return undefined;
	if (typeof answer['failing'] === 'number') return answer['failing'];
	const error = answer['error'];
	if (error === undefined || error === null) return 0;
	const counted = typeof error === 'string' ? /^(\d+) failing/.exec(error) : null;
	return counted === null ? undefined : Number(counted[1]);
};
/** What a resumed turn is told: its open request, and that a call made before the restart is not run again. */
export const NUDGE = {
	resumed: (request: string) =>
		`Your turn was interrupted and has resumed. The person's request is still open: "${request.length > 2000 ? `${request.slice(0, 2000)}…` : request}".`,
	replayed: 'Not run: this call was made before the turn resumed and may have taken effect; its outcome is above.',
	cutTool:
		'Your last reply was cut off while you were still writing a tool call. Make smaller calls: write or edit a large file in several parts.'
} as const;
/** Rule 59: fixed replies; internal error text never reaches a sender. */
export const FIXED = {
	failed:
		'I could not finish this request because a service it needs did not answer. Please try again later.',
	broke:
		'Sorry, I could not finish that: something went wrong on my side. Please send it again in a moment.',
	unavailable: 'The assistant is not available to you here.',
	stale: 'I could not act for this message: its sender no longer has access.',
	red: 'I stopped here: the checks kept failing after several attempts, so the change is not finished. Tell me what to try next.',
	stuck:
		'I stopped here: the data this needs kept failing to load, so I have no answer. Try rephrasing, or ask me what data is available.',
	empty: 'I could not put an answer together for this request. Please try again or rephrase it.',
	limit:
		'I stopped here: the assistant reached its spending limit for this month. An administrator can raise it in Settings.',
	unreported:
		'The workspace restarted before this reported back, so whether it finished is unknown. Check before running it again.',
	steps: 'I stopped here: this request took more steps than one turn allows. Tell me how to continue.',
	overflow:
		'This conversation is too long for the model and could not be compacted further. Start a fresh conversation (or run /compact), then ask again: the work already done stays in the workspace.'
} as const;
/** How long a step waits for the tab's answer to the page call it ends in. */
const PAGE_ANSWER_MS = 5000;
/** A confirmation card's second answer (a repeat press, another tab): refused, so its call never runs twice. */
export const ANSWERED = 'This was already answered.';
/** `modelCall`'s reason when the host binds no AI port. */
const NO_AI = 'the host provides no ai';
/** A catalogue note: its meta holds the index it reached and, on the first after a checkpoint, the native MCP tools. */
const isCatalogueNote = (row: MessageRow) => row.role === 'system' && row.meta?.tag === 'note' && row.meta.catalogue !== undefined;
const CONV_COLS =
	'id, title, owner, envoy, integration, thread, parent, status, model, plan';
const TurnInput = Schema.Struct({ conversation: Schema.String });
/** A step's reply as it streams (`drain`'s `streamer`). */
type Streamer = {
	delta(x: string): void;
	reasoning(x: string): void;
	end(): Effect.Effect<MessageRow | null, EngineError>;
};
type TurnState = {
	model: string;
	steps: number;
	failing: number;
	red: number;
	lowest: number;
	lastError: string;
	cutTools: number;
	compactions: number;
	/** A checkpoint failed this turn: none is tried again until the turn ends. */
	compactFailed: boolean;
	lastInput: number;
	/** The last call's cached input tokens: a later call reading far fewer is logged as a cache drop. */
	cached: number;
	as: As | null;
	mode: 'agent' | 'plan' | 'compact';
	force: boolean;
	/** A question ends its turn after the current calls settle. */
	question: AgentQuestion | null;
	cut: ({ readonly row: MessageRow } & ModelCarry) | null;
	reply: MessageRow | null;
	heard: boolean;
	typingIn: { integration: string; thread: string } | null;
	streaming: Streamer | null;
	inputs: string[];
	usage: Usage;
	receipts: ToolContext['receipts'];
	zooms: ToolContext['zooms'];
	files: ToolContext['files'];
	failures: Map<string, number>;
	/** The previous owner may have committed these calls without recording their results. */
	replayed: Set<string>;
	mcpTools: ToolContext['mcpTools'] | null;
	mcpFor: string;
	host_tools: ToolContext['host_tools'];
	hostFor: string;
};
type TurnGuard = { when(current: TurnState): boolean; text: string; code: 'toolFailures' | 'redChecks' };
/** Hard stops when a turn makes no progress: every call failing, or checks failing without a new low. */
const TURN_GUARDS: readonly TurnGuard[] = [
	{ when: (s) => s.failing > AGENT_LIMITS.failingSteps, text: FIXED.stuck, code: 'toolFailures' },
	{ when: (s) => s.red > AGENT_LIMITS.failingSteps, text: FIXED.red, code: 'redChecks' }
];
const turnGuard = (current: TurnState, calls: number, failed: number) => {
	current.failing = calls > 0 && failed === calls ? current.failing + 1 : 0;
	return TURN_GUARDS.find((guard) => guard.when(current));
};
const j = (v: unknown): Json => (v === undefined || v === null ? null : JSON.stringify(v));
export const agents = Effect.fn('Agents.make')(function* (config: AgentConfig) {
	const e = config.engine,
		m: EngineManifest = e.manifest,
		db = e.db,
		mcp_port = yield* Mcp,
		logs = yield* Logs;
	const manifestHash = sha256_hex(JSON.stringify(m));
	const runningChildren = Effect.fn('Agents.runningChildren')(function* (parent: string) {
		return yield* db.value(Schema.Number, sql(
			`SELECT count(*)::int AS n FROM sys_conversation WHERE parent = $1 AND status = 'running'`,
			parent
		));
	});
	// a parent's id per finished sub-agent; a subscriber past this many unread drops the oldest, and re-reads the table
	const reports = yield* PubSub.sliding<string>(256);
	const authorities = new Authorities(m, 'agent', { remember: true });
	// the workspace's skills, their files read from the release where the host binds them
	const skillFiles = config.skill_files;
	// the platform's skills first, so a workspace skill of the same name replaces one
	const allSkills = { ...PLATFORM_SKILLS, ...m.agent.skills };
	const workspaceSkills: ToolContext['skills'] = Object.fromEntries(
		Object.entries(allSkills).map(([name, skill]) => [
			name,
			{
				...skill,
				read: (path: string) =>
					skillFiles === undefined || !(name in m.agent.skills)
						? Port.unavailable('agent.skills', 'the host binds no skill files')
						: Port.attempt('agent.skills', () => skillFiles(name, path))
			}
		])
	);
	const resolve =
		config.resolve ??
		Effect.fn('Agents.authority')(function* (as: As) {
			if ('member' in as) {
				const own = yield* authorities.member(db, e.live.publish, as.member);
				return as.team === undefined || own === null || own.actor.kind !== 'member'
					? own
					: yield* authorities.team(db, own.actor, as.team);
			}
			if ('envoy' in as)
				return yield* authorities.envoy(db, e.live.publish, {
					envoy: as.envoy.name,
					instance: as.envoy.instance,
					sender: as.envoy.sender,
					member: as.envoy.member,
					dm: as.envoy.dm
				});
			return yield* authorities.compile(
				{
					actor: { kind: 'system', run: as.run, by: { platform: 'agent' } },
					admin: false,
					policies: as.policies
				},
				`agent:${as.run}:${as.policies.join(',')}`
			);
		});
	const running = yield* FiberMap.make<string, { ran: boolean; reply: MessageRow | null }, EngineError>();
	/** Sub-agent runs and the parent turns their reports start: detached from any one turn, ended with the service. */
	const detached = yield* FiberSet.make<unknown, never>();
	/** The conversations inside a step: a planned close waits for none, and holds each turn at its next step. */
	const stepping = makeParking();
	/** A shared message piece: the rows reach live transcripts as written, with no re-read. */
	const changed = Effect.fn('Agents.changed')(function* (statement: Sql) {
		const chain = new Chain();
		chain.params.push(...statement.params);
		const source = messagePiece(chain, statement.text);
		return yield* messageStatement(chain, source);
	});
	const messageStatement = Effect.fn('Agents.messageStatement')(function* (
		chain: Chain,
		source: string
	) {
		const result = yield* nativeCommit(db.write, e.live.publish, chain,
			Schema.Struct({ ...CapturedResult.fields, messages: Schema.Array(Message) }).annotate({ identifier: 'sys_message' }),
			`(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM ${source}) AS messages`);
		return result.messages;
	});
	const cancelQueued = (conversation: string) => {
		const chain = new Chain();
		return messageStatement(chain, cancelMessage(chain, conversation, null));
	};
	/** A native conversation mutation publishes the same statement's complete captures. */
	const convChanged = Effect.fn('Agents.conversationChanged')(function* (statement: Sql) {
		const chain = new Chain();
		chain.params.push(...statement.params);
		const source = capturePiece(chain, 'conversation', 'sys_conversation', statement.text, { returning: 'to_jsonb(c) AS r' });
		const result = yield* nativeCommit(db.write, e.live.publish, chain, Schema.Struct({
			...CapturedResult.fields, rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
		}), `(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM ${source}) AS rows`);
		return result.rows;
	});
	/** A row the step wrote that must not stay (a failed step's partial reply): its removal reaches live transcripts too. */
	const discard = (row: MessageRow) =>
		changed(sql('DELETE FROM sys_message m WHERE id = $1', row.id));
	/** A reply or a call a turn left unfinished (a stop, a closed generation, a dead process) is finished as interrupted. */
	const unfinished = (conversation: string, of?: string) =>
		changed(
			sql(
				`UPDATE sys_message m SET state = NULL, meta = CASE WHEN role = 'assistant' THEN coalesce(meta, '{"tag":"cut"}'::jsonb) ELSE meta END,
				content = CASE WHEN role = 'tool' THEN content || '{"result":{"error":"The turn ended before this call finished."}}'::jsonb ELSE content END
				WHERE conversation = $1 AND state IN ('streaming', 'running') ${of === undefined ? '' : 'AND turn = $2'}`,
				...(of === undefined ? [conversation] : [conversation, of])
			)
		).pipe(
			Effect.tapCause(Effect.logWarning)
		);
	const conversation = Effect.fn('Agents.conversation')(function* (id: string) {
		const row = yield* db.one(Conversation, sql(`SELECT ${CONV_COLS} FROM sys_conversation WHERE id = $1`, id));
		if (Option.isNone(row)) return yield* new AgentRefusal({ message: `no conversation '${id}'` });
		return row.value;
	});
	const maybeConversation = (id: string) => conversation(id).pipe(
		Effect.tapCause(Effect.logWarning),
		Effect.catchTag('AgentRefusal', () => Effect.succeed(null))
	);
	/** A conversation's messages in `seq` order: all, those `from` a seq on, or the `limit` just `before` one (a panel's older page). */
	const transcript = Effect.fn('Agents.transcript')(function* (
		id: string,
		page?: { from: number } | { before: number; limit: number }
	) {
		const [result] = yield* db.read([
			page === undefined
				? sql(`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 ORDER BY seq`, id)
				: 'from' in page
					? sql(
							`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 AND seq >= $2 ORDER BY seq`,
							id,
							page.from
						)
					: sql(
							`SELECT x.r FROM (SELECT ${MSG}, m.seq FROM sys_message m WHERE conversation = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3) x ORDER BY x.seq`,
							id,
							page.before,
							page.limit
						)
		]);
		return yield* rowsOf(result?.rows ?? []);
	});
	const insert = Effect.fn('Agents.insert')(function* (row: {
		conversation: string;
		role: MessageRow['role'];
		content: Json;
		text?: string | null;
		state?: MessageRow['state'];
		mode?: MessageRow['mode'];
		as?: As | null;
		author?: string | null;
		meta?: Meta | null;
		supersedes?: string | null;
		turn?: string | null;
		files?: readonly Json[];
		addressed?: false;
	}) {
		const chain = new Chain();
		const source = postMessage(chain, {
			...row,
			content: storable(row.content),
			...(row.text === undefined || row.text === null ? {} : { text: storable(row.text) }),
			state: row.state ?? null,
			mode: row.mode ?? null,
			as: row.as ?? null,
			meta: row.meta === undefined || row.meta === null ? null : storable(row.meta),
			files: row.files === undefined ? [] : [...row.files]
		});
		const [message] = yield* messageStatement(chain, source);
		if (message === undefined)
			return yield* BoltError.make('corrupt', 'commit', 'the message insert returned no row');
		return message;
	});
	/** The host resolves this class; runtime settings narrow the models each step may use. */
	const defaultModel = 'default';
	const setConv = (id: string, set: string, ...params: Json[]) =>
		convChanged(
			sql(
				`UPDATE sys_conversation AS c SET ${set}, revision = revision + 1, updated_at = now() WHERE id = $1`,
				id,
				...params
			)
		);
	const start = Effect.fn('Agents.start')(function* (o: Parameters<AgentsShape['start']>[0]) {
		const id = globalThis.crypto.randomUUID();
		yield* convChanged(
			sql(
				`INSERT INTO sys_conversation AS c (id, title, owner, envoy, integration, parent, model) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				id,
				o.title ?? null,
				o.owner ?? null,
				o.envoy ?? null,
				o.integration ?? null,
				o.parent ?? null,
				o.model ?? defaultModel
			)
		);
		return id;
	});
	const queue = yield* messageQueue({
		db,
		publish: e.live.publish,
		now: config.bindings.pipe(Effect.map((b) => b.now)),
		announce: (at) => config.announce?.(at) ?? Effect.void,
		start: (id) => FiberSet.run(detached, kick(id)).pipe(Effect.asVoid)
	});
	const { post } = queue;
	/** Rule 60: an unaddressed group message: history `read_messages` reads, never a turn. */
	const ambient = (o: {
		conversation: string;
		text: string;
		author: string;
		files?: readonly Json[];
	}) =>
		insert({
			conversation: o.conversation,
			role: 'user',
			content: { text: o.text },
			text: o.text,
			author: o.author,
			addressed: false,
			...(o.files === undefined ? {} : { files: o.files })
		});
	const UNTURN = `DELETE FROM sys_run WHERE automation = '${TURN_RUN}' AND state = 'queued' AND input->>'conversation' = $1`;
	const claim = Effect.fn('Agents.claim')(function* (id: string) {
		const now = (yield* config.bindings).now,
			due = leaseUntil(now, AGENT_LIMITS.leaseMs), chain = new Chain();
		capturePiece(chain, 'c', 'sys_conversation',
			`UPDATE sys_conversation SET status = 'running', updated_at = ${chain.p(now)}::timestamptz, lease_until = ${chain.p(due)}::timestamptz
			WHERE id = ${chain.p(id)} AND (status = 'idle' OR (status = 'running' AND lease_until < ${chain.p(now)}::timestamptz))`);
		enqueueTurn(chain, id, due, 'EXISTS (SELECT 1 FROM c)');
		const result = yield* nativeCommit(db.write, e.live.publish, chain, Schema.Struct({
			...CapturedResult.fields, claimed: Schema.Number, next_due: Schema.NullOr(Schema.String), taken: Schema.Boolean
		}), `(SELECT count(*)::int FROM c) AS claimed, ${next_due(chain)}::text AS next_due,
			EXISTS (SELECT 1 FROM sys_conversation WHERE id = ${chain.p(id)} AND status = 'running') AS taken`);
		if (result.next_due !== null) yield* config.announce?.(result.next_due) ?? Effect.void;
		return result.claimed !== 1 ? null : result.taken ? 'takeover' : 'claimed';
	});
	/** A closing generation releases its actual lease and queued takeover together. */
	const release = (id: string) => Effect.gen(function* () {
		const now = (yield* config.bindings).now, chain = new Chain();
		chain.params.push(id, now);
		capturePiece(chain, 'released', 'sys_conversation',
			"UPDATE sys_conversation SET lease_until = $2::timestamptz WHERE id = $1 AND status = 'running'");
		runPiece(chain, 'moved', `UPDATE sys_run SET due_at = $2::timestamptz
			WHERE automation = '${TURN_RUN}' AND state = 'queued' AND input->>'conversation' = $1 AND EXISTS (SELECT 1 FROM released)`);
		const result = yield* nativeCommit(db.write, e.live.publish, chain,
			Schema.Struct({ ...CapturedResult.fields, moved: Schema.Number }),
			'(SELECT count(*)::int FROM moved) AS moved');
		if (result.moved > 0) yield* config.announce?.(now) ?? Effect.void;
	}).pipe(Effect.timeout(2000), Effect.tapCause(Effect.logWarning), Effect.ignore);
	const idle = Effect.fn('Agents.idle')(function* (id: string, onlyEmpty: boolean) {
		const chain = new Chain();
		chain.params.push(id);
		capturePiece(chain, 'settled', 'sys_conversation', `UPDATE sys_conversation SET status = 'idle', lease_until = NULL
			WHERE id = $1 AND status = 'running'${onlyEmpty ? " AND NOT EXISTS (SELECT 1 FROM sys_message WHERE conversation = $1 AND state = 'queued')" : ''}`);
		runPiece(chain, 'unqueued', `${UNTURN} AND EXISTS (SELECT 1 FROM settled)`);
		const result = yield* nativeCommit(db.write, e.live.publish, chain,
			Schema.Struct({ ...CapturedResult.fields, changed: Schema.Number }),
			'(SELECT count(*)::int FROM settled) AS changed');
		return result.changed;
	});
	/** Idle only when nothing is queued; otherwise the turn continues. */
	const settle = Effect.fn('Agents.settle')(function* (id: string) {
		if (yield* queue.finished(id)) return false;
		return (yield* idle(id, true)) === 1;
	});
	/** Static per agent: an envoy's by its audience, the in-app agent's by the member kind it serves. */
	/** A public envoy's or an external member's turn: the external brief, and no view of the workspace's source. */
	const outward = Effect.fn('Agents.outward')(function* (conv: ConversationRow, a: Authority) {
		const envoy = conv.envoy ?? (a.actor.kind === 'envoy' ? a.actor.envoy : null);
		return envoy !== null
			? (yield* envoySpec(db, envoy))?.audience === 'public'
			: a.actor.kind === 'member' && a.actor.external;
	});
	/**
	 * Job lines no running turn takes (a job that ended after its turn, or one the turn left untaken): queued in the
	 * conversation as notes from the starter, and the conversation is kicked, so a turn runs on them.
	 */
	const queuedNote = (conversation: string, as: As | null, text: string) =>
		insert({ conversation, role: 'system', content: { text }, text, state: 'queued', mode: 'agent', as, meta: { tag: 'note' } });
	const steer = (conversation: string, as: As | null, lines: readonly string[]) =>
		Effect.gen(function* () {
			for (const line of lines) yield* queuedNote(conversation, as, line);
			yield* FiberSet.run(detached, kick(conversation));
		}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
	/** The workspace events a conversation has not heard: after its newest event row, else after its first row. */
	const unheard = (conversation: string) =>
		Effect.gen(function* () {
			const events = config.events;
			if (events === undefined) return [];
			const since = yield* db.value(
				Schema.NullOr(Schema.String),
				sql(
					`SELECT to_json(coalesce(max((meta->>'at')::timestamptz) FILTER (WHERE meta->>'tag' = 'event'), min(created_at)))#>>'{}'
					 FROM sys_message WHERE conversation = $1`,
					conversation
				)
			);
			if (since === null) return [];
			return (yield* Port.attempt('agent.events', () => events(since))).slice(
				-AGENT_LIMITS.eventsHeard
			);
		}).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.orElseSucceed((): readonly WorkspaceNote[] => [])
		);
	const confirmations = new Map<string, Set<Deferred.Deferred<void>>>();
	const withConfirmation = <A, E, R>(conversation: string, work: Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
		Effect.gen(function* () {
			const done = yield* Deferred.make<void>();
			const active = confirmations.get(conversation) ?? new Set<Deferred.Deferred<void>>();
			active.add(done); confirmations.set(conversation, active);
			return done;
		}),
		() => work,
		(done) => Effect.sync(() => {
			const active = confirmations.get(conversation);
			active?.delete(done);
			if (active?.size === 0) confirmations.delete(conversation);
			Deferred.doneUnsafe(done, Effect.void);
		})
	);
	const declinePending = (id: string) => changed(sql(
		`UPDATE sys_message m SET state = NULL, content = content || jsonb_build_object('result', $2::jsonb, 'resumed', true)
		 WHERE conversation = $1 AND role = 'tool' AND state = 'confirm' AND meta->>'tag' = 'confirm'`,
		id, j({ declined: true, reason: 'A new turn started before approval.' })
	));
	/** Wait on active confirmations; an orphan is uncertain, never replayed or sent as a placeholder. */
	const modelRows = Effect.fn('Agents.modelRows')(function* (id: string, conv: Pick<ConversationRow, 'plan'>) {
		for (;;) {
			const rows = yield* transcript(id);
			const inFlight = (row: MessageRow) => (row.role === 'tool' && row.state === 'running') || (row.role === 'assistant' && row.state === 'streaming');
			if (rows.some(inFlight)) {
				yield* unfinished(id);
				if ((yield* transcript(id)).some(inFlight))
					return yield* BoltError.make('corrupt', 'admission', 'The previous step could not be settled.');
				continue;
			}
			if (rows.some((row) => row.role === 'tool' && (row.state === 'confirm' || row.state === 'approved') && row.meta?.tag !== 'confirm'))
				return yield* BoltError.make('corrupt', 'admission', 'An unsettled confirmation has no saved call.');
			if (rows.some((row) => row.role === 'tool' && row.state === 'confirm')) { yield* declinePending(id); continue; }
			if (!rows.some((row) => row.role === 'tool' && row.state === 'approved')) {
				const missing = projection(rows, conv).flatMap((row) => row.role === 'assistant' && row.content !== null && typeof row.content === 'object'
					? (row.content.toolCalls ?? []).filter((call) => !rows.some((tool) => tool.role === 'tool' && tool.content.assistant === row.id && tool.content.id === call.id)).map((call) => ({ row, call })) : []);
				if (missing.length === 0) return rows;
				for (const { row, call } of missing) yield* insert({ conversation: id, role: 'tool', content: { id: call.id, name: call.name, assistant: row.id, result: { error: FIXED.unreported } }, turn: row.turn });
				continue;
			}
			const active = [...(confirmations.get(id) ?? [])];
			if (active.length > 0) yield* Effect.forEach(active, Deferred.await, { concurrency: 'unbounded', discard: true });
			else yield* changed(sql(
				`UPDATE sys_message m SET state = NULL, content = content || jsonb_build_object('result', $2::jsonb)
				 WHERE conversation = $1 AND role = 'tool' AND state = 'approved' AND meta->>'tag' = 'confirm'`,
				id, j({ error: FIXED.unreported })
			));
		}
	});

	/** Steps waiting for their tab's answer to a page call, by conversation; `page_result` completes one. */
	const pageWaits = new Map<string, Deferred.Deferred<void>>();
	/** The transcript once the tab answered the page call it ends in, or after `PAGE_ANSWER_MS` without one. */
	const pageAnswer = Effect.fn('Agents.pageAnswer')(function* (id: string, conv: Pick<ConversationRow, 'plan'>) {
		const answered = yield* Deferred.make<void>();
		pageWaits.set(id, answered);
		return yield* Effect.gen(function* () {
			const rows = yield* modelRows(id, conv);
			if (!pageWaiting(rows)) return rows;
			yield* Deferred.await(answered).pipe(Effect.timeoutOption(PAGE_ANSWER_MS));
			return yield* modelRows(id, conv);
		}).pipe(
			Effect.ensuring(Effect.sync(() => {
				if (pageWaits.get(id) === answered) pageWaits.delete(id);
			}))
		);
	});
	/** The ingests this engine runs (`ToolContext.reading`) and its raw-schema validators: the engine's, never the process's. */
	const reading = new Set<string>();
	const validators: Validators = new WeakMap();

	const drainTurn = Effect.fn('Agents.drain')(function* (
		id: string,
		options: DrainOptions = {}
	): Effect.fn.Return<{ ran: boolean; reply: MessageRow | null }, EngineError, Scope.Scope> {
		const admitted = yield* claim(id);
		if (admitted === null) return { ran: false, reply: null };
		const turn = globalThis.crypto.randomUUID();
		const log = (event: Pick<LogEvent, 'at' | 'severity' | 'event' | 'attributes'>) =>
			logs.write({
				at: event.at, severity: event.severity, event: event.event,
				invocation: turn, run: null, conversation: id, turn, attributes: event.attributes
			});
		const declined = { declined: true, reason: 'A new turn started before approval.' };
		yield* declinePending(id);
		const onTurnStart = config.on_turn_start;
		const rejected =
			onTurnStart === undefined
				? []
				: yield* Port.attempt('agent.onTurnStart', () => onTurnStart(id)).pipe(
						Effect.mapError((error) => BoltError.make('internal', 'facility', error.message, error))
					);
		if (rejected.length > 0) {
			const ids = new Set(rejected);
			for (const row of yield* transcript(id)) {
				const approval = transcriptRow(row, true, false)?.tool?.approval;
				if (row.role !== 'tool' || approval === undefined || !ids.has(approval)) continue;
				yield* changed(
					sql(
						`UPDATE sys_message m SET content = content || jsonb_build_object('approval_result', $2::jsonb) WHERE id = $1`,
						row.id,
						j(declined)
					)
				);
			}
		}
		yield* Effect.gen(function* () {
			const now = (yield* config.bindings).now;
			yield* convChanged(
				sql(
					`UPDATE sys_conversation c SET lease_until = $2::timestamptz WHERE id = $1 AND status = 'running'`,
					id,
					leaseUntil(now, AGENT_LIMITS.leaseMs)
				)
			);
		}).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.ignore,
			Effect.repeat(Schedule.spaced(AGENT_LIMITS.heartbeatMs)),
			Effect.forkScoped
		);
		const mcp = yield* mcpSessions(m, config.mcp).pipe(Effect.provideService(Mcp, mcp_port));
		const current: TurnState = {
			model: '', steps: 0, failing: 0, red: 0, lowest: Number.POSITIVE_INFINITY,
			lastError: '', cutTools: 0,
			compactions: 0, compactFailed: false, lastInput: 0, cached: 0,
			as: null, mode: 'agent', force: options.force === true, question: null,
			cut: null, reply: null, heard: true, typingIn: null, streaming: null,
			inputs: [], usage: { input: 0, output: 0, calls: 0 },
			receipts: [...(options.receipts ?? [])], zooms: new Map(), files: [],
			failures: new Map(), replayed: new Set(),
			mcpTools: null, mcpFor: '', host_tools: [], hostFor: ''
		};
		// Jobs that finish after the turn closes queue their report and wake it.
		const work = yield* jobs({
			detached,
			late: (lines) => steer(id, current.as, lines),
			ended: (answer, behavior) => {
				if (behavior.progress_check !== true) return;
				// A red check counts only when it reaches no new low of failures.
				const failing = checkFailing(answer);
				if (failing === 0) {
					current.red = 0;
					current.lowest = Number.POSITIVE_INFINITY;
				} else if (failing !== undefined && failing < current.lowest) {
					current.lowest = failing;
					current.red = 0;
				} else current.red += 1;
			}
		});
		const add = (u: Partial<Usage> & { provider?: string }, calls: number) => {
			current.usage.input += u.input ?? 0;
			current.usage.output += u.output ?? 0;
			current.usage.calls += calls;
			if (typeof u.cost === 'number') current.usage.cost = (current.usage.cost ?? 0) + u.cost;
			if (typeof u.cached === 'number') current.usage.cached = (current.usage.cached ?? 0) + u.cached;
			if (typeof u.reasoning === 'number') current.usage.reasoning = (current.usage.reasoning ?? 0) + u.reasoning;
			if (u.provider !== undefined)
				current.usage.providers = [...new Set([...(current.usage.providers ?? []), u.provider])];
		};
		/**
		 * each provider call is one immutable `ai.call` observation: its call id (the metering key), model, tokens
		 * and charge, `settlement: 'pending'` for the meter; a call reported without a charge or id is `attention`, never a guessed cost.
		 */
		const used = Effect.fn('Agents.recordUsage')(function* (r: AiResponse, request: string) {
			add(r.usage, 1);
			const { cost, call } = r.usage,
				over = cost !== undefined && cost > AI_GAUGE_USD,
				incomplete = cost === undefined || call === undefined,
				// the prefix is append-only, so a cache read under half the last one is a rewrite to find (or a provider switch)
				cacheDrop = r.usage.cached !== undefined && r.usage.cached < current.cached / 2;
			current.cached = r.usage.cached ?? current.cached;
			yield* log({
				at: (yield* config.bindings).now,
				severity: incomplete || over || cacheDrop ? 'warn' : 'info',
				event: 'ai.call',
				attributes: {
					category: 'chat',
					request,
					call: call ?? null,
					...(r.usage.provider === undefined ? {} : { provider: r.usage.provider }),
					model: current.model,
					input: r.usage.input,
					output: r.usage.output,
					cached: r.usage.cached ?? null,
					reasoning: r.usage.reasoning ?? null,
					prompt: r.usage.prompt ?? null,
					cost: cost ?? null,
					settlement: incomplete ? 'attention' : 'pending',
					...(over ? { gauge: AI_GAUGE_USD } : {}),
					...(cacheDrop ? { cacheDrop: true } : {}),
					...memoryOf()
				}
			});
		});
		const observed = Effect.fn('Agents.model')(function* (
			operation: 'chat' | 'compact' | 'verify',
			rows: readonly MessageRow[],
			conv: Pick<ConversationRow, 'plan'>,
			work: (
				onRequest: (request: AiRequest) => Effect.Effect<void>
			) => Effect.Effect<AiResponse, FacilityFailure | Unavailable>,
			sender?: string
		) {
			const request_id = globalThis.crypto.randomUUID();
			const startedAt = yield* Clock.currentTimeMillis;
			const result = yield* work((request) =>
				log({
					at: new Date(startedAt).toISOString(),
					severity: 'info',
					event: 'ai.request',
					attributes: {
						request: request_id,
						phase: 'prepared',
						operation,
						manifest: manifestHash,
						evidence: requestEvidence(request),
						context: {
							through: rows.at(-1)?.seq ?? 0,
							projected: sequenceRanges(projection(rows, conv).map((row) => row.seq)),
							plan:
								conv.plan === null
									? null
									: {
											status: conv.plan.status,
											checkpoint: conv.plan.checkpoint,
											sha256: sha256_hex(JSON.stringify(conv.plan))
										},
							senderHash: sender === undefined ? null : sha256_hex(sender)
						}
					}
				})
			).pipe(
				Effect.onExit((exit) =>
					Effect.gen(function* () {
						yield* log({
							at: new Date(yield* Clock.currentTimeMillis).toISOString(),
							severity: 'info',
							event: 'ai.request.finished',
							attributes: {
								request: request_id,
								status: Exit.isSuccess(exit)
									? 'answered'
									: Cause.hasInterruptsOnly(exit.cause)
										? 'interrupted'
										: 'failed',
								finish: Exit.isSuccess(exit) ? exit.value.finish : null,
								milliseconds: (yield* Clock.currentTimeMillis) - startedAt,
								...memoryOf()
							}
						});
					})
				)
			);
			yield* used(result, request_id);
			return result;
		});
		const inApp = (conv: ConversationRow) => conv.envoy === null;
		const wall = config.wall_ms === undefined ? {} : { wallMs: config.wall_ms };
		// the linked chat shows the assistant typing from the step that answers new input until its reply is written (and
		// shipped by `onWrite`); a turn that ends while it still shows stops it
		const composing = yield* FiberHandle.make<void, never>();
		const typing = (on: boolean) =>
			current.typingIn === null || config.typing === undefined
				? Effect.void
				: config.typing(current.typingIn.integration, current.typingIn.thread, on);
		const startTyping = (conv: ConversationRow) =>
			Effect.gen(function* () {
				if (conv.integration === null || conv.thread === null || current.typingIn !== null) return;
				current.typingIn = { integration: conv.integration, thread: conv.thread };
				yield* FiberHandle.run(
					composing,
					typing(true).pipe(Effect.repeat(Schedule.spaced(TYPING_REFRESH_MS)), Effect.asVoid)
				);
			});
		const stopTyping = (paused: boolean) =>
			Effect.gen(function* () {
				if (current.typingIn === null) return;
				yield* FiberHandle.clear(composing);
				if (paused) yield* typing(false);
				current.typingIn = null;
			});
		const wrote = Effect.fn('Agents.wrote')(function* (row: MessageRow) {
			if (row.role === 'assistant' && (row.text ?? '') !== '') yield* stopTyping(false);
			if (options.onWrite !== undefined)
				yield* options.onWrite(row).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
			return row;
		});
		const write = Effect.fn('Agents.write')(function* (r: Parameters<typeof insert>[0]) {
			return yield* wrote(yield* insert({ ...r, turn }));
		});
		/** A system row of this turn: the step's closing notes, events, asides, checkpoints and verdicts. */
		const systemRow = (text: string, meta: Meta, extra: Pick<Parameters<typeof insert>[0], 'state' | 'mode' | 'as'> = {}) =>
			write({ conversation: id, role: 'system', content: { text }, text, meta, ...extra });
		const appendNote = (text: string) => systemRow(text, { tag: 'note' });
		/** Rewrites a row the step already wrote (its streamed reply, its running tool call) as finished, in one statement. */
		const rewrite = Effect.fn('Agents.rewrite')(function* (
			row: MessageRow,
			content: Json,
			text: string | null,
			meta: Meta | null,
			extra: { state?: 'confirm'; as?: As | null } = {}
		) {
			const chain = new Chain(),
				source = settleMessage(chain, row.id, {
					content: storable(row.role === 'tool' && isObj(content) ? { ...content, assistant: row.content.assistant } : content),
					text: text === null ? null : storable(text),
					meta: meta === null ? null : storable(meta),
					state: extra.state ?? null,
					...(extra.as === undefined ? {} : { as: extra.as })
				});
			const [updated] = yield* messageStatement(chain, source);
			if (updated === undefined)
				return yield* BoltError.make('corrupt', 'commit', 'the message settle returned no row');
			return updated;
		});
		/** An assistant row: the step's streamed row finished in place, else a new one. */
		const reply = (partial: MessageRow | null, content: Json, text: string, meta: Meta | null) =>
			partial !== null
				? Effect.flatMap(rewrite(partial, content, text, meta), wrote)
				: write({ conversation: id, role: 'assistant', content, text, meta });
		/**
		 * The step's reply as the model writes it: one `streaming` row (the cut row a continuation extends), rewritten with
		 * everything so far at most every STREAM_FLUSH_MS and never while the previous flush is still in flight.
		 */
		const streamer = Effect.fn('Agents.streamer')(function* (
			from: {
				row: MessageRow;
				text: string;
				reasoning: string;
			} | null
		) {
			let row = from?.row ?? null,
				text = from?.text ?? '',
				reasoning = from?.reasoning ?? '';
			// the text so far lives here; the queue only signals that it grew, so it holds one item however fast the model writes
			const queue = yield* Queue.sliding<void, Cause.Done>(1);
			const flush = yield* Stream.fromQueue(queue).pipe(
				Stream.groupedWithin(1024, STREAM_FLUSH_MS),
				Stream.runForEach(() =>
					Effect.gen(function* () {
						const content = { text, toolCalls: [], ...(reasoning === '' ? {} : { reasoning }) };
						if (row === null)
							row = yield* insert({
								conversation: id,
								role: 'assistant',
								content,
								text,
								state: 'streaming',
								turn
							});
						else {
							const chain = new Chain(),
								source = streamMessage(chain, row.id, text, content);
							row = (yield* messageStatement(chain, source))[0] ?? row;
						}
					}).pipe(
						// a flush only shows progress: one the database refuses is skipped, and the next writes everything so far
						Effect.catch((error) => Effect.logWarning('agent stream flush skipped', error))
					)
				),
				Effect.forkScoped
			);
			return {
				delta: (value: string) => {
					text += value;
					Queue.offerUnsafe(queue, undefined);
				},
				reasoning: (value: string) => {
					reasoning += value;
					Queue.offerUnsafe(queue, undefined);
				},
				end: () =>
					Effect.gen(function* () {
						yield* Queue.end(queue);
						yield* Fiber.join(flush);
						return row;
					})
			};
		});
		const fail = Effect.fn('Agents.fail')(function* (
			conv: ConversationRow,
			text: string,
			code: string,
			detail?: string
		) {
			current.reply = yield* reply(null, { text, toolCalls: [] }, text, {
				tag: 'failed',
				code,
				...(detail !== undefined && inApp(conv) ? { detail } : {}),
				...(current.usage.calls === 0 ? {} : { usage: { ...current.usage } })
			});
			// hook:wiring — a failed turn is a workspace log line naming the real reason; only an absent port is the missing provider
			const message =
				code === 'unavailable' && detail === NO_AI
					? 'AI provider not configured'
					: (detail ?? code);
			yield* log({
				at: (yield* config.bindings).now,
				severity: code === 'unavailable' ? 'warn' : 'error',
				event: 'agent.failed',
				attributes: { code, message }
			});
		});
		/**
		 * A checkpoint summary on the step's own prefix (its system and tools, the transcript, the instruction appended), so the
		 * provider's cache serves it; a transcript past the window is summarised from its newest part. An empty summary is
		 * asked for once more; answers whether the checkpoint was written, and a failed one is not tried again this turn.
		 */
		const compact = Effect.fn('Agents.compact')(function* (
			conv: ConversationRow,
			rows: readonly MessageRow[],
			keep: string[],
			origin: 'manual' | 'requested' | 'automatic',
			prefix: Pick<AiRequest, 'system' | 'tools'>,
			overflowed = false
		) {
			current.compactions++;
			current.lastInput = 0;
			const history = modelTranscript(rows, conv);
			return yield* Effect.gen(function* () {
				const response = yield* observed('compact', rows, conv, (onRequest) =>
					modelCall(
						config.ai,
						{
							model: conv.model,
							purpose: 'chat',
							...prefix,
							messages: [...(overflowed ? fit(history, 240_000) : history), { role: 'user', content: COMPACT_FORMAT }]
						},
						{ ...wall, onRequest }
					)
				);
				const summary = textOf(response.content);
				if (summary.trim() === '')
					return yield* Effect.fail(new Unusable({ message: 'the compaction response was empty' }));
				const waiting = rows
					.filter((row) => row.state === 'queued' || row.state === 'pending')
					.map((row) => row.id);
				yield* systemRow(summary, {
					tag: 'compact',
					cutoff: Math.max(0, ...rows.map((row) => row.seq)),
					keep: [...keep, ...waiting],
					origin
				});
				// the transcript after a checkpoint is a new prefix: its first step reads little from the cache
				current.cached = 0;
				return true;
			}).pipe(
				Effect.retry({ times: 1, while: (error) => error instanceof Unusable }),
				Effect.catchTags({
					Unusable: (error) => Effect.logWarning(error).pipe(Effect.as(false)),
					FacilityFailure: (error) => Effect.logWarning(error).pipe(Effect.as(false)),
					Unavailable: (error) => Effect.logWarning(error).pipe(Effect.as(false))
				}),
				Effect.tap((written) => Effect.sync(() => { if (!written) current.compactFailed = true; }))
			);
		});
		/**
		 * The plan's one verification: the step's own prefix and transcript, then the plan and the instruction, so the provider's
		 * cache serves all but the tail. `null` when no verdict could be read.
		 */
		const verify = Effect.fn('Agents.verify')(function* (
			conv: ConversationRow,
			plan: Plan,
			rows: readonly MessageRow[],
			prefix: Pick<AiRequest, 'system' | 'tools'>
		) {
			const request: AiRequest = {
				model: conv.model,
				purpose: 'chat',
				...prefix,
				messages: [
					...modelTranscript(rows, conv),
					{
						role: 'user',
						content: [
							'Verify the plan below against the work above as an independent reviewer: completion claims are not evidence. Mark complete only when every acceptance check has concrete evidence; otherwise list the gaps. Answer JSON only, with no tool call: {"complete": boolean, "gaps": string[], "summary": string}.',
							`Plan revision ${plan.revision}:\n${plan.body}`
						].join('\n\n')
					}
				],
				output: { kind: 'json' }
			};
			const schema = Schema.Struct({
				complete: Schema.Boolean,
				gaps: Schema.Array(Schema.String),
				summary: Schema.optionalKey(Schema.String)
			});
			return yield* observed('verify', rows, conv, (onRequest) => modelCall(config.ai, request, { ...wall, onRequest })).pipe(
				Effect.flatMap((response) =>
					response.finish === 'cut'
						? Effect.fail(new Unusable({ message: 'the verifier response was cut' }))
						: (typeof response.content === 'string'
								? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.content)
								: Schema.decodeUnknownEffect(schema)(response.content)
							).pipe(Effect.mapError((error) => new Unusable({ message: error.message })))
				),
				Effect.map((verdict) => ({
					complete: verdict.complete && verdict.gaps.length === 0,
					gaps: [...verdict.gaps],
					summary: verdict.summary ?? ''
				})),
				Effect.catchTags({
					Unusable: (error) => Effect.logWarning(error).pipe(Effect.as(null)),
					FacilityFailure: (error) => Effect.logWarning(error).pipe(Effect.as(null)),
					Unavailable: (error) => Effect.logWarning(error).pipe(Effect.as(null))
				})
			);
		});
		const executeCalls = Effect.fn('Agents.calls')(function* (
			conv: ConversationRow, sender: As, toolset: Effect.Success<ReturnType<typeof catalogue>>,
			tools: readonly { readonly name: string }[], row: MessageRow, calls: readonly ToolCall[], window: number
		) {
			let waiting = false,
				failed = 0;
			yield* run_calls(calls, Effect.fn('Agents.runCall')(function* (call, invalid) {
				// the call is a `running` row while it runs, finished in place when it answers
				const started = yield* Clock.currentTimeMillis,
					args = clip(call.input, 8000);
				const operation = toolset.presentation(call.name, call.input);
				const role = {
					behavior: operation.behavior,
					...(operation.studio === undefined ? {} : { studio: operation.studio }),
					...(operation.name === call.name ? {} : {
						display: { name: operation.name, args: clip(operation.input, 8000) }
					})
				};
				const step = yield* insert({
					conversation: id,
					role: 'tool',
					content: { id: call.id, name: call.name, assistant: row.id, args, ...role },
					state: 'running',
					turn
				});
				/** The running row finished in place with the call's answer. */
				const finish = Effect.fnUntraced(function* (result?: Json, meta: Meta | null = null, extra: { state?: 'confirm'; as?: As } = {}) {
					const ms = (yield* Clock.currentTimeMillis) - started;
					const content = { id: call.id, name: call.name, ...role, args, ...(result === undefined ? {} : { ms, result }) };
					yield* wrote(yield* rewrite(step, content, null, meta, extra));
				});
				const tool = tools.find((t) => t.name === call.name),
					key = callKey(call.name, call.input);
				// a call the dead generation made (its result never recorded) is not made again; nor one that already failed
				// this often
				const skipped = current.replayed.delete(stepKey(call.name, args))
					? NUDGE.replayed
					: (current.failures.get(key) ?? 0) >= AGENT_LIMITS.sameFailure
						? 'Not run: this exact call already failed several times this turn.'
						: undefined;
				const skip = tool === undefined || skipped !== undefined;
				const answer: ToolAnswer =
					tool === undefined
						? {
								result: {
									error: toolset.available.some((t) => t.name === call.name)
										? `'${call.name}' runs through run_tool: run_tool { name: '${call.name}', input }.`
										: `No tool '${call.name}'.`
								}
							}
						: invalid !== undefined
							? { result: invalid }
							: skipped !== undefined
								? { result: { error: skipped } }
								: yield* toolset.run(call.name, call.input, call.id);
				// what the call opened goes right after the call's result, on the next request
				for (const file of current.files) file.call ??= call.id;
				if ('confirm' in answer && conv.parent !== null)
					yield* finish({ error: "This needs the person's confirmation; hand it back to the delegating agent." });
				else if ('confirm' in answer) {
					waiting = true;
					yield* finish(undefined, { tag: 'confirm', call }, { state: 'confirm', as: sender });
				} else {
					const result = answer.result;
					if (failedResult(result)) {
						current.failures.set(key, (current.failures.get(key) ?? 0) + 1);
						failed++;
						if (!skip || current.lastError === '') current.lastError = String(result['error']); // staff see the real failure, not the cut-short
					} else current.failures.clear(); // a call that worked is progress: an earlier failure is worth one fresh try
					// the model sees a bounded result; a clipped one keeps the whole output for `read_output`
					const own = 'bounded' in answer && answer.bounded === true,
						whole = own && answer.full !== undefined ? answer.full : result,
						shown = own ? result : bounded(result).value;
					const stored = storedToolResult(call.id, shown, whole);
					yield* finish(stored.result, stored.full === undefined ? null : { tag: 'output', full: stored.full });
				}
				return Option.none();
			}));
			if (waiting) {
				current.reply = null;
				return yield* settle(id);
			}
			// Channels receive the same question in plain words; the shell retains its choices as controls.
			if (current.question !== null) {
				const question = current.question;
				const text = [question.question, ...question.options.map((option, index) => `${index + 1}. ${option}`)].join('\n\n');
				current.question = null;
				current.reply = yield* reply(null, { text, toolCalls: [] }, text, {
					tag: 'reply',
					receipts: [...current.receipts],
					asked: true,
					question,
					usage: { ...current.usage, context: current.lastInput, window, model: conv.model }
				});
				current.receipts.length = 0;
				return yield* settle(id);
			}
			const guard = turnGuard(current, calls.length, failed);
			if (guard !== undefined) {
				yield* fail(conv, guard.text, guard.code, current.lastError);
				yield* cancelQueued(id);
				return true;
			}
			return false;
		});
		const buildContext = Effect.fn('Agents.context')(function* (
			conv: ConversationRow, authority: Authority, sender: As,
			rows: readonly MessageRow[], mode: ToolContext['mode'], external: boolean
		) {
			if (current.mcpTools === null || current.mcpFor !== authority.key) {
				current.mcpTools = yield* mcp.tools(authority);
				current.mcpFor = authority.key;
			}
			const envoy = conv.envoy === null ? undefined : yield* envoySpec(db, conv.envoy);
			const staff = authority.actor.kind === 'member' && !authority.actor.external;
			const hostSide = inApp(conv) && staff;
			const host_tools = config.host_tools;
			// once a turn for an actor: a tool's own call reads the state it depends on
			if (current.hostFor !== authority.key) {
				current.host_tools =
					!hostSide || host_tools === undefined
						? []
						: typeof host_tools === 'function'
							? yield* Port.attempt('agent.host_tools', () => host_tools(authority, id))
							: host_tools;
				current.hostFor = authority.key;
			}
			const hostSkills = config.skills, search = config.search, draft = config.draft;
			const authoring =
				hostSide && draft !== undefined ? yield* Port.attempt('agent.draft', () => draft(authority)) : undefined;
			const audience: Audience = !inApp(conv) ? 'channel' : staff ? 'staff' : 'member';
			// the platform's skills by who can use them: authoring ones to authors, research to in-app staff
			const skills: ToolContext['skills'] = {
				...Object.fromEntries(
					Object.entries(workspaceSkills).filter(
						([name]) =>
							name in m.agent.skills ||
							(AUTHORING_SKILLS.has(name) ? authoring !== undefined : name !== 'research' || audience === 'staff')
					)
				),
				...(hostSide && hostSkills !== undefined
					? Object.fromEntries(
							Object.entries(
								yield* Port.attempt('agent.skills', () => hostSkills(authority))
							).map(([name, skill]) => [
								name,
								{
									...skill,
									read: (path: string) => Port.attempt('agent.skills', () => skill.read(path))
								}
							])
						)
					: {})
			};
			const who = rows.findLast((r) => r.as !== null && r.role === 'user');
			const said = who === undefined || who.role === 'tool' ? null : who.content,
				tz = typeof said === 'object' ? said?.tz : undefined;
			const b = yield* config.bindings,
				ingester = e.convert?.ingest;
			const ctx: ToolContext = {
				engine: e,
				conv,
				authority,
				bindings: b,
				turn,
				mode,
				inApp: inApp(conv),
				tz,
				question: who?.text ?? undefined,
				child: conv.parent !== null,
				delegation:
					conv.parent === null && (conv.envoy === null ? staff : envoy?.delegation === 'enabled'),
				mcp,
				logs,
				mcpTools: current.mcpTools,
				host_tools: current.host_tools,
				browser_tools: config.browser_tools ?? [],
				attachments: config.attachments,
				...(ingester === undefined
					? {}
					: {
							ingest: (
								file: { sha256: string; name: string; mime: string; key: string; size: number },
								read: { readonly page?: number; readonly password?: string } = {}
							) =>
								ingester(
									{ sha256: file.sha256, name: file.name, mime: file.mime, key: file.key },
									{
										...(read.page !== undefined
											? { page: read.page }
											: file.size > TEXT_FIRST_BYTES
												? { pictures: false }
												: {}),
										...(read.password === undefined ? {} : { password: read.password })
									}
								).pipe(Port.call('ingest', JOBS.ingestMs))
						}),
				// every inward agent reads the source (models, policies) for exact shapes; a public envoy's or external member's turn does not
				workspace: external ? undefined : config.workspace,
				...(hostSide && search !== undefined
					? { search: (request: SearchRequest) => search(authority, request) }
					: {}),
				draft: authoring,
				geocoder: config.geocoder,
				skills,
				agents: ['workspace', ...(yield* activeEnvoys(db)).map(({ id }) => id)],
				receipts: current.receipts,
				audience,
				zooms: current.zooms,
				reading,
				validators,
				files: current.files,
				jobs: work,
				inlineMs: config.host_inline_ms,
				setPlan: (body) =>
					setConv(id, 'plan = $2::jsonb', j({
						revision: (conv.plan?.revision ?? 0) + 1, body, status: 'draft', checkpoint: 0, verdicts: 0
					} satisfies Plan)).pipe(Effect.asVoid),
				ask: (text) => {
					if (current.question !== null) return false;
					current.question = text;
					return true;
				},
				messages: Effect.fn('Agents.messages')(function* (o: { limit: number; before?: number }) {
					const [result] = yield* db.read([
						sql(
							`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 AND deleted_at IS NULL AND refused IS NULL AND coalesce(role, 'user') IN ('user', 'assistant') AND coalesce(state, '') <> 'scheduled' AND ($2::bigint IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
							id,
							o.before ?? null,
							o.limit
						)
					]);
					return yield* rowsOf(result?.rows ?? []);
				}),
				output: Effect.fn('Agents.toolOutput')(function* (call) {
					const [result] = yield* db.read([
						sql(
							`SELECT meta->'full' AS full FROM sys_message WHERE conversation = $1 AND role = 'tool'
					AND ($2::text IS NULL OR content->>'id' = $2) AND meta->>'tag' IN ('output', 'confirm') AND meta ? 'full' ORDER BY seq DESC LIMIT 1`,
							id,
							call
						)
					]);
					return result?.rows[0]?.['full'] ?? undefined;
				}),
				history: Effect.fn('Agents.history')(function* (text, scope, limit) {
					const a = authority.actor,
						member =
							a.kind === 'member' ? a.id : a.kind === 'envoy' ? (a.linked?.id ?? null) : null; // a group turn searches no one's own
					// `dm: 'envoy'`: the member's own is their conversations on this instance alone, never their app or another envoy's
					const bound =
						a.kind === 'envoy' && (yield* envoySpec(db, a.envoy))?.dm === 'envoy'
							? a.instance
							: null;
					const [r] = yield* db.read([
						sql(
							`SELECT m.conversation, m.seq, m.role, coalesce(m.author, m.sender_name, m.sender) AS author, left(m.text, 500) AS text, m.created_at::text AS at
						FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
						WHERE strpos(lower(m.text), lower($1)) > 0 AND m.role IN ('user', 'assistant') AND m.deleted_at IS NULL
							AND (m.conversation = $2 OR ($3::text IS NOT NULL AND CASE WHEN $5::text IS NULL THEN c.owner = $3 OR m."as"->>'member' = $3
								ELSE c.integration = $5 AND EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id AND p."as"->'envoy'->>'member' = $3) END))
						ORDER BY m.seq DESC LIMIT $4`,
							text,
							id,
							scope === 'mine' ? member : null,
							limit,
							bound
						)
					]);
					return { hits: r?.rows ?? [] };
				}),
				heard: queue.heard(id),
				subagent: {
					// a sub-agent runs detached: this turn goes on (or ends), and its report arrives as a message here
					spawn: Effect.fn('Agents.spawnChild')(function* (task, agent, done, format) {
						// each child is a full agent loop in this host: cap the fan-out, not only the token spend
						if ((yield* runningChildren(id)) >= AGENT_LIMITS.subagents)
							return {
								error: `At most ${AGENT_LIMITS.subagents} sub-agents work at once; wait for one or stop one first.`
							};
						const brief = [
							task,
							...(done === undefined ? [] : [`Done when: ${done}`]),
							...(format === undefined ? [] : [`Return: ${format}`])
						].join('\n\n');
						const child = yield* start({
							parent: id,
							owner: conv.owner,
							envoy: agent === null ? conv.envoy : agent === 'workspace' ? null : agent,
							model: conv.model,
							title: task.slice(0, 80)
						}); // no instance: nothing it says is sent
						yield* post({ conversation: child, as: sender, text: brief, author: 'delegating agent' });
						yield* FiberSet.run(detached, drain(child).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore));
						return {
							conversation: child,
							note: 'It works in the background. Its report arrives as a message in this conversation when it finishes or asks you something: carry on, or end your reply, and you are prompted again then.'
						};
					}),
					// what it did so far: its status, its last messages, the tool calls it made, what it changed
					read: Effect.fn('Agents.readChild')(function* (child) {
						if (!(yield* ownChild(id, child))) return { error: 'Not one of your sub-agents.' };
						const kid = yield* conversation(child);
						const rows = (yield* transcript(child)).flatMap((r) => {
							const row = transcriptRow(r, true, false);
							return row === null ? [] : [row];
						});
						const brief = (v: string) => (v.length <= 200 ? v : `${v.slice(0, 199)}…`);
						return {
							status: kid.status,
							messages: rows
								.filter((r) => (r.role === 'user' || r.role === 'assistant') && !!r.text)
								.slice(-10)
								.map((r) => ({ role: r.role, text: r.text, ...(r.asked ? { asked: true } : {}) })),
							steps: rows
								.flatMap(({ tool }) => tool === undefined ? [] : [{
									tool: tool.name,
									...(tool.running ? { running: true } : {}),
									...(tool.failed ? { failed: true } : {}),
									...(tool.args === undefined ? {} : { input: brief(tool.args) }),
									...(tool.result === undefined ? {} : { result: brief(tool.result) })
								}])
								.slice(-30),
							changes: rows.flatMap((r) => r.receipts ?? []),
							files: rows.flatMap((r) => (r.role === 'tool' ? (r.files ?? []) : []))
						};
					}),
					message: Effect.fn('Agents.messageChild')(function* (child, text) {
						if (!(yield* ownChild(id, child))) return { error: 'Not one of your sub-agents.' };
						yield* post({ conversation: child, as: sender, text, author: 'delegating agent' });
						yield* FiberSet.run(detached, kick(child));
						return { sent: true, note: 'It carries on; its next report arrives as a message here.' };
					}),
					stop: Effect.fn('Agents.stopChild')(function* (child) {
						return (yield* ownChild(id, child))
							? (yield* api.stop(child), { stopped: true })
							: { error: 'Not one of your sub-agents.' };
					}),
					running: () => runningChildren(id),
					// a report waiting in this conversation (it is claimed at the next step), or none at the bound
					report: (ms: number) =>
						Effect.scoped(
							Effect.gen(function* () {
								const subscription = yield* PubSub.subscribe(reports);
								const [pending] = yield* db.read([
									sql(
										`SELECT 1 FROM sys_message WHERE conversation = $1 AND state = 'queued' AND meta->>'tag' = 'report' LIMIT 1`,
										id
									)
								]);
								if ((pending?.rows.length ?? 0) > 0) return true;
								return Option.isSome(
									yield* PubSub.take(subscription).pipe(
										Effect.repeat({ until: (parent) => parent === id }),
										Effect.timeoutOption(ms)
									)
								);
							})
						)
				}
			};
			return { ctx, envoy };
		});
		const advance = Effect.fn('Agents.step')(function* () {
			// a planned close: the turn holds here, between steps, until its generation closes; its interruption hands it to
			// the next generation (`release`). ponytail: a parent in `wait` on a held sub-agent only ends at the host's cap
			stepping.leave(id);
			if (stepping.parked) yield* Effect.never;
			stepping.enter(id);
			// the CPU budget is a step's, not a turn's: a long turn is many small steps
			yield* (yield* RunUnits).next();
			// an administrator's runtime settings narrow the model and cap the month's spend (settings.ts)
			const settings = yield* agentSettings(db);
			const stored = yield* conversation(id);
			const conv = { ...stored, model: allowedModel(settings, stored.model) };
			current.model = conv.model;
			if (conv.status === 'stopped') return true;
			// hook:triage — `delivered_turn` marks each row new input at most once
			// one sender's inputs per step, oldest first; a later sender's steer is claimed at the next step under its own authority
			const claimChain = new Chain();
			const claimed = [
				...(yield* messageStatement(claimChain, claimMessage(claimChain, id, turn)))
			];
			claimed.sort((a, b) => a.seq - b.seq);
			const last = claimed.at(-1);
			if (last !== undefined) {
				current.heard = true;
				current.as = claimed.findLast((r) => r.as !== null)?.as ?? current.as;
				current.mode = last.mode ?? 'agent';
				current.inputs = claimed.map((r) => r.id);
				// a draft plan locks the conversation; only `execute_plan` starts execution
				if (current.mode === 'agent' && conv.plan?.status === 'draft' && conv.parent === null)
					current.mode = 'plan';
			} else if (current.steps === 0 && !current.force) {
				return yield* settle(id);
			}
			current.force = false;
			// plan 12: each job that finished since the last step says so once, at the end of the context (the cached
			// prefix is unchanged)
			for (const line of work.take()) yield* appendNote(line);
			// workspace events since the conversation last heard one (or began): each once, never a turn of their own
			if (inApp(conv))
				for (const event of yield* unheard(id)) {
					yield* systemRow(
						`Workspace event (${event.at}): ${event.title}${event.body === undefined ? '' : `\n${event.body}`}`,
						{ tag: 'event', at: event.at }
					);
				}
			if (current.as === null) {
				const prior = (yield* transcript(id)).findLast((r) => r.as !== null);
				current.as = prior?.as ?? null;
			}
			const sender = current.as;
			const authority = sender === null ? null : yield* resolve(sender);
			const external = authority !== null && (yield* outward(conv, authority));
			const brief =
				authority === null ? undefined : external ? m.agent.external : m.agent.internal;
			if (sender === null || authority === null || (inApp(conv) && brief === undefined)) {
				yield* fail(
					conv,
					authority === null ? FIXED.stale : FIXED.unavailable,
					authority === null ? 'noAuthority' : 'noAgent'
				);
				return yield* settle(id);
			}
			// the tab answers a page step in a moment: what it then shows closes this step's context
			const seen = yield* modelRows(id, conv);
			let rows = pageWaiting(seen) ? yield* pageAnswer(id, conv) : seen;
			for (const aside of senderAsides(rows, conv, 'envoy' in sender ? sender.envoy.sender : undefined))
				rows = [...rows, yield* systemRow(aside.text, { tag: 'aside', message: aside.message })];
			if ((yield* overLimit(db, settings, conv.owner, authority.policies)) !== null) {
				yield* fail(conv, FIXED.limit, 'spendLimit');
				yield* cancelQueued(id);
				return true;
			}
			if (current.steps >= AGENT_LIMITS.steps) {
				yield* fail(conv, FIXED.steps, 'stepCap');
				yield* cancelQueued(id);
				return true;
			}
			// `/compact` checkpoints under the agent's own prefix
			const { ctx, envoy } = yield* buildContext(
				conv,
				authority,
				sender,
				rows,
				current.mode === 'plan' ? 'plan' : 'agent',
				external
			);
			const toolset = yield* catalogue(ctx);
			// the catalogue as of the conversation's start (or its last checkpoint) holds its native MCP tools; a merge since
			// is one appended note of what changed, written when the conversation next runs
			const notes = projection(rows, conv).flatMap((row) =>
				row.role === 'system' && row.meta?.tag === 'note' && row.meta.catalogue !== undefined ? [row.meta.catalogue] : []
			);
			const base = notes[0],
				native = base?.native ?? toolset.mcp;
			const catalogueText = catalogueNote(toolset.index, notes.at(-1)?.index);
			if (catalogueText !== undefined)
				rows = [
					...rows,
					yield* systemRow(catalogueText, {
						tag: 'note',
						catalogue: {
							index: toolset.index,
							...(base === undefined ? { native: toolset.mcp.map(({ name, description, input }) => ({ name, description, input })) } : {})
						}
					})
				];
			// one list for the conversation: its audience's tools, the host's, and the MCP tools it began with
			const offered = [...toolset.fixed, ...toolset.host, ...native];
			const prefix: Pick<AiRequest, 'system' | 'tools'> = {
				system: system({
					envoy: envoy === undefined ? undefined : envoyName(envoy.name),
					brief,
					task: envoy?.task,
					authors: ctx.draft !== undefined,
					authority
				}),
				tools: offered.map(({ name, description, input }) => ({ name, description, input }))
			};
			if (current.mode === 'compact') {
				// `/compact`: a checkpoint now, then the turn ends
				if (current.compactions < AGENT_LIMITS.compactions) yield* compact(conv, rows, [], 'manual', prefix);
				return yield* settle(id);
			}
			const configuredWindow = config.windows?.[conv.model];
			const catalog =
				configuredWindow !== undefined || config.ai === undefined
					? undefined
					: yield* config.ai.catalog.pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.catch(() => Effect.succeed(undefined))
						);
			// a conversation on a class (`default`) runs the catalogue's default model: its window is that model's
			const concrete = catalog?.models.some((x) => x.id === conv.model)
				? conv.model
				: catalog?.default;
			// the model's own window, never a smaller host budget: compaction starts at 80% of what the model provides
			const window =
				configuredWindow ??
				catalog?.models.find((x) => x.id === concrete)?.context ??
				AGENT_LIMITS.window;
			if (
				current.lastInput > AGENT_LIMITS.compactAt * window &&
				current.compactions < AGENT_LIMITS.compactions &&
				!current.compactFailed &&
				current.cut === null
			) {
				yield* compact(conv, rows, current.inputs, 'automatic', prefix);
				return false;
			}
			const note = state(
				conv,
				current.mode === 'plan' ? 'plan' : 'agent',
				[turnFacts(e, authority, ctx.bindings, ctx.tz), pageNote(rows)]
					.filter((p): p is string => p !== undefined)
					.join('\n')
			);
			// the note closes the context, before a reply cut at the wall that this step continues
			const history = modelTranscript(rows, conv);
			if (note !== undefined) {
				const tail = projection(rows, conv).at(-1);
				const segments = tail?.role === 'assistant' && tail.content !== null && typeof tail.content === 'object' ? tail.content.segments?.length ?? 1 : 1;
				history.splice(history.at(-1)?.role === 'assistant' ? history.length - segments : history.length, 0, {
					role: 'user',
					content: note
				});
			}
			const request: AiRequest = {
				model: conv.model,
				purpose: 'chat',
				...prefix,
				messages: history,
				...(current.files.length === 0
					? {}
					: {
							files: current.files.map(({ mime, bytes, call }) => ({
								mime,
								bytes,
								...(call === undefined ? {} : { call })
							}))
						}),
				...(current.cut?.continuation === undefined ? {} : { continuation: current.cut.continuation })
			};
			// shown on this request alone: what a request carries at its end, no later prefix holds
			current.files.length = 0;
			current.steps++;
			// the chat shows the assistant is on it while the model writes: a pending reply is silence the sender would read as being ignored
			if (current.heard) {
				current.heard = false;
				yield* startTyping(conv);
			}
			const live = yield* streamer(current.cut);
			current.streaming = live;
			const served = 'envoy' in sender ? sender.envoy.sender : undefined;
			const stepped = yield* model_step(observed(
				'chat',
				rows,
				conv,
				(onRequest) =>
					modelCall(config.ai, request, {
						onDelta: live.delta,
						onReasoning: live.reasoning,
						...wall,
						onRequest
					}),
				served
			), current.cut ?? undefined).pipe(Effect.catch((error) => Effect.succeed(error)));
			const partial: MessageRow | null = yield* live.end();
			current.streaming = null;
			if (isFacilityError(stepped)) {
				const r = stepped;
				// a failed step leaves no half reply: a continuation's row goes back to its cut, a fresh one goes
				if (partial !== null)
					yield* current.cut === null
						? discard(partial)
						: rewrite(partial, current.cut.row.content, current.cut.row.text, current.cut.row.meta);
				// past the window: a checkpoint from the newest part, and the turn fails at once when none can be written
				if (overflow(r) && current.compactions < AGENT_LIMITS.compactions && !current.compactFailed &&
					(yield* compact(conv, rows, current.inputs, 'automatic', prefix, true)))
					return false;
				if (/still writing a tool call/.test(r.message) && !current.cutTools++) {
					// once per turn: ask for smaller calls
					yield* appendNote(NUDGE.cutTool);
					return false;
				}
				// a provider's context refusal is not a service outage: name the one action that fixes it
				const contextOverflow = overflow(r);
				yield* fail(
					conv,
					contextOverflow ? FIXED.overflow : FIXED.failed,
					contextOverflow ? 'overflow' : r instanceof Unavailable ? 'unavailable' : r.kind,
					r instanceof Unavailable ? r.reason : r.message
				);
				return yield* settle(id);
			}
			const { response: r, text, reasoning, calls } = stepped;
			// a model step is progress: compaction may run again as often as a long turn needs
			current.compactions = 0;
			current.lastInput = r.usage.input;
			// a reply while background work runs is interim: the turn collects the work and goes on (today's child report-back)
			const collecting =
				r.finish !== 'cut' && calls.length === 0 && (work.running() > 0 || work.ready() > 0);
			const done = r.finish !== 'cut' && calls.length === 0 && !collecting;
			// a turn never settles on silence: an empty reply is answered visibly
			if (done && text.trim() === '' && current.cut === null) {
				// a reasoning-only reply is kept (the panel shows it)
				if (reasoning !== '') yield* reply(partial, { text: '', toolCalls: [], reasoning }, '', null);
				else if (partial !== null) yield* discard(partial);
				yield* fail(conv, FIXED.empty, 'emptyReply');
				return yield* settle(id);
			}
			// The reply is the model's own words: a receipt's record ids live in the row's `meta`, where the transcript
			// shows them as tool cards, and never in the text — an envoy turn is read on a phone by a person the
			// envoy prompt has told it not to hand ids to.
			const content = {
				text,
				toolCalls: calls,
				...(r.finish === 'cut' || current.cut !== null ? { segments: stepped.carry.segments } : {}),
				...(reasoning === '' ? {} : { reasoning })
			};
			const meta: Meta | null =
				r.finish === 'cut'
					? {
							tag: 'cut',
							...(r.continuation === undefined ? {} : { continuation: r.continuation })
						}
					: done
						? {
								tag: 'reply',
								receipts: [...current.receipts],
								usage: { ...current.usage, context: current.lastInput, window, model: conv.model }
							}
						: null;
			const row = yield* reply(partial, content, content.text, meta);
			if (r.finish === 'cut') {
				current.cut = { row, ...stepped.carry };
				return false;
			}
			current.cut = null;
			if (collecting) {
				// the finished jobs' messages open the next step
				if (!(yield* work.settled(JOBS.waitMs)))
					yield* appendNote('Background work did not finish in time.');
				return false;
			}
			if (done) {
				current.reply = row;
				current.receipts.length = 0;
				// an executed plan is verified once, on this step's prefix: an incomplete verdict sends it back to work once
				if (current.mode === 'agent' && conv.plan?.status === 'active' && conv.plan.verdicts === 0) {
					const proof = yield* transcript(id);
					const verdict = yield* verify(conv, conv.plan, proof, prefix);
					const gaps = verdict === null ? ['The verifier could not reach a verdict.'] : verdict.gaps;
					const note = [
						`Plan verification: ${verdict?.complete === true ? 'complete' : 'incomplete'}.`,
						verdict?.summary ?? '',
						...gaps.map((g) => `- ${g}`)
					]
						.filter((s) => s !== '')
						.join('\n');
					const status: Plan['status'] = verdict?.complete === true ? 'verified' : 'active';
					yield* setConv(id, 'plan = $2::jsonb', j({ ...conv.plan, status, verdicts: 1 }));
					yield* systemRow(
						note,
						{ tag: 'verdict', complete: verdict?.complete === true, gaps },
						verdict !== null && !verdict.complete ? { state: 'queued', mode: 'agent', as: sender } : {}
					);
				}
				return yield* settle(id);
			}
			return yield* executeCalls(conv, sender, toolset, offered, row, calls, window);
		});
		yield* Effect.gen(function* () {
			// a turn taken over mid-work (its generation closed, its process died) goes on from its transcript and
			// answers; its input was already consumed, so only a turn that had replied or was waiting on a card settles
			if (admitted === 'takeover') {
				for (const row of yield* unfinished(id))
					if (row.role === 'tool') current.replayed.add(stepKey(row.content.name, row.content.args));
				const rows = yield* transcript(id),
					last = rows.at(-1);
				current.force ||=
					last?.meta?.tag !== 'reply' && last?.meta?.tag !== 'failed' && last?.state !== 'confirm';
				// cut mid-work, the transcript ends in the model's own rows: name the open request, or the resumed step
				// reads it as finished work to summarise
				const request = rows.findLast((r) => r.role === 'user' && r.state === 'consumed');
				if (current.force && (last?.role === 'assistant' || last?.role === 'tool') && request !== undefined)
					yield* appendNote(NUDGE.resumed(request.text ?? ''));
			}
			for (;;) {
				if (yield* advance()) break;
			}
		}).pipe(
			// a turn that breaks (a failure or a defect, never an interruption: a durable turn hands that turn on) answers its sender
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.gen(function* () {
							yield* Effect.logWarning(cause);
							const conv = yield* maybeConversation(id);
							const err = Cause.squash(cause);
							if (conv !== null)
								yield* fail(
									conv,
									FIXED.broke,
									'internal',
									err instanceof Error ? err.message : String(err)
								);
						})
			),
			Effect.onExit((exit) =>
				Effect.gen(function* () {
					stepping.leave(id);
					// no reply followed the typing it showed: the chat stops showing it
					yield* stopTyping(true);
					// Only an explicitly stopped turn can finish incomplete rows after an unhandled failure.
					// A leased turn retains its queued takeover and uncertain calls for the next owner.
					if (Exit.isFailure(exit) && (yield* maybeConversation(id))?.status !== 'stopped') return;
					// a reply or a call the turn left unfinished (a stop, a crash) is finished as interrupted before the turn reads idle
					if (current.streaming !== null) yield* current.streaming.end();
					yield* unfinished(id, turn);
					if (Exit.isFailure(exit)) return;
					yield* idle(id, false);
				}).pipe(Effect.tapCause(Effect.logWarning))
			)
		);
		return { ran: true, reply: current.reply };
	});
	const drain: (
		id: string,
		options?: Parameters<typeof drainTurn>[1]
	) => Effect.Effect<{ ran: boolean; reply: MessageRow | null }, EngineError> = Effect.fn(
		'Agents.drainManaged'
	)(function* (id: string, options: Parameters<typeof drainTurn>[1] = {}) {
		const existing = yield* FiberMap.get(running, id);
		if (Option.isSome(existing)) {
			yield* queue.ring(id);
			return { ran: false, reply: null };
		}
		const fiber = yield* FiberMap.run(
			running,
			id,
			Effect.scoped(drainTurn(id, options)).pipe(Effect.onInterrupt(() => release(id))),
			{
				onlyIfMissing: true
			}
		);
		// a stopped sub-agent's turn is interrupted (stop removes it from `running`), yet its parent is still told
		const exit = yield* Fiber.await(fiber);
		if (Exit.isFailure(exit) || exit.value.ran)
			yield* reportUp(id, Exit.isSuccess(exit) ? exit.value.reply : null).pipe(
				Effect.tapCause(Effect.logWarning),
				Effect.ignore
			);
		return yield* exit;
	});
	/** Runs a conversation once its running turn (if any) ends, so an input that landed as it finished is not left queued. */
	const kick = (id: string): Effect.Effect<void> =>
		Effect.gen(function* () {
			const existing = yield* FiberMap.get(running, id);
			if (Option.isSome(existing)) {
				yield* queue.ring(id);
				yield* Fiber.await(existing.value);
			}
			// the turn took it: a drain now would only flash the conversation as running
			if (yield* queue.waiting(id)) yield* drain(id);
		}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
	/**
	 * A generation's start resumes, once, each approved call a switch-over restarted (its card settled by the old generation,
	 * no reply after it): the new generation runs the turn that reports it. One statement at start, none while idle.
	 */
	const resumeSettled = Effect.gen(function* () {
		const rows = yield* changed(
			sql(
				`UPDATE sys_message m SET content = content || '{"resumed":true}'::jsonb
				WHERE m.role = 'tool' AND m.state IS NULL AND m.meta->>'tag' = 'confirm' AND NOT m.content ? 'resumed'
				AND m.content->'result'->>'error' = $1
				AND NOT EXISTS (SELECT 1 FROM sys_message a WHERE a.conversation = m.conversation AND a.seq > m.seq AND a.role = 'assistant')`,
				FIXED.unreported
			)
		);
		for (const id of new Set(rows.map((r) => r.conversation)))
			yield* FiberSet.run(
				detached,
				drain(id, { force: true }).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
			);
	}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
	/**
	 * A sub-agent's turn ended (its answer, a question for its parent, a failure or a stop): its report lands in the parent
	 * conversation as a queued input from the same sender, which a running parent turn claims at its next step and an idle
	 * parent runs a turn on. The sub-agent runs detached, so the parent can answer the person and finish meanwhile.
	 */
	const reportUp = Effect.fn('Agents.reportUp')(function* (
		child: string,
		reply: MessageRow | null
	) {
		const conv = yield* conversation(child);
		if (conv.parent === null || conv.status === 'running') return;
		const task = (yield* transcript(child)).find((r) => r.role === 'user');
		const asked = reply?.meta?.tag === 'reply' && reply.meta.asked === true;
		const how = asked
			? 'asks you'
			: conv.status === 'stopped'
				? 'was stopped'
				: reply?.meta?.tag === 'failed'
					? 'failed'
					: 'finished';
		const text =
			`Sub-agent "${conv.title ?? 'sub-agent'}" (conversation ${child}) ${how}: ${reply?.text ?? '(no reply)'}` +
			(asked ? '\nAnswer it with subagent_message.' : '');
		yield* insert({
			conversation: conv.parent,
			role: 'user',
			content: { text },
			text,
			state: 'queued',
			mode: 'agent',
			as: task?.as ?? null,
			author: 'sub-agent',
			meta: { tag: 'report', conversation: child, ...(asked ? { asked: true as const } : {}) }
		});
		yield* PubSub.publish(reports, conv.parent);
		yield* FiberSet.run(detached, kick(conv.parent));
	});
	const ownChild = Effect.fn('Agents.ownChild')(function* (parent: string, child: string) {
		return (yield* maybeConversation(child))?.parent === parent;
	});
	const attachments = (member: string, refs: readonly Json[]) => attachmentsFor(db, member, refs);
	const api = {
		start,
		post,
		kick,
		queue,
		ambient,
		notify: (o: { conversation: string; text: string; as?: As | null | undefined }) =>
			steer(o.conversation, o.as ?? null, [o.text]),
		gaveUp: (conversations: readonly string[]) =>
			Effect.forEach(
				conversations,
				(conversation) =>
					insert({
						conversation,
						role: 'assistant',
						content: { text: FIXED.broke, toolCalls: [] },
						text: FIXED.broke,
						meta: { tag: 'failed', code: 'gaveUp' }
					}),
				{ discard: true }
			),
		park: stepping.park,
		drain,
		conversation,
		transcript,
		attachments,
		stop: Effect.fn('Agents.stop')(function* (id: string) {
			yield* setConv(id, `status = 'stopped', lease_until = NULL`);
			yield* cancelQueued(id);
			yield* FiberMap.remove(running, id);
		}),
		resume: Effect.fn('Agents.resume')(function* (id: string) {
			yield* conversation(id);
			// A follow-up may already have restarted it while the client still showed Resume.
			const reopened = yield* convChanged(
				sql(
					`UPDATE sys_conversation AS c SET status = 'idle', revision = revision + 1, updated_at = now()
					 WHERE id = $1 AND status = 'stopped'`,
					id
				)
			);
			if (reopened.length > 0) {
				const rows = yield* transcript(id),
					lastReply =
						rows.findLast((r) => r.role === 'assistant' && r.meta?.tag === 'reply')?.seq ?? 0;
				const objective = rows.findLast((r) => r.role === 'user' && r.state === 'consumed');
				const cancelled = rows.filter(
					(r) => r.role === 'user' && r.state === 'cancelled' && r.seq > lastReply
				);
				const as = rows.findLast((r) => r.as !== null)?.as ?? null;
				const text = [
					'The person resumed this conversation after stopping it; continue the stopped work if it is still wanted.',
					objective?.text == null ? '' : `Stopped request: ${objective.text}`,
					...cancelled.map((r) => `Not yet handled: ${r.text ?? ''}`)
				]
					.filter((x) => x !== '')
					.join('\n');
				if (as !== null) yield* queuedNote(id, as, text);
			}
			return yield* drain(id);
		}),
		set_model: Effect.fn('Agents.set_model')(function* (id: string, model: string) {
			if (
				config.ai !== undefined &&
				!(yield* servesModel(config.ai, model).pipe(
					Effect.mapError((error) => BoltError.make(error.kind, 'facility', error.message, error))
				))
			)
				return yield* new AgentRefusal({ message: `the host runs no model '${model}'` });
			yield* setConv(id, 'model = $2', model);
		}),
		revise: queue.revise,
		restart: queue.restart,
		dequeue: queue.remove,
		reorder: queue.reorder,
		turnRun: Effect.fn('Agents.turnRun')(function* (
			input: Json,
			run: (conversation: string, envoy: boolean) => Effect.Effect<{ ran: boolean }, EngineError>
		) {
			const { conversation: id } = yield* Schema.decodeUnknownEffect(TurnInput, { onExcessProperty: 'error' })(input).pipe(
				Effect.mapError((error) => BoltError.make('invalid_input', 'decode', 'An agent turn needs a conversation id.', error))
			);
			const conv = yield* maybeConversation(id);
			if (conv === null) return { conversation: id, gone: true };
			if ((yield* run(id, conv.envoy !== null && conv.integration !== null)).ran)
				return { conversation: id, ran: true };
			const [lease] = yield* db.read([
				sql(
					`SELECT (extract(epoch FROM lease_until) * 1000)::float8 AS until FROM sys_conversation WHERE id = $1 AND status = 'running'`,
					id
				)
			]);
			const live = lease?.rows[0];
			if (live === undefined) return { conversation: id, ran: false };
			const due = new Date(
				Math.max(Number(live['until']), Date.parse((yield* config.bindings).now)) + 1000
			).toISOString();
			const chain = new Chain();
			enqueueTurn(chain, id, due);
			const queued = yield* nativeCommit(db.write, e.live.publish, chain,
				Schema.Struct({ ...CapturedResult.fields, due: Schema.NullOr(Schema.String) }),
				`${next_due(chain)}::text AS due`);
			if (queued.due !== null)
				yield* config.announce?.(queued.due) ?? Effect.void;
			return { conversation: id, deferred: due };
		}),
		execute_plan: Effect.fn('Agents.execute_plan')(function* (id: string, as: As) {
			const conv = yield* conversation(id);
			if (conv.plan === null)
				return yield* new AgentRefusal({ message: 'there is no plan to execute' });
			const checkpoint = yield* db.value(Schema.Number,
				sql(`SELECT coalesce(max(seq), 0)::int AS s FROM sys_message WHERE conversation = $1`, id)
			);
			yield* setConv(id, 'plan = $2::jsonb', j({ ...conv.plan, status: 'active', checkpoint, verdicts: 0 } satisfies Plan));
			yield* post({ conversation: id, as, text: 'Execute the plan.', mode: 'agent' });
			return yield* drain(id);
		}),
		discard_plan: Effect.fn('Agents.discard_plan')(function* (id: string) {
			yield* setConv(id, 'plan = NULL');
		}),
		/**
		 * Deletes an in-app conversation for good, by its owner: its turn stops, its messages, its sub-agents' and their
		 * queued turns go, and the removal reaches live transcripts and lists. The files it holds stay with their records.
		 */
		archive: Effect.fn('Agents.archive')(function* (id: string, archived: boolean, by: Authority) {
			const conv = yield* conversation(id);
			if (conv.integration !== null || by.actor.kind !== 'member' || conv.owner !== by.actor.id)
				return yield* new AgentRefusal({ message: 'Only its owner archives an in-app conversation.' });
			yield* setConv(id, archived ? 'archived_at = now()' : 'archived_at = NULL');
		}),
		remove: Effect.fn('Agents.remove')(function* (id: string, by: Authority) {
			const conv = yield* conversation(id);
			if (conv.integration !== null || by.actor.kind !== 'member' || conv.owner !== by.actor.id)
				return yield* new AgentRefusal({ message: 'Only its owner deletes an in-app conversation.' });
			const children = yield* db.rows(Schema.Struct({ id: Schema.String }), sql('SELECT id FROM sys_conversation WHERE parent = $1', id));
			for (const one of [id, ...children.map((child) => child.id)]) yield* FiberMap.remove(running, one);
			yield* changed(sql(
				'DELETE FROM sys_message m WHERE conversation IN (SELECT id FROM sys_conversation WHERE id = $1 OR parent = $1)', id
			));
			const chain = new Chain();
			chain.params.push(id);
			runPiece(chain, 'unqueued', `DELETE FROM sys_run WHERE automation = '${TURN_RUN}' AND state = 'queued'
				AND input->>'conversation' IN (SELECT id FROM sys_conversation WHERE id = $1 OR parent = $1)`);
			capturePiece(chain, 'removed', 'sys_conversation', 'DELETE FROM sys_conversation WHERE id = $1 OR parent = $1');
			yield* nativeCommit(db.write, e.live.publish, chain, CapturedResult);
		}),
		set_agent: Effect.fn('Agents.set_agent')(function* (id: string, agent: string) {
			if (agent !== 'workspace' && (yield* envoySpec(db, agent)) === undefined)
				return yield* new AgentRefusal({ message: `there is no agent '${agent}'` });
			yield* setConv(id, 'envoy = $2', agent === 'workspace' ? null : agent);
		}),
		file: Effect.fn('Agents.file')(function* (
			messageId: string,
			about: { model: string; id: string } | null
		) {
			const chain = new Chain();
			yield* messageStatement(chain, markMessage(chain, messageId, { about }));
		}),
		mark_read: Effect.fn('Agents.mark_read')(function* (id: string, member: string) {
			yield* convChanged(
				sql(
					`UPDATE sys_conversation c SET read = read || jsonb_build_object($2::text, (SELECT coalesce(max(seq), 0) FROM sys_message WHERE conversation = $1)) WHERE id = $1`,
					id,
					member
				)
			);
		}),
		claim_page_action: Effect.fn('Agents.claim_page_action')(function* (messageId: string) {
			const rows = yield* changed(
				sql(
					`UPDATE sys_message m SET content = jsonb_set(content, '{result,pageClaim}', 'true'::jsonb, true)
					WHERE id = $1 AND role = 'tool' AND copied_from IS NULL AND content->'result'->'pageClaim' IS NULL`,
					messageId
				)
			);
			return rows.length > 0;
		}),
		page_result: Effect.fn('Agents.page_result')(function* (messageId: string, result: PageResult) {
			const answered = yield* changed(
				sql(
					`UPDATE sys_message m SET content = jsonb_set(content, '{result,page_result}', $2::jsonb, true)
					WHERE m.id = $1 AND m.role = 'tool' AND m.copied_from IS NULL AND jsonb_typeof(m.content->'result') = 'object'`,
					messageId,
					JSON.stringify(result)
				)
			);
			for (const row of answered) {
				const waiting = pageWaits.get(row.conversation);
				if (waiting !== undefined) yield* Deferred.succeed(waiting, undefined);
			}
		}),
		confirm: Effect.fn('Agents.confirm')(function* (
			messageId: string,
			approve: boolean,
			by: Authority
		) {
			const [answer] = yield* db.read([sql(`SELECT ${MSG} FROM sys_message m WHERE id = $1`, messageId)]);
			const [r] = yield* rowsOf(answer?.rows ?? []);
			if (r === undefined || r.copied_from != null || r.meta?.tag !== 'confirm')
				return yield* new AgentRefusal({ message: 'nothing awaits confirmation here' });
			if (r.state !== 'confirm') return yield* new AgentRefusal({ message: ANSWERED });
			if (
				by.agent !== undefined ||
				by.actor.kind !== 'member' ||
				r.as === null ||
				!('member' in r.as) ||
				r.as.member !== by.actor.id
			)
				return yield* new AgentRefusal({ message: 'only the person this turn serves can confirm it' });
			const as = r.as;
			const confirmation = r.meta;
			const receipts = yield* withConfirmation(r.conversation, Effect.gen(function* () {
			const receipts: Receipt[] = [];
			// one answer per card: the claim moves it out of `confirm` first, so a second press never runs the call again
			if (
				(yield* changed(
					sql(
						`UPDATE sys_message m SET state = 'approved' WHERE id = $1 AND state = 'confirm' `,
						messageId
					)
				)).length === 0
			)
				return yield* new AgentRefusal({ message: ANSWERED });
			const call = confirmation.call;
			const settle = (result: Json) => {
				const stored = storedToolResult(call.id, bounded(result).value, result);
				return changed(
					sql(
						`UPDATE sys_message m SET state = NULL, content = $2::jsonb, meta = CASE WHEN $3::jsonb IS NULL THEN meta - 'full' ELSE jsonb_set(meta, '{full}', $3::jsonb, true) END WHERE id = $1 AND state = 'approved' `,
						messageId,
						j({
							id: call.id,
							name: call.name,
							...(r.role === 'tool' ? { assistant: r.content.assistant } : {}),
							...(r.role === 'tool' && r.content.studio !== undefined
								? { studio: r.content.studio }
								: {}),
							result: stored.result
						}),
						j(stored.full)
					)
				);
			};
			const answer = Effect.gen(function* () {
				let result: Json = { declined: true };
				if (approve) {
					const authority = yield* resolve(as);
					if (authority === null) result = { error: FIXED.stale };
					else if (call.name !== 'act')
						return yield* new AgentRefusal({ message: 'only a write awaits confirmation' });
					else {
						const write = yield* Schema.decodeUnknownEffect(WriteInput, CLOSED)(call.input).pipe(
							Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message, error))
						);
						const started = yield* perform(
							{
								engine: e,
								authority,
								bindings: yield* config.bindings,
								turn: r.turn ?? r.id,
								receipts,
								// a confirmation card is the in-app agent's: a start records the conversation it came from
								agent: { conversation: r.conversation }
							},
							write.callable,
							write.input ?? null,
							call.id
						);
						// a confirmed start is a job too: no turn holds it, so its end is queued and wakes the conversation
						result = yield* Effect.scoped(
							Effect.flatMap(
								jobs({ detached, late: (lines) => steer(r.conversation, as, lines) }),
								(once) => runJob(once, e, authority, write.callable, started)
							)
						);
					}
				}
				return result;
			});
			const result = yield* answer.pipe(
				Effect.catch((failure) => Effect.succeed<Json>({ error: failure.message })),
				// the call can outlive this generation: the card still gets its answer
				Effect.onInterrupt(() =>
					settle({ error: FIXED.unreported }).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
				)
			);
			yield* settle(result);
			return receipts;
			}));
			return yield* drain(r.conversation, { force: true, receipts });
		}),
		/** The agent's live surface: the model classes and the MCP servers this actor may use. */
		surface: (a: Authority) => ({ models: config.ai?.models ?? [], mcp: mcpServers(m, a) }),
		models: Effect.fn('Agents.models')(function* () {
			const cat =
				config.ai === undefined
					? undefined
					: yield* config.ai.catalog.pipe(Effect.catch(() => Effect.succeed(undefined)));
			return (
				cat ?? {
					models: (config.ai?.models ?? []).map((id) => ({ id, label: id })),
					default: defaultModel
				}
			);
		}),
		exportTranscript: Effect.fn('Agents.exportTranscript')(function* (id: string) {
			const conv = yield* conversation(id),
				rows = (yield* transcript(id)).filter(
					(r) => !isAmbient(r) && !isCatalogueNote(r) && r.state !== 'cancelled' && r.state !== 'queued'
				);
			const calls = rows.reduce(
				(n, r) =>
					n +
					(r.copied_from == null && (r.meta?.tag === 'reply' || r.meta?.tag === 'failed') ? (r.meta.usage?.calls ?? 0) : 0),
				0
			);
			const tools = new Map<string, number>();
			for (const r of rows)
				if (r.copied_from == null && r.role === 'tool') {
					const name = r.content.display?.name ?? r.content.name;
					tools.set(name, (tools.get(name) ?? 0) + 1);
				}
			const out = [
				`# ${conv.title ?? 'Conversation'}`,
				'',
				`Model calls: ${calls}. Tool calls: ${[...tools].map(([n, c]) => `${n} ${c}`).join(', ') || 'none'}.`
			];
			for (const r of rows) {
				if (r.role === 'tool') continue;
				const body = r.text ?? '';
				if (r.meta?.tag === 'compact') out.push('', '## Checkpoint', '', body);
				else if (r.role === 'system') out.push('', `> ${body.replaceAll('\n', '\n> ')}`);
				else if (r.role === 'assistant') {
					if (body !== '') out.push('', '### Assistant', '', body);
				} else out.push('', `### ${authorOf(r) ?? 'Person'}`, '', body);
			}
			return out.join('\n') + '\n';
		})
	};
	e.db.owe(resumeSettled);
	return api;
});
export type Agents = Effect.Success<ReturnType<typeof agents>>;
/** What the host adds to every agent (its tools, skills, draft source). */
export type AgentHostConfig = Omit<
	AgentConfig,
	'engine' | 'ai' | 'bindings' | 'announce' | 'media'
>;
export const AgentHost = Context.Reference<AgentHostConfig>('bolt/AgentHost', {
	defaultValue: () => ({})
});
export const AgentsLive = Layer.effectContext(
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			live = yield* Live,
			calls = yield* Callables,
			automations = yield* Automations,
			reads = yield* Reads,
			approvals = yield* Approvals;
		const ai = yield* Ai,
			files = yield* Files,
			images = yield* Images,
			convert = yield* Convert,
			runEnds = yield* RunEnds,
			guest = yield* GuestIsolates,
			http = yield* Http,
			bundler = yield* Effect.serviceOption(Bundler),
			identity = yield* Effect.serviceOption(HostIdentity),
			audit = yield* Audit,
			geo = yield* Geo,
			wake = yield* Wake,
			turnHandlers = yield* TurnHandlers,
			runHandlers = yield* RunHandlers,
			links = yield* Effect.serviceOption(Links),
			host = yield* AgentHost;
		const bindings = Clock.currentTimeMillis.pipe(
			Effect.map((now) => bindingsAt(now, manifest.workspace.tz))
		);
		const typing =
			host.typing ??
			(Option.isSome(links)
				? (integration: string, thread: string, on: boolean) =>
						links.value
							.typing(integration, thread, on)
							.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
				: undefined);
		const secrets = yield* Secrets;
		// The MCP server's secret names resolve through the workspace's sealed secrets, not the host process environment.
		const mcp = host.mcp ?? {
			secret: (name: string) =>
				Config.option(Config.Redacted(name)).pipe(
					Effect.provideService(ConfigProvider.ConfigProvider, secrets.config),
					Effect.map((value) => Option.getOrUndefined(Option.map(value, Redacted.value))),
					Effect.mapError(Port.failure('mcp.configuration'))
				)
		};
		const api = yield* agents({
			...host,
			mcp,
			...(typing === undefined ? {} : { typing }),
			engine: {
				...Option.match(identity, { onNone: () => ({}), onSome: (identity) => ({ identity }) }),
				manifest,
				db,
				live,
				calls,
				automations,
				read: reads.run,
				approvals,
				...(audit.mode === 'disabled' ? {} : { audit }),
				files,
				images,
				convert,
				runEnds,
				guest,
				http,
				...Option.match(bundler, { onNone: () => ({}), onSome: (b) => ({ bundler: b }) })
			},
			ai,
			bindings,
			announce: wake.at,
			attachments: host.attachments ?? file_attachments(db, files, images),
			media: { files, images },
			geocoder: host.geocoder ?? geo
		});
		yield* turnHandlers.register('Agent', api.drain);
		const handlers = {
			[TURN_RUN]: (input: Json) =>
				api.turnRun(input, (conversation, envoy) =>
					turnHandlers.drain(conversation, envoy ? 'Envoy' : 'Agent')
				),
			[SCHEDULED_RUN]: api.queue.due
		};
		yield* runHandlers.register(handlers, {
			[TURN_RUN]: { attempts: 3, backoff: '10s' },
			[SCHEDULED_RUN]: { attempts: 3, backoff: '10s' }
		});
		const service: AgentsShape = {
			...api,
			handlers,
			attachments: api.attachments,
			revise: (id: string, text: string, by?: Authority, attachments?: readonly Json[]) =>
				api.revise(id, text, by, attachments).pipe(Effect.map(Option.fromNullishOr)),
			models: api.models()
		};
		return Context.make(AgentsTag, service).pipe(
			Context.add(AgentDrains, { drain: api.drain }),
			Context.add(MessageQueue, api.queue)
		);
	})
);
