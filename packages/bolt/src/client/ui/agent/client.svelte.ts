import { Effect, Schedule } from 'effect';
import type { BoltTransport } from '../../../client.js';
import { rowsFrom } from '../../runtime.js';
import { parseAgentMessage } from '../../../runtime/agents/agent-message.js';
import { decodeMessageText } from './message-text.js';

export type InteractiveAgentStartInput = {
	readonly message: string;
	readonly runId?: string;
	readonly planMode?: boolean;
	readonly intent?: 'do' | 'plan';
	readonly verifierPrompt?: string;
	readonly model?: string;
	readonly mentions?: readonly {
		readonly collection: string;
		readonly recordId: string;
		readonly label: string;
	}[];
};

export type AgentChatStartResult = { readonly runId: string; readonly chatId: string };

type ChatSessionRow = {
	readonly norbital_id: string;
	readonly automation_run_id?: string | null;
	readonly title: string | null;
	readonly user_id: string;
	readonly visibility: string;
	readonly platform?: string | null;
	readonly channel_key?: string | null;
	readonly external_thread_id?: string | null;
	readonly messages: Array<Record<string, unknown>>;
	readonly turns: Array<Record<string, unknown>>;
	readonly usage_cost_usd?: number;
	readonly usage_cost_micro_units?: number;
	readonly usage_cost_currency?: string | null;
	readonly usage_total_tokens?: number;
	readonly usage_turns_counted?: number;
	readonly usage_turns_unreported?: number;
};

/**
 * The authenticated caller, as the wire carries it.
 *
 * This was `unknown`, which made every command that includes it fail to be `Json` — so the agent
 * client's own command calls were untypeable and the errors were suppressed rather than fixed. A
 * subject is a plain record; saying so is what lets the commands type-check.
 */
type AgentSubject = Readonly<{
	readonly userId: string;
	readonly tenantId: string;
	readonly roles: ReadonlyArray<string>;
	readonly teams: ReadonlyArray<string>;
	readonly email?: string;
}>;

type AgentRuntimeConfig = {
	readonly transport: BoltTransport;
	readonly subject: AgentSubject;
	readonly agentName: string;
	readonly userId: string;
};

type SessionQuery = {
	readonly current: readonly ChatSessionRow[];
	readonly loading: boolean;
	readonly error: unknown;
	readonly refresh: () => void;
};

type ConversationListRow = {
	readonly id: string;
	readonly agent_name?: string;
	readonly title?: string | null;
};

/** One conversation's cumulative spend, as `agents.history` reports it off the session row. */
type ConversationUsage = {
	readonly costUsd?: number;
	readonly costMicroUnits?: number;
	readonly costCurrency?: string | null;
	readonly totalTokens?: number;
	readonly turnsCounted?: number;
	readonly turnsUnreported?: number;
};

type ConversationHistory = {
	readonly conversationId: string;
	readonly title: string;
	/**
	 * Every row of this conversation *and* of everything it delegated, in one ordering.
	 *
	 * `turn_id` is what tells the two apart: a delegated session's rows carry the turn that produced
	 * them, and the projection nests those under the call that spawned it instead of leaving them
	 * interleaved into the parent by write order.
	 */
	readonly messages: ReadonlyArray<{
		readonly role: string;
		readonly content: unknown;
		readonly turn_id?: string | null;
	}>;
	readonly usage?: ConversationUsage;
};

let runtime: AgentRuntimeConfig | undefined;
let sessions = $state<ChatSessionRow[]>([]);
let sessionQueryVersion = $state(0);
let sessionsLoading = $state(false);

export function configureAgentRuntime(config: AgentRuntimeConfig): void {
	runtime = config;
	void refreshAgentSessions();
}

export function getAgentRuntime(): AgentRuntimeConfig | undefined {
	return runtime;
}

function notifySessions(): void {
	sessionQueryVersion += 1;
}

const sessionQuery: SessionQuery = {
	get current() {
		void sessionQueryVersion;
		return sessions;
	},
	get loading() {
		return sessionsLoading;
	},
	error: null,
	refresh: () => {
		void refreshAgentSessions();
	}
};

