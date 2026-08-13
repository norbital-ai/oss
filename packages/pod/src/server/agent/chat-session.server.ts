import { v7 } from 'uuid';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { withCollectionTransaction } from '$lib/server/collection/collection_transaction.server.js';
import { emitSyncOutboxRow } from '$lib/server/collection/sync/sync-outbox.server.js';
import type {
	ChatSessionAggregate,
	ChatSessionMessage,
	ChatSessionTurn
} from '$lib/shared/agent/chat-session.js';
import type { AiMessage } from '@norbital-ai/platform-utils/runtime/binding';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type MutableChatSessionAggregate = Mutable<ChatSessionAggregate> & {
	messages: ChatSessionMessage[];
	turns: ChatSessionTurn[];
};

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function aggregate(row: Readonly<Record<string, unknown>>): MutableChatSessionAggregate {
	if (typeof row.norbital_id !== 'string') throw new Error('Chat session has no id');
	return {
		norbital_id: row.norbital_id,
		norbital_row_version: numberOrZero(row.norbital_row_version),
		title: typeof row.title === 'string' ? row.title : '',
		messages: asArray<ChatSessionMessage>(row.messages),
		turns: asArray<ChatSessionTurn>(row.turns),
		usage_cost_usd: numberOrZero(row.usage_cost_usd),
		usage_total_tokens: numberOrZero(row.usage_total_tokens),
		usage_turns_counted: numberOrZero(row.usage_turns_counted),
		usage_turns_unreported: numberOrZero(row.usage_turns_unreported)
	};
}

/** Read the one tenant row that owns a conversation and every part in it. */
export async function readChatSession(sessionId: string): Promise<MutableChatSessionAggregate> {
	const ctx = getWorkspace({ provision: true });
	const result = await ctx.tenantDb.query<Record<string, unknown>>(
		`SELECT norbital_id,
		        norbital_row_version,
		        title,
		        messages,
		        turns,
		        usage_cost_usd,
		        usage_total_tokens,
		        usage_turns_counted,
		        usage_turns_unreported
		   FROM chat_session
		  WHERE norbital_id = $1::uuid
		  LIMIT 1`,
		[sessionId]
	);
	const row = result.rows[0];
	if (!row) throw new Error('Chat session does not exist');
	return aggregate(row);
}

/**
 * Serialize one aggregate mutation and publish exactly one chat_session sync event in the same
 * transaction. This is the only write boundary for messages and turns: no dual writes, polling, or
 * ordering repair exists elsewhere.
 */
export async function mutateChatSession<T>(
	sessionId: string,
	mutate: (session: MutableChatSessionAggregate) => T | Promise<T>
): Promise<T> {
	const ctx = getWorkspace({ provision: true });
	return withCollectionTransaction(ctx, async () => {
		const selected = await ctx.tenantDb.query<Record<string, unknown>>(
			`SELECT norbital_id,
			        norbital_row_version,
			        title,
			        messages,
			        turns,
			        usage_cost_usd,
			        usage_total_tokens,
			        usage_turns_counted,
			        usage_turns_unreported
			   FROM chat_session
			  WHERE norbital_id = $1::uuid
			  FOR UPDATE`,
			[sessionId]
		);
		const row = selected.rows[0];
		if (!row) throw new Error('Chat session does not exist');
		const session = aggregate(row);
		const result = await mutate(session);
		const updated = await ctx.tenantDb.query<{ norbital_row_version: number }>(
			`UPDATE chat_session
			    SET title = $2,
			        messages = $3::jsonb,
			        turns = $4::jsonb,
			        usage_cost_usd = $5,
			        usage_total_tokens = $6,
			        usage_turns_counted = $7,
			        usage_turns_unreported = $8,
			        norbital_updated_at = now()
			  WHERE norbital_id = $1::uuid
			RETURNING norbital_row_version`,
			[
				sessionId,
				session.title,
				JSON.stringify(session.messages),
				JSON.stringify(session.turns),
				session.usage_cost_usd,
				session.usage_total_tokens,
				session.usage_turns_counted,
				session.usage_turns_unreported
			]
		);
		const version = updated.rows[0]?.norbital_row_version;
		if (typeof version !== 'number')
			throw new Error('Chat session update did not return a version');
		await emitSyncOutboxRow(ctx.tenantDb, 'chat_session', 'update', sessionId, version);
		return result;
	});
}

