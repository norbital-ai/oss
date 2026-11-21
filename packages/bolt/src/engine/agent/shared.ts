// Shared types, constants, guards, and pure helpers for the agent engine.
import {
	Context,
	Effect,
	Option,
	Predicate,
	PubSub,
	Schema
} from 'effect';
import {
	type AgentPorts,
	type HostTool,
	type WorkspacePort
} from '@norbital-ai/host-api';
import type { Json } from '../../decl/values.ts';
import type { AgentQuestion } from '../../protocol/schema.ts';
import type { AuditShape } from '../audit.ts';
import type { Authority, Bindings } from '../contracts.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { EngineError } from '../errors.ts';
import type { Credentials } from '../integrations/credentials.ts';
import type { EngineManifest } from '../manifest.ts';
import type {
	Ai,
	Bundler,
	Convert,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Images
} from '../ports.ts';
import { LEASE_MS } from '../queue.ts';
import type {
	ApprovalsShape,
	AutomationsShape,
	CallablesShape,
	LiveShape,
	ReadsShape
} from '../services.ts';
import { isObj } from './draft.ts';
import type { McpHost } from './mcp.ts';
import {
	ambient as isAmbient,
	authorOf,
	clip,
	type As,
	type ConversationRow,
	type MessageRow,
	type Receipt,
	type Usage
} from './schema.ts';
import type { ModelCarry } from './step.ts';
import { WriteInput, type AttachmentPort, type ToolContext } from './tools.ts';

export type AgentEngine = {
	identity?: import('../identity/session.ts').IdentityHost;
	manifest: EngineManifest;
	db: TenantDbShape;
	live: LiveShape;
	calls: CallablesShape;
	automations: AutomationsShape;
	read: ReadsShape['run'];
	/** The administrator audit trail, where the host keeps one: the `audit` tool. */
	audit?: AuditShape | undefined;
	approvals: ApprovalsShape;
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
	/** The integration instances' sealed credentials: a host tool's request through the actor's connection. */
	credentials?: Credentials | undefined;
};