/** A row of the workspace `user` collection, as the chat panel labels members from it. */
/**
 * A person, as much of one as this panel may read.
 *
 * No `email`, because the system read policy grants `bolt_auth_user` with the field mask
 * `['norbital_id', 'name']` — `findMany` masks every row it returns, so an address is not merely
 * unselected here, it cannot be read through that grant at all. Typing one promised the panel a
 * field the runtime refuses, and the label fell back to it.
 */
export type WorkspaceUserRow = Readonly<{
	readonly norbital_id?: string;
	readonly name?: string;
}>;

type UserQuery = Readonly<{ readonly current: ReadonlyArray<WorkspaceUserRow> }>;

let workspaceUsers = $state<ReadonlyArray<WorkspaceUserRow>>([]);
let workspaceUsersLoaded = false;

const userQuery: UserQuery = {
	get current() {
		return workspaceUsers;
	}
};

/**
 * Loads the workspace members the chat panel labels conversations with.
 *
 * `bolt_auth_user` is the only description of a person the runtime has. This read `user`, a table the
 * identity merge removed, so the request failed and the catch below turned every failure into an
 * empty list: every conversation scoped to another member rendered as "unknown member" and the admin
 * scope picker had nothing to pick.
 *
 * `kind` separates a person from a host provisioner's service row and defaults to `'person'`. The
 * operand is an operator object because a bare value fails the where compiler and takes the whole
 * query with it — which is the second way this query returned nothing.
 *
 * Answered by the server rather than out of the replica: identity is excluded from `Sync.shape` and
 * from the change stream, so the membership table is never mirrored into a browser.
 */
const loadWorkspaceUsers = async (): Promise<void> => {
	if (workspaceUsersLoaded) return;
	workspaceUsersLoaded = true;
	const active = runtime;
	if (active === undefined) return;
	try {
		// `BoltTransport.command` takes an optional signal, not an output schema — the schema-decoding
		// overload belongs to `BoltClient`.
		const rows = await active.transport.command('collections.findMany', {
			collection: 'bolt_auth_user',
			where: { kind: { eq: 'person' } },
			orderBy: { name: 'asc' },
			limit: 500
		});
		workspaceUsers = (rowsFrom(rows) ?? []).filter(
			(row): row is WorkspaceUserRow =>
				row !== null && typeof row === 'object' && !Array.isArray(row)
		);
	} catch {
		// A subject the read grant does not reach labels by id; that is a display difference, not a
		// failure worth propagating into the chat panel.
		workspaceUsers = [];
	}
};

/**
 * The subset of the workspace client the agent chat reads.
 *
 * `findMany` accepts the same options shape as the real client so callers are not written against a
 * narrower stub, even though the session query is already live and ignores them.
 */
export function getInitializedWorkspaceClient(_collection?: string) {
	void loadWorkspaceUsers();
	return {
		db: {
			chat_session: {
				findMany: (_options?: Readonly<Record<string, unknown>>): SessionQuery => sessionQuery
			},
			bolt_auth_user: {
				findMany: (_options?: Readonly<Record<string, unknown>>): UserQuery => userQuery
			}
		}
	};
}

function isConversationListRow(value: unknown): value is ConversationListRow {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const id = Reflect.get(value, 'id');
	return typeof id === 'string' && id.length > 0;
}

function isConversationHistory(value: unknown): value is ConversationHistory {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const conversationId = Reflect.get(value, 'conversationId');
	const messages = Reflect.get(value, 'messages');
	return typeof conversationId === 'string' && Array.isArray(messages);
}

/** Reads one field of a stored record, or nothing when the content is text rather than a record. */
function readField(value: unknown, field: string): unknown {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? Reflect.get(value, field)
		: undefined;
}

/**
 * One stored record as the panel reads it.
 *
 * An assistant record is a whole turn: its `parts` are the steps it took, in the order it took them,
 * and its `status` is the turn's own. Rekeying it here would break the join the projection makes
 * between a call and the answer that names it, so the stored parts are handed on unchanged.
 */