function pushChatMessage(
	session: MutableChatSessionAggregate,
	turnId: string,
	message: AiMessage,
	extra: Readonly<Record<string, unknown>> = {}
): string {
	const id = v7();
	const lastSequence = session.messages.at(-1)?.seq ?? 0;
	session.messages.push({
		norbital_id: id,
		turn_id: turnId,
		role: message.role,
		seq: lastSequence + 1,
		parts: [message],
		model: typeof extra.model === 'string' ? extra.model : null,
		usage:
			extra.usage && typeof extra.usage === 'object' && !Array.isArray(extra.usage)
				? (extra.usage as Readonly<Record<string, unknown>>)
				: null,
		plan_mode: extra.plan_mode === true,
		goal_mode: extra.goal_mode === true,
		kind:
			extra.kind === 'reasoning' ||
			extra.kind === 'summary' ||
			extra.kind === 'usage' ||
			extra.kind === 'goal'
				? extra.kind
				: 'normal',
		status: extra.status === 'streaming' || extra.status === 'aborted' ? extra.status : 'complete',
		queue_status:
			extra.queue_status === 'queued' ||
			extra.queue_status === 'released' ||
			extra.queue_status === 'removed'
				? extra.queue_status
				: 'live',
		release_mode:
			extra.release_mode === 'step' || extra.release_mode === 'turn' ? extra.release_mode : null,
		author_user_id: typeof extra.author_user_id === 'string' ? extra.author_user_id : null,
		author_display_name:
			typeof extra.author_display_name === 'string' ? extra.author_display_name : null,
		source_provider: typeof extra.source_provider === 'string' ? extra.source_provider : null,
		source_conversation_id:
			typeof extra.source_conversation_id === 'string' ? extra.source_conversation_id : null,
		source_message_id: typeof extra.source_message_id === 'string' ? extra.source_message_id : null,
		source_deleted_at: typeof extra.source_deleted_at === 'string' ? extra.source_deleted_at : null,
		durable_ordinal: typeof extra.durable_ordinal === 'number' ? extra.durable_ordinal : null
	});
	return id;
}

function pushChatTurn(
	session: MutableChatSessionAggregate,
	input: { readonly model: string; readonly parentTurnId?: string; readonly subagentId?: string }
): string {
	const now = new Date().toISOString();
	const id = v7();
	session.turns.push({
		norbital_id: id,
		prompt_message_id: null,
		status: 'running',
		model: input.model,
		parent_turn_id: input.parentTurnId ?? null,
		subagent_id: input.subagentId ?? null,
		error: null,
		started_at: now,
		heartbeat_at: now,
		ended_at: null,
		usage_settled_at: null
	});
	return id;
}

export async function appendChatMessage(
	sessionId: string,
	turnId: string,
	message: AiMessage,
	extra: Readonly<Record<string, unknown>> = {}
): Promise<string> {
	return mutateChatSession(sessionId, (session) =>
		pushChatMessage(session, turnId, message, extra)
	);
}

export async function updateChatMessage(
	sessionId: string,
	messageId: string,
	values: Readonly<Record<string, unknown>>
): Promise<void> {
	await mutateChatSession(sessionId, (session) => {
		const index = session.messages.findIndex((message) => message.norbital_id === messageId);
		if (index < 0) throw new Error('Chat message does not exist');
		session.messages[index] = { ...session.messages[index]!, ...values } as ChatSessionMessage;
	});
}

export async function appendChatTurn(
	sessionId: string,
	input: { readonly model: string; readonly parentTurnId?: string; readonly subagentId?: string }
): Promise<string> {
	return mutateChatSession(sessionId, (session) => pushChatTurn(session, input));
}

/**
 * Persist the root turn, user message, and any system notices in one aggregate write.
 *
 * The hosted start path has a two-second guest budget. Opening those rows as separate
 * `mutateChatSession` transactions spent that budget on round-trips before admission.
 */
export async function openInteractiveAgentTurn(input: {
	readonly sessionId: string;
	readonly model: string;
	readonly userMessage: string;
	readonly userExtra?: Readonly<Record<string, unknown>>;
	readonly systemMessages?: readonly {
		readonly content: string;
		readonly extra?: Readonly<Record<string, unknown>>;
	}[];
}): Promise<{ readonly turnId: string; readonly inputMessageId: string }> {
	return mutateChatSession(input.sessionId, (session) => {
		const turnId = pushChatTurn(session, { model: input.model });
		const inputMessageId = pushChatMessage(
			session,
			turnId,
			{ role: 'user', content: input.userMessage },
			input.userExtra ?? {}
		);
		const turnIndex = session.turns.findIndex((candidate) => candidate.norbital_id === turnId);
		const turn = session.turns[turnIndex];
		if (turn) {
			session.turns[turnIndex] = { ...turn, prompt_message_id: inputMessageId };
		}
		for (const notice of input.systemMessages ?? []) {
			pushChatMessage(
				session,
				turnId,
				{ role: 'system', content: notice.content },
				notice.extra ?? {}
			);
		}
		return { turnId, inputMessageId };
	});
}

export async function updateChatTurn(
	sessionId: string,
	turnId: string,
	values: Readonly<Record<string, unknown>>
): Promise<void> {
	await mutateChatSession(sessionId, (session) => {
		const index = session.turns.findIndex((turn) => turn.norbital_id === turnId);
		if (index < 0) throw new Error('Chat turn does not exist');
		session.turns[index] = { ...session.turns[index]!, ...values } as ChatSessionTurn;
	});
}