export type DrainOptions = {
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

/** What the host adds to every agent (its tools, skills, draft source). */
export type AgentHostConfig = Omit<
	AgentConfig,
	'engine' | 'ai' | 'bindings' | 'announce' | 'media'
>;

export const AgentHost = Context.Reference<AgentHostConfig>('bolt/AgentHost', {
	defaultValue: () => ({})
});

export class Unusable extends Schema.TaggedError<Unusable>()('Unusable', {
	message: Schema.String
}) {}

export const AI_GAUGE_USD = 5;
export const PAGE_ANSWER_MS = 5000;
export const DEFAULT_MODEL = 'default';
export const NO_AI = 'the host provides no ai';
export const CONV_COLS =
	'id, title, owner, envoy, integration, thread, parent, status, model, plan';
export const TurnInput = Schema.Struct({ conversation: Schema.String });

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

/**
 * A reply being written reaches its row at most this often: one UPDATE of the whole text so far per flush (a write is
 * one statement), each published live like any other write, so the panel's transcript grows patch by patch.
 */
export const STREAM_FLUSH_MS = 400;
/** A chat's typing presence lapses on its own (WhatsApp's after about 10 s): a working turn renews it this often. */
export const TYPING_REFRESH_MS = 10_000;

/** What a resumed turn is told: its open request, and that a call made before the restart is not run again. */
export const NUDGE = {
	/** A request with no words (files only) is named, not quoted as `""`. */
	resumed: (request: string) => {
		const said = request.trim();
		return said === ''
			? "Your turn was interrupted and has resumed. The person's request is still open: their last message above."
			: `Your turn was interrupted and has resumed. The person's request is still open: "${said.length > 2000 ? `${said.slice(0, 2000)}…` : said}".`;
	},
	replayed:
		'Not run: this call was made before the turn resumed and may have taken effect; its outcome is above.',
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
	steps:
		'I stopped here: this request took more steps than one turn allows. Tell me how to continue.',
	overflow:
		'This conversation is too long for the model and could not be compacted further. Start a fresh conversation (or run /compact), then ask again: the work already done stays in the workspace.'
} as const;

/** A confirmation card's second answer (a repeat press, another tab): refused, so its call never runs twice. */
export const ANSWERED = 'This was already answered.';
export const APPROVED =
	'The person approved this call: make it again exactly as it was; it runs once.';

export type Streamer = {
	delta(x: string): void;
	reasoning(x: string): void;
	end(): Effect.Effect<MessageRow | null, EngineError>;
};

export type TurnState = {
	model: string;
	steps: number;
	failing: number;
	red: number;
	lowest: number;
	lastFailing: number;
	lastError: string;
	cutTools: number;
	compactions: number;
	compactFailed: boolean;
	lastInput: number;
	cached: number;
	as: As | null;
	mode: 'agent' | 'plan' | 'compact';
	force: boolean;
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
	replayed: Set<string>;
	mcpTools: ToolContext['mcpTools'] | null;
	mcpFor: string;
	host_tools: ToolContext['host_tools'];
	hostFor: string;
};

export type TurnGuard = {
	when(current: TurnState): boolean;
	text: string;
	code: 'toolFailures' | 'redChecks';
};

export const TURN_GUARDS: readonly TurnGuard[] = [
	{ when: (s) => s.failing > AGENT_LIMITS.failingSteps, text: FIXED.stuck, code: 'toolFailures' },
	{ when: (s) => s.red > AGENT_LIMITS.failingSteps, text: FIXED.red, code: 'redChecks' }
];

export const turnGuard = (current: TurnState, calls: number, failed: number) => {
	current.failing = calls > 0 && failed === calls ? current.failing + 1 : 0;
	return TURN_GUARDS.find((guard) => guard.when(current));
};

/** Updates red-check progress: clean resets; a new low resets; strictly decreasing after a spike holds `red` steady. */
export const recordCheckProgress = (
	current: Pick<TurnState, 'red' | 'lowest' | 'lastFailing'>,
	failing: number | undefined
): void => {
	if (failing === 0) {
		current.red = 0;
		current.lowest = Number.POSITIVE_INFINITY;
		current.lastFailing = Number.POSITIVE_INFINITY;
		return;
	}
	if (failing !== undefined) {
		if (failing < current.lowest) {
			current.lowest = failing;
			current.red = 0;
		} else if (failing < current.lastFailing) {
			// Making downward progress after a parse unblock or batch write: do not penalize convergence.
		} else {
			current.red += 1;
		}
		current.lastFailing = failing;
		return;
	}
	current.red += 1;
};

export const j = (v: unknown): Json =>
	v === undefined || v === null ? null : JSON.stringify(v);

const ActCall = Schema.fromJsonString(WriteInput);
const ActRow = Schema.Struct({
	target: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
	set: Schema.optionalKey(Schema.Json)
});

export const writesOf = (args: string | undefined) => {
	const call = Option.getOrUndefined(Schema.decodeUnknownOption(ActCall)(args));
	return Object.entries(call?.acts ?? {}).flatMap(([callable, input]) => {
		const at = callable.lastIndexOf('.');
		if (at < 0) return [];
		const model = callable.slice(0, at),
			verb = callable.slice(at + 1);
		if (!['create', 'update', 'delete', 'import'].includes(verb)) return [];
		const rows =
			verb === 'import' &&
			Predicate.isObject(input) &&
			!Array.isArray(input) &&
			Array.isArray(input['rows'])
				? input['rows']
				: Array.isArray(input)
					? input
					: [];
		return rows.map((row) => {
			const target = Option.getOrUndefined(Schema.decodeUnknownOption(ActRow)(row));
			const fields = verb === 'delete' ? undefined : verb === 'update' ? target?.set : row;
			return {
				model,
				verb,
				...(target?.target === undefined ? {} : { id: target.target.id }),
				...(fields === undefined ? {} : { fields: clip(fields, 300) })
			};
		});
	});
};

const MIB = 1_048_576;
export const memoryOf = (): {
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

export const failedResult = (result: Json): result is { readonly [key: string]: Json } =>
	isObj(result) && result['error'] !== undefined && result['error'] !== null;

export const fit = <M extends { content: unknown }>(list: readonly M[], budget: number): M[] => {
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

export const stepKey = (name: string, args: string | undefined): string =>
	`${name}\u0000${args ?? ''}`;

/**
 * How many failures a check (`ToolBehavior.progress_check`) reported: its `failing` count; 0 when it came back clean;
 * undefined when it could not run at all (an `error`).
 */
export const checkFailing = (answer: Json): number | undefined => {
	if (!isObj(answer)) return undefined;
	if (typeof answer['failing'] === 'number') return answer['failing'];
	return answer['error'] === undefined || answer['error'] === null ? 0 : undefined;
};

/**
 * The calls the person approved on a card and the agent has not made since, by `callKey`: each runs once without a
 * second card, until the person's next message. A `run_tool` card approves the tool it names.
 */
export const approvedCalls = (rows: readonly MessageRow[]): Set<string> =>
	new Set(
		rows.flatMap((card, at) => {
			if (card.role !== 'tool' || card.meta?.tag !== 'confirm' || card.state !== null) return [];
			const result = card.content.result;
			if (!isObj(result) || result['approved'] !== true) return [];
			const { name, input } = card.meta.call,
				args = clip(input, 8000);
			if (
				rows
					.slice(at + 1)
					.some(
						(later) =>
							later.role === 'user' ||
							(later.role === 'tool' &&
								later.content.name === name &&
								later.content.args === args)
					)
			)
				return [];
			return [
				name === 'run_tool' && isObj(input) && typeof input['name'] === 'string'
					? callKey(input['name'], input['input'] ?? {})
					: callKey(name, input)
			];
		})
	);

/** Whether the person approved `page` tab control once in this conversation (grants all subsequent `page` actions in the session). */
export const approvedPageSession = (rows: readonly MessageRow[]): boolean =>
	rows.some(
		(card) =>
			card.role === 'tool' &&
			card.meta?.tag === 'confirm' &&
			card.state === null &&
			isObj(card.content.result) &&
			card.content.result['approved'] === true &&
			card.meta.call.name === 'page'
	);

export const isCatalogueNote = (row: MessageRow) =>
	row.role === 'system' && row.meta?.tag === 'note' && row.meta.catalogue !== undefined;

export const formatExportTranscript = (
	conv: Pick<ConversationRow, 'title'>,
	allRows: readonly MessageRow[]
): string => {
	const rows = allRows.filter(
		(r) => !isAmbient(r) && !isCatalogueNote(r) && r.state !== 'cancelled' && r.state !== 'queued'
	);
	const calls = rows.reduce(
		(n, r) =>
			n +
			(r.copied_from == null && (r.meta?.tag === 'reply' || r.meta?.tag === 'failed')
				? (r.meta.usage?.calls ?? 0)
				: 0),
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
};