function mapHistoryMessage(
	message: { readonly role: string; readonly content: unknown; readonly turn_id?: string | null },
	index: number
): Record<string, unknown> {
	const stored = message.content;
	// Carried on every projected record, delegated or not: the projection reads it to decide which
	// rows are this conversation's own and which belong inside one of its calls.
	const turn = typeof message.turn_id === 'string' ? { turn_id: message.turn_id } : {};
	// A sibling session's message is a `user` row that no user wrote. It is marked here rather than
	// left to the projection to guess, because by the time the panel sees a role and some text the
	// difference between "the person asked" and "another agent asked" is gone.
	const relayed = parseAgentMessage(stored);
	if (relayed !== null) {
		return {
			norbital_id: `agent-message-${index}`,
			kind: 'agent_message',
			role: message.role,
			from: relayed.from,
			parts: [{ kind: 'text', text: relayed.text }],
			...turn
		};
	}
	const parts = readField(stored, 'parts');
	if (Array.isArray(parts)) {
		const id = readField(stored, 'id');
		const status = readField(stored, 'status');
		// The turn's own usage travels with the turn. The panel reads the newest one to say how much of
		// the context window this conversation is occupying; cumulative spend comes off the session row
		// instead, because that has to survive these messages being compacted away.
		const usage = readField(stored, 'usage');
		return {
			norbital_id: typeof id === 'string' ? id : `${message.role}-${index}`,
			role: message.role,
			parts,
			...(typeof status === 'string' ? { status } : {}),
			...(usage !== undefined && usage !== null ? { usage } : {}),
			...turn
		};
	}
	// A user message has one part because a person's turn is one thing they said.
	const text = decodeMessageText(stored);
	return {
		norbital_id: `${message.role}-${index}`,
		role: message.role,
		parts: [{ kind: 'text', text }],
		...turn
	};
}

/**
 * The turn a message *is*, as the session's `turns` shape.
 *
 * One agent turn is one assistant message, so this reads the lifecycle off that message rather than
 * off a record beside it. There used to be a separate `turn` row, which meant the panel could see a
 * turn whose parts had not arrived and a set of parts with no turn to project their state against.
 */
function mapHistoryTurn(content: unknown): Record<string, unknown> | null {
	const id = readField(content, 'id');
	const status = readField(content, 'status');
	if (typeof id !== 'string' || typeof status !== 'string') return null;
	return { norbital_id: id, status, subagent_id: readField(content, 'subagent_id') ?? null };
}

/** A finite counter off the wire, or zero — a total that cannot be read is not a total of zero spend. */
function usageCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function mapHistoryToSession(
	history: ConversationHistory,
	userId: string,
	fallbackTitle?: string | null
): ChatSessionRow {
	// Derived from the assistant messages rather than listed beside them: the turn is the message.
	const turns = history.messages.flatMap((message) => {
		if (message.role !== 'assistant') return [];
		const turn = mapHistoryTurn(message.content);
		return turn === null ? [] : [turn];
	});
	// A delegated session's rows arrive inside this history. They are this conversation's content, but
	// they are not messages anyone here sent — so they name neither the conversation nor the window
	// the person's next prompt will be measured against.
	const delegatedTurnIds = new Set(
		turns
			.filter((turn) => typeof turn.subagent_id === 'string')
			.map((turn) => turn.norbital_id)
			.filter((id): id is string => typeof id === 'string')
	);
	const delegated = (message: ConversationHistory['messages'][number]): boolean =>
		typeof message.turn_id === 'string' && delegatedTurnIds.has(message.turn_id);
	// Titled from what the person asked, not from what another agent sent in: a conversation named
	// after an incoming message is named after somebody else's turn.
	const firstUser = history.messages.find(
		(message) =>
			message.role === 'user' && !delegated(message) && parseAgentMessage(message.content) === null
	);
	const title =
		history.title.trim().length > 0 && history.title !== 'New conversation'
			? history.title
			: firstUser
				? decodeMessageText(firstUser.content).slice(0, 48) || 'New conversation'
				: (fallbackTitle ?? 'New conversation');
	return {
		norbital_id: history.conversationId,
		automation_run_id: history.conversationId,
		title,
		user_id: userId,
		visibility: 'personal',
		messages: history.messages.map((message, index) => ({
			...mapHistoryMessage(message, index),
			...(delegated(message) ? { delegated: true } : {})
		})),
		turns,
		// Read off the session row, never summed here. The counters already include everything this
		// conversation delegated, at any depth, which is exactly the figure a reader takes for the
		// cost of the conversation in front of them.
		usage_cost_usd: usageCount(history.usage?.costUsd),
		usage_cost_micro_units: usageCount(history.usage?.costMicroUnits),
		usage_cost_currency:
			typeof history.usage?.costCurrency === 'string' ? history.usage.costCurrency : null,
		usage_total_tokens: usageCount(history.usage?.totalTokens),
		usage_turns_counted: usageCount(history.usage?.turnsCounted),
		usage_turns_unreported: usageCount(history.usage?.turnsUnreported)
	};
}

/**
 * Reads one conversation and replaces the session it projects to, reporting whether it landed.
 *
 * Split out of `refreshAgentSessions` because a turn in flight needs *this* conversation and not the
 * whole list: the loop rewrites the turn's row as each part lands, so re-reading one conversation is
 * what makes a step visible while it is still happening. It replaces the session rather than merging
 * into it because the stored turn is already the whole turn — merging part-wise would rebuild, on the
 * client, the per-round split the loop was changed to stop producing.
 *
 * The boolean is the caller's answer to "did the store speak"; a host that has not wired persistence
 * answers no, and the caller keeps what it has instead of blanking the conversation.
 */
async function loadSession(
	conversationId: string,
	fallbackTitle?: string | null
): Promise<boolean> {
	if (!runtime) return false;
	try {
		const history = await runtime.transport.command('agents.history', {
			subject: runtime.subject,
			conversationId
		});
		// An answer about some other conversation is not this one's history. Keying the session off the
		// reply rather than off the question would file it under the conversation it describes, leaving
		// the one actually asked about untouched and its caller believing it had been refreshed.
		if (!isConversationHistory(history) || history.conversationId !== conversationId) return false;
		const row = mapHistoryToSession(history, runtime.userId, fallbackTitle ?? null);
		const merged = new Map(sessions.map((session) => [session.norbital_id, session]));
		merged.set(row.norbital_id, row);
		sessions = [...merged.values()];
		notifySessions();
		return true;
	} catch {
		// Keep whatever is already in memory when the host has not wired persistence yet.
		return false;
	}
}

/** Reloads persisted conversations and messages from the bolt runtime. */
export async function refreshAgentSessions(): Promise<void> {
	if (!runtime) {
		sessions = [];
		notifySessions();
		return;
	}
	sessionsLoading = true;
	notifySessions();
	try {
		const listed = await runtime.transport.command('agents.listConversations', {
			subject: runtime.subject
		});
		if (!Array.isArray(listed)) return;
		const rows = listed.filter(isConversationListRow);
		if (rows.length === 0) return;
		await Effect.runPromise(
			Effect.all(
				rows.map((row) => Effect.tryPromise(() => loadSession(row.id, row.title ?? null))),
				{
					concurrency: 'unbounded'
				}
			).pipe(Effect.catch(() => Effect.succeed(undefined)))
		);
	} catch {
		// Keep whatever is already in memory when the host has not wired persistence yet.
	} finally {
		sessionsLoading = false;
		notifySessions();
	}
}

/**
 * How often a turn in flight re-reads its own conversation.
 *
 * The loop commits a part the moment it exists — before a round's calls run, and again as each answer
 * returns — so the store already holds every step as it happens. Nothing pushes it: agent messages
 * live in `bolt_agent_messages`, a platform table, and the sync outbox only carries records of
 * declared workspace collections, so the browser replica never sees them in any grain. Reading is
 * therefore the only way a step reaches the reader before the turn returns, and this is how often.
 */
export const AGENT_TURN_POLL_MS = 500;

function upsertSession(conversationId: string, userId: string): ChatSessionRow {
	const existing = sessions.find((session) => session.norbital_id === conversationId);
	if (existing) return existing;
	const row: ChatSessionRow = {
		norbital_id: conversationId,
		automation_run_id: conversationId,
		title: 'New conversation',
		user_id: userId,
		visibility: 'personal',
		messages: [],
		turns: []
	};
	sessions = [...sessions, row];
	notifySessions();
	return row;
}

function extractTurnText(output: unknown): string {
	if (output !== null && typeof output === 'object' && 'text' in output) {
		const text = Reflect.get(output, 'text');
		if (typeof text === 'string') return text;
	}
	if (typeof output === 'string') return output;
	return output == null ? '' : String(output);
}

function extractCommandOutput(result: unknown): unknown {
	if (result !== null && typeof result === 'object' && 'output' in result) {
		return Reflect.get(result, 'output');
	}
	return result;
}

export async function startInteractiveAgent(
	input: InteractiveAgentStartInput
): Promise<AgentChatStartResult> {
	if (!runtime) throw new Error('Agent runtime not configured');
	const { transport, subject, agentName, userId } = runtime;
	const conversationId = input.runId ?? crypto.randomUUID();
	upsertSession(conversationId, userId);

	const userMessage = {
		norbital_id: crypto.randomUUID(),
		role: 'user',
		parts: [{ kind: 'text', text: input.message }]
	};
	const turnId = conversationId;
	const turn = {
		norbital_id: turnId,
		status: 'running',
		subagent_id: null
	};

	sessions = sessions.map((session) =>
		session.norbital_id === conversationId
			? {
					...session,
					title:
						session.title === 'New conversation' || session.title == null
							? input.message.slice(0, 48)
							: session.title,
					messages: [...session.messages, userMessage],
					turns: [...session.turns, turn]
				}
			: session
	);
	notifySessions();

	try {
		try {
			await transport.command('agents.start', {
				subject,
				agent: agentName,
				conversationId
			});
		} catch {
			// Conversation may already exist from a prior turn.
		}
		// The turn is one round trip that can run for a minute; its steps land in the store the whole
		// time. Reading while it is in flight is what turns "nothing, then everything" into a turn the
		// reader watches happen — without it, `agents.turn` returning is the first and only news.
		const watch = Effect.runFork(
			Effect.repeat(
				Effect.sync(() => {
					void loadSession(conversationId);
				}),
				Schedule.spaced(AGENT_TURN_POLL_MS)
			)
		);
		let result: unknown;
		try {
			result = await transport.command('agents.turn', {
				subject,
				agent: agentName,
				conversationId,
				message: input.message
			});
		} finally {
			watch.interruptUnsafe();
		}
		// The settled turn is read back rather than assembled here: the store holds every part the turn
		// produced, and the response carries only its last words. Assembling a one-part message from
		// them dropped the tool calls the reader had just watched land.
		const landed = await loadSession(conversationId);
		if (!landed) {
			// A host without persistence has no store to read, so the response is all there is.
			const text = extractTurnText(extractCommandOutput(result));
			const assistantMessage = {
				norbital_id: turnId,
				role: 'assistant',
				status: 'completed',
				parts: [{ kind: 'text', text }]
			};
			sessions = sessions.map((session) =>
				session.norbital_id === conversationId
					? {
							...session,
							messages: [...session.messages, assistantMessage],
							turns: session.turns.map((entry) =>
								entry.norbital_id === turnId ? { ...entry, status: 'completed' } : entry
							)
						}
					: session
			);
			notifySessions();
		}
		return { runId: conversationId, chatId: conversationId };
	} catch (error) {
		// The loop marks its own turn failed before it propagates, so the store already says so — and
		// it says it about the turn's real id, which the optimistic entry below does not share once a
		// read has landed. Reading first is what keeps a failed turn from reading as one still running,
		// which is the state that holds the composer locked until it goes stale.
		const landed = await loadSession(conversationId);
		if (!landed) {
			sessions = sessions.map((session) =>
				session.norbital_id === conversationId
					? {
							...session,
							turns: session.turns.map((entry) =>
								entry.norbital_id === turnId ? { ...entry, status: 'failed' } : entry
							)
						}
					: session
			);
			notifySessions();
		}
		throw error;
	}
}

export async function updateAgentVerifier(input: {
	readonly runId: string;
	readonly prompt: string;
}): Promise<{ readonly accepted: true }> {
	if (!runtime) throw new Error('Agent runtime not configured');
	await runtime.transport.command('agents.updateVerifier', {
		conversationId: input.runId,
		verifier: { prompt: input.prompt }
	});
	return { accepted: true };
}
